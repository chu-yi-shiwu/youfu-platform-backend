// 报修入口智能补全服务（DMR：最小输入 → 最全工单）
// 纯函数 + 轻量 DB 查询，供 publicReport 复用，亦可单测。
// v0.3：语义关联增强 —— 动态用租户自身分类体系做 token 匹配 + 通用故障词表 + 优先级语义推断
import type { PoolClient } from 'pg';

// 通用故障/设备词表 → 分类 hint（与租户 fault_category 名称对齐；纯本地零依赖）
// 说明：这些 hint 会与租户分类名做 ILIKE 模糊匹配，找不到则回落到分类 token 匹配
export const KEYWORD_CATEGORY_HINTS: Array<{ kw: string[]; hint: string }> = [
  // 空调/制冷
  { kw: ['空调', '制冷', '制热', '冷气', '暖气', '不制冷', '不制热', '冷风', '热风', '风口'], hint: '空调' },
  // 制冷设备（冰箱冰柜等）
  { kw: ['冰箱', '冰柜', '冷藏', '冷冻', '冷藏柜', '冷库'], hint: '制冷' },
  // 水电/疏通
  { kw: ['水', '漏', '管道', '马桶', '龙头', '排水', '堵', '渗', '漫', '溢', '下水', '水管', '阀门', '地漏'], hint: '水' },
  { kw: ['疏通', '堵塞', '卡住'], hint: '疏通' },
  // 网络/IT
  { kw: ['网', 'wifi', 'WiFi', '电脑', '网络', '信号', '断网', '上不了网', '路由器', '服务器', '卡顿', '蓝屏', '死机'], hint: '网络' },
  { kw: ['打印机', '打印', '卡纸', '硒鼓', '墨盒', '加墨'], hint: '打印' },
  // 门窗
  { kw: ['门', '锁', '窗', '玻璃', '门禁', '门把手'], hint: '门' },
  // 照明/电工
  { kw: ['灯', '照明', '插座', '电', '跳闸', '断电', '停电', '线路', '开关', '电路', '烧了'], hint: '电' },
  // 设备/电梯/医疗设备
  { kw: ['电梯', '困人', '卡梯'], hint: '电梯' },
  { kw: ['CT', 'MRI', 'X线', 'X光', 'B超', '超声', '核磁', 'DR', '影像', '设备', '机器', '仪器', '故障', '损坏', '不工作'], hint: '设备' },
  // 通用故障
  { kw: ['坏', '故障', '异常', '不能用', '不工作', '失灵', '异响', '报警', '闪烁'], hint: '维修' },
];

export function matchCategoryHint(description: string): string | undefined {
  for (const rule of KEYWORD_CATEGORY_HINTS) {
    if (rule.kw.some((k) => description.includes(k))) return rule.hint;
  }
  return undefined;
}

// 分类 token 提取：把"暖通空调类"→["暖通","空调"]；"电脑维修"→["电脑","维修"]
// 用于描述与分类名的语义关联（动态适配任意租户的分类体系）
export function categoryTokens(name: string): string[] {
  const clean = (name || '').replace(/类$|服务$|维修$|维护$|保养$|处理$/g, '');
  if (!clean || clean.length < 2) return [];
  const tokens = new Set<string>();
  // 整词
  tokens.add(clean);
  // 常见复合词拆分（2-4 字窗口）
  if (clean.length >= 4) {
    for (let i = 0; i <= clean.length - 2; i++) {
      const tok = clean.slice(i, i + 2);
      // 只取有意义的二字词（排除虚词）
      if (!/^(维修|维护|处理|管理|服务|故障|问题)$/.test(tok)) tokens.add(tok);
    }
  }
  return Array.from(tokens);
}

