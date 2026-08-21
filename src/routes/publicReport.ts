// P1 需求侧：public 免登录报修端点（扫码即报，机构归属）。
// 挂载在 authMiddleware 之前（server.ts 前缀 /api），不走租户 JWT：
//   org=tenant_id 显式指定机构（扫码 URL 带参）→ 服务端查 tenant_registry（active）防伪造
// 安全：loginRateLimit 限流 + D3 质量硬拒 + org 白名单。
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import pool from '../db/pool.js';
import { withTenantClient } from '../db/pool.js';
import { validateIntake } from '../services/dataQuality.js';
import { AppError } from '../middleware/error.js';
import { createWithIdem } from '../repo/ticket.js';
import { loginRateLimit } from '../middleware/auth.js';

const router = Router();

const reportSchema = z.object({
  org: z.string().min(3).max(64),          // tenant_id（扫码 URL 带）
  name: z.string().min(1).max(32).optional(), // 报修人姓名（可选，电话必填做追溯）
  // 审查修复 P2：public 免登录电话硬拒（11 位手机，D3 仅为软提示在此场景不够严）
  phone: z.string().regex(/^1\d{10}$/, '联系电话应为 11 位手机号'),
  location: z.string().min(1).max(128),    // 位置（必填）
  description: z.string().min(1).max(500), // 问题描述（必填，D3 长度硬拒）
  catalog: z.string().uuid().optional(),  // 分类 id（fault_category uuid，防类型错误）
  priority: z.enum(['low', 'normal', 'urgent']).default('normal'),
});

// POST /api/v1/public/repair-report —— 免登录报修（扫码/链接直报）
router.post('/public/repair-report', loginRateLimit(20), async (req, res, next) => {
  try {
    const b = reportSchema.parse(req.body);
    // 机构归属校验（防伪造 org）
    const tr = await pool.query(
      `SELECT tenant_id, name, category, quota FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`,
      [b.org],
    );
    if (tr.rowCount === 0) {
      return res.status(404).json({ ok: false, code: 'ORG_404', message: '机构不存在或未启用' });
    }
    const tenantId = b.org;

    // 审查修复 P1：org 级每日配额（防跨机构灌单；quota 默认 500 单/日，超限 429）
    const dailyLimit = Number(tr.rows[0].quota?.repair_daily) || 500;
    const cnt = await pool.query(
      `SELECT count(*)::int AS c FROM work_orders WHERE tenant_id = $1 AND source = 'wechat' AND created_at > now() - interval '1 day'`,
      [tenantId],
    );
    if (cnt.rows[0].c >= dailyLimit) {
      return res.status(429).json({ ok: false, code: 'QUOTA_001', message: '该机构今日报修量已达上限，请稍后再试' });
    }

    // D3 质量硬拒（免登录场景软提示升级为硬拒，保数据源头质量）
    const title = b.description.length > 20 ? b.description.slice(0, 20) + '…' : b.description;
    const q = validateIntake({
      title,
      location: b.location,
      reporter_phone: b.phone,
      contact: b.phone,
    });
    if (!q.ok) {
      return res.status(400).json({ ok: false, code: 'BAD_DATA', message: '报修信息质量校验未通过', issues: q.issues });
    }

    const result = await withTenantClient(tenantId, async (client) => {
      // 审查修复 P4：catalog 存在性 + 租户归属校验（防脏分类/跨机构分类）
      if (b.catalog) {
        const cat = await client.query(
          `SELECT 1 FROM fault_category WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
          [b.catalog, tenantId],
        );
        if (cat.rowCount === 0) {
          throw new AppError('BAD_DATA', '所选问题类型无效，请刷新后重试', 400);
        }
      }
      const { row, created } = await createWithIdem(client, {
        id: crypto.randomUUID(),
        tenantId,
        businessType: 'repair',
        catalog: b.catalog ?? undefined,
        priority: b.priority,
        location: b.location,
        title: q.normalized_title || title,
        description: b.description,
        contact: b.phone,
        reporterName: b.name ?? undefined,
        source: 'public_report', // 审查修复 P7：诚实标注来源（不预设 wechat）
        ext: { source_channel: 'public_report' },
        // 审查修复 P3：幂等（前端 Idempotency-Key header，防重复提交重复建单）
        idempotencyKey: (req.header('Idempotency-Key') as string | undefined) || undefined,
      });
      return { row, created };
    });

    return res.status(result.created ? 201 : 200).json({
      ok: true, code: 0,
      id: result.row.id, order_no: result.row.order_no, status: result.row.status,
      org_name: tr.rows[0].name,
      note: '报修已提交',
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/public/fault-categories?org= —— 报修页分类下拉（免登录只读，限流）
router.get('/public/fault-categories', loginRateLimit(30), async (req, res, next) => {
  try {
    const org = (req.query.org as string) || '';
    if (!org) return res.json({ ok: true, code: 0, items: [] });
    // 审查修复 P6：与 repair-report 一致——仅 active 机构可读分类（防枚举）
    const tr = await pool.query(`SELECT 1 FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`, [org]);
    if (tr.rowCount === 0) return res.json({ ok: true, code: 0, items: [] });
    const r = await pool.query(
      `SELECT id, name FROM fault_category WHERE tenant_id = $1 AND enabled = true ORDER BY sort, name LIMIT 200`,
      [org],
    );
    return res.json({ ok: true, code: 0, items: r.rows });
  } catch (e) {
    next(e);
  }
});

export default router;
