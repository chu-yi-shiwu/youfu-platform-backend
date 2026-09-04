// 结算仓储（注册制批次三 卡4 · P0-3）：结算单/明细全部 SQL 集中于此。
// 所有函数接收 client（withTenantClient 注入的租户隔离连接），可 mock 单测真实调用路径。
// D1=A 第一阶段只记账：**无任何支付/收款端点**；paid_at/payment_ref 字段仅预留
// （支付字段预留，接微信支付待 D1 后续拍板），本模块不写这两列。
import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { csvEscape } from '../services/csvUtil.js';

/** 结算单可入账的工单状态口径（完成态口径，与 doneStates 富模板对齐）。 */
export const SETTLEMENT_ELIGIBLE_STATUSES = ['completed', 'closed', 'evaluated'] as const;

export interface ConflictItem {
  work_order_id: string;
  order_no: string | null;
  reason: 'not_found' | 'bad_status' | 'already_settled';
  status?: string;
}

export interface SettlementDraftResult {
  ok: boolean;
  settlement?: SettlementRow;
  conflicts?: ConflictItem[];
}

export interface SettlementRow {
  id: string;
  tenant_id: string;
  settlement_no: string;
  status: 'draft' | 'confirmed';
  total: string | number;
  item_count: number;
  note: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  paid_at: string | null;      // 支付字段预留（只展示不操作）
  payment_ref: string | null;  // 支付字段预留（只展示不操作）
  created_at: string;
  updated_at: string;
}

/** 结算单号构造（纯函数，可单测）：ST + yyyymmdd + 当日序号 4 位。 */
export function buildSettlementNo(ymd: string, seq: number): string {
  return `ST${ymd}${String(seq).padStart(4, '0')}`;
}

