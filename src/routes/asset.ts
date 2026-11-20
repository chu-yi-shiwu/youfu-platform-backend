// 资产管理模块（批次 C）：资产档案 + 扫码绑定 + 故障转工单 + 关联工单历史。
// 风格对齐批次 B（inspection.ts 转单写法）：withTenantClient 注入租户/RLS；写操作 requirePermission。
// 转单复用 services/linkedWorkOrder（资产故障 → 标准维修工单，进入既有派单流）。
// 契约：DB status 枚举 = in_use/repairing/standby/disabled；前端映射中文，禁止中文入库。
// E-9 权限收口（20260914）：全部写端点（建档/改档/调拨/故障/维保增改删/批量导入）→ asset.manage（默认仅 admin，
//   原 requireConfigRole 的 operator 不再维护资产目录）；**读端点（GET /assets、/assets/:id/history|maintenance、
//   /assets/export）维持现状不动**——写归口 manage、读维持现状。
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import { createLinkedWorkOrder } from '../services/linkedWorkOrder.js';
import { mergeAssetTimeline } from '../services/assetTimeline.js';
import { withRowSavepoint } from '../services/rowSavepoint.js';
import { computeAssetDepreciation } from '../services/assetDepreciation.js';
import { evaluateDisposalReversal } from '../services/assetDisposal.js';
import { analyzeWorkflowReadiness } from '../services/assetWorkflowReadiness.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { scanUploadFile } from '../services/attachmentScan.js';
import { mimeForUploadExt } from '../services/uploadPolicy.js';
import { buildSafeUploadPath } from './uploads.js';
import { UPLOAD_ROOT, UPLOAD_MAX_BYTES } from './upload.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { parseCsv, csvHeader, csvRowLine, csvHeaderMap, csvParseRow, csvDateOnly, type CsvField } from '../services/csvUtil.js';

import { requireModuleWrites } from '../middleware/moduleGuard.js';

const router = Router();
// 报障与现场照片属于个人任务执行/证据留存，模块关闭也必须可用；台账维护类写入仍受模块门禁。
router.use(requireModuleWrites('asset', { allow: [/^\/assets\/[^/]+\/(fault|attachments)$/] }));


const ASSET_STATUS = ['in_use', 'repairing', 'standby', 'disabled', 'disposed'] as const;
const assetSchema = z.object({
  name: z.string().min(1),
  model: z.string().optional(),
  pinyin: z.string().optional(),
  location: z.string().optional(),
  status: z.enum(ASSET_STATUS).optional(),
  has_sno: z.boolean().optional(),
  sno: z.string().nullable().optional(),
  financial_category: z.string().optional(), // 财务分类（UOne A4）
  price: z.union([z.number(), z.string()]).optional(), // 购置金额
  supplier: z.string().optional(), // 供应商
  purchase_date: z.string().optional(), // 购置日期（YYYY-MM-DD）
  responsible_user: z.string().max(100).optional(), // 责任人
  department: z.string().max(100).optional(), // 使用/归属部门
  warranty_until: z.string().optional(), // 保修截止日（YYYY-MM-DD）
  warranty_vendor: z.string().max(200).optional(), // 保修方
  useful_life_months: z.number().int().min(1).max(600).optional(), // 折旧年限（月）
});

