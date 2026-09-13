// 仓库物资模块（批次 C）：材料档案 + 库存台账 + 入库/出库/流水 + 工单耗材消耗（E-9）。
// 风格对齐 config.ts / volunteer.ts：withTenantClient 注入租户/RLS；写操作 requirePermission；占位符防注入。
// 出库防超卖靠 SELECT ... FOR UPDATE（事务内），并发正确性【部署后补验：并发出库实测】。
// E-9 权限收口（20260914）：耗材目录增删改 / 手工出入库 / 批量导入 → material.manage（默认仅 admin）；
//   工单耗材消耗 → consumable.consume（默认 worker+operator）；**读端点（GET /materials|/inventory|/inventory/logs）
//   维持「已认证即放」不变**（工人选耗材依赖目录读）。导出（GET /materials/export）按设计未列「读不收」，
//   维持原 requireConfigRole 管理面口径不动（写归口 manage、读维持现状的原则）。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole, requirePermission } from '../middleware/role.js';
import { applyStockAction } from '../services/inventory.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { parseCsv, csvEscape } from '../services/csvUtil.js';
import { RICH_WORK_ORDER_DEF, doneStates as wfDoneStates } from '../engine/stateMachine.js';
import { getWorkflowDefOrDefault } from '../engine/workflowDef.js';
import { syncMaterialCostRows } from '../repo/settlement.js';

const router = Router();

// ============ 材料档案 ============
const materialSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional(),
  spec: z.string().optional(),
  unit: z.string().optional(),
  price: z.number().nonnegative().optional(),
  enabled: z.boolean().optional(),
  doc: z.string().optional(), // 文档（UOne B 耗材文档）
});

