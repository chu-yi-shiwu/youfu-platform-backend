// 报修优先级预填规则（2026-09-06）
// 数据源：UOne 老平台 44.8 万行历史工单统计（置信度高，非拍脑袋）：
//   - 跳闸断电：紧急+特急占比 21.6%（787/3652）→ 命中即 urgent
//   - 电梯困人：非常紧急显著（81/1826），含困人场景 → 命中即 urgent
//   - 漏水：紧急率 6.8%（191/2804）→ 命中即 urgent（"空调漏水"历史上同样命中，保持一致）
//   - 医用气体（氧气/送氧/负压/设备带）：临床风险高，命中即 urgent（历史 141+5 行紧急）
//   - 水工 3.2% / 门窗帘子 6.9% / 打印机 8.7% / 缺墨 3.7%：紧急率不高，不自动升档，保持 normal
//   - 默认：全部类目缺省 normal（历史 97.9% 为一般，不激进升档）
// 硬红线：
//   1. 本模块绝不进入派单模型训练链路（不 import / 不被 engine/dispatch.ts、modelTrainer 引用）
//   2. 陪检/运送类目（陪检、转科、CT 类、X线类等）不参与预填（另一条业务线）
// 结构：独立纯函数 + 规则表，零 DB 依赖，便于单测与后续从 JSON 灌入更多规则。
// 优先级链：user > rule > llm > fallback(legacy inferPriority) > default('normal')，
// 见 resolvePrefillPriority；调用方把结果落 ext.inferred/filled.priority_source 留痕。

export type TicketPriority = 'urgent' | 'normal' | 'low';
export type PrioritySource = 'user' | 'rule' | 'llm' | 'default';

export interface PriorityRule {
  /** 规则 ID（留痕/审计用） */
  id: string;
  /** 命中后预填的优先级（当前规则表只做 urgent 升档，不降档） */
  priority: 'urgent';
  /** 关键词：对描述与类目名同时匹配（scope=both） */
  keywords: readonly string[];
  /** 匹配范围：both = 描述 + 类目名 */
  scope: 'both';
  /** 规则说明（历史数据依据） */
  note: string;
}

// 规则表：顺序敏感（更具体的在前），命中即返回第一条
export const PRIORITY_RULES: readonly PriorityRule[] = [
  {
    id: 'elevator_trapped',
    priority: 'urgent',
    keywords: ['电梯困人', '困人'],
    scope: 'both',
    note: '电梯困人涉及人身安全，历史非常紧急显著（81/1826）',
  },
  {
    id: 'medical_gas',
    priority: 'urgent',
    keywords: ['医用气体', '氧气', '送氧', '负压', '设备带'],
    scope: 'both',
    note: '医用气体临床风险高，历史紧急 141+5 行',
  },
  {
    id: 'power_trip',
    priority: 'urgent',
    keywords: ['跳闸', '断电', '停电'],
    scope: 'both',
    note: '跳闸断电历史紧急+特急占比 21.6%（787/3652）',
  },
  {
    id: 'water_leak',
    priority: 'urgent',
    keywords: ['漏水'],
    scope: 'both',
    note: '漏水紧急率 6.8%（191/2804），"空调漏水"历史上同样命中',
  },
];

// 不参与预填的类目关键词（陪检/运送业务线，历史紧急口径不同，绝不混入本规则表）
// 匹配范围仅限类目名（catalogName），不匹配描述——避免描述里"CT室空调漏水"这类被误排除
export const EXCLUDED_CATEGORY_KEYWORDS: readonly string[] = [
  '陪检', '转科', '护送', '运送', '转运', 'CT', 'X线', 'X光',
];

// 全部类目的缺省优先级（历史 97.9% 为一般，不激进升档）
export const DEFAULT_PRIORITY: TicketPriority = 'normal';

/** 类目名是否命中排除清单（陪检/运送业务线不参与预填；大小写不敏感，纯函数可单测）。 */
export function isExcludedCategory(catalogName?: string | null): boolean {
  if (!catalogName) return false;
  const lower = catalogName.toLowerCase();
  return EXCLUDED_CATEGORY_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

export interface PriorityRuleHit {
  ruleId: string;
  matchedKeyword: string;
  priority: 'urgent';
}

/**
 * 规则矩阵匹配：描述 + 类目名双通道，命中排除类目则整体不参与。
 * 返回第一条命中的规则；无命中返回 null（纯函数，零 DB 依赖）。
 */
export function matchPriorityRule(
  description: string,
  catalogName?: string | null,
): PriorityRuleHit | null {
  const desc = (description || '').trim();
  const cat = (catalogName || '').trim();
  if (isExcludedCategory(cat)) return null;
  for (const rule of PRIORITY_RULES) {
    for (const kw of rule.keywords) {
      if (desc.includes(kw) || (cat && cat.includes(kw))) {
        return { ruleId: rule.id, matchedKeyword: kw, priority: rule.priority };
      }
    }
  }
  return null;
}

export interface PrefillPriorityInput {
  /** 用户显式选择的优先级（报告端点选），完全尊重、最高优先 */
  userPriority?: TicketPriority | null;
  /** LLM 推断的优先级（可能为任意字符串，非枚举值不采纳） */
  llmPriority?: string | null;
  /** 报修描述原文 */
  description: string;
  /** 已解析的类目名（可为空；空则只匹配描述） */
  catalogName?: string | null;
  /** 兜底优先级：调用方用 legacy inferPriority(desc, catalogName) 的结果传入 */
  fallbackPriority?: TicketPriority | null;
}

export interface PrefillPriorityResult {
  priority: TicketPriority;
  source: PrioritySource;
  /** source='rule' 时命中规则 ID（留痕/审计用） */
  ruleId?: string;
  /** source='rule' 时命中关键词（留痕/审计用） */
  matchedKeyword?: string;
}

/**
 * 优先级预填决策链（单一事实来源，纯函数可单测）：
 *   1. user      —— 用户显式传了 priority，完全尊重（预填永不覆盖用户意图）
 *   2. rule      —— 规则矩阵命中（历史数据背书的 urgent 升档），优先于 LLM
 *   3. llm       —— LLM 推断值（必须是合法枚举才采纳）
 *   4. fallback  —— 调用方传入的 legacy inferPriority 结果（含旧关键词推断）；
 *                   非 normal（旧关键词命中 urgent/low）记 source='rule'，normal 记 'default'
 *   5. default   —— 全部未命中 → 'normal'（历史 97.9% 为一般）
 */
export function resolvePrefillPriority(opts: PrefillPriorityInput): PrefillPriorityResult {
  const { userPriority, llmPriority, description, catalogName, fallbackPriority } = opts;
  if (userPriority) return { priority: userPriority, source: 'user' };
  const hit = matchPriorityRule(description, catalogName);
  if (hit) return { priority: hit.priority, source: 'rule', ruleId: hit.ruleId, matchedKeyword: hit.matchedKeyword };
  if (llmPriority === 'urgent' || llmPriority === 'normal' || llmPriority === 'low') {
    return { priority: llmPriority, source: 'llm' };
  }
  if (fallbackPriority) {
    return {
      priority: fallbackPriority,
      source: fallbackPriority === 'normal' ? 'default' : 'rule',
    };
  }
  return { priority: DEFAULT_PRIORITY, source: 'default' };
}