router.get('/assets', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { name, pinyin, location, status, code } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
    };
    if (name) add('name ILIKE ?', `%${name}%`);
    if (pinyin) add('pinyin ILIKE ?', `%${pinyin}%`);
    if (location) add('location = ?', location);
    if (status) add('status = ?', status);
    const { department, responsible_user } = req.query as Record<string, string>;
    if (department) add('department = ?', department);
    if (responsible_user) add('responsible_user ILIKE ?', `%${responsible_user}%`);
    // #565 P1：扫资产码过滤（资产编号 / 二维码 / 序列号任一匹配），供小程序 worker 扫资产码看档案。
    if (code) {
      const c = String(code).trim();
      if (c) {
        params.push(`%${c}%`, c, c);
        clauses.push(
          `(asset_no ILIKE $${params.length - 2} OR qr_code = $${params.length - 1} OR sno = $${params.length})`,
        );
      }
    }
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM asset WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/assets', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = assetSchema.parse(req.body);
    if (b.status === 'disposed') {
      throw new AppError('BAD_PARAM', '报废请走 POST /assets/:id/dispose（需原因/方式留痕）', 400);
    }
    const id = randomUUID();
    const assetNo = `ASSET-${id.slice(0, 8).toUpperCase()}`;
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage'); // E-9：资产建档归口 asset.manage（默认仅 admin）
      const r = await client.query(
        `INSERT INTO asset (tenant_id, asset_no, name, model, pinyin, location, status, has_sno, sno, qr_code, financial_category, price, supplier, purchase_date, responsible_user, department, warranty_until, warranty_vendor, useful_life_months)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [
          tenantId,
          assetNo,
          b.name,
          b.model ?? null,
          b.pinyin ?? null,
          b.location ?? null,
          b.status ?? 'in_use',
          b.has_sno ?? false,
          b.sno ?? null,
          `AST-${assetNo}`, // 二维码内容：AST-<资产编号>
          b.financial_category ?? null,
          b.price ?? null,
          b.supplier ?? null,
          b.purchase_date ?? null,
          b.responsible_user ?? null,
          b.department ?? null,
          b.warranty_until ?? null,
          b.warranty_vendor ?? null,
          b.useful_life_months ?? null,
        ],
      );
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'asset',
        entityId: id,
        type: 'asset_created',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { asset_no: assetNo, name: b.name },
      });
      return r.rows[0];
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/assets/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = assetSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const cur = await client.query(`SELECT * FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      if (b.status === 'disposed') {
        throw new AppError('BAD_PARAM', '报废请走 POST /assets/:id/dispose', 400);
      }
      if (cur.rows[0].status === 'disposed') {
        throw new AppError('CONFLICT', '已处置资产不可修改', 409);
      }
      const sets: string[] = [];
      const params: unknown[] = [req.params.id, tenantId];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.name !== undefined) set('name', b.name);
      if (b.model !== undefined) set('model', b.model);
      if (b.pinyin !== undefined) set('pinyin', b.pinyin);
      if (b.location !== undefined) set('location', b.location);
      if (b.status !== undefined) set('status', b.status);
      if (b.has_sno !== undefined) set('has_sno', b.has_sno);
      if (b.sno !== undefined) set('sno', b.sno);
      if (b.financial_category !== undefined) set('financial_category', b.financial_category);
      if (b.price !== undefined) set('price', b.price);
      if (b.supplier !== undefined) set('supplier', b.supplier);
      if (b.purchase_date !== undefined) set('purchase_date', b.purchase_date);
      if (b.responsible_user !== undefined) set('responsible_user', b.responsible_user);
      if (b.department !== undefined) set('department', b.department);
      if (b.warranty_until !== undefined) set('warranty_until', b.warranty_until);
      if (b.warranty_vendor !== undefined) set('warranty_vendor', b.warranty_vendor);
      if (b.useful_life_months !== undefined) set('useful_life_months', b.useful_life_months);
      if (sets.length === 0) return cur.rows[0];
      sets.push('updated_at = now()');
      const r = await client.query(
        `UPDATE asset SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        params,
      );
      const changed = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'asset',
        entityId: req.params.id,
        type: 'asset_updated',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { fields: changed },
      });
      if (b.status !== undefined && b.status !== cur.rows[0].status) {
        await emitDomainEvent(client, {
          tenantId,
          entityType: 'asset',
          entityId: req.params.id,
          type: 'asset_status_changed',
          actor: auth.username ?? auth.role ?? 'system',
          payload: { from: cur.rows[0].status, to: b.status },
        });
      }
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/assets/:id/transfer', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = z.object({ location: z.string().min(1) }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const cur = await client.query(`SELECT * FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const r = await client.query(
        `UPDATE asset SET location=$3, updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, b.location],
      );
      const row = r.rows[0];
      // P0 飞轮：资产调拨事件
      await emitDomainEvent(client, { tenantId, entityType: 'asset', entityId: row.id, type: 'asset_transfer', actor: 'config_role', payload: { to_location: b.location } });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 故障报修 → 转标准维修工单（进入既有派单流）；同时维护 linked_order_ids 供 history 反查
router.post('/assets/:id/fault', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
      })
      .parse(req.body);
    const result = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const cur = await client.query(`SELECT * FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const a = cur.rows[0];
      const wo = await createLinkedWorkOrder(client, {
        id: randomUUID(),
        tenantId,
        businessType: 'repair',
        catalog: 'repair',
        priority: 'normal',
        title: b.title ?? `资产故障报修·${a.name}`,
        description: b.description ?? `资产(${a.asset_no ?? a.name})故障报修`,
        location: b.location ?? a.location ?? undefined,
        sourceType: 'asset',
        sourceId: a.id,
      });
      const ids: string[] = Array.isArray(a.linked_order_ids) ? a.linked_order_ids : [];
      if (!ids.includes(wo.id)) ids.push(wo.id);
      await client.query(
        `UPDATE asset SET linked_order_ids=$3, status='repairing', updated_at=now() WHERE id=$1 AND tenant_id=$2`,
        [a.id, tenantId, ids],
      );
      // P0 飞轮：资产故障事件（挂工单上下文，供分类-工人匹配特征）
      await emitDomainEvent(client, { tenantId, entityType: 'asset', entityId: a.id, type: 'asset_fault', actor: 'config_role', payload: { work_order_id: wo.id, asset_no: a.asset_no ?? null } });
      return wo;
    });
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