router.get('/materials', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { code, name, category } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
    };
    if (code) add('code ILIKE ?', `%${code}%`);
    if (name) add('name ILIKE ?', `%${name}%`);
    if (category) add('category = ?', category);
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM material WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/materials', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = materialSchema.parse(req.body);
    const item = await withTenantClient(tenantId, (client) => {
      // E-9：耗材目录维护归口 material.manage（默认仅 admin；租户可经 role_permission 代授）
      return requirePermission(auth, client, 'material.manage').then(() =>
        client
          .query(
            `INSERT INTO material (tenant_id, code, name, category, spec, unit, price, enabled, doc)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [tenantId, b.code, b.name, b.category ?? null, b.spec ?? null, b.unit ?? null, b.price ?? 0, b.enabled ?? true, b.doc ?? null],
          )
          .then((r) => r.rows[0]),
      );
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/materials/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = materialSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'material.manage');
      const cur = await client.query(`SELECT * FROM material WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'material not found', 404);
      const r = await client.query(
        `UPDATE material SET code=COALESCE($3,code), name=COALESCE($4,name), category=COALESCE($5,category),
           spec=COALESCE($6,spec), unit=COALESCE($7,unit), price=COALESCE($8,price), enabled=COALESCE($9,enabled), doc=COALESCE($10,doc), updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, b.code ?? null, b.name ?? null, b.category ?? null, b.spec ?? null, b.unit ?? null, b.price ?? null, b.enabled ?? null, b.doc ?? null],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.delete('/materials/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const n = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'material.manage');
      const inv = await client.query(`SELECT 1 FROM inventory WHERE material_id=$1 AND tenant_id=$2 LIMIT 1`, [req.params.id, tenantId]);
      if (inv.rowCount && inv.rowCount > 0) throw new AppError('CONFLICT', '该材料仍有库存台账，禁止删除', 409);
      const log = await client.query(`SELECT 1 FROM inventory_log WHERE material_id=$1 AND tenant_id=$2 LIMIT 1`, [req.params.id, tenantId]);
      if (log.rowCount && log.rowCount > 0) throw new AppError('CONFLICT', '该材料仍有出入库流水，禁止删除', 409);
      const r = await client.query(`DELETE FROM material WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      return r.rowCount ?? 0;
    });
    if (n === 0) throw new AppError('NOT_FOUND', 'material not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ 库存台账 + 出入库 ============
const stockSchema = z.object({
  material_id: z.string().uuid(),
  warehouse: z.string().optional(),
  qty: z.number().int().positive(),
  ref_no: z.string().optional(),
  note: z.string().optional(),
  // 物料×工单 关联（工单维修领料）：order_no → 服务端解析为 work_order_id（校验租户）
  work_order_no: z.string().optional(),
});

router.get('/inventory', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { material_id, warehouse, low } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
    };
    if (material_id) add('material_id = ?', material_id);
    if (warehouse) add('warehouse = ?', warehouse);
    if (low === '1') clauses.push('qty < min_qty');
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM inventory WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/inventory/in', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = stockSchema.parse(req.body);
    const who = auth.userId ?? auth.role ?? 'system';
    const result = await withTenantClient(tenantId, async (client) => {
      // E-9：手工出入库 = 管理动作（无单出库/入库），归口 material.manage（默认仅 admin）
      await requirePermission(auth, client, 'material.manage');
      const mat = await client.query(`SELECT id FROM material WHERE id=$1 AND tenant_id=$2`, [b.material_id, tenantId]);
      if (mat.rowCount === 0) throw new AppError('NOT_FOUND', 'material not found', 404);
      const wh = b.warehouse ?? '中心库';
      // R23-001 修复：并发首存入库竞态——SELECT ... FOR UPDATE 不会锁「不存在的行」，
      // 两个并发首存会对同一 (tenant_id,material_id,warehouse) 各 INSERT 一条 → 重复台账行 / 库存翻倍。
      // 改用唯一约束 + ON CONFLICT DO UPDATE 原子 upsert（依赖 061_inventory_unique.sql 的唯一约束）。
      const ups = await client.query(
        `INSERT INTO inventory (tenant_id, material_id, warehouse, qty, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (tenant_id, material_id, warehouse)
         DO UPDATE SET qty = inventory.qty + EXCLUDED.qty, updated_at = now()
         RETURNING qty`,
        [tenantId, b.material_id, wh, b.qty],
      );
      const nextQty = Number(ups.rows[0].qty);
      await client.query(
        `INSERT INTO inventory_log (tenant_id, material_id, type, qty, ref_no, note, created_by)
         VALUES ($1,$2,'in',$3,$4,$5,$6)`,
        [tenantId, b.material_id, b.qty, b.ref_no ?? null, b.note ?? null, who],
      );
      return { qty: nextQty };
    });
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

router.post('/inventory/out', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = stockSchema.parse(req.body);
    const who = auth.userId ?? auth.role ?? 'system';
    const result = await withTenantClient(tenantId, async (client) => {
      // E-9：手工出库归口 material.manage —— worker 恒 403（无单出库是管理动作，工人消耗必须挂单走 /inventory/consume）
      await requirePermission(auth, client, 'material.manage');
      const mat = await client.query(`SELECT id FROM material WHERE id=$1 AND tenant_id=$2`, [b.material_id, tenantId]);
      if (mat.rowCount === 0) throw new AppError('NOT_FOUND', 'material not found', 404);
      // 物料×工单 关联：order_no → work_order_id（校验租户；不存在则忽略，不阻断出库）
      let woId: string | null = null;
      if (b.work_order_no) {
        const wo = await client.query('SELECT id FROM work_orders WHERE tenant_id=$1 AND order_no=$2 LIMIT 1', [tenantId, b.work_order_no.trim()]);
        if (wo.rows.length > 0) woId = wo.rows[0].id;
      }
      const wh = b.warehouse ?? '中心库';
      const lock = await client.query(
        `SELECT qty FROM inventory WHERE tenant_id=$1 AND material_id=$2 AND warehouse=$3 FOR UPDATE`,
        [tenantId, b.material_id, wh],
      );
      if (lock.rowCount === 0) throw new AppError('BAD_REQUEST', '库存台账不存在', 400);
      const calc = applyStockAction(Number(lock.rows[0].qty), { type: 'out', qty: b.qty });
      if (!calc.ok) throw new AppError('BAD_REQUEST', '库存不足', 400);
      await client.query(
        `UPDATE inventory SET qty=$3, updated_at=now() WHERE tenant_id=$1 AND material_id=$2 AND warehouse=$4`,
        [tenantId, b.material_id, calc.next, wh],
      );
      await client.query(
        `INSERT INTO inventory_log (tenant_id, material_id, type, qty, ref_no, note, created_by, work_order_id)
         VALUES ($1,$2,'out',$3,$4,$5,$6,$7)`,
        [tenantId, b.material_id, b.qty, b.ref_no ?? null, b.note ?? null, who, woId],
      );
      // P0 飞轮：材料领料/换件事件（挂工单 id，供工单上下文特征与归因）
      await emitDomainEvent(client, { tenantId, entityType: 'material', entityId: b.material_id, type: 'material_consumed', actor: who, payload: { qty: b.qty, ref_no: b.ref_no ?? null, warehouse: wh, work_order_id: woId } });

      // §14 复议1：**挂单出库同样联动** draft 结算单——带 work_order_no 命中工单时，与 consume 同口径
      // 全量重投影（pruneStale=true），否则「管理员挂单出库」的耗材费会漏进结算单。
      // 不传 work_order_no（woId=null）→ 本段整段跳过，零行为变化（未挂单出库零回归）。
      if (woId) {
        const draftHdr = await client.query(
          `SELECT s.id, s.settlement_no FROM settlement s
           WHERE s.tenant_id = $1 AND s.status = 'draft'
             AND s.id IN (SELECT si.settlement_id FROM settlement_item si
                          WHERE si.tenant_id = $1 AND si.work_order_id = $2)
           ORDER BY s.created_at DESC
           LIMIT 1 FOR UPDATE`,
          [tenantId, woId],
        );
        if ((draftHdr.rowCount ?? 0) > 0) {
          const hdr = draftHdr.rows[0] as { id: string; settlement_no: string };
          await syncMaterialCostRows(client, tenantId, hdr.id, [woId], { pruneStale: true });
        }
      }
      return { qty: calc.next };
    });
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

// ============ 工单耗材消耗（E-9 §3.1，工人 / 受理台专用）============
// 与 /inventory/out 的分界线：工人**不获**手工出库权（无单出库=管理动作=material.manage），
// 消耗必须挂单走本端点 —— 流水强制带 work_order_id。这是「留」与「收」的边界。
const consumeSchema = z.object({
  work_order_id: z.string().min(1),
  items: z
    .array(
      z.object({
        material_id: z.string().uuid(),
        qty: z.number().int().positive(),
        note: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(20), // ≤20 行/次（设计 §3.1）
});

/** 领料默认仓库：与 /inventory/in、/inventory/out 同口径（'中心库'）——多仓调拨明确砍到二期。 */
export const CONSUME_WAREHOUSE = '中心库';

/**
 * 耗材消耗禁入的工单终态（E-9 §3.1 校验链①）——**静态兜底基准**。
 * ⚠️ §13 裁决2：运行时终态判定已收敛到后端动态口径 = 租户 workflow_def.config.doneStates
 *   ∪ {completed, cancelled}（本常量仅保留给单测锚定与 mp UX 预判对齐参考，不再是运行时唯一事实源）。
 *   真实理由（2026-09-14 注释纠错）：本批修的是「**租户自定义终态漏拦**」——旧实现只按本静态常量拦，
 *   租户把 workflow_def.config.doneStates 配成 ['archived'] 等自定义终态时，该工单仍可被登记耗材消耗
 *   （快照口径漂移）。修正方式 = 运行时改读租户 config（consumeBlockedStatuses 见下）。
 *   澄清（避免伪因留档）：旧静态清单**并不缺 completed**——RICH_WORK_ORDER_DEF.config.doneStates
 *   本就含 'completed'（src/engine/stateMachine.ts，与 DEFAULT 的 ['completed'] 对齐），本批 diff 中本常量
 *   是 context 行、未改动；此前注释"旧清单缺 completed 会放行完成态"与事实不符，已更正。
 */
export const CONSUME_BLOCKED_STATUSES: readonly string[] = [
  ...(((RICH_WORK_ORDER_DEF.config?.doneStates as string[] | undefined) ?? ['completed', 'closed', 'evaluated'])),
  'cancelled',
];

/** §13 裁决2：动态终态口径 = 租户 workflow_def 的 doneStates ∪ {completed, cancelled}（单一事实源）。 */
async function consumeBlockedStatuses(client: import('pg').PoolClient, tenantId: string): Promise<Set<string>> {
  // 无 workflow_def 行的租户回退富模板（与历史行为一致：completed/closed/evaluated 均拦）
  const def = await getWorkflowDefOrDefault(client, tenantId, 'work_order', RICH_WORK_ORDER_DEF);
  return new Set<string>([...wfDoneStates(def), 'completed', 'cancelled']);
}

router.post('/inventory/consume', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = consumeSchema.parse(req.body);
    const who = auth.userId ?? auth.role ?? 'system';
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'consumable.consume');

      // ① 工单存在且非终态（FOR UPDATE：与流转/结算串行化，防「消耗登记」与「评价结算」并发口径漂移）
      const wo = await client.query(
        `SELECT id, order_no, status FROM work_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, b.work_order_id],
      );
      if (wo.rowCount === 0) throw new AppError('NOT_FOUND', 'work_order not found', 404);
      const order = wo.rows[0] as { id: string; order_no: string | null; status: string };
      // §13 裁决2：终态判定收敛后端——按租户 workflow_def 动态口径（∪{completed,cancelled}），
      // 修掉「静态清单只认富模板默认终态」的漏拦：租户自定义终态（如 archived）同样被拦住。
      const blocked = await consumeBlockedStatuses(client, tenantId);
      if (blocked.has(order.status)) {
        throw new AppError(
          'ORDER_CLOSED',
          `工单已结束（${order.status}），不可再登记耗材消耗（评价后耗材费已进入结算快照）`,
          422,
        );
      }

      // ①b B 守卫（§13 裁决1）：该工单的结算单若已 confirmed → 拒绝。
      //    放在零写库阶段（校验链内）——抛错即整事务回滚，不破 all-or-nothing，库存分毫不动。
      //    错误码 SETTLEMENT_LOCKED 供 mp/FE 透出（区别于 ORDER_CLOSED 的终态语义）。
      const lockedHdr = await client.query(
        `SELECT s.id, s.settlement_no FROM settlement s
         WHERE s.tenant_id = $1 AND s.status = 'confirmed'
           AND s.id IN (SELECT si.settlement_id FROM settlement_item si
                        WHERE si.tenant_id = $1 AND si.work_order_id = $2)
         LIMIT 1`,
        [tenantId, order.id],
      );
      if ((lockedHdr.rowCount ?? 0) > 0) {
        const lk = lockedHdr.rows[0] as { settlement_no: string };
        throw new AppError(
          'SETTLEMENT_LOCKED',
          `结算单 ${lk.settlement_no} 已确认锁定，不可再登记耗材消耗`,
          422,
        );
      }

      // 入参同一材料重复出现 → 先按 material_id 合并：否则逐行读同一库存行会拿到**未落库的旧 qty**，
      // 导致「库存够不够」判断失真（重复行各自都判为够，实际合计超卖）。
      const merged = new Map<string, { material_id: string; qty: number; note: string | null }>();
      for (const it of b.items) {
        const prev = merged.get(it.material_id);
        if (prev) {
          prev.qty += it.qty;
          if (it.note) prev.note = prev.note ? `${prev.note}；${it.note}` : it.note;
        } else {
          merged.set(it.material_id, { material_id: it.material_id, qty: it.qty, note: it.note ?? null });
        }
      }

      // ② 逐材料校验存在性 + FOR UPDATE 锁库存行 + 计算；任一行不足 → 收集缺货明细后整体 422 回滚
      //    （all-or-nothing：本事务此阶段**零写库**，抛错即回滚，不存在部分扣减）
      const planned: Array<{ material_id: string; name: string; qty: number; next: number; note: string | null }> = [];
      const shortages: Array<{ material_id: string; name: string | null; required: number; available: number }> = [];
      for (const line of merged.values()) {
        const mat = await client.query(`SELECT id, name FROM material WHERE id = $1 AND tenant_id = $2`, [line.material_id, tenantId]);
        if (mat.rowCount === 0) throw new AppError('NOT_FOUND', `material not found: ${line.material_id}`, 404);
        const name = ((mat.rows[0] as { name?: string }).name ?? null) as string | null;
        const lock = await client.query(
          `SELECT qty FROM inventory WHERE tenant_id = $1 AND material_id = $2 AND warehouse = $3 FOR UPDATE`,
          [tenantId, line.material_id, CONSUME_WAREHOUSE],
        );
        const current = lock.rowCount && lock.rowCount > 0 ? Number(lock.rows[0].qty) : 0;
        const calc = applyStockAction(current, { type: 'out', qty: line.qty });
        if (!calc.ok) {
          shortages.push({ material_id: line.material_id, name, required: line.qty, available: current });
          continue;
        }
        planned.push({ material_id: line.material_id, name: name ?? line.material_id, qty: line.qty, next: calc.next, note: line.note });
      }
      if (shortages.length > 0) {
        const detail = shortages
          .map((s) => `${s.name ?? s.material_id}（需 ${s.required} / 可用 ${s.available}）`)
          .join('；');
        throw new AppError('INSUFFICIENT_STOCK', `库存不足，无法领料：${detail}`, 422);
      }

      // ③ 扣减库存 + 写流水（type='out'，work_order_id 强制带单）+ ④ 领域事件
      const out: Array<{ material_id: string; name: string; remaining_qty: number }> = [];
      for (const p of planned) {
        await client.query(
          `UPDATE inventory SET qty=$3, updated_at=now() WHERE tenant_id=$1 AND material_id=$2 AND warehouse=$4`,
          [tenantId, p.material_id, p.next, CONSUME_WAREHOUSE],
        );
        await client.query(
          `INSERT INTO inventory_log (tenant_id, material_id, type, qty, ref_no, note, created_by, work_order_id)
           VALUES ($1,$2,'out',$3,$4,$5,$6,$7)`,
          [tenantId, p.material_id, p.qty, order.order_no ?? order.id, p.note, who, order.id],
        );
        // P0 飞轮：材料领料事件（挂工单 id，供工单上下文特征与归因）；source='consume' 与手工出库区分
        await emitDomainEvent(client, {
          tenantId,
          entityType: 'material',
          entityId: p.material_id,
          type: 'material_consumed',
          actor: who,
          payload: {
            qty: p.qty,
            work_order_id: order.id,
            order_no: order.order_no,
            warehouse: CONSUME_WAREHOUSE,
            source: 'consume',
          },
        });
        out.push({ material_id: p.material_id, name: p.name, remaining_qty: p.next });
      }

      // ⑤ A2 同步段（§13 裁决1）：该工单存在 **draft** 结算单 → 同事务内全量重投影耗材行 + recalcHeader。
      //    修掉 E4b「draft 建立后的消耗静默漏计」：白名单 `=== 'draft'`（confirmed 已被 B 守卫拦截，
      //    其它状态一律不联动）+ FOR UPDATE 与结算侧写串行化；留痕零成本（重投影即最新事实，不新增事件/列）。
      //    pruneStale=true：事实源已无消耗的残留耗材行同步清掉（全量重投影语义）。
      let settlementEcho: { id: string; settlement_no: string; total: string | number } | null = null;
      const draftHdr = await client.query(
        `SELECT s.id, s.settlement_no FROM settlement s
         WHERE s.tenant_id = $1 AND s.status = 'draft'
           AND s.id IN (SELECT si.settlement_id FROM settlement_item si
                        WHERE si.tenant_id = $1 AND si.work_order_id = $2)
         ORDER BY s.created_at DESC
         LIMIT 1 FOR UPDATE`,
        [tenantId, order.id],
      );
      if ((draftHdr.rowCount ?? 0) > 0) {
        const hdr = draftHdr.rows[0] as { id: string; settlement_no: string };
        await syncMaterialCostRows(client, tenantId, hdr.id, [order.id], { pruneStale: true });
        const totalRow = await client.query(`SELECT total FROM settlement WHERE id = $1 AND tenant_id = $2`, [
          hdr.id,
          tenantId,
        ]);
        settlementEcho = {
          id: hdr.id,
          settlement_no: hdr.settlement_no,
          total: ((totalRow.rows[0] as { total?: unknown } | undefined)?.total ?? 0) as string | number,
        };
      }
      return { out, settlement: settlementEcho };
    });
    // 响应补 settlement 回显（§13 裁决1）：mp 据此提示「已同步进结算单 STxxx」，null = 无联动。
    return res.json({ ok: true, code: 0, items: items.out, settlement: items.settlement });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return next(new AppError('BAD_REQUEST', `invalid body: ${e.issues.map((i) => i.message).join(';')}`, 400));
    }
    next(e);
  }
});

router.get('/inventory/logs', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { material_id, type, work_order_id } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
    };
    if (material_id) add('material_id = ?', material_id);
    if (type) add('type = ?', type);
    // E-9：按工单查耗材流水（工人端 task-detail「已消耗清单」只读展示用）
    if (work_order_id) add('work_order_id = ?', work_order_id);
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM inventory_log WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// ============ 耗材 CSV 导出 / 导入 ============
const MAT_CSV_COLS = ['code', 'name', 'category', 'spec', 'unit', 'price', 'doc'];
router.get('/materials/export', async (req, res, next) => {
  try {
    requireConfigRole(req, res); // R9-F1：导出属管理面，仅 admin/operator
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client.query(`SELECT * FROM material WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]).then((r) => r.rows),
    );
    const lines = [MAT_CSV_COLS.join(',')];
    for (const row of items) lines.push(MAT_CSV_COLS.map((h) => csvEscape(row[h])).join(','));
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="material.csv"');
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

router.post('/materials/import', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const text = typeof req.body === 'string' ? req.body : (req.body as any)?.csv;
    if (!text || typeof text !== 'string') throw new AppError('BAD_INPUT', 'csv text required', 400);
    const rows = parseCsv(text);
    if (rows.length < 2) return res.json({ ok: true, code: 0, inserted: 0 });
    const headers = rows[0].map((h) => h.trim());
    const dataRows = rows.slice(1);
    let inserted = 0;
    await withTenantClient(tenantId, async (client) => {
      // E-9：批量导入 = 批量新增耗材目录（设计 §4 第 1 点「增删改」覆盖）→ material.manage
      // （否则会留下「不能改单条却能整表灌入」的破窗）
      await requirePermission(auth, client, 'material.manage');
      for (const r of dataRows) {
        const obj: Record<string, unknown> = {};
        headers.forEach((h, i) => { if (MAT_CSV_COLS.includes(h)) obj[h] = r[i] ?? null; });
        if (!obj.code || !obj.name) continue;
        const id = randomUUID();
        const cols = ['id', 'tenant_id', ...MAT_CSV_COLS];
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        const vals = [id, tenantId, ...MAT_CSV_COLS.map((c) => obj[c] ?? null)];
        await client.query(`INSERT INTO material (${cols.join(', ')}) VALUES (${ph})`, vals);
        inserted++;
      }
    });
    return res.json({ ok: true, code: 0, inserted });
  } catch (e) {
    next(e);
  }
});

export default router;
