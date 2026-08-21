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
  phone: z.string().min(5).max(20),        // 电话（必填，D3 追溯）
  location: z.string().min(1).max(128),    // 位置（必填）
  description: z.string().min(1).max(500), // 问题描述（必填，D3 长度硬拒）
  catalog: z.string().max(64).optional(),  // 分类 code（fault_category）
  priority: z.enum(['low', 'normal', 'urgent']).default('normal'),
});

// POST /api/v1/public/repair-report —— 免登录报修（扫码/链接直报）
router.post('/public/repair-report', loginRateLimit(), async (req, res, next) => {
  try {
    const b = reportSchema.parse(req.body);
    // 机构归属校验（防伪造 org）
    const tr = await pool.query(
      `SELECT tenant_id, name, category FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`,
      [b.org],
    );
    if (tr.rowCount === 0) {
      return res.status(404).json({ ok: false, code: 'ORG_404', message: '机构不存在或未启用' });
    }
    const tenantId = b.org;

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
        source: 'wechat', // 扫码/链接即报（H5 移动端来源）
        ext: { source_channel: 'public_report' },
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
router.get('/public/fault-categories', loginRateLimit(), async (req, res, next) => {
  try {
    const org = (req.query.org as string) || '';
    if (!org) return res.json({ ok: true, code: 0, items: [] });
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