// 资产报废/处置（2026-11-17 P1）：不物理删除，保留原因/方式/残值/操作人/时间。
router.post('/assets/:id/dispose', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = z.object({
      reason: z.string().min(1).max(500),
      method: z.string().max(100).optional(),
      residual_value: z.union([z.number(), z.string()]).optional(),
      note: z.string().max(1000).optional(),
    }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const cur = await client.query(`SELECT * FROM asset WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const a = cur.rows[0];
      if (a.status === 'disposed') throw new AppError('CONFLICT', 'asset already disposed', 409);
      if (a.status === 'repairing') {
        throw new AppError('CONFLICT', '资产处于维修中，请先关闭/取消维修工单再报废', 409);
      }
      const r = await client.query(
        `UPDATE asset
            SET status='disposed', disposed_at=now(), disposed_by=$3,
                dispose_reason=$4, dispose_method=$5, residual_value=$6,
                disposal_reversed_at=NULL, disposal_reversed_by=NULL, disposal_reversal_reason=NULL,
                updated_at=now()
          WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, auth.username ?? auth.role ?? 'system', b.reason, b.method ?? null, b.residual_value ?? null],
      );
      await emitDomainEvent(client, {
        tenantId, entityType: 'asset', entityId: req.params.id, type: 'asset_dispose', actor: auth.username ?? 'config_role',
        payload: { reason: b.reason, method: b.method ?? null, residual_value: b.residual_value ?? null, note: b.note ?? null, previous_status: a.status },
      });
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

// ============ 处置撤销审批（2026-11-20） ============
// 原则：disposed 仍是终态；撤销是审批后的冲销，必须留申请/审批/决定三段时间与操作人。
const reversalRequestSchema = z.object({
  reason: z.string().min(1).max(500),
});
const reversalDecisionSchema = z.object({
  note: z.string().max(500).optional(),
});

router.post('/assets/:id/dispose/reversal', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = reversalRequestSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const cur = await client.query(`SELECT * FROM asset WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const a = cur.rows[0];
      const decision = evaluateDisposalReversal(a);
      if (!decision.ok) {
        throw new AppError(decision.code ?? 'CONFLICT', decision.message ?? '不能撤销处置', 409);
      }
      const existing = await client.query(
        `SELECT id FROM asset_disposal_reversal WHERE tenant_id=$1 AND asset_id=$2 AND status='pending'`,
        [tenantId, req.params.id],
      );
      if (existing.rowCount) throw new AppError('CONFLICT', '该资产已有待审批的撤销申请', 409);
      const r = await client.query(
        `INSERT INTO asset_disposal_reversal
           (tenant_id, asset_id, status, reason, snapshot, requested_by, requested_by_id)
         VALUES ($1,$2,'pending',$3,$4,$5,$6) RETURNING *`,
        [
          tenantId,
          req.params.id,
          b.reason,
          JSON.stringify({
            disposed_at: a.disposed_at,
            disposed_by: a.disposed_by,
            dispose_reason: a.dispose_reason,
            dispose_method: a.dispose_method,
            residual_value: a.residual_value,
          }),
          auth.username ?? auth.role ?? 'system',
          auth.userId ?? null,
        ],
      );
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'asset',
        entityId: req.params.id,
        type: 'asset_disposal_reversal_requested',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { reversal_id: r.rows[0].id, reason: b.reason, days_since_dispose: decision.days_since_dispose ?? null },
      });
      return r.rows[0];
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.get('/assets/disposal-reversals', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const status = z.enum(['pending', 'approved', 'rejected', 'all']).catch('pending').parse(req.query.status);
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      return client.query(
        `SELECT r.*, a.asset_no, a.name, a.status AS asset_status,
                a.disposed_at, a.dispose_method, a.residual_value
           FROM asset_disposal_reversal r
           JOIN asset a ON a.id = r.asset_id AND a.tenant_id = r.tenant_id
          WHERE r.tenant_id=$1 AND ($2='all' OR r.status=$2)
          ORDER BY r.requested_at DESC
          LIMIT 200`,
        [tenantId, status],
      ).then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.get('/assets/:id/disposal-reversals', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      const a = await client.query(`SELECT id FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (a.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      return client.query(
        `SELECT * FROM asset_disposal_reversal
          WHERE tenant_id=$1 AND asset_id=$2 ORDER BY requested_at DESC LIMIT 50`,
        [tenantId, req.params.id],
      ).then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/assets/disposal-reversals/:rid/approve', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    if (auth.role !== 'admin') throw new AppError('FORBIDDEN', '处置撤销需管理员审批', 403);
    const b = reversalDecisionSchema.parse(req.body ?? {});
    const result = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const rq = await client.query(
        `SELECT * FROM asset_disposal_reversal WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
        [req.params.rid, tenantId],
      );
      if (rq.rowCount === 0) throw new AppError('NOT_FOUND', 'reversal request not found', 404);
      const request = rq.rows[0];
      if (request.status !== 'pending') throw new AppError('CONFLICT', '该申请已处理', 409);
      const sameUser = (request.requested_by_id && auth.userId && request.requested_by_id === auth.userId)
        || (request.requested_by && request.requested_by === (auth.username ?? ''));
      if (sameUser) throw new AppError('SELF_APPROVAL', '申请人不能审批自己提交的撤销申请', 409);

      const cur = await client.query(`SELECT * FROM asset WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [request.asset_id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const a = cur.rows[0];
      const decision = evaluateDisposalReversal(a);
      if (!decision.ok) throw new AppError(decision.code ?? 'CONFLICT', decision.message ?? '不能撤销处置', 409);

      const upd = await client.query(
        `UPDATE asset
            SET status='in_use',
                disposal_reversed_at=now(),
                disposal_reversed_by=$3,
                disposal_reversal_reason=$4,
                updated_at=now()
          WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [request.asset_id, tenantId, auth.username ?? auth.role ?? 'system', request.reason],
      );
      const decided = await client.query(
        `UPDATE asset_disposal_reversal
            SET status='approved', decided_by=$3, decided_by_id=$4, decided_at=now(), decision_note=$5
          WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.rid, tenantId, auth.username ?? auth.role ?? 'system', auth.userId ?? null, b.note ?? null],
      );
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'asset',
        entityId: request.asset_id,
        type: 'asset_disposal_reversal_approved',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { reversal_id: req.params.rid, reason: request.reason, note: b.note ?? null },
      });
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'asset',
        entityId: request.asset_id,
        type: 'asset_status_changed',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { from: 'disposed', to: 'in_use', reason: 'disposal_reversal', reversal_id: req.params.rid },
      });
      return { item: upd.rows[0], request: decided.rows[0] };
    });
    return res.json({ ok: true, code: 0, ...result });
  } catch (e) {
    next(e);
  }
});

