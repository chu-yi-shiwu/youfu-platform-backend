// 管理对话 agent（注册制批次一 卡3 · P0-4；智能体批次一 2026-09-07 扩只读查询）
// ───────────────────────────────────────────────────────────────────────────
// 与 C 端 conversationAgent（R36）的关系：复用其 JSON 动作协议与诚实降级基建思路，
// 但系统提示词/工具白名单/能力边界完全独立：
//   - 工具白名单：parse_intent（建议卡，不查库不落库）+ query_tickets / get_stats（只读查询，
//     由路由层注入 makeAdminToolExecutor 执行——本模块保持无 DB 依赖，可纯单测）。
//   - 角色分层：admin/operator 全工具；reviewer/service_desk 仅只读查询（toolsForRole，
//     执行层二次拦截，不靠提示词自觉）；worker 不开放（有移动端自有通道）。
//   - 安全铁律：管理操作绝不走 /public 匿名通道（路由层 adminAiChat.ts 挂 authMiddleware 之后）；
//     agent 永不直写库——落库由前端拿确认卡调既有 API，复用其权限链。
//   - 诚实降级：LLM 未配置/未授权时由路由层经 conversationAvailable 统一 503（不假装对话）。
// ───────────────────────────────────────────────────────────────────────────
import { chatCompletion, type ChatMsg } from './llm.js';
import { isConfigRole } from '../middleware/role.js';

export const ADMIN_TOOL_NAMES = ['parse_intent', 'query_tickets', 'get_stats'] as const;
export const READONLY_TOOL_NAMES = ['query_tickets', 'get_stats'] as const;

/** 按角色下发工具白名单：配置类角色全量，其余（reviewer/service_desk）仅只读查询。
 *  role 缺省 → 全量（向后兼容：路由层已先行 403 白名单，此处仅二层收窄，不承担一层门禁）。 */
export function toolsForRole(role: string | undefined): readonly string[] {
  return !role || isConfigRole(role) ? ADMIN_TOOL_NAMES : READONLY_TOOL_NAMES;
}

export interface AdminAgentAction {
  action: 'reply' | 'tool';
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

// ---------- 纯函数：动作解析（可单测，风格对齐 conversationAgent.parseAgentAction） ----------
export function parseAdminAction(raw: string): AdminAgentAction | null {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj?.action === 'reply' && typeof obj.content === 'string') return { action: 'reply', content: obj.content };
  if (obj?.action === 'tool' && typeof obj.tool === 'string' && (ADMIN_TOOL_NAMES as readonly string[]).includes(obj.tool)) {
    // 形状归一（不信任模型形状）：模型可能把参数平铺在顶层（live 诊断 0907 实锤：
    // {"action":"tool","tool":"parse_intent","type":...,"payload":{...}}），或包一层 payload。
    // 优先取 args；无 args 时取顶层剩余键；仅剩 payload 一键时解包。
    let args: Record<string, unknown>;
    if (obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)) {
      args = obj.args as Record<string, unknown>;
    } else {
      const { action: _a, tool: _t, args: _x, ...rest } = obj;
      args = Object.keys(rest).length ? (rest as Record<string, unknown>) : {};
    }
    if (Object.keys(args).length === 1 && args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)) {
      args = args.payload as Record<string, unknown>;
    }
    return { action: 'tool', tool: obj.tool, args };
  }
  return null;
}

