// 服务反馈模块（批次 B · PRD §D）：满意度/意见提交，轻量无派单，后台统计归类。
// 提交仅需登录（患者/用户），回复/导出需 feedback.manage（默认 admin/operator，租户可按角色授予）。
// 契约 snake_case 对齐 013 表（含 reply 列）。
// B1 统一事件总线：提交/回复 emit domain_event（过程挖掘统一数据源）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { csvHeader, csvRowLine, csvDateTime, type CsvField } from '../services/csvUtil.js';

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

// 安全修复（2026-11）：列表端点此前**零权限校验**——任何登录用户（含 worker）都能拉到
// 全租户反馈正文、图片 URL、录音 URL。PC 前端菜单虽用 feedback.manage 挡了，但那是前端门，
// API 层裸奔。此处补 feedback.manage，写法与同文件 POST /:id/reply、GET /export 一致
// （守卫必须在 withTenantClient 内调用——requirePermission 需要 DB client 查 role_permission）。
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
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'feedback.manage'); // 反馈列表属管理面
      const r = await client.query(
        `SELECT * FROM feedback WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
        params,
      );
      return r.rows;
    });
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
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'feedback.manage');
      const b = z.object({ reply: z.string().min(1) }).parse(req.body);
      const cur = await client.query(`SELECT * FROM feedback WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'feedback not found', 404);
      // 关闭是终态：回复不得把已关闭反馈悄悄改回 replied（否则“关闭”形同虚设）。
      if (cur.rows[0].status === 'closed') {
        throw new AppError('CONFLICT', '反馈已关闭，不可再回复；如需跟进请新建反馈', 409);
      }
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

// 关闭反馈（2026-11-14）：new/replied → closed，留痕关闭人/时间/说明。
// 为什么单独端点：回复≠结案——回复后仍可能继续跟进；关闭是明确的终态，便于列表收口与统计。
router.post('/:id/close', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'feedback.manage');
      const cur = await client.query(`SELECT * FROM feedback WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'feedback not found', 404);
      if (cur.rows[0].status === 'closed') throw new AppError('CONFLICT', '反馈已关闭，不可重复关闭', 409);
      const r = await client.query(
        `UPDATE feedback
            SET status='closed', closed_at=now(), closed_by=$3, close_note=$4
          WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, res.locals.auth.username ?? 'unknown', b.note ?? null],
      );
      await emitDomainEvent(client, { tenantId, entityType: 'feedback', entityId: req.params.id, type: 'close', actor: 'config_role' });
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 安全修复（2026-11）：统计端点与列表同病——此前零权限校验，任何登录用户可拉全租户满意度聚合。
// 补 feedback.manage，与列表 / 回复 / 导出三处同口径。
router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'feedback.manage'); // 反馈统计属管理面
      const r = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE type = 'satisfaction') AS satisfaction_count,
           COUNT(*) FILTER (WHERE type = 'opinion') AS opinion_count,
           COUNT(*) FILTER (WHERE status = 'new') AS new_count,
           COUNT(*) FILTER (WHERE status = 'replied') AS replied_count,
           COUNT(*) FILTER (WHERE status = 'closed') AS closed_count,
           COALESCE(AVG(rating) FILTER (WHERE type = 'satisfaction' AND rating IS NOT NULL), 0) AS avg_rating
         FROM feedback WHERE tenant_id = $1`,
        [tenantId],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, stats });
  } catch (e) {
    next(e);
  }
});

// ============ 反馈 CSV 导出（UOne H 导出） ============
const FEEDBACK_CSV_FIELDS: CsvField[] = [
  { key: 'created_at', label: '提交时间', export: (r) => csvDateTime(r.created_at) },
  { key: 'type', label: '类型', export: (r) => (r.type === 'satisfaction' ? '满意度' : '意见') },
  { key: 'content', label: '内容' },
  { key: 'rating', label: '评分' },
  { key: 'status', label: '状态', export: (r) => (r.status === 'closed' ? '已关闭' : r.status === 'replied' ? '已回复' : '待处理') },
  { key: 'channel', label: '渠道', export: (r) => (r.channel === 'mobile' ? '移动端' : r.channel === 'desk' ? '后台' : r.channel || '') },
  { key: 'reply', label: '回复内容' },
  { key: 'replied_at', label: '回复时间', export: (r) => csvDateTime(r.replied_at) },
  { key: 'closed_at', label: '关闭时间', export: (r) => csvDateTime(r.closed_at) },
  { key: 'closed_by', label: '关闭人' },
  { key: 'close_note', label: '关闭说明' },
];

router.get('/export', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'feedback.manage'); // R9-F1：导出属管理面
      return client
        .query(`SELECT * FROM feedback WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId])
        .then((r) => r.rows);
    });
    const lines = [csvHeader(FEEDBACK_CSV_FIELDS)];
    for (const row of items) lines.push(csvRowLine(row, FEEDBACK_CSV_FIELDS));
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="feedback.csv"');
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

export default router;