// 主题命名（DMR：从表述提炼，不要求用户命名；识别不清诚实标记，绝不硬造语义）
export function generateTitle(opts: {
  description?: string;
  hasAudio?: boolean;
  hasImage?: boolean;
  categoryName?: string | null;
  voiceUnclear?: boolean;
}): string {
  const { description, hasAudio, hasImage, categoryName, voiceUnclear } = opts;
  const desc = (description || '').trim();
  const prefix = categoryName ? `[${categoryName}]` : '';

  if (voiceUnclear && !desc) return prefix ? `${prefix}语音报修（未识别清晰）` : '语音报修（未识别清晰）';

  if (desc) return desc.length > 24 ? desc.slice(0, 24) + '…' : desc;

  const media = hasAudio && hasImage ? '（含录音与照片）' : hasAudio ? '（含录音）' : hasImage ? '（含照片）' : '';
  if (categoryName) return `${prefix}现场报修${media}`;
  return `现场报修${media}`;
}

// 故障类别推断 v0.3（语义关联）：
//   1) 描述精确含分类名（如"电梯故障"描述含"电梯"）
//   2) 分类 token 语义匹配（动态用租户自己的分类词表，任意机构自适应）
//   3) 通用故障词表 ILIKE 兜底
export async function resolveFaultCategory(
  client: PoolClient,
  tenantId: string,
  description: string,
): Promise<{ id: string; name: string } | null> {
  const cats = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM fault_category WHERE tenant_id = $1 AND enabled = true`,
    [tenantId],
  );
  if (!cats.rowCount) return null;

  // 1) 精确包含分类名
  for (const c of cats.rows) {
    if (description.includes(c.name)) return { id: c.id, name: c.name };
  }

  // 2) 分类 token 语义匹配（动态词表，命中越多越靠前）
  const scored: Array<{ id: string; name: string; score: number }> = [];
  for (const c of cats.rows) {
    const tokens = categoryTokens(c.name);
    let score = 0;
    for (const tok of tokens) {
      if (tok.length >= 2 && description.includes(tok)) score += tok.length >= 4 ? 2 : 1;
    }
    if (score > 0) scored.push({ id: c.id, name: c.name, score });
  }
  if (scored.length) {
    scored.sort((a, b) => b.score - a.score);
    return { id: scored[0].id, name: scored[0].name };
  }

  // 3) 通用词表兜底（防止误判：先 token 语义、再词表）
  const hint = matchCategoryHint(description);
  if (hint) {
    const m = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM fault_category WHERE tenant_id = $1 AND enabled = true AND name ILIKE $2 LIMIT 1`,
      [tenantId, `%${hint}%`],
    );
    if (m.rowCount) return { id: m.rows[0].id, name: m.rows[0].name };
  }
  return null;
}

// 优先级推断 v0.3（语义）：分档 urgent/normal/low
export function inferPriority(description: string): 'low' | 'normal' | 'urgent' {
  // urgent：影响安全/生产/大面积
  const urgentKw = [
    '紧急', '漏水', '断电', '停电', '冒烟', '起火', '危险', '停水', '堵塞', '溢', '伤人', '漏电',
    '困人', '不制冷', '不制热', '无法', '不能', '不能用', '停用', '无法使用', '故障', '坏了', '不工作',
    '影响', '耽误', '紧急处理', '立即', '马上', '抢修', '大面积', '全院', '全楼',
  ];
  // low：日常/计划性
  const lowKw = ['保养', '维护', '更换配件', '计划', '预约', '例行', '咨询', '咨询下', '检查下', '看看'];
  if (urgentKw.some((k) => description.includes(k))) return 'urgent';
  if (lowKw.some((k) => description.includes(k))) return 'low';
  return 'normal';
}

// 关联资产推断 v0.3：描述命中资产名/编号/拼音 → 绑定（限制扫描面，仅当描述含资产相关词时查）
export async function resolveAsset(
  client: PoolClient,
  tenantId: string,
  description: string,
): Promise<{ id: string; name: string } | null> {
  const hint = matchCategoryHint(description);
  if (!hint) return null;
  const m = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM asset WHERE tenant_id = $1 AND (name ILIKE $2 OR pinyin ILIKE $2) LIMIT 1`,
    [tenantId, `%${hint}%`],
  );
  return m.rowCount ? { id: m.rows[0].id, name: m.rows[0].name } : null;
}