// ---------- 系统提示词（按角色白名单动态生成） ----------
// P4 失稳迭代（2026-09-08）：live 探针实锤模型低频不调工具直接回话，根因两层——
//   ①只读角色工具编号写死 3/4 起跳（清单断裂）；②输出契约只有末尾一句、零示例。
// 修复：动态编号 + 显式输出协议段 + 判断流程①②③ + 按角色 few-shot 示例 + 硬规则强化。
export function buildAdminSystemPrompt(allowedTools: readonly string[] = ADMIN_TOOL_NAMES): string {
  const canCreate = allowedTools.includes('parse_intent');
  const lines: string[] = [
    '你是优服家管理后台的 AI 管家。你绝不直接创建或修改任何数据：创建类操作只输出「建议卡」JSON（由用户确认后提交），查询类操作只调用只读工具。你的每一条输出都必须是一个 JSON 对象，以 { 开头、以 } 结尾。',
    '可用工具（必须以 JSON 输出调用）：',
  ];
  let n = 0;
  if (canCreate) {
    lines.push(
      `${++n}. parse_intent {"type":"dict_entry","dict_type":"location|reporter","payload":{...}} —— 解析为字典建议卡：`,
      '   location（位置字典）payload 字段：code(编号)、name(名称)、category(类别，设备/房间/工位)、default_reporter_name(默认报修人姓名，仅供参考)；',
      '   reporter（报修人字典）payload 字段：code(编号)、name(姓名)、phone(手机号)、role(角色说明)。',
      `${++n}. parse_intent {"type":"worker_onboarding","payload":{...}} —— 解析为员工入驻建议卡：`,
      '   payload 字段：username(登录用户名)、display_name(姓名)、phone(手机号)、skill_tags(技能标签数组)。',
    );
  }
  if (allowedTools.includes('query_tickets')) {
    lines.push(
      `${++n}. query_tickets {"status":"...","priority":"urgent|normal|low","department":"...","service_desk":"...","source":"...","today_only":true,"limit":5} —— 只读查询工单：`,
      '   各参数只放用户明确说出的条件，不用的字段省略；status 可逗号分隔多个；limit 建议 5，最大 10。',
    );
  }
  if (allowedTools.includes('get_stats')) {
    lines.push(
      `${++n}. get_stats {} —— 今日工单概览（今日新增按状态分布 + 当前未完成总数）。用户问「今天/现在整体情况」时用这个。`,
    );
  }
  lines.push(
    '输出协议（唯一合法输出，二选一）：',
    '{"action":"tool","tool":"<工具名>","args":{...}}',
    '{"action":"reply","content":"<给用户的文字>"}',
    '判断流程（每条消息按序执行）：',
    '① 用户的问题能否由上面的工具回答？能 → 必须输出工具调用 JSON；涉及工单数量/状态/明细的问题，禁止不调用工具就用文字回答，禁止凭空编造数字；',
    '② 用户意图明确但关键信息不足以成卡/成查询 → 输出 reply JSON 诚实追问，只问缺的那一项；',
  );
  if (canCreate) {
    lines.push('③ 用户要求创建数据时输出 parse_intent 工具调用，args 只放用户明确说出的字段，绝不编造；');
  } else {
    lines.push('③ 你没有创建类工具：用户要求新增/创建任何数据时，输出 reply JSON 诚实告知该操作仅管理员和操作员可用，并建议其改问工单情况；');
  }
  lines.push('示例：');
  if (canCreate) {
    lines.push(
      '用户：新增位置 3F-A01 三楼会议室 → {"action":"tool","tool":"parse_intent","args":{"type":"dict_entry","dict_type":"location","payload":{"code":"3F-A01","name":"三楼会议室","category":"房间"}}}',
      '用户：开通员工张三，手机号 13800001234 → {"action":"tool","tool":"parse_intent","args":{"type":"worker_onboarding","payload":{"display_name":"张三","phone":"13800001234"}}}',
    );
  }
  if (allowedTools.includes('query_tickets')) {
    lines.push('用户：查一下处理中的单 → {"action":"tool","tool":"query_tickets","args":{"status":"assigned,processing","limit":5}}');
  }
  if (allowedTools.includes('get_stats')) {
    lines.push('用户：今天整体情况怎么样 → {"action":"tool","tool":"get_stats","args":{}}');
  }
  lines.push(
    '用户：帮我把张三加进去 → {"action":"reply","content":"您想新增报修人「张三」还是开通员工账号？请确认对象类型。"}',
    '硬规则：手机号必须是 1 开头的 11 位数字，否则视为未提供、不得写进 args；只输出 JSON，不要输出 JSON 以外的任何文字。',
  );
  return lines.join('\n');
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

// ---------- 只读查询参数净化（智能体批次一：不信任模型形状，白名单+钳位） ----------
export interface TicketQueryArgs {
  status?: string;
  priority?: string;
  department?: string;
  service_desk?: string;
  source?: string;
  today_only?: boolean;
  limit: number;
}

const TICKET_PRIORITY_WHITELIST = ['urgent', 'normal', 'low'];
const STATUS_TOKEN_RE = /^[a-z_]{2,40}$/;

/** 纯函数：query_tickets 参数净化；args 形状非法返回 null（由调用方诚实追问）。 */
export function sanitizeTicketQueryArgs(args: unknown): TicketQueryArgs | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  const out: TicketQueryArgs = { limit: 5 };
  if (typeof a.status === 'string') {
    const toks = a.status.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const valid = [...new Set(toks.filter((t) => STATUS_TOKEN_RE.test(t)))].slice(0, 5);
    if (valid.length) out.status = valid.join(',');
  }
  if (typeof a.priority === 'string') {
    const p = a.priority.trim().toLowerCase();
    if (TICKET_PRIORITY_WHITELIST.includes(p)) out.priority = p;
  }
  for (const k of ['department', 'service_desk', 'source'] as const) {
    const s = sanitizeStr(a[k], 60);
    if (s !== undefined) out[k] = s;
  }
  if (a.today_only === true || a.today_only === 'true' || a.today_only === 1) out.today_only = true;
  const lim = Number(a.limit);
  if (Number.isFinite(lim)) out.limit = Math.min(Math.max(1, Math.floor(lim)), 10);
  return out;
}

