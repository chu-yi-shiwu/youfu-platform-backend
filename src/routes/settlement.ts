// 结算路由（注册制批次三 卡4 · P0-3）：/api/v1/settlements，RBAC 权限点 settlement.read / settlement.edit。
// D1=A 第一阶段只记账：**无任何支付/收款端点**（paid_at/payment_ref 预留字段只展示不操作）。
// CSV 导出范式照抄 asset.ts（BOM+UTF-8，csvEscape 转义）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import {
  createSettlementDraft,
  updateSettlementItem,
  deleteSettlement,
  confirmSettlement,
  listSettlements,
  getSettlementDetail,
  buildSettlementCsv,
} from '../repo/settlement.js';

const router = Router();

// work_order_ids 为工单业务号文本（001 主键 work_orders.id = text，非 uuid）——
// live 修复：uuid 校验会对业务号 400「Invalid uuid」；text 列天然兼容 uuid 形态字符串，不设限。
const createSchema = z.object({
  work_order_ids: z.array(z.string().min(1)).min(1).max(200),
});

const itemPatchSchema = z.object({
  price: z.number().nonnegative().optional(),
  qty: z.number().positive().optional(),
  note: z.string().max(500).optional(),
});

const LIST_STATUSES = ['draft', 'confirmed'] as const;

// GET /api/v1/settlements?status=&limit=&offset= —— 列表（含明细数/总额）
router.get('/settlements', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const status = typeof req.query.status === 'string' && (LIST_STATUSES as readonly string[]).includes(req.query.status)
      ? req.query.status
      : undefined;
    const limit = Math.min(Math.max(1, Math.floor(Number(req.query.limit) || 20)), 200);
    const offset = Math.max(0, Math.min(Math.floor(Number(req.query.offset) || 0), 10000));
    const data = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'settlement.read');
      return listSettlements(client, tenantId, { status, limit, offset });
    });
    return res.json({
      ok: true,
      code: 0,
      items: data.items,
      total: data.total,
      grand_total: data.items.reduce((s: number, it: any) => s + Number(it.total ?? 0), 0),
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/settlements/:id —— 详情（含 items，items 关联 work_orders 带出 order_no/category）
router.get('/settlements/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const detail = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'settlement.read');
      return getSettlementDetail(client, tenantId, req.params.id);
    });
    if (!detail) throw new AppError('NOT_FOUND', 'settlement not found', 404);
    return res.json({ ok: true, code: 0, ...detail });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/settlements —— 建草稿（work_order_ids；冲突 409 并列明冲突单号）
router.post('/settlements', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const body = createSchema.parse(req.body);
    const result = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'settlement.edit');
      return createSettlementDraft(client, tenantId, body.work_order_ids, auth.username);
    });
    if (!result.ok) {
      return res.status(409).json({
        ok: false,
        code: 'CONFLICT',
        message: '部分工单不可入结算单',
        conflicts: result.conflicts,
      });
    }
    return res.status(201).json({ ok: true, code: 0, settlement: result.settlement });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return next(new AppError('BAD_REQUEST', `invalid body: ${e.issues.map((i) => i.message).join(';')}`, 400));
    }
    next(e);
  }
});

// PUT /api/v1/settlements/:id/items/:itemId —— 改明细（仅 draft；重算金额与表头汇总）
router.put('/settlements/:id/items/:itemId', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const patch = itemPatchSchema.parse(req.body);
    const settlement = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'settlement.edit');
      return updateSettlementItem(client, tenantId, req.params.id, req.params.itemId, patch);
    });
    return res.json({ ok: true, code: 0, settlement });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return next(new AppError('BAD_REQUEST', `invalid body: ${e.issues.map((i) => i.message).join(';')}`, 400));
    }
    next(e);
  }
});

// DELETE /api/v1/settlements/:id —— 删草稿（仅 draft；CASCADE 释放明细，工单回归"未结算"）
router.delete('/settlements/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'settlement.edit');
      return deleteSettlement(client, tenantId, req.params.id);
    });
    return res.json({ ok: true, code: 0, deleted: true });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/settlements/:id/confirm —— 确认锁定（draft→confirmed；0 明细/已确认 → 409）
router.post('/settlements/:id/confirm', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const settlement = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'settlement.edit');
      return confirmSettlement(client, tenantId, req.params.id, auth.username);
    });
    return res.json({ ok: true, code: 0, settlement });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/settlements/:id/export —— CSV 导出（BOM+UTF-8；confirmed 与 draft 均可导）
router.get('/settlements/:id/export', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const detail = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'settlement.read');
      return getSettlementDetail(client, tenantId, req.params.id);
    });
    if (!detail) throw new AppError('NOT_FOUND', 'settlement not found', 404);
    const csv = buildSettlementCsv(
      detail.items.map((it: any) => ({
        settlement_no: detail.settlement.settlement_no,
        category_name: it.category_name,
        category_code: it.category_code,
        price: it.price,
        qty: it.qty,
        amount: it.amount,
        note: it.note,
        order_no: it.order_no,
      })),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${detail.settlement.settlement_no}.csv"`);
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

export default router;
