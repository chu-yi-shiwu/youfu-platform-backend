// L3 对话管家 agent 核心（R36 · R34 设计稿 §3）
// ───────────────────────────────────────────────────────────────────────────
// 协议：chatCompletion 不带原生 tools API，用 JSON 动作协议实现工具循环——
//   模型每轮必须输出 {"action":"reply","content":"..."} 或
//   {"action":"tool","tool":"search_history|create_ticket|check_status","args":{...}}，
//   服务端执行工具 → 结果以 tool 角色落库并回灌上下文 → 最多 MAX_TOOL_ROUNDS 轮。
// 防幻觉三件套（R34 铁律）：
//   ① 工具返回真实数据才允许引用（系统提示词硬约束 + 工具结果落库可审计）；
//   ② 建议类回复必须带出处（工单号/相似度），无数据时诚实说"没有找到"；
//   ③ 建单写操作必须过 consent（缺省/false 一律拒绝，模型只能诚实转告用户）。
// 诚实降级：LLM 未配置/未授权 → 不跑 agent，路由层直接返回结构化错误（不假装对话）。
// ───────────────────────────────────────────────────────────────────────────
import { withTenantClient } from '../db/pool.js';
import { chatCompletion, llmInferCategory, embeddingConfigured, embedText, cosineSimilarity, type ChatMsg } from './llm.js';
import { getLlmEnabled, getAiFeaturesEnabled } from '../repo/tenantSettings.js';
import { createWithIdem } from '../repo/ticket.js';
import { matchCategoryHint, inferPriority, generateTitle } from './intakeEnrich.js';
import { autoDispatchAfterCreate } from '../routes/workOrder.js';
import { appendTurn, listTurns, type TurnRow } from '../repo/aiConversation.js';
import crypto from 'node:crypto';