router.post('/assets/disposal-reversals/:rid/reject', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    if (auth.role !== 'admin') throw new AppError('FORBIDDEN', '处置撤销需管理员审批', 403);
    const b = reversalDecisionSchema.parse(req.body ?? {});
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const rq = await client.query(
        `SELECT * FROM asset_disposal_reversal WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
        [req.params.rid, tenantId],
      );
      if (rq.rowCount === 0) throw new AppError('NOT_FOUND', 'reversal request not found', 404);
      const request = rq.rows[0];
      if (request.status !== 'pending') throw new AppError('CONFLICT', '该申请已处理', 409);
      const r = await client.query(
        `UPDATE asset_disposal_reversal
            SET status='rejected', decided_by=$3, decided_by_id=$4, decided_at=now(), decision_note=$5
          WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.rid, tenantId, auth.username ?? auth.role ?? 'system', auth.userId ?? null, b.note ?? null],
      );
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'asset',
        entityId: request.asset_id,
        type: 'asset_disposal_reversal_rejected',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { reversal_id: req.params.rid, reason: request.reason, note: b.note ?? null },
      });
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 资产报障流程配置预检 ============
router.get('/assets/workflow-readiness', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const result = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const def = await getWorkflowDef(client, tenantId, 'work_order');
      return analyzeWorkflowReadiness(def);
    });
    return res.json({ code: 0, ...result });
  } catch (e) {
    next(e);
  }
});

// 关联工单历史（只读聚合）：读 work_orders WHERE id = ANY(linked_order_ids)
router.get('/assets/:id/history', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const data = await withTenantClient(tenantId, async (client) => {
      const a = await client.query(`SELECT linked_order_ids FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (a.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const ids = a.rows[0].linked_order_ids ?? [];
      const events = await client.query(
        `SELECT id, type, actor, payload, created_at FROM domain_event
          WHERE tenant_id=$1 AND entity_type='asset' AND entity_id=$2
          ORDER BY created_at DESC LIMIT 200`,
        [tenantId, req.params.id],
      );
      let orders: Array<{ id: string; order_no: string | null; business_type: string | null; status: string; created_at: string }> = [];
      if (Array.isArray(ids) && ids.length > 0) {
        const r = await client.query(
          `SELECT id, order_no, business_type, status, created_at, updated_at, completed_at FROM work_orders WHERE id = ANY($1) AND tenant_id=$2`,
          [ids, tenantId],
        );
        orders = r.rows;
      }
      return { orders, events: events.rows };
    });
    return res.json({ ok: true, code: 0, items: mergeAssetTimeline(data.orders, data.events) });
  } catch (e) {
    next(e);
  }
});

// ============ 维保台账（asset_maintenance） ============
const maintSchema = z.object({
  maintain_date: z.string().optional(),
  type: z.string().optional(),
  cost: z.union([z.number(), z.string()]).optional(),
  vendor: z.string().optional(),
  note: z.string().optional(),
  next_due: z.string().optional(), // 下次维保计划日（YYYY-MM-DD）
});

router.get('/assets/:id/maintenance', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT * FROM asset_maintenance WHERE tenant_id=$1 AND asset_id=$2 ORDER BY maintain_date DESC NULLS LAST, created_at DESC`,
          [tenantId, req.params.id],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/assets/:id/maintenance', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = maintSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const a = await client.query(`SELECT id FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (a.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const r = await client.query(
        `INSERT INTO asset_maintenance (tenant_id, asset_id, maintain_date, type, cost, vendor, note, next_due)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [tenantId, req.params.id, b.maintain_date ?? null, b.type ?? null, b.cost ?? null, b.vendor ?? null, b.note ?? null, b.next_due ?? null],
      );
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'asset',
        entityId: req.params.id,
        type: 'asset_maintenance_added',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { maintenance_id: r.rows[0].id, type: b.type ?? null, next_due: b.next_due ?? null },
      });
      return r.rows[0];
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/assets/maintenance/:mid', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = maintSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const cur = await client.query(`SELECT * FROM asset_maintenance WHERE id=$1 AND tenant_id=$2`, [req.params.mid, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'maintenance not found', 404);
      const sets: string[] = [];
      const params: unknown[] = [req.params.mid, tenantId];
      const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
      if (b.maintain_date !== undefined) set('maintain_date', b.maintain_date);
      if (b.type !== undefined) set('type', b.type);
      if (b.cost !== undefined) set('cost', b.cost);
      if (b.vendor !== undefined) set('vendor', b.vendor);
      if (b.note !== undefined) set('note', b.note);
      if (b.next_due !== undefined) set('next_due', b.next_due);
      if (sets.length === 0) return cur.rows[0];
      sets.push('updated_at = now()');
      const r = await client.query(
        `UPDATE asset_maintenance SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        params,
      );
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'asset',
        entityId: cur.rows[0].asset_id,
        type: 'asset_maintenance_updated',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { maintenance_id: req.params.mid, fields: Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined) },
      });
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.delete('/assets/maintenance/:mid', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const n = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const cur = await client.query(`SELECT asset_id FROM asset_maintenance WHERE id=$1 AND tenant_id=$2`, [req.params.mid, tenantId]);
      if (cur.rowCount === 0) return 0;
      const r = await client.query(`DELETE FROM asset_maintenance WHERE id=$1 AND tenant_id=$2`, [req.params.mid, tenantId]);
      if (r.rowCount) {
        await emitDomainEvent(client, {
          tenantId,
          entityType: 'asset',
          entityId: cur.rows[0].asset_id,
          type: 'asset_maintenance_deleted',
          actor: auth.username ?? auth.role ?? 'system',
          payload: { maintenance_id: req.params.mid },
        });
      }
      return r.rowCount ?? 0;
    });
    if (n === 0) throw new AppError('NOT_FOUND', 'maintenance not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ 资产 CSV 导出 / 导入 ============
const ASSET_STATUS_CN: Record<string, string> = { in_use: '在用', repairing: '维修中', standby: '备用', disabled: '停用', disposed: '已处置' };
const ASSET_STATUS_FROM_CN: Record<string, string> = Object.fromEntries(Object.entries(ASSET_STATUS_CN).map(([k, v]) => [v, k]));

const ASSET_CSV_FIELDS: CsvField[] = [
  { key: 'asset_no', label: '资产编号' },
  { key: 'name', label: '资产名称', required: true },
  { key: 'model', label: '型号' },
  { key: 'pinyin', label: '拼音' },
  { key: 'location', label: '位置' },
  {
    key: 'status', label: '状态',
    export: (r) => ASSET_STATUS_CN[r.status] || r.status || '',
    parse: (v) => ASSET_STATUS_FROM_CN[v] || v || undefined,
  },
  { key: 'sno', label: '序列号' },
  { key: 'financial_category', label: '财务分类' },
  { key: 'price', label: '购置金额' },
  { key: 'supplier', label: '供应商' },
  { key: 'purchase_date', label: '购置日期', export: (r) => csvDateOnly(r.purchase_date) },
  { key: 'responsible_user', label: '责任人' },
  { key: 'department', label: '部门' },
  { key: 'warranty_until', label: '保修截止', export: (r) => csvDateOnly(r.warranty_until) },
  { key: 'warranty_vendor', label: '保修方' },
  { key: 'useful_life_months', label: '折旧年限(月)' },
];

router.get('/assets/import-template', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
    });
    const sample = {
      asset_no: 'ASSET-EXAMPLE01',
      name: '示例-输液泵',
      model: 'IP-01',
      pinyin: 'shuyebeng',
      location: '住院楼 2F 护士站',
      status: '在用',
      sno: 'SN-EXAMPLE01',
      financial_category: '医疗设备',
      price: '8800.50',
      supplier: '示例供应商',
      purchase_date: '2026-01-01',
      responsible_user: '张三',
      department: 'ICU',
      warranty_until: '2028-01-01',
      warranty_vendor: '示例保修方',
      useful_life_months: '60',
    };
    const csv = '\ufeff' + csvHeader(ASSET_CSV_FIELDS) + '\r\n' + csvRowLine(sample, ASSET_CSV_FIELDS) + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="asset-import-template.csv"');
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

