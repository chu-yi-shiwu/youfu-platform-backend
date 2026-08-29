// services/llm.ts —— K1 多模型 LLM 网关（统一接入 + 调用审计 + 成本统计）
// 兼容旧 API：llmConfigured / llmInferCategory / llmGenConfig / maskPhone / normalizeLocation / PHONE_MASK_RE
// 安全/合规（继承自旧实现）：
//   - 只传脱敏描述 + 分类名清单（绝不传手机号/姓名/位置等个人信息）
//   - 未配置 key / 超时 / 解析失败 → 返回 null，调用方回退 A 档规则引擎
//   - 每次网关调用落 llm_call_log（provider/model/task/tokens/cost/latency），支撑「调用可审计 + 成本统计」
//   - Node16 无全局 fetch → 仍用 https 模块
import pool from '../db/pool.js';
import { httpsPostJson } from './httpJson.js';

const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 8000);

// ---------- 模型注册表（多模型可切换） ----------
// 所有 provider 均 OpenAI Chat Completions 兼容协议；国内合规 provider（智谱/通义/字节）亦兼容。
interface ModelDef {
  id: string;
  provider: string;
  baseUrl: string;
  apiKeyEnv: string;
  pricePer1kIn: number; // USD / 1K input tokens
  pricePer1kOut: number; // USD / 1K output tokens
}
const MODELS: Record<string, ModelDef> = {
  'deepseek-chat': {
    id: 'deepseek-chat', provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/chat/completions',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    pricePer1kIn: 0.00027, pricePer1kOut: 0.0011,
  },
  'openai-gpt-4o-mini': {
    id: 'openai-gpt-4o-mini', provider: 'openai',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_API_KEY',
    pricePer1kIn: 0.00015, pricePer1kOut: 0.0006,
  },
  'zhipu-glm-4-flash': {
    id: 'zhipu-glm-4-flash', provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKeyEnv: 'ZHIPU_API_KEY',
    pricePer1kIn: 0.000034, pricePer1kOut: 0.000034,
  },
};
const DEFAULT_MODEL = process.env.LLM_DEFAULT_MODEL || 'deepseek-chat';

function getModel(id?: string): ModelDef | null {
  const key = id || DEFAULT_MODEL;
  const m = MODELS[key];
  if (!m) return null;
  if (!process.env[m.apiKeyEnv]) return null; // 未配置 key → 视为不可用
  return m;
}