export const MAX_TOOL_ROUNDS = 4;
export const TOOL_NAMES = ['search_history', 'create_ticket', 'check_status'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface AgentAction {
  action: 'reply' | 'tool';
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

// ---------- 纯函数：动作解析（可单测） ----------
export function parseAgentAction(raw: string): AgentAction | null {
  try {
    const obj = JSON.parse(raw) as AgentAction;
    if (obj?.action === 'reply' && typeof obj.content === 'string') return { action: 'reply', content: obj.content };
    if (obj?.action === 'tool' && typeof obj.tool === 'string' && (TOOL_NAMES as readonly string[]).includes(obj.tool)) {
      return { action: 'tool', tool: obj.tool, args: (obj.args ?? {}) as Record<string, unknown> };
    }
    return null;
  } catch {
    return null;
  }
}

export function buildSystemPrompt(tenantName: string): string {
  return [
    `你是「${tenantName}」的报修服务管家。只用对话中工具返回的真实数据回答，绝不编造工单号、状态、分类或相似案例。`,
    '可用工具（以 JSON 输出调用）：',
    '1. search_history  {"description":"报修描述"} —— 查本机构历史相似单（带工单号与相似度出处）。',
    '2. check_status    {"order_no":"工单号","phone_last4":"手机后4位可选"} —— 查报修进度。',
    '3. create_ticket   {"description":"报修描述","contact":"手机号可选","location":"位置可选"} —— 代报修人建单（仅在用户明确同意后调用）。',
    '回复规则：需要调用工具时输出 {"action":"tool","tool":"工具名","args":{...}}；',
    '回答用户时输出 {"action":"reply","content":"给用户的话"}，不要输出 JSON 以外的任何文字。',
    '引用相似案例必须带工单号；没有查到就诚实说没有找到，不猜测。',
  ].join('\n');
}

// ---------- 工具实现 ----------
export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

// search_history：K2 语义检索本机构历史单（复用 aiPreview /similar 的检索模式）
export async function toolSearchHistory(tenantId: string, description: string): Promise<ToolResult> {
  const desc = (description || '').trim().slice(0, 200);
  if (!desc) return { ok: false, summary: '缺少描述，无法检索' };
  if (!embeddingConfigured()) return { ok: false, summary: '语义检索未启用，请直接描述问题或报修' };
  const qvec = await embedText(desc, tenantId);
  if (!qvec) return { ok: false, summary: '语义检索暂不可用，请稍后再试' };
  const rows = await withTenantClient(tenantId, (client) =>
    client.query(
      `SELECT ref_id, ref_type, category, priority, source_text, embedding
       FROM ai_case_embeddings WHERE tenant_id = $1
       ORDER BY updated_at DESC LIMIT 300`,
      [tenantId],
    ),
  );
  const items = rows.rows
    .map((row: any) => ({
      ref_id: row.ref_id as string,
      title: (row.source_text || '').slice(0, 60),
      category: row.category || '',
      score: Number(cosineSimilarity(qvec, (row.embedding as number[]) || []).toFixed(4)),
    }))
    .filter((x) => x.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  // 工单号出处：ref_id → work_orders.order_no（防幻觉：给模型真号，让它引用）
  const ids = items.map((x) => x.ref_id);
  const orderMap: Record<string, string> = {};
  if (ids.length) {
    const or = await withTenantClient(tenantId, (client) =>
      client.query(`SELECT id, order_no FROM work_orders WHERE tenant_id = $1 AND id = ANY($2)`, [tenantId, ids]),
    );
    or.rows.forEach((r: any) => { orderMap[r.id] = r.order_no; });
  }
  const data = items.map((x) => ({ order_no: orderMap[x.ref_id] ?? null, title: x.title, category: x.category, similarity: x.score }));
  if (!data.length) return { ok: true, summary: '本机构历史单中没有找到相似案例（诚实告知用户，不要编造）', data };
  return { ok: true, summary: '以下为检索到的相似历史单（引用必须带工单号）', data };
}

// check_status：单号 + 可选手机尾号（与 /public/repair-status 同口径，防他查）
export async function toolCheckStatus(tenantId: string, orderNo: string, phoneLast4?: string): Promise<ToolResult> {
  const no = (orderNo || '').trim();
  if (!no) return { ok: false, summary: '缺少工单号' };
  const conds = ['tenant_id = $1', 'order_no = $2'];
  const params: unknown[] = [tenantId, no];
  if (phoneLast4) {
    if (!/^\d{4}$/.test(String(phoneLast4))) return { ok: false, summary: '手机后4位格式不正确' };
    params.push(String(phoneLast4));
    conds.push(`right(contact, 4) = $${params.length}`);
  }
  const r = await withTenantClient(tenantId, (client) =>
    client.query(
      `SELECT order_no, status, title, location, created_at, updated_at
       FROM work_orders WHERE ${conds.join(' AND ')} LIMIT 1`,
      params,
    ),
  );
  if (r.rowCount === 0) return { ok: false, summary: '未找到该报修（请核对工单号；如填了手机尾号需匹配）' };
  return { ok: true, summary: '查询成功（以下为真实进度，原样转告）', data: r.rows[0] };
}

// create_ticket：DMR 种子建单 + consent 硬拒（与 /public/mp-phone 同口径）
export async function toolCreateTicket(
  tenantId: string,
  args: { description?: string; contact?: string; location?: string },
  consent: boolean,
): Promise<ToolResult> {
  if (consent !== true) {
    return { ok: false, summary: '用户尚未同意 AI 代建工单（consent 硬拒），请先征得用户明确同意' };
  }
  const desc = (args.description || '').trim().slice(0, 500);
  if (!desc) return { ok: false, summary: '缺少报修描述，无法建单' };
  const contact = (args.contact || '').trim() || undefined;
  const location = (args.location || '').trim() || '待核实';
  const llmOn = await getLlmEnabled(tenantId);
  const llm = llmOn ? await llmInferCategory(desc, []) : null;
  const catName = llm?.category || matchCategoryHint(desc) || undefined;
  let catalogId: string | undefined;
  let catalogName: string | undefined;
  if (catName) {
    const m = await withTenantClient(tenantId, (client) =>
      client.query(
        `SELECT id, name FROM fault_category WHERE tenant_id = $1 AND enabled = true AND name = $2 LIMIT 1`,
        [tenantId, catName],
      ),
    );
    if (m.rowCount) { catalogId = m.rows[0].id; catalogName = m.rows[0].name; }
    else catalogName = catName; // 诚实：匹配不到则保留名称不绑定 id
  }
  const priority = llm?.priority || inferPriority(desc);
  const title = generateTitle({ description: desc, categoryName: catalogName });
  const viewToken = crypto.randomBytes(24).toString('hex');
  const { row } = await withTenantClient(tenantId, async (client) => {
    const created = await createWithIdem(client, {
      id: crypto.randomUUID(),
      tenantId,
      businessType: 'repair',
      catalog: catalogId,
      priority,
      location,
      title,
      description: desc,
      contact,
      source: 'ai_conversation',
      ext: {
        source_channel: 'ai_conversation',
        public_view_token: viewToken,
        filled: { category: catalogName ?? null, priority },
        reporter_phone: contact ?? null, // 与 /public 通道同口径：手机号身份锚点存原值（换设备凭单号+手机号找回）
      },
    });
    // 建单即派单 + SLA 起算（与公开报修同链路，避免卡 draft 无通知断链）
    let dispatch: Awaited<ReturnType<typeof autoDispatchAfterCreate>> | null = null;
    try {
      dispatch = await autoDispatchAfterCreate(client, tenantId, created.row, { business_type: 'repair', priority, catalog: catalogId });
    } catch (e) {
      console.warn('[ai-chat] autoDispatch failed (ticket kept):', (e as Error).message);
    }
    return { row: created.row, dispatch };
  });
  return {
    ok: true,
    summary: '建单成功（以下为真实单号与标题，原样转告；视图令牌可用于「我的报修」）',
    data: { order_no: row.order_no, title: row.title, status: row.status, view_token: viewToken },
  };
}

// ---------- agent 主循环 ----------
export interface RunTurnOpts {
  tenantId: string;
  tenantName: string;
  conversationId: string;
  userText: string;
  consent: boolean;
}

export interface RunTurnResult {
  assistantText: string;
  toolTrace: { tool: string; args: Record<string, unknown>; summary: string; ok: boolean }[];
}

export async function runAgentTurn(opts: RunTurnOpts): Promise<RunTurnResult> {
  const { tenantId, tenantName, conversationId, userText, consent } = opts;
  const toolTrace: RunTurnResult['toolTrace'] = [];

  return withTenantClient(tenantId, async (client) => {
    // 1) 用户话轮落库
    await appendTurn(client, tenantId, conversationId, { role: 'user', content: userText.slice(0, 1000) });
    // 2) 取历史（含 tool 结果）构造上下文
    const history: TurnRow[] = await listTurns(client, tenantId, conversationId);
    const messages: ChatMsg[] = [
      { role: 'system', content: buildSystemPrompt(tenantName) },
      ...history.slice(-20).map((t) => ({
        role: t.role === 'tool' ? ('user' as const) : (t.role as 'user' | 'assistant'),
        content: t.role === 'tool'
          ? `[工具 ${t.tool_name} 返回] ${t.content}`
          : t.content,
      })),
    ];

    // 3) 工具循环（最多 MAX_TOOL_ROUNDS）
    for (let i = 0; i <= MAX_TOOL_ROUNDS; i++) {
      const result = await chatCompletion({
        messages,
        task: 'ai_conversation',
        tenantId,
        response_format: { type: 'json_object' },
        max_tokens: 500,
      });
      const action = parseAgentAction(result.content);
      if (!action) {
        // 模型输出不合规 → 诚实降级为固定话术（不编造）
        const fallback = '抱歉，我暂时没理解您的意思，您可以换个说法，或直接告诉我工单号。';
        await appendTurn(client, tenantId, conversationId, { role: 'assistant', content: fallback });
        return { assistantText: fallback, toolTrace };
      }
      if (action.action === 'reply') {
        await appendTurn(client, tenantId, conversationId, { role: 'assistant', content: action.content! });
        return { assistantText: action.content!, toolTrace };
      }
      // action === 'tool'
      const tool = action.tool as ToolName;
      let tr: ToolResult;
      if (tool === 'search_history') {
        tr = await toolSearchHistory(tenantId, String(action.args?.description ?? ''));
      } else if (tool === 'check_status') {
        tr = await toolCheckStatus(tenantId, String(action.args?.order_no ?? ''), action.args?.phone_last4 ? String(action.args.phone_last4) : undefined);
      } else {
        tr = await toolCreateTicket(
          tenantId,
          {
            description: action.args?.description ? String(action.args.description) : undefined,
            contact: action.args?.contact ? String(action.args.contact) : undefined,
            location: action.args?.location ? String(action.args.location) : undefined,
          },
          consent,
        );
      }
      toolTrace.push({ tool, args: action.args ?? {}, summary: tr.summary, ok: tr.ok });
      // 工具结果落库（审计 + 回灌上下文）
      await appendTurn(client, tenantId, conversationId, {
        role: 'tool',
        content: JSON.stringify({ ok: tr.ok, summary: tr.summary, data: tr.data ?? null }),
        toolName: tool,
        toolCalls: action.args ?? {},
      });
      messages.push({ role: 'user', content: `[工具 ${tool} 返回] ${JSON.stringify({ ok: tr.ok, summary: tr.summary, data: tr.data ?? null })}` });
    }
    // 超轮次 → 诚实兜底
    const fallback = '这个问题我需要转人工处理，请拨打服务热线或稍后再试。';
    await appendTurn(client, tenantId, conversationId, { role: 'assistant', content: fallback });
    return { assistantText: fallback, toolTrace };
  });
}

// I4 灰度开关统一出口：AI 未开/LLM 未配 → 路由层诚实 403/503，不假装对话
export async function conversationAvailable(tenantId: string): Promise<{ ok: boolean; reason?: string }> {
  const aiOn = await getAiFeaturesEnabled(tenantId);
  if (!aiOn) return { ok: false, reason: 'AI_FEATURES_DISABLED' };
  const llmOn = await getLlmEnabled(tenantId);
  if (!llmOn) return { ok: false, reason: 'LLM_NOT_AUTHORIZED' };
  return { ok: true };
}