router.get('/assets/export', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.export');
      return client
        .query(`SELECT * FROM asset WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId])
        .then((r) => r.rows);
    });
    const lines = [csvHeader(ASSET_CSV_FIELDS)];
    for (const row of items) lines.push(csvRowLine(row, ASSET_CSV_FIELDS));
    const csv = '\ufeff' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="asset.csv"');
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

router.post('/assets/import', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const text = typeof req.body === 'string' ? req.body : (req.body as { csv?: string })?.csv;
    if (!text || typeof text !== 'string') throw new AppError('BAD_INPUT', 'csv text required', 400);
    const rows = parseCsv(text);
    if (rows.length < 2) return res.json({ ok: true, code: 0, inserted: 0, skipped: 0, errors: [] });
    const headerMap = csvHeaderMap(rows[0], ASSET_CSV_FIELDS);
    const dataRows = rows.slice(1);
    if (dataRows.length > 2000) throw new AppError('BAD_INPUT', '单次导入最多 2000 行，请拆分后重试', 400);
    let inserted = 0;
    const errors: Array<{ row: number; reason: string }> = [];
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      for (let i = 0; i < dataRows.length; i++) {
        const obj = csvParseRow(dataRows[i], headerMap);
        if (!obj.name) { errors.push({ row: i + 2, reason: '缺少资产名称' }); continue; }
        try {
          await withRowSavepoint(client, async () => {
            const id = randomUUID();
            const assetNo = obj.asset_no || `ASSET-${id.slice(0, 8).toUpperCase()}`;
            const keys = ASSET_CSV_FIELDS.map((f) => f.key).filter((k) => k !== 'asset_no');
            const cols = ['id', 'tenant_id', 'asset_no', 'qr_code', ...keys];
            const ph = cols.map((_, n) => `$${n + 1}`).join(', ');
            const vals = [id, tenantId, assetNo, `AST-${assetNo}`, ...keys.map((k) => obj[k] ?? null)];
            await client.query(`INSERT INTO asset (${cols.join(', ')}) VALUES (${ph})`, vals);
            await emitDomainEvent(client, {
              tenantId,
              entityType: 'asset',
              entityId: id,
              type: 'asset_imported',
              actor: auth.username ?? auth.role ?? 'system',
              payload: { asset_no: assetNo, name: obj.name },
            });
          });
          inserted++;
        } catch (e: unknown) {
          errors.push({ row: i + 2, reason: e instanceof Error ? e.message : '写入失败' });
        }
      }
    });
    return res.json({ ok: true, code: 0, inserted, skipped: errors.length, errors: errors.slice(0, 20) });
  } catch (e) {
    next(e);
  }
});

// ============ 资产到期提醒（保修 / 维保计划） ============
router.get('/assets/reminders', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const rawDays = Number(req.query.days ?? 30);
    const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, Math.trunc(rawDays))) : 30;
    const out = await withTenantClient(tenantId, async (client) => {
      const warranty = await client.query(
        `SELECT id, id AS asset_id, asset_no, name, location, department, responsible_user, warranty_vendor, warranty_until,
                (warranty_until - current_date)::int AS days_left
           FROM asset
          WHERE tenant_id=$1 AND status <> 'disposed'
            AND warranty_until IS NOT NULL AND warranty_until <= current_date + ($2::int || ' days')::interval
            AND NOT EXISTS (
              SELECT 1 FROM asset_reminder_dismissal d
               WHERE d.tenant_id = asset.tenant_id AND d.kind='warranty' AND d.ref_id = asset.id
                 AND d.restored_at IS NULL
            )
          ORDER BY warranty_until ASC
          LIMIT 200`,
        [tenantId, days],
      );
      const maintenance = await client.query(
        `SELECT m.id, m.asset_id, m.next_due, m.type, m.vendor,
                (m.next_due - current_date)::int AS days_left,
                a.asset_no, a.name, a.location, a.department, a.responsible_user
           FROM asset_maintenance m
           JOIN asset a ON a.id = m.asset_id AND a.tenant_id = m.tenant_id
          WHERE m.tenant_id=$1 AND a.status <> 'disposed'
            AND m.next_due IS NOT NULL AND m.next_due <= current_date + ($2::int || ' days')::interval
            AND NOT EXISTS (
              SELECT 1 FROM asset_reminder_dismissal d
               WHERE d.tenant_id = m.tenant_id AND d.kind='maintenance' AND d.ref_id = m.id
                 AND d.restored_at IS NULL
            )
          ORDER BY m.next_due ASC
          LIMIT 200`,
        [tenantId, days],
      );
      return { warranty: warranty.rows, maintenance: maintenance.rows };
    });
    return res.json({ ok: true, code: 0, days, ...out });
  } catch (e) {
    next(e);
  }
});

// 手动忽略到期提醒（租户内持久化；不删除业务数据，只隐藏提醒）
router.post('/assets/reminders/dismiss', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = z.object({
      kind: z.enum(['warranty', 'maintenance']),
      ref_id: z.string().uuid(),
    }).parse(req.body);
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      // 校验终点存在，避免忽略一条不存在的提醒
      if (b.kind === 'warranty') {
        const a = await client.query(`SELECT id FROM asset WHERE id=$1 AND tenant_id=$2`, [b.ref_id, tenantId]);
        if (a.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      } else {
        const m = await client.query(`SELECT id FROM asset_maintenance WHERE id=$1 AND tenant_id=$2`, [b.ref_id, tenantId]);
        if (m.rowCount === 0) throw new AppError('NOT_FOUND', 'maintenance not found', 404);
      }
      await client.query(
        `INSERT INTO asset_reminder_dismissal (tenant_id, kind, ref_id, dismissed_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, kind, ref_id)
         DO UPDATE SET dismissed_by=EXCLUDED.dismissed_by, dismissed_at=now(),
                       restored_at=NULL, restored_by=NULL`,
        [tenantId, b.kind, b.ref_id, auth.username ?? auth.role ?? 'system'],
      );
    });
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// 已忽略提醒列表：只展示当前仍生效的忽略记录（历史恢复记录保留在表中可审计）
router.get('/assets/reminders/dismissed', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      return client.query(
        `SELECT d.kind, d.ref_id, d.dismissed_by, d.dismissed_at,
                a.id AS asset_id, a.asset_no, a.name,
                CASE WHEN d.kind='warranty' THEN a.warranty_until ELSE m.next_due END AS due_at
           FROM asset_reminder_dismissal d
           LEFT JOIN asset_maintenance m
             ON d.kind='maintenance' AND m.id = d.ref_id AND m.tenant_id = d.tenant_id
           JOIN asset a
             ON a.tenant_id = d.tenant_id
            AND a.id = CASE WHEN d.kind='warranty' THEN d.ref_id ELSE m.asset_id END
          WHERE d.tenant_id=$1 AND d.restored_at IS NULL
          ORDER BY d.dismissed_at DESC
          LIMIT 200`,
        [tenantId],
      ).then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 恢复已忽略提醒：保留忽略历史，只标记 restored_at/restored_by
router.post('/assets/reminders/restore', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = z.object({
      kind: z.enum(['warranty', 'maintenance']),
      ref_id: z.string().uuid(),
    }).parse(req.body);
    const n = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const r = await client.query(
        `UPDATE asset_reminder_dismissal
            SET restored_at=now(), restored_by=$4
          WHERE tenant_id=$1 AND kind=$2 AND ref_id=$3 AND restored_at IS NULL
          RETURNING ref_id`,
        [tenantId, b.kind, b.ref_id, auth.username ?? auth.role ?? 'system'],
      );
      return r.rowCount ?? 0;
    });
    if (n === 0) throw new AppError('NOT_FOUND', 'dismissal not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ 资产统计 / 折旧 ============
router.get('/assets/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const data = await withTenantClient(tenantId, async (client) => {
      const summary = await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status='in_use')::int AS in_use,
                count(*) FILTER (WHERE status='repairing')::int AS repairing,
                count(*) FILTER (WHERE status='standby')::int AS standby,
                count(*) FILTER (WHERE status='disabled')::int AS disabled,
                count(*) FILTER (WHERE status='disposed')::int AS disposed,
                coalesce(sum(price),0)::text AS purchase_total,
                coalesce(sum(residual_value) FILTER (WHERE status='disposed'),0)::text AS residual_total,
                count(*) FILTER (WHERE warranty_until IS NOT NULL AND warranty_until < current_date)::int AS warranty_expired
           FROM asset WHERE tenant_id=$1`,
        [tenantId],
      );
      const byDepartment = await client.query(
        `SELECT coalesce(nullif(department,''), '未分部门') AS department, count(*)::int AS count,
                coalesce(sum(price),0)::text AS purchase_total
           FROM asset WHERE tenant_id=$1 GROUP BY 1 ORDER BY 2 DESC`,
        [tenantId],
      );
      const byCategory = await client.query(
        `SELECT coalesce(nullif(financial_category,''), '未分类') AS category, count(*)::int AS count,
                coalesce(sum(price),0)::text AS purchase_total
           FROM asset WHERE tenant_id=$1 GROUP BY 1 ORDER BY 2 DESC`,
        [tenantId],
      );
      // 直线折旧：仅对同时配置 购置金额 / 购置日期 / 折旧年限 的未处置资产计算，避免凭空造假数据。
      const dep = await client.query(
        `SELECT price, purchase_date, useful_life_months FROM asset
          WHERE tenant_id=$1 AND status <> 'disposed'
            AND price IS NOT NULL AND purchase_date IS NOT NULL
            AND useful_life_months IS NOT NULL AND useful_life_months > 0`,
        [tenantId],
      );
      const now = new Date();
      let monthlyTotal = 0;
      let accumulatedTotal = 0;
      let netTotal = 0;
      let covered = 0;
      for (const row of dep.rows) {
        const d = computeAssetDepreciation(row, now);
        if (!d) continue;
        covered += 1;
        monthlyTotal += d.monthly;
        accumulatedTotal += d.accumulated;
        netTotal += d.net;
      }
      const round2 = (n: number) => Math.round(n * 100) / 100;
      return {
        summary: summary.rows[0],
        by_department: byDepartment.rows,
        by_category: byCategory.rows,
        depreciation: {
          covered_assets: covered,
          monthly_total: round2(monthlyTotal),
          accumulated_total: round2(accumulatedTotal),
          net_total: round2(netTotal),
        },
      };
    });
    return res.json({ ok: true, code: 0, ...data });
  } catch (e) {
    next(e);
  }
});

