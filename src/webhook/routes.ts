// Webhook 管理路由（P5 对外投递）：订阅/列表/停用/投递查询/探针。
// 全部位于 /api/v1 下，受 authMiddleware（/api）保护，按租户隔离（RLS）。
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { probeWebhook, assertSafeOutboundUrl } from './dispatch.js';
import { requireConfigRole } from '../middleware/role.js';

const router = Router();

const subscribeSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).optional(),
  secret: z.string().min(8).optional(),
});

// POST /api/v1/webhooks/subscriptions —— 注册订阅（secret 缺省自动生成，仅创建时返回一次）
router.post('/webhooks/subscriptions', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const body = subscribeSchema.parse(req.body);
    // SSRF 前置闸（F-E2）：注册即拒绝私网/环回/链路本地（含云元数据）地址，提早反馈
    try {
      await assertSafeOutboundUrl(body.url);
    } catch (e) {
      // R31-QC（2026-08-31 审查）：不把 SSRF guard 内部细节（e.message）回给客户端——
      // 已登录用户可借此探测内网校验逻辑；细节仅进服务端日志。
      console.warn('[webhook subscribe] url blocked by SSRF guard', { url: body.url, err: e });
      return res.status(400).json({
        ok: false,
        code: 1,
        message: 'webhook url blocked (private/loopback/metadata)',
      });
    }
    const secret = body.secret ?? crypto.randomBytes(24).toString('hex');
    const events = body.events && body.events.length ? body.events : ['*'];
    const row = await withTenantClient(tenantId, async (client) => {
      const r = await client.query<{ id: string; url: string; events: string[]; active: boolean }>(
        `INSERT INTO webhook_subscription (tenant_id, url, secret, events, active)
         VALUES ($1,$2,$3,$4,true) RETURNING id, url, events, active`,
        [tenantId, body.url, secret, events],
      );
      return r.rows[0];
    });
    return res.status(201).json({
      ok: true,
      code: 0,
      id: row.id,
      url: row.url,
      events: row.events,
      active: row.active,
      secret, // 仅创建时返回；后续 GET 列表不返回明文 secret
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/webhooks/subscriptions —— 列出本租户订阅（不泄露 secret）
router.get('/webhooks/subscriptions', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const rows = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `SELECT id, url, events, active, created_at FROM webhook_subscription
         WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId],
      );
      return r.rows;
    });
    return res.json({ ok: true, code: 0, items: rows });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/v1/webhooks/subscriptions/:id —— 软停用（不物理删除，保留投递记录关联）
router.delete('/webhooks/subscriptions/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    await withTenantClient(tenantId, async (client) => {
      await client.query(
        `UPDATE webhook_subscription SET active = false WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
    });
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/webhooks/deliveries —— 最近投递记录（可观测/排错）
router.get('/webhooks/deliveries', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const rows = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `SELECT id, subscription_id, event_type, work_order_id, status_code, error, delivered_at
         FROM webhook_delivery WHERE tenant_id = $1 ORDER BY delivered_at DESC LIMIT $2`,
        [tenantId, limit],
      );
      return r.rows;
    });
    return res.json({ ok: true, code: 0, items: rows });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/webhooks/test —— 探针：向指定 URL 发一次 webhook_test，校验可达性与签名
router.post('/webhooks/test', async (req, res, next) => {
  try {
    const schema = z.object({ url: z.string().url(), secret: z.string().min(8).optional() });
    const { url, secret } = schema.parse(req.body);
    const result = await probeWebhook(url, secret);
    return res.json({
      ok: true,
      code: 0,
      status_code: result.statusCode,
      error: result.error,
      verified: result.statusCode != null && result.statusCode < 500,
      sample_signature: result.signature,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