export function llmConfigured(): boolean {
  return getModel() !== null;
}
export function listConfiguredModels(): string[] {
  return Object.values(MODELS).filter((m) => process.env[m.apiKeyEnv]).map((m) => m.id);
}
// 多模型切换：按任务选模型（默认走 DEFAULT_MODEL；可通过 env LLM_MODEL_<TASK> 覆盖）
export function selectModel(task: string): string {
  const envKey = `LLM_MODEL_${(task || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return process.env[envKey] || DEFAULT_MODEL;
}

// ---------- 审计（best-effort，绝不阻断主流程） ----------
async function logCall(p: {
  tenantId?: string; provider: string; model: string; task: string;
  promptTokens: number; completionTokens: number; costUsd: number;
  latencyMs: number; ok: boolean; error?: string;
}): Promise<void> {
  try {
    await pool.query(
      'SELECT log_llm_call($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        p.tenantId ?? 'system', p.provider, p.model, p.task,
        p.promptTokens, p.completionTokens, p.costUsd,
        p.latencyMs, p.ok, p.error ?? null,
      ],
    );
  } catch (e) {
    console.warn('[llm] audit log skipped:', (e as Error).message);
  }
}

function estimateTokens(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.length / 3);
}

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ChatResult { content: string; promptTokens: number; completionTokens: number; model: string; provider: string; }

// 网关核心：统一模型接入 + 审计 + 成本
export async function chatCompletion(opts: {
  model?: string; messages: ChatMsg[]; temperature?: number; max_tokens?: number;
  response_format?: { type: 'json_object' }; task?: string; tenantId?: string;
}): Promise<ChatResult> {
  const model = getModel(opts.model);
  if (!model) throw new Error(`llm not configured for model ${opts.model || DEFAULT_MODEL}`);
  const t0 = Date.now();
  let ok = true, errMsg: string | undefined, promptTokens = 0, completionTokens = 0, content = '';
  try {
    const data = await httpsPostJson(
      model.baseUrl,
      {
        model: model.id,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.max_tokens ?? 200,
        ...(opts.response_format ? { response_format: opts.response_format } : {}),
      },
      LLM_TIMEOUT_MS,
      { 'Authorization': `Bearer ${process.env[model.apiKeyEnv]}` },
    );
    content = data?.choices?.[0]?.message?.content || '';
    const usage = data?.usage;
    promptTokens = Number(usage?.prompt_tokens ?? estimateTokens(opts.messages.map((m) => m.content).join(' ')));
    completionTokens = Number(usage?.completion_tokens ?? estimateTokens(content));
    if (!content) throw new Error('empty llm content');
  } catch (e) {
    ok = false; errMsg = (e as Error).message;
    throw e;
  } finally {
    const latency = Date.now() - t0;
    const cost = (promptTokens / 1000) * model.pricePer1kIn + (completionTokens / 1000) * model.pricePer1kOut;
    await logCall({
      tenantId: opts.tenantId, provider: model.provider, model: model.id, task: opts.task || 'unknown',
      promptTokens, completionTokens, costUsd: cost, latencyMs: latency, ok, error: errMsg,
    });
  }
  return { content, promptTokens, completionTokens, model: model.id, provider: model.provider };
}

// ---------- 隐私硬护栏（与旧实现一致） ----------
export const PHONE_MASK_RE = /1[3-9]\d{9}/g;
export function maskPhone(desc: string): string {
  return desc.replace(PHONE_MASK_RE, '***');
}
const LOC_NEGATION_RE = /^(null|none|unknown|未提及|未提供|未说|没说|未提到|没提到|未知|无|无位置|没有位置|没位置|暂无|暂无位置|不清楚|不确定|用户未说|用户没说|用户未提到|用户没提到|没提|不明)$/i;
export function normalizeLocation(raw: string | null | undefined): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  if (LOC_NEGATION_RE.test(s)) return null;
  return s.slice(0, 128);
}

// ---------- 业务封装（兼容旧调用方） ----------
export interface LlmResult {
  category: string | null;
  priority: 'urgent' | 'normal' | 'low' | null;
  asset: string | null;
  location: string | null;
  reason?: string;
}

// 语义推断：描述 + 分类清单 → {category, priority, asset, location}；任何异常返回 null（调用方回退规则引擎）
export async function llmInferCategory(description: string, categoryNames: string[], tenantId?: string): Promise<LlmResult | null> {
  if (!llmConfigured()) return null;
  const raw = (description || '').trim();
  const desc = maskPhone(raw).slice(0, 500); // 先脱敏再截断：上限 500 与 infer/repair-report schema 对齐
  if (!desc) return null;
  const cats = categoryNames.filter(Boolean).slice(0, 60).join('、');

  const system = '你是物业/医院报修工单的分类助手。根据用户描述，从给定的分类列表中选择最合适的分类，并判断优先级和关联资产。只输出 JSON，不要解释。';
  const user = `可用分类：${cats}\n用户描述：${desc}\n请输出 JSON：{"category":"分类名或null","priority":"urgent|normal|low","asset":"关联设备名或null","location":"描述中提到的位置(如楼层/房间/区域)或null"}。注意：分类必须从可用分类列表中选，选不出就 null，不要编造；location 只抽取描述里明确提到的位置，没提就 null。`;

  try {
    const r = await chatCompletion({
      task: 'infer-category', tenantId, model: selectModel('infer'),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.1, max_tokens: 200, response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(r.content);
    // 过滤字符串 "null"/"none"（DeepSeek 有时输出字面 null 字符串）
    const rawCat = typeof parsed.category === 'string' ? parsed.category.trim() : '';
    const category = rawCat && !/^(null|none|unknown)$/i.test(rawCat) ? rawCat : null;
    const priority = ['urgent', 'normal', 'low'].includes(parsed.priority) ? parsed.priority : null;
    const assetRaw = typeof parsed.asset === 'string' ? parsed.asset.trim() : '';
    const asset = assetRaw && !/^(null|none|unknown)$/i.test(assetRaw) ? assetRaw : null;
    const location = normalizeLocation(parsed.location);
    // 可观测性（诚实证据链）：LLM 成功推断时留痕，便于核对"走了 LLM 而非规则引擎"
    console.log(`[llm] ok category=${category ?? '-'} priority=${priority ?? '-'} asset=${asset ?? '-'} location=${location ?? '-'}`);
    return { category, priority, asset, location };
  } catch (e) {
    console.warn('[llm] infer fail (fallback to rule):', (e as Error).message);
    return null;
  }
}

// 配置向导：业务需求 → 字段/流程配置草稿（H1）
// 返回 null = 未配置/失败（调用方诚实降级）
export async function llmGenConfig(requirement: string, tenantId?: string): Promise<{ name: string; fields: any[]; initial: string; states: string[]; transitions: any[] } | null> {
  if (!llmConfigured()) return null;
  const req = maskPhone((requirement || '').trim().slice(0, 300));
  if (!req) return null;

  const system = '你是零代码业务平台的配置助手。根据用户的一句话需求，生成业务配置草稿。只输出 JSON，不要解释。';
  const user = `用户需求：${req}
请输出 JSON：{
  "name":"业务名称",
  "fields":[{"key":"字段英文名","label":"中文标签","type":"text|select|number|location|image|voice","required":true/false,"options":["单选选项数组，非单选则空"]}],
  "initial":"draft","states":["draft","assigned","processing","completed"],
  "transitions":[{"from":"draft","to":"assigned","event":"dispatch","label":"派单","requiredFields":["assignee"]},{"from":"assigned","to":"processing","event":"start","label":"开始处理"},{"from":"processing","to":"completed","event":"complete","label":"完成"}]
}
注意：字段 3-8 个；type 只能是 text|select|number|location|image|voice 之一；label 用中文；key 用小写英文。`;

  try {
    const r = await chatCompletion({
      task: 'gen-config', tenantId, model: selectModel('genconfig'),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2, max_tokens: 800, response_format: { type: 'json_object' },
    });
    const parsed = JSON.parse(r.content);
    if (!Array.isArray(parsed.fields) || !parsed.fields.length) return null;
    const fields = parsed.fields
      .map((f: any) => ({
        key: String(f.key || '').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'f' + Math.random().toString(36).slice(2, 6),
        label: String(f.label || ''),
        type: ['text', 'select', 'number', 'location', 'image', 'voice'].includes(f.type) ? f.type : 'text',
        required: Boolean(f.required),
        options: Array.isArray(f.options) ? f.options.map((o: any) => String(o)).slice(0, 20) : [],
      }))
      .slice(0, 8);
    return {
      name: String(parsed.name || '新业务').slice(0, 20),
      fields,
      initial: 'draft',
      states: ['draft', 'assigned', 'processing', 'completed'],
      transitions: [
        { from: 'draft', to: 'assigned', event: 'dispatch', label: '派单', requiredFields: ['assignee'] },
        { from: 'assigned', to: 'processing', event: 'start', label: '开始处理' },
        { from: 'processing', to: 'completed', event: 'complete', label: '完成' },
      ],
    };
  } catch (e) {
    console.warn('[llm] gen-config fail:', (e as Error).message);
    return null;
  }
}

// ---------- K2 向量嵌入客户端（可插拔国内 provider，OpenAI /embeddings 兼容） ----------
// 选型（已与初一确认）：「国内合规 API 嵌入」——腾讯云/智谱等国内 embedding API，
//   合规零本地算力、按量付费。默认走智谱 OpenAI 兼容 /embeddings（embedding-3）；
//   任何 OpenAI 兼容嵌入端点（通义/字节/腾讯云）均可经 env 覆盖。
// 未配置 key → embedText 返回 null，调用方零回归回退关键词兜底。
const EMBEDDING_TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS || 10000);
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/embeddings';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'embedding-3';
const EMBEDDING_PRICE_PER_1K_USD = Number(process.env.EMBEDDING_PRICE_PER_1K_USD || 0); // 默认 0（未配置单价则不计成本，留痕即诚实）

// 注意：EMBEDDING_API_KEY 在调用时读取（与 K1 getModel 一致），不缓存为 const——
// 否则进程启动后注入/变更 key 需重启才生效，且单测无法覆盖。
export function embeddingConfigured(): boolean {
  return Boolean(process.env.EMBEDDING_API_KEY);
}
export function embeddingModel(): string {
  return EMBEDDING_MODEL;
}

// 嵌入单段文本 → number[]（将落库为 real[]）；未配置 / 失败 → null（调用方回退关键词兜底）
export async function embedText(text: string, tenantId?: string): Promise<number[] | null> {
  const apiKey = process.env.EMBEDDING_API_KEY || '';
  if (!apiKey) return null;
  const t = maskPhone((text || '').trim());
  if (!t) return null;
  const t0 = Date.now();
  let ok = true, errMsg: string | undefined, tokens = 0;
  try {
    const data = await httpsPostJson(
      EMBEDDING_BASE_URL,
      { model: EMBEDDING_MODEL, input: t.slice(0, 8000) },
      EMBEDDING_TIMEOUT_MS,
      { 'Authorization': `Bearer ${apiKey}` },
    );
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) throw new Error('empty embedding');
    return vec.map((x: number) => Number(x));
  } catch (e) {
    ok = false; errMsg = (e as Error).message;
    console.warn('[embedding] fail:', errMsg);
    return null;
  } finally {
    tokens = estimateTokens(t);
    const latency = Date.now() - t0;
    const cost = (tokens / 1000) * EMBEDDING_PRICE_PER_1K_USD;
    await logCall({
      tenantId: tenantId ?? 'system', provider: 'embedding', model: EMBEDDING_MODEL, task: 'embed',
      promptTokens: tokens, completionTokens: 0, costUsd: cost, latencyMs: latency, ok, error: errMsg,
    });
  }
}

// 余弦相似度（pure，供 /ai/similar 在 Node 端对 real[] 向量计算 top-k；无 pgvector）
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