// ============ 资产批量操作 ============
const batchSchema = z.object({
  action: z.enum(['update', 'dispose']),
  ids: z.array(z.string().uuid()).min(1).max(200),
  patch: assetSchema.partial().optional(),
  reason: z.string().min(1).max(500).optional(),
  method: z.string().max(100).optional(),
  residual_value: z.union([z.number(), z.string()]).optional(),
});

router.post('/assets/batch', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = batchSchema.parse(req.body);
    if (b.action === 'update' && !b.patch) throw new AppError('BAD_PARAM', '批量更新需要 patch', 400);
    if (b.action === 'dispose' && !b.reason) throw new AppError('BAD_PARAM', '批量报废需要 reason', 400);
    if (b.action === 'update' && b.patch?.status === 'disposed') {
      throw new AppError('BAD_PARAM', '报废请使用 action=dispose', 400);
    }
    const result = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      let updated = 0;
      const skipped: Array<{ id: string; reason: string }> = [];
      for (const id of b.ids) {
        const cur = await client.query(`SELECT * FROM asset WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [id, tenantId]);
        if (cur.rowCount === 0) { skipped.push({ id, reason: '不存在' }); continue; }
        const a = cur.rows[0];
        if (a.status === 'disposed') { skipped.push({ id, reason: '已处置' }); continue; }
        if (b.action === 'dispose') {
          if (a.status === 'repairing') { skipped.push({ id, reason: '维修中，请先关闭工单' }); continue; }
          await client.query(
            `UPDATE asset SET status='disposed', disposed_at=now(), disposed_by=$3,
                    dispose_reason=$4, dispose_method=$5, residual_value=$6,
                    disposal_reversed_at=NULL, disposal_reversed_by=NULL, disposal_reversal_reason=NULL,
                    updated_at=now()
              WHERE id=$1 AND tenant_id=$2`,
            [id, tenantId, auth.username ?? auth.role ?? 'system', b.reason, b.method ?? null, b.residual_value ?? null],
          );
          await emitDomainEvent(client, {
            tenantId, entityType: 'asset', entityId: id, type: 'asset_dispose',
            actor: auth.username ?? auth.role ?? 'system',
            payload: { reason: b.reason, method: b.method ?? null, residual_value: b.residual_value ?? null, previous_status: a.status, batch: true },
          });
          updated++;
          continue;
        }
        const patch = b.patch ?? {};
        const sets: string[] = [];
        const params: unknown[] = [id, tenantId];
        const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
        const fields: Array<keyof typeof patch> = [
          'name', 'model', 'pinyin', 'location', 'status', 'has_sno', 'sno',
          'financial_category', 'price', 'supplier', 'purchase_date',
          'responsible_user', 'department', 'warranty_until', 'warranty_vendor', 'useful_life_months',
        ];
        for (const f of fields) if (patch[f] !== undefined) set(String(f), patch[f]);
        if (sets.length === 0) { skipped.push({ id, reason: '无变更字段' }); continue; }
        sets.push('updated_at = now()');
        await client.query(`UPDATE asset SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2`, params);
        await emitDomainEvent(client, {
          tenantId, entityType: 'asset', entityId: id, type: 'asset_updated',
          actor: auth.username ?? auth.role ?? 'system',
          payload: { fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined), batch: true },
        });
        if (patch.status !== undefined && patch.status !== a.status) {
          await emitDomainEvent(client, {
            tenantId, entityType: 'asset', entityId: id, type: 'asset_status_changed',
            actor: auth.username ?? auth.role ?? 'system',
            payload: { from: a.status, to: patch.status, batch: true },
          });
        }
        updated++;
      }
      return { updated, skipped };
    });
    return res.json({ ok: true, code: 0, ...result });
  } catch (e) {
    next(e);
  }
});

// ============ 资产附件（元数据落库，文件走 /upload） ============
router.get('/assets/:id/attachments', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      const a = await client.query(`SELECT id FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (a.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      return client
        .query(`SELECT * FROM asset_attachment WHERE tenant_id=$1 AND asset_id=$2 ORDER BY created_at DESC`, [tenantId, req.params.id])
        .then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/assets/:id/attachments', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = z.object({
      name: z.string().min(1).max(200),
      url: z.string().min(1).max(1000),
    }).parse(req.body);

    // 附件 URL 必须是本租户 /uploads 下的真实文件：拒绝外链、跨租户 URL、目录穿越。
    const prefix = `/uploads/${tenantId}/`;
    if (!b.url.startsWith(prefix)) {
      throw new AppError('BAD_PARAM', '附件必须来自本租户上传目录', 400);
    }
    const fileName = b.url.slice(prefix.length);
    const filePath = buildSafeUploadPath(tenantId, fileName);
    if (!filePath) throw new AppError('BAD_PARAM', '附件路径非法', 400);
    const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
    let stat: Awaited<ReturnType<typeof fs.promises.stat>>;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      throw new AppError('NOT_FOUND', '附件文件不存在，请重新上传', 404);
    }
    if (!stat.isFile()) throw new AppError('BAD_PARAM', '附件不是普通文件', 400);
    if (stat.size > UPLOAD_MAX_BYTES) throw new AppError('TOO_LARGE', '附件不能超过 5MB', 413);

    // 先校验权限，再扫描（扫描可能耗时，不占用数据库事务）。
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
    });
    const scan = await scanUploadFile(filePath);
    if (scan.status === 'infected') {
      // 隔离：移出可下载目录，避免 URL 继续可访问；原始上传记录仍可在日志追溯。
      try {
        const qdir = path.join(UPLOAD_ROOT, '.quarantine', tenantId);
        await fs.promises.mkdir(qdir, { recursive: true });
        await fs.promises.rename(filePath, path.join(qdir, fileName));
      } catch (e) {
        console.error('[asset-attachment] quarantine failed', e);
      }
      throw new AppError('ATTACHMENT_INFECTED', '附件安全扫描发现风险，已隔离', 422);
    }
    if (process.env.ASSET_AV_REQUIRED === 'true' && scan.status !== 'clean') {
      throw new AppError('ATTACHMENT_UNSCANNED', '附件未通过病毒扫描，当前环境要求扫描后才可上传', 503);
    }

    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const a = await client.query(`SELECT id FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (a.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const r = await client.query(
        `INSERT INTO asset_attachment
           (tenant_id, asset_id, name, url, content_type, size, uploaded_by, scan_status, scan_engine, scan_detail, scanned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) RETURNING *`,
        [
          tenantId,
          req.params.id,
          b.name,
          b.url,
          mimeForUploadExt(ext),
          stat.size,
          auth.username ?? auth.role ?? 'system',
          scan.status,
          scan.engine,
          scan.detail,
        ],
      );
      await emitDomainEvent(client, {
        tenantId, entityType: 'asset', entityId: req.params.id, type: 'asset_attachment_added',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { attachment_id: r.rows[0].id, name: b.name, scan_status: scan.status },
      });
      return r.rows[0];
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.delete('/assets/attachments/:aid', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const n = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'asset.manage');
      const cur = await client.query(`SELECT asset_id, name FROM asset_attachment WHERE id=$1 AND tenant_id=$2`, [req.params.aid, tenantId]);
      if (cur.rowCount === 0) return 0;
      const r = await client.query(`DELETE FROM asset_attachment WHERE id=$1 AND tenant_id=$2`, [req.params.aid, tenantId]);
      if (r.rowCount) {
        await emitDomainEvent(client, {
          tenantId, entityType: 'asset', entityId: cur.rows[0].asset_id, type: 'asset_attachment_deleted',
          actor: auth.username ?? auth.role ?? 'system',
          payload: { attachment_id: req.params.aid, name: cur.rows[0].name },
        });
      }
      return r.rowCount ?? 0;
    });
    if (n === 0) throw new AppError('NOT_FOUND', 'attachment not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// 单个资产详情（含折旧净值）：列表只返回原始字段，详情按需计算，避免列表被派生字段污染。
router.get('/assets/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(`SELECT * FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      return { ...r.rows[0], depreciation: computeAssetDepreciation(r.rows[0]) };
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

export default router;
