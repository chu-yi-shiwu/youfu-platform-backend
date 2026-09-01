// 服务反馈模块（批次 B · PRD §D）：满意度/意见提交，轻量无派单，后台统计归类。
// 提交仅需登录（患者/用户），回复需 admin/operator。契约 snake_case 对齐 013 表（含 reply 列）。
// B1 统一事件总线：提交/回复 emit domain_event（过程挖掘统一数据源）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { csvEscape } from '../services/csvUtil.js';

const router = Router();

const submitSchema = z.object({
  type: z.enum(['satisfaction', 'opinion']).default('opinion'),
  content: z.string().min(1),
  rating: z.number().int().min(1).max(5).optional(),
  images: z.array(z.string()).optional(),
  audio: z.string().optional(),
  channel: z.enum(['mobile', 'desk']).default('mobile'),
  // P1 归因桥接：可选工单号（order_no），服务端解析为 work_order_id（校验租户）
  work_order_no: z.string().optional(),
});

router.get('/', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { type, status } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
    };
    if (type) add('type = ?', type);
    if (status) add('status = ?', status);
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM feedback WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = submitSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      // P1 归因桥接：order_no → work_order_id（校验租户；不存在则忽略）
      let woId: string | null = null;
      if (b.work_order_no) {
        const wo = await client.query('SELECT id FROM work_orders WHERE tenant_id=$1 AND order_no=$2 LIMIT 1', [tenantId, b.work_order_no.trim()]);
        if (wo.rows.length > 0) woId = wo.rows[0].id;
      }
      const r = await client.query(
        `INSERT INTO feedback (tenant_id, type, content, rating, images, audio, channel, status, work_order_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'new',$8) RETURNING *`,
        [tenantId, b.type, b.content, b.rating ?? null, b.images ? JSON.stringify(b.images) : '[]', b.audio ?? null, b.channel, woId],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'feedback',
        entityId: row.id,
        type: 'submit',
        actor: 'user',
        payload: { feedback_type: b.type, rating: b.rating ?? null, work_order_id: woId },
      });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/reply', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ reply: z.string().min(1) }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM feedback WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'feedback not found', 404);
      const r = await client.query(
        `UPDATE feedback SET status = 'replied', reply = $3, replied_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId, b.reply],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'feedback', entityId: row.id, type: 'reply', actor: 'config_role' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT
             COUNT(*) FILTER (WHERE type = 'satisfaction') AS satisfaction_count,
             COUNT(*) FILTER (WHERE type = 'opinion') AS opinion_count,
             COUNT(*) FILTER (WHERE status = 'new') AS new_count,
             COUNT(*) FILTER (WHERE status = 'replied') AS replied_count,
             COALESCE(AVG(rating) FILTER (WHERE type = 'satisfaction' AND rating IS NOT NULL), 0) AS avg_rating
           FROM feedback WHERE tenant_id = $1`,
          [tenantId],
        )
        .then((r) => r.rows[0]),
    );
    return res.json({ ok: true, code: 0, stats });
  } catch (e) {
    next(e);
  }
});

// ============ 反馈 CSV 导出（UOne H 导出） ============
const FEEDBACK_CSV_COLS = ['created_at', 'type', 'content', 'rating', 'status', 'channel', 'reply', 'replied_at'];
router.get('/export', async (req, res, next) => {
  try {
    requireConfigRole(req, res); // R9-F1：导出属管理面，仅 admin/operator
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM feedback WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId])
        .then((r) => r.rows),
    );
    const lines = [FEEDBACK_CSV_COLS.join(',')];
    for (const row of items) {
      lines.push(FEEDBACK_CSV_COLS.map((h) => csvEscape((row as any)[h])).join(','));
    }
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="feedback.csv"');
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

export default router;