// ---------- 结果卡类型（只读查询产出，前端渲染+跳转；agent 不落任何库） ----------
export interface TicketResultItem {
  id: string;
  order_no?: string;
  status?: string;
  priority?: string;
  department?: string;
  assignee_name?: string | null;
  created_at?: string;
}

export interface TicketResultCard {
  type: 'ticket_result';
  total: number;
  items: TicketResultItem[];
}

export interface StatsRow {
  status: string;
  count: number;
}

export interface StatsCard {
  type: 'usage_stats';
  total_today: number;
  open_total: number;
  rows: StatsRow[];
}

export type AgentResultCard = TicketResultCard | StatsCard;

/** 只读工具执行器（由路由层注入 makeAdminToolExecutor；测试注入 mock）。null=参数不合规/查询失败。
 *  message=用户原话透传（执行器做确定性关键词兜底，治模型丢条件）。 */
export type AdminToolExecutor = (
  tool: string,
  args: Record<string, unknown>,
  message?: string,
) => Promise<{ reply: string; card?: AgentResultCard } | null>;

// ---------- 对话式新手引导（注册制批次二 · P1） ----------
// 命中"怎么开通/新手/第一步/怎么配置"类引导意图 → 纯回复固定四步文案（无卡、不调 LLM，
// 确定性短路：引导文案是平台事实，不交给模型自由发挥）。
export const ONBOARDING_INTENT_RE =
  /(怎么开通|如何开通|新手|第一步|第1步|怎么配置|如何配置|怎么开始|从哪开始|怎么上手|引导|四步)/;

export const ONBOARDING_GUIDE_TEXT = [
  '新手四步引导：',
  '① 管理员登录：用机构管理员账号登录机构后台；',
  '② 基础数据：录入位置、报修人通讯录（页面右下角 AI 助理支持对话式录入，直接告诉我即可）；',
  '③ 人员开通：人员页「一键开通」员工账号，开通成功展示一次性登录密码；',
  '④ 服务目录：录入服务价目（商品目录），建单派单即可正常流转。',
  '要录入具体对象时直接说，例如「新增位置 3F-A01 三楼会议室」或「开通员工张三，手机号 13800001234」。',
].join('\n');

/** 纯函数：是否命中新手引导意图（可单测） */
export function matchOnboardingIntent(message: string): boolean {
  return ONBOARDING_INTENT_RE.test(message);
}

// ---------- agent 主流程（单次 LLM 调用，无工具循环；写卡不落库，查询经注入执行器只读） ----------
export interface AdminTurnOptions {
  role?: string;
  contextPage?: string;
  toolExecutor?: AdminToolExecutor;
}

export interface AdminTurnResult {
  reply: string;
  confirm_card?: ConfirmCard;
  result_card?: AgentResultCard;
}

const FALLBACK_REPLY =
  '抱歉，我暂时没理解您的意思，您可以换个说法，例如「新增位置 3F-A01 三楼会议室」「开通员工张三，手机号 13800001234」或「今天有多少待处理的工单」。';