/** 当日 yyyymmdd（本地时区，与 genOrderNo 口径一致）。 */
export function todayYmd(d: Date = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 建结算草稿：逐单校验 → 明细预填（product_catalog 命中快照，未命中 price=0 + note 提示）
 * → 表头汇总 → settlement_no 生成（当日 count+1，唯一冲突重试 ≤3 次后 409）。
 * 取舍3：只做填空题不做判断题——预填不校验合理性，价格数量留给人工改。
 */
export async function createSettlementDraft(
  client: PoolClient,
  tenantId: string,
  workOrderIds: string[],
  operator?: string,
): Promise<SettlementDraftResult> {
  // ① 逐单校验：租户内存在 + 状态可入账 + 未被任何结算单占用（UNIQUE(work_order_id) 语义）
  // work_order_id 为 text 业务号（001 主键），cast 用 text[] 而非 uuid[]（live 修复：uuid cast 对业务号 22P02）
  const found = await client.query(
    `SELECT id, order_no, status, catalog AS category FROM work_orders
     -- live 修复（#927）：work_orders 的分类列实名是 catalog（001_init.sql:28），别名 category 供预填复用
     WHERE tenant_id = $1 AND id = ANY($2::text[])`,
    [tenantId, workOrderIds],
  );
  const foundMap = new Map<string, { order_no: string; status: string; category: string | null }>(
    found.rows.map((r: any) => [r.id, r]),
  );
  const settled = await client.query(
    `SELECT si.work_order_id, wo.order_no FROM settlement_item si
     JOIN work_orders wo ON wo.id = si.work_order_id
     WHERE wo.tenant_id = $1 AND si.work_order_id = ANY($2::text[])`,
    [tenantId, workOrderIds],
  );
  const settledSet = new Set(settled.rows.map((r: any) => r.work_order_id));
  const conflicts: ConflictItem[] = [];
  for (const id of workOrderIds) {
    const row = foundMap.get(id);
    if (!row) {
      conflicts.push({ work_order_id: id, order_no: null, reason: 'not_found' });
    } else if (!(SETTLEMENT_ELIGIBLE_STATUSES as readonly string[]).includes(row.status)) {
      conflicts.push({ work_order_id: id, order_no: row.order_no, reason: 'bad_status', status: row.status });
    } else if (settledSet.has(id)) {
      conflicts.push({ work_order_id: id, order_no: row.order_no, reason: 'already_settled' });
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };

  // ② 生成单号（当日序号，唯一冲突重试 ≤3 次）
  const ymd = todayYmd();
  const cnt = await client.query(
    `SELECT COUNT(*)::int AS c FROM settlement WHERE tenant_id = $1 AND created_at::date = CURRENT_DATE`,
    [tenantId],
  );
  let seq = (cnt.rows[0]?.c ?? 0) + 1;
  let settlementNo = buildSettlementNo(ymd, seq);
  let headerId: string | null = null;
  // QA 修复③：单号唯一冲突重试必须走 SAVEPOINT——同事务内 INSERT 撞 23505 后 PG 事务进入
  // aborted 状态（25P02），不 ROLLBACK TO SAVEPOINT 直接重试必然 500 冒泡。
  for (let attempt = 0; attempt < 3; attempt++) {
    await client.query('SAVEPOINT st_no_retry');
    try {
      const ins = await client.query(
        `INSERT INTO settlement (tenant_id, settlement_no, status, total, item_count)
         VALUES ($1, $2, 'draft', 0, 0) RETURNING id`,
        [tenantId, settlementNo],
      );
      await client.query('RELEASE SAVEPOINT st_no_retry');
      headerId = ins.rows[0].id;
      break;
    } catch (e: any) {
      await client.query('ROLLBACK TO SAVEPOINT st_no_retry');
      if (e?.code === '23505') {
        seq += 1;
        settlementNo = buildSettlementNo(ymd, seq);
        continue;
      }
      throw e;
    }
  }
  if (!headerId) {
    throw new AppError('CONFLICT', `结算单号生成冲突（当日重试 3 次失败）：${settlementNo}`, 409);
  }

  // ③ 明细预填：按工单 category 匹配 product_catalog（code 或 name 相等），命中快照，未命中 price=0 + note 提示
  let total = 0;
  let itemCount = 0;
  for (const id of workOrderIds) {
    const wo = foundMap.get(id)!;
    let price = 0;
    let categoryCode: string | null = null;
    let categoryName: string | null = null;
    let itemNote: string | null = null;
    if (wo.category) {
      const cat = await client.query(
        `SELECT code, name, price FROM product_catalog
         WHERE tenant_id = $1 AND enabled = true AND (code = $2 OR name = $2)
         LIMIT 1`,
        [tenantId, wo.category],
      );
      if (cat.rows.length > 0) {
        categoryCode = cat.rows[0].code;
        categoryName = cat.rows[0].name;
        price = Number(cat.rows[0].price) || 0;
      } else {
        itemNote = '价目未匹配，请手填';
      }
    } else {
      itemNote = '价目未匹配，请手填';
    }
    const qty = 1;
    const amount = Math.round(price * qty * 100) / 100;
    await client.query(
      `INSERT INTO settlement_item (tenant_id, settlement_id, work_order_id, category_code, category_name, price, qty, amount, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tenantId, headerId, id, categoryCode, categoryName, price, qty, amount, itemNote],
    );
    total = Math.round((total + amount) * 100) / 100;
    itemCount += 1;
  }

  // ④ 表头汇总
  await client.query(
    `UPDATE settlement SET total = $1, item_count = $2, updated_at = now() WHERE id = $3 AND tenant_id = $4`,
    [total, itemCount, headerId, tenantId],
  );
  const header = await client.query(
    'SELECT * FROM settlement WHERE id = $1 AND tenant_id = $2',
    [headerId, tenantId],
  );
  void operator;
  return { ok: true, settlement: header.rows[0] as SettlementRow };
}

/** 改明细（价格/数量/备注）：仅 draft；重算 item.amount 与表头 total/item_count。 */
export async function updateSettlementItem(
  client: PoolClient,
  tenantId: string,
  settlementId: string,
  itemId: string,
  patch: { price?: number; qty?: number; note?: string },
): Promise<SettlementRow> {
  const header = await client.query(
    'SELECT * FROM settlement WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [settlementId, tenantId],
  );
  if (header.rows.length === 0) throw new AppError('NOT_FOUND', 'settlement not found', 404);
  if (header.rows[0].status !== 'draft') {
    throw new AppError('CONFLICT', '结算单已确认，不可修改', 409);
  }
  const cur = await client.query(
    'SELECT * FROM settlement_item WHERE id = $1 AND settlement_id = $2 AND tenant_id = $3',
    [itemId, settlementId, tenantId],
  );
  if (cur.rows.length === 0) throw new AppError('NOT_FOUND', 'settlement item not found', 404);
  const item = cur.rows[0];
  const price = patch.price !== undefined ? patch.price : Number(item.price);
  const qty = patch.qty !== undefined ? patch.qty : Number(item.qty);
  const note = patch.note !== undefined ? patch.note : item.note;
  if (!Number.isFinite(price) || price < 0) throw new AppError('BAD_REQUEST', 'price 必须为非负数字', 400);
  if (!Number.isFinite(qty) || qty <= 0) throw new AppError('BAD_REQUEST', 'qty 必须为正数字', 400);
  const amount = Math.round(price * qty * 100) / 100;
  await client.query(
    `UPDATE settlement_item SET price = $1, qty = $2, amount = $3, note = $4
     WHERE id = $5 AND settlement_id = $6 AND tenant_id = $7`,
    [price, qty, amount, note, itemId, settlementId, tenantId],
  );
  return recalcHeader(client, tenantId, settlementId);
}

/** 删除草稿结算单：仅 draft（CASCADE 级联清明细，工单回归"未结算"可再入新单）。 */
export async function deleteSettlement(
  client: PoolClient,
  tenantId: string,
  settlementId: string,
): Promise<void> {
  const header = await client.query(
    'SELECT * FROM settlement WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [settlementId, tenantId],
  );
  if (header.rows.length === 0) throw new AppError('NOT_FOUND', 'settlement not found', 404);
  if (header.rows[0].status !== 'draft') {
    throw new AppError('CONFLICT', '结算单已确认，不可删除', 409);
  }
  await client.query('DELETE FROM settlement WHERE id = $1 AND tenant_id = $2', [settlementId, tenantId]);
}

/** 确认锁定：draft→confirmed（写 confirmed_by/confirmed_at）；0 明细→409；已确认（幂等冲突）→409。 */
export async function confirmSettlement(
  client: PoolClient,
  tenantId: string,
  settlementId: string,
  operator?: string,
): Promise<SettlementRow> {
  const header = await client.query(
    'SELECT * FROM settlement WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [settlementId, tenantId],
  );
  if (header.rows.length === 0) throw new AppError('NOT_FOUND', 'settlement not found', 404);
  if (header.rows[0].status !== 'draft') {
    throw new AppError('CONFLICT', '结算单已确认，不可重复确认', 409);
  }
  const cnt = await client.query(
    'SELECT COUNT(*)::int AS c FROM settlement_item WHERE settlement_id = $1 AND tenant_id = $2',
    [settlementId, tenantId],
  );
  if ((cnt.rows[0]?.c ?? 0) === 0) {
    throw new AppError('CONFLICT', '结算单无明细，不可确认', 409);
  }
  await client.query(
    `UPDATE settlement SET status = 'confirmed', confirmed_by = $1, confirmed_at = now(), updated_at = now()
     WHERE id = $2 AND tenant_id = $3`,
    [operator ?? 'system', settlementId, tenantId],
  );
  const after = await client.query(
    'SELECT * FROM settlement WHERE id = $1 AND tenant_id = $2',
    [settlementId, tenantId],
  );
  return after.rows[0] as SettlementRow;
}

/** 汇总重算表头 total/item_count（改/删明细后调用），返回最新表头。 */
async function recalcHeader(client: PoolClient, tenantId: string, settlementId: string): Promise<SettlementRow> {
  const agg = await client.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric(12,2) AS total, COUNT(*)::int AS c
     FROM settlement_item WHERE settlement_id = $1 AND tenant_id = $2`,
    [settlementId, tenantId],
  );
  await client.query(
    `UPDATE settlement SET total = $1, item_count = $2, updated_at = now()
     WHERE id = $3 AND tenant_id = $4`,
    [agg.rows[0].total, agg.rows[0].c, settlementId, tenantId],
  );
  const header = await client.query(
    'SELECT * FROM settlement WHERE id = $1 AND tenant_id = $2',
    [settlementId, tenantId],
  );
  return header.rows[0] as SettlementRow;
}

/** 结算单列表（含明细数/总额，来自表头列；status 可选过滤）。 */
export async function listSettlements(
  client: PoolClient,
  tenantId: string,
  filter: { status?: string; limit?: number; offset?: number },
): Promise<{ items: SettlementRow[]; total: number }> {
  const conds = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (filter.status) {
    params.push(filter.status);
    conds.push(`status = $${params.length}`);
  }
  const where = conds.join(' AND ');
  const totalR = await client.query(
    `SELECT COUNT(*)::int AS c FROM settlement WHERE ${where}`,
    params,
  );
  const limit = Math.min(Math.max(1, Math.floor(Number(filter.limit) || 20)), 200);
  const offset = Math.max(0, Math.min(Math.floor(Number(filter.offset) || 0), 10000));
  const rows = await client.query(
    `SELECT * FROM settlement WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { items: rows.rows as SettlementRow[], total: totalR.rows[0].c };
}

/** 结算单详情（含 items，items 关联 work_orders 带出 order_no/category）。 */
export async function getSettlementDetail(
  client: PoolClient,
  tenantId: string,
  settlementId: string,
): Promise<{ settlement: SettlementRow; items: any[] } | null> {
  const header = await client.query(
    'SELECT * FROM settlement WHERE id = $1 AND tenant_id = $2',
    [settlementId, tenantId],
  );
  if (header.rows.length === 0) return null;
  const items = await client.query(
    `SELECT si.*, wo.order_no, wo.catalog AS work_order_category, wo.title AS work_order_title
     FROM settlement_item si
     LEFT JOIN work_orders wo ON wo.id = si.work_order_id
     WHERE si.settlement_id = $1 AND si.tenant_id = $2
     ORDER BY si.created_at ASC`,
    [settlementId, tenantId],
  );
  return { settlement: header.rows[0] as SettlementRow, items: items.rows };
}

// CSV 导出（asset.ts 范式）：BOM + UTF-8；confirmed 与 draft 均可导。
const SETTLEMENT_CSV_HEADERS = ['单号', '分类', '价目', '数量', '金额', '备注', '工单号'] as const;

export interface SettlementCsvRow {
  settlement_no: string;
  category_name?: string | null;
  category_code?: string | null;
  price: string | number;
  qty: string | number;
  amount: string | number;
  note?: string | null;
  order_no?: string | null;
}

/** CSV 构造（纯函数，可单测）：首列单号、末列工单号，BOM 头。 */
export function buildSettlementCsv(rows: SettlementCsvRow[]): string {
  const lines = [SETTLEMENT_CSV_HEADERS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.settlement_no,
        r.category_name ?? r.category_code ?? '',
        r.price,
        r.qty,
        r.amount,
        r.note ?? '',
        r.order_no ?? '',
      ]
        .map((v) => csvEscape(v == null ? '' : String(v)))
        .join(','),
    );
  }
  return '﻿' + lines.join('\r\n');
}
