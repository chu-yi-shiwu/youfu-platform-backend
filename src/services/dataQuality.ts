// C2 数据质量治理层（设计第 0 层）：事件/工单写入 gate —— 语义归一/校验/去噪/完整性。
//
// 作用（封死 n3「低质数据喂模型」隐患）：
//   - 纯函数 validateEvent / validateOrder / assessQuality 用于度量接口与单测。
//   - 在 modelTrainer 消费事件前，丢弃无法归因（缺 business_type）或异常的事件，避免污染模型。
//   - /stats/data-quality 接口给出租户数据质量评分与问题分布（诚实：无数据时返回 1.0 + note，不编造）。
import type { PoolClient } from 'pg';

export interface QualityIssue {
  entity: string;
  field: string;
  problem: string;
}

export interface QualityReport {
  score: number;
  total: number;
  by_type: Record<string, number>;
  note: string;
}

const KNOWN_EVENT_TYPES = new Set([
  'create', 'signup', 'checkin', 'checkout', 'approve', 'complete', 'exception',
  'convert', 'submit', 'reply', 'status_change', 'alert', 'resolve', 'assign', 'sla_escalated',
  'material_consumed', 'asset_fault', 'asset_transfer', 'miss', 'transpond', 'claim',
]);
const KNOWN_ENTITY_TYPES = new Set([
  'work_order', 'volunteer_activity', 'volunteer_record', 'inspection_task',
  'inspection_point', 'feedback', 'monitor_device', 'monitor_alert',
  'material', 'asset', 'patrol_point', 'patrol_task', 'alert',
]);

/** 纯函数：校验单条统一事件总线的事件。 */
export function validateEvent(ev: {
  entity_type?: string;
  entity_id?: string | null;
  type?: string;
  created_at?: string;
  payload?: unknown;
}): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const et = String(ev.entity_type ?? '?');
  if (!ev.entity_type || !KNOWN_ENTITY_TYPES.has(ev.entity_type))
    issues.push({ entity: et, field: 'entity_type', problem: '未知/缺失实体类型' });
  if (ev.entity_id == null)
    issues.push({ entity: et, field: 'entity_id', problem: '缺失 entity_id' });
  if (!ev.type || !KNOWN_EVENT_TYPES.has(ev.type))
    issues.push({ entity: et, field: 'type', problem: '未知/缺失事件类型' });
  if (ev.created_at) {
    const t = new Date(ev.created_at).getTime();
    if (Number.isNaN(t)) issues.push({ entity: et, field: 'created_at', problem: '日期格式不可解析' });
    else if (t > Date.now() + 60_000) issues.push({ entity: et, field: 'created_at', problem: '未来时间戳' });
  }
  if (ev.payload == null)
    issues.push({ entity: et, field: 'payload', problem: '空 payload' });
  return issues;
}

/** 纯函数：校验工单（模型归因维度 + SLA 合理性）。 */
export function validateOrder(o: {
  id: string;
  business_type?: string | null;
  sla_due_at?: string | null;
  created_at?: string;
}): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (!o.business_type)
    issues.push({ entity: o.id, field: 'business_type', problem: '缺失 business_type（模型维度缺失）' });
  if (o.sla_due_at && o.created_at) {
    const due = new Date(o.sla_due_at).getTime();
    const crt = new Date(o.created_at).getTime();
    if (!Number.isNaN(due) && !Number.isNaN(crt) && due < crt)
      issues.push({ entity: o.id, field: 'sla_due_at', problem: 'SLA 截止早于创建时间' });
  }
  return issues;
}

/** 纯函数：由事件+工单集合评估数据质量（启发式评分 = 1 - 问题数/实体数）。 */
export function assessQuality(
  events: Parameters<typeof validateEvent>[0][],
  orders: Parameters<typeof validateOrder>[0][],
): QualityReport {
  const all: QualityIssue[] = [];
  for (const e of events) all.push(...validateEvent(e));
  for (const o of orders) all.push(...validateOrder(o));
  const by_type: Record<string, number> = {};
  for (const i of all) by_type[i.problem] = (by_type[i.problem] ?? 0) + 1;
  const total = events.length + orders.length;
  const raw = total ? 1 - all.length / total : 1;
  const score = Number(Math.max(0, Math.min(1, raw)).toFixed(4));
  const note = total
    ? ''
    : '当前租户无事件/工单数据，质量评分无数据可算（返回 1.0，不编造问题）';
  return { score, total, by_type, note };
}

// 内存保护：domain_event / work_orders 可能规模巨大，全量拉回内存逐行校验有 OOM 风险
// （与 R18-006 CSV 导出同源）。此处硬上限抽样，超出则诚实标注"抽样估计"，绝不以全量幻觉掩盖。
const QUALITY_MAX_ROWS = 20000;

/** DB 聚合：读 domain_event + work_orders 评估数据质量。
 *  为防大租户全表拉回内存导致 OOM，对两类表各取前 QUALITY_MAX_ROWS+1 行（多取 1 行用于判断是否截断），
 *  超出部分诚实标注"抽样估计"，评分仅供管理端参考，不编造全量口径。 */