// ---------- 纠偏重试（P4 失稳迭代 2026-09-08）：模型偶发不调工具直接回话/输出自由文本 ----------
// 强查询意图信号（确定性关键词，不做短路边界——只作重试触发条件，最终仍由模型按协议输出）。
export const QUERY_INTENT_RE = /(多少|几单|几个|哪些|查一下|查查|统计|概览|概况|情况|列表|明细)/;

/** 纯函数：是否命中强查询意图（可单测） */
export function looksLikeQueryIntent(message: string): boolean {
  return QUERY_INTENT_RE.test(message);
}

const NUDGE_SYSTEM_MSG =
  '上一次输出不符合输出协议或未调用工具。重新判断：若用户问题可由可用工具回答，必须输出 {"action":"tool","tool":"<工具名>","args":{...}} 的 JSON；只有关键信息不足时才输出 reply JSON 诚实追问。只输出一个 JSON 对象，不要输出 JSON 以外的任何文字。';

/** 内部：判断是否需要一次纠偏重试。无查询工具的角色不重试（纯建卡链路失稳面不同，保持零改动）。 */
function needsNudge(action: AdminAgentAction | null, message: string, allowed: readonly string[]): boolean {
  if (!allowed.includes('query_tickets')) return false;
  if (!action) return true; // 自由文本/非法 JSON
  return action.action === 'reply' && looksLikeQueryIntent(message); // 强查询意图却回了纯文字
}

export async function runAdminTurn(tenantId: string, message: string, opts?: AdminTurnOptions): Promise<AdminTurnResult> {
  // 新手引导意图 → 确定性短路返回固定四步文案（纯回复，无卡，不消耗 LLM 调用）
  if (matchOnboardingIntent(message)) {
    return { reply: ONBOARDING_GUIDE_TEXT };
  }
  const allowed = toolsForRole(opts?.role);
  const page = opts?.contextPage ? `[用户当前页面：${opts.contextPage.slice(0, 200)}]\n` : '';
  const messages: ChatMsg[] = [
    { role: 'system', content: buildAdminSystemPrompt(allowed) },
    { role: 'user', content: page + message.slice(0, 1000) },
  ];
  const result = await chatCompletion({
    messages,
    task: 'admin_ai_chat',
    tenantId,
    response_format: { type: 'json_object' },
    max_tokens: 500,
  });
  let action = parseAdminAction(result.content);
  // 有界纠偏重试：仅一次（最多 2 次 LLM 调用）；重试失败/抛错 → 落回首轮结果走既有诚实降级
  if (needsNudge(action, message, allowed)) {
    try {
      const retry = await chatCompletion({
        messages: [...messages, { role: 'system', content: NUDGE_SYSTEM_MSG }],
        task: 'admin_ai_chat',
        tenantId,
        response_format: { type: 'json_object' },
        max_tokens: 500,
      });
      const nudged = parseAdminAction(retry.content);
      if (nudged) action = nudged;
    } catch {
      // 重试通道异常（配额/网络）：保持首轮 action 原状（null → FALLBACK，reply → 原样透传）
    }
  }
  if (!action) {
    // 模型输出不合规 → 诚实固定话术（不编造卡片）
    return { reply: FALLBACK_REPLY };
  }
  if (action.action === 'reply') {
    return { reply: action.content ?? '请补充更多信息。' };
  }
  if (typeof action.tool !== 'string') {
    return { reply: FALLBACK_REPLY };
  }
  const toolName: string = action.tool;
  if (toolName === 'parse_intent') {
    // 执行层二次拦截（不靠提示词自觉）：非配置角色请求建卡 → 诚实告知边界
    if (!allowed.includes('parse_intent')) {
      return { reply: '创建/修改类操作仅管理员和操作员可用。您也可以问我工单情况，例如「今天有多少待处理的工单」。' };
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
  // 只读查询工具：经注入执行器执行（真实数据 → 确定性话术，模型不自由发挥）
  const executor = opts?.toolExecutor;
  if (!executor) {
    return { reply: '查询功能暂时不可用，请稍后再试。' };
  }
  const out = await executor(toolName, action.args ?? {}, message);
  if (!out) {
    return { reply: '这个查询我没处理成功：请换个说法，例如「今天有多少 urgent 工单」或「查一下处理中的单」。' };
  }
  return { reply: out.reply, result_card: out.card };
}
