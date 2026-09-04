// 管理对话 agent（注册制批次一 卡3 · P0-4）
// ───────────────────────────────────────────────────────────────────────────
// 与 C 端 conversationAgent（R36）的关系：复用其 JSON 动作协议与诚实降级基建思路，
// 但系统提示词/工具白名单/能力边界完全独立：
//   - 工具白名单只有 parse_intent：把管理员自然语言解析为「建议卡」，不查库、不落库、不写任何数据。
//   - 安全铁律：管理操作绝不走 /public 匿名通道（路由层 adminAiChat.ts 挂 authMiddleware 之后，
//     requireConfigRole 仅 admin/operator）；agent 永不直写库——落库由前端拿确认卡调既有 API
//     （POST /basic-data/location|reporter、POST /workers/with-account），复用其权限链。
//   - 诚实降级：LLM 未配置/未授权时由路由层经 conversationAvailable 统一 503（不假装对话）。
// ───────────────────────────────────────────────────────────────────────────
import { chatCompletion, type ChatMsg } from './llm.js';

export const ADMIN_TOOL_NAMES = ['parse_intent'] as const;

export interface AdminAgentAction {
  action: 'reply' | 'tool';
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

// ---------- 纯函数：动作解析（可单测，风格对齐 conversationAgent.parseAgentAction） ----------
export function parseAdminAction(raw: string): AdminAgentAction | null {
  try {
    const obj = JSON.parse(raw) as AdminAgentAction;
    if (obj?.action === 'reply' && typeof obj.content === 'string') return { action: 'reply', content: obj.content };
    if (obj?.action === 'tool' && typeof obj.tool === 'string' && (ADMIN_TOOL_NAMES as readonly string[]).includes(obj.tool)) {
      return { action: 'tool', tool: obj.tool, args: (obj.args ?? {}) as Record<string, unknown> };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- 系统提示词 ----------
export function buildAdminSystemPrompt(): string {
  return [
    '你是优服家管理后台的 AI 管家，帮助管理员把自然语言转成结构化的「创建建议卡」。你只解析意图，绝不直接创建任何数据。',
    '可用工具（以 JSON 输出调用）：',
    '1. parse_intent {"type":"dict_entry","dict_type":"location|reporter","payload":{...}} —— 解析为字典建议卡：',
    '   location（位置字典）payload 字段：code(编号)、name(名称)、category(类别，设备/房间/工位)、default_reporter_name(默认报修人姓名，仅供参考)；',
    '   reporter（报修人字典）payload 字段：code(编号)、name(姓名)、phone(手机号)、role(角色说明)。',
    '2. parse_intent {"type":"worker_onboarding","payload":{...}} —— 解析为员工入驻建议卡：',
    '   payload 字段：username(登录用户名)、display_name(姓名)、phone(手机号)、skill_tags(技能标签数组)。',
    '规则：',
    '- 用户意图明确（新增位置/报修人/开通员工）时输出 {"action":"tool","tool":"parse_intent",...}，payload 只放用户明确说出的字段，绝不编造；',
    '- 用户没说清对象类型或关键信息不足以成卡时，输出 {"action":"reply","content":"诚实的追问"}；',
    '- 手机号必须是 1 开头的 11 位数字，否则视为未提供；',
    '- 只输出 JSON，不要输出 JSON 以外的任何文字。',
  ].join('\n');
}

// ---------- 建议卡构造（服务端规范化，不信任模型形状） ----------
export interface DictEntryCard {
  type: 'dict_entry';
  dict_type: 'location' | 'reporter';
  payload: Record<string, unknown>;
  missing_fields: string[];
}

export interface WorkerOnboardingCard {
  type: 'worker_onboarding';
  payload: Record<string, unknown>;
  missing_fields: string[];
}

export type ConfirmCard = DictEntryCard | WorkerOnboardingCard;

const DICT_ALLOWED_KEYS = ['code', 'name', 'category', 'phone', 'role', 'default_reporter_name'] as const;
const WORKER_ALLOWED_KEYS = ['username', 'display_name', 'phone', 'skill_tags'] as const;

function sanitizeStr(v: unknown, max = 100): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s === '' ? undefined : s.slice(0, max);
}

function isPhone(v: unknown): boolean {
  return typeof v === 'string' && /^1\d{10}$/.test(v.trim());
}

/** 从 parse_intent args 构造规范化建议卡；意图/形状不合法返回 null（由调用方诚实追问）。 */
export function buildConfirmCard(args: Record<string, unknown>): ConfirmCard | null {
  const type = sanitizeStr(args.type, 40);
  const rawPayload = (args.payload && typeof args.payload === 'object' ? args.payload : {}) as Record<string, unknown>;

  if (type === 'dict_entry') {
    const dictType = sanitizeStr(args.dict_type, 20);
    if (dictType !== 'location' && dictType !== 'reporter') return null;
    const payload: Record<string, unknown> = {};
    for (const k of DICT_ALLOWED_KEYS) {
      const v = rawPayload[k];
      if (k === 'phone') {
        if (isPhone(v)) payload.phone = String(v).trim();
        continue;
      }
      const s = sanitizeStr(v, k === 'role' ? 100 : 60);
      if (s !== undefined) payload[k] = s;
    }
    // 必填字段缺失提示（前端补全后才能提交）
    const required = dictType === 'location' ? ['code', 'name'] : ['code', 'name', 'phone'];
    const missingFields = required.filter((f) => payload[f] === undefined);
    return { type: 'dict_entry', dict_type: dictType, payload, missing_fields: missingFields };
  }

  if (type === 'worker_onboarding') {
    const payload: Record<string, unknown> = {};
    for (const k of WORKER_ALLOWED_KEYS) {
      const v = rawPayload[k];
      if (k === 'phone') {
        if (isPhone(v)) payload.phone = String(v).trim();
        continue;
      }
      if (k === 'skill_tags') {
        if (Array.isArray(v)) {
          const tags = v.map((t) => sanitizeStr(t, 30)).filter((t): t is string => !!t).slice(0, 10);
          if (tags.length) payload.skill_tags = tags;
        }
        continue;
      }
      const s = sanitizeStr(v, k === 'username' ? 40 : 60);
      if (s !== undefined) payload[k] = s;
    }
    const missingFields: string[] = [];
    if (payload.display_name === undefined) missingFields.push('display_name');
    // username 缺失 → 自动按时间戳后6位生成建议值（管理员可在卡片中改）
    if (payload.username === undefined) {
      payload.username = `w${String(Date.now()).slice(-6)}`;
    }
    return { type: 'worker_onboarding', payload, missing_fields: missingFields };
  }

  return null;
}

// ---------- agent 主流程（单次 LLM 调用，无工具循环，无任何写库） ----------
export interface AdminTurnResult {
  reply: string;
  confirm_card?: ConfirmCard;
}

export async function runAdminTurn(tenantId: string, message: string): Promise<AdminTurnResult> {
  const messages: ChatMsg[] = [
    { role: 'system', content: buildAdminSystemPrompt() },
    { role: 'user', content: message.slice(0, 1000) },
  ];
  const result = await chatCompletion({
    messages,
    task: 'admin_ai_chat',
    tenantId,
    response_format: { type: 'json_object' },
    max_tokens: 500,
  });
  const action = parseAdminAction(result.content);
  if (!action) {
    // 模型输出不合规 → 诚实固定话术（不编造卡片）
    return { reply: '抱歉，我暂时没理解您的意思，您可以换个说法，例如「新增位置 3F-A01 三楼会议室」或「开通员工张三，手机号 13800001234」。' };
  }
  if (action.action === 'reply') {
    return { reply: action.content ?? '请补充更多信息。' };
  }
  const card = buildConfirmCard(action.args ?? {});
  if (!card) {
    return { reply: '这个意图我还拿不准：请说明是「新增位置」「新增报修人」还是「开通员工」，并给出名称/手机号等关键信息。' };
  }
  const reply =
    card.type === 'dict_entry'
      ? `已为您生成${card.dict_type === 'location' ? '位置字典' : '报修人字典'}建议卡，请确认或补全${card.missing_fields.length ? '标红字段（' + card.missing_fields.join('、') + '）' : '字段'}后提交。`
      : '已为您生成员工入驻建议卡，请确认字段后提交，开通成功将展示一次性登录密码。';
  return { reply, confirm_card: card };
}