export async function qualityReport(client: PoolClient, tenantId: string): Promise<QualityReport> {
  const ev = await client.query<{
    entity_type: string; entity_id: string | null; type: string;
    created_at: string; payload: unknown;
  }>(
    `SELECT entity_type, entity_id, type, created_at, payload
     FROM domain_event WHERE tenant_id = $1 LIMIT $2`,
    [tenantId, QUALITY_MAX_ROWS + 1],
  );
  const evTruncated = ev.rows.length > QUALITY_MAX_ROWS;
  const evRows = ev.rows.slice(0, QUALITY_MAX_ROWS);
  const wo = await client.query<{
    id: string; business_type: string | null; sla_due_at: string | null; created_at: string;
  }>(
    `SELECT id, business_type, sla_due_at, created_at FROM work_orders WHERE tenant_id = $1 LIMIT $2`,
    [tenantId, QUALITY_MAX_ROWS + 1],
  );
  const woTruncated = wo.rows.length > QUALITY_MAX_ROWS;
  const woRows = wo.rows.slice(0, QUALITY_MAX_ROWS);
  const report = assessQuality(
    evRows.map((r) => ({
      entity_type: r.entity_type, entity_id: r.entity_id, type: r.type,
      created_at: r.created_at, payload: r.payload,
    })),
    woRows.map((r) => ({
      id: r.id, business_type: r.business_type, sla_due_at: r.sla_due_at, created_at: r.created_at,
    })),
  );
  if (report.total > 0 && (evTruncated || woTruncated)) {
    report.note = `数据量较大，已对前 ${QUALITY_MAX_ROWS} 行抽样评估（事件截断=${evTruncated}，工单截断=${woTruncated}）；评分为抽样估计值，仅供参考`;
  }
  return report;
}

// ============ D3 · 录入端质量闸门（S4 前置，回应⑤模数共振） ============
// 设计原则：轻闸门——「硬拒」明显非法（防脏数据入库），「warnings」软提示不阻断（不误伤正常报修）。
// 电话宽松匹配：11 位手机 / 7-8 位固话（含 - 与分机），不匹配仅 warning（避免误伤分机号）。
const PHONE_RE = /^(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8}(?:-\d{1,5})?|\d{7,8})$/;
// 标题去噪：去首尾空白/控制字符/重复空格，长度 3-120（过短无信息量、超长刷屏）
const TITLE_MAX = 120;
const TITLE_MIN = 3;
// 术语联想（轻量内置映射，009_term 语义层接入留后续）：常见口语 → 规范业务词
const TERM_MAP: Array<[RegExp, string]> = [
  [/空调不冷|不制冷|没冷气/i, '暖通空调故障'],
  [/灯不亮|灯泡坏|没电灯/i, '照明故障'],
  [/电梯不动|电梯卡|困人/i, '电梯故障'],
  [/漏水|水管爆|滴水/i, '给排水故障'],
  [/没网|断网|连不上网/i, '网络故障'],
];

export interface IntakeInput {
  title?: string | null;
  location?: string | null;
  reporter_phone?: string | null;
  contact?: string | null;
}

export interface IntakeQuality {
  ok: boolean;                 // false = 有硬拒问题（调用方应 400）
  issues: QualityIssue[];      // 硬拒
  warnings: QualityIssue[];    // 软提示
  normalized_title: string;    // 去噪后的标题（调用方应使用）
}

/** 录入端校验（纯函数）：标题去噪/长度、电话格式、位置完整性、术语联想。 */
export function validateIntake(input: IntakeInput): IntakeQuality {
  const issues: QualityIssue[] = [];
  const warnings: QualityIssue[] = [];

  // 标题去噪 + 长度
  const raw = (input.title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) {
    issues.push({ entity: 'work_order', field: 'title', problem: '标题不能为空' });
  } else if (raw.length < TITLE_MIN) {
    issues.push({ entity: 'work_order', field: 'title', problem: `标题过短（<${TITLE_MIN} 字），无信息量` });
  } else if (raw.length > TITLE_MAX) {
    issues.push({ entity: 'work_order', field: 'title', problem: `标题超长（>${TITLE_MAX} 字）` });
  }
  // 术语联想（仅 warning，不阻断；命中则建议规范标题）
  let normalized_title = raw;
  for (const [re, tpl] of TERM_MAP) {
    if (re.test(raw)) {
      warnings.push({ entity: 'work_order', field: 'title', problem: `建议规范描述：「${tpl}」` });
      break;
    }
  }

  // 电话格式（选填；填了但明显非法 → warning，不硬拒避免误伤分机号）
  const phone = (input.reporter_phone ?? input.contact ?? '').trim();
  if (phone && !PHONE_RE.test(phone.replace(/\s/g, ''))) {
    warnings.push({ entity: 'work_order', field: 'phone', problem: '电话格式异常（应为 11 位手机或座机）' });
  }

  // 位置（选填；缺失/过短 → warning）
  const loc = (input.location ?? '').trim();
  if (!loc) {
    warnings.push({ entity: 'work_order', field: 'location', problem: '建议补充位置，便于派单与到场' });
  } else if (loc.length < 2) {
    warnings.push({ entity: 'work_order', field: 'location', problem: '位置信息过短，建议更具体' });
  }

  return { ok: issues.length === 0, issues, warnings, normalized_title };
}
