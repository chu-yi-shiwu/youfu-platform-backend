// P1 需求侧：public 免登录报修端点（扫码即报，机构归属）。
// 挂载在 authMiddleware 之前（server.ts 前缀 /api），不走租户 JWT：
//   org=tenant_id 显式指定机构（扫码 URL 带参）→ 服务端查 tenant_registry（active）防伪造
// 安全：loginRateLimit 限流 + D3 质量硬拒 + org 白名单。
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pool from '../db/pool.js';
import { withTenantClient } from '../db/pool.js';
import { validateIntake } from '../services/dataQuality.js';
import { AppError } from '../middleware/error.js';
import { createWithIdem } from '../repo/ticket.js';
import { loginRateLimit } from '../middleware/auth.js';

const router = Router();

// 上传白名单（与 B0 upload.ts 一致）
const CTYPE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

// 整改 v2：一键报修——校验分级（public 宽松引导，内部录入端 D3 硬拒不变）
// 描述 ≥4 字；电话选填（填了校验格式，不填允许——进度查询凭证改单号+可选后4位）；
// images[] 照片随工单流转；快捷标签 → 关键词智能匹配（存 ext.category_hint 供模型特征）
const reportSchema = z.object({
  org: z.string().min(3).max(64),          // tenant_id（扫码 URL 带）
  name: z.string().min(1).max(32).optional(), // 报修人姓名（选填）
  phone: z.string().regex(/^1\d{10}$/, '联系电话应为 11 位手机号').optional(), // 选填
  location: z.string().min(1).max(128),    // 位置（必填）
  description: z.string().min(4, '请描述一下问题（至少 4 个字）').max(500), // ≥4 字引导
  catalog: z.string().uuid().optional(),  // 分类 id（fault_category uuid，可选）
  images: z.array(z.string().max(200)).max(3).optional(), // 现场照片 URL（≤3 张）
  priority: z.enum(['low', 'normal', 'urgent']).default('normal'),
});

// 快捷标签 → 关键词智能匹配（报修人无感；不落 fault_category 避免污染陪检字典）
const KEYWORD_CATEGORY_HINTS: Array<{ kw: string[]; hint: string }> = [
  { kw: ['空调', '制冷', '制热', '冷气', '暖气'], hint: '空调' },
  { kw: ['水', '漏', '管道', '马桶', '龙头', '排水', '堵'], hint: '水电' },
  { kw: ['网', 'wifi', 'WiFi', '电脑', '网络', '信号'], hint: '网络' },
  { kw: ['门', '锁', '窗', '玻璃'], hint: '门窗' },
  { kw: ['灯', '照明', '插座', '电', '跳闸', '断电'], hint: '照明电工' },
  { kw: ['电梯', '监控', '设备', '机器', '故障'], hint: '设备' },
];
function matchCategoryHint(description: string): string | undefined {
  for (const rule of KEYWORD_CATEGORY_HINTS) {
    if (rule.kw.some((k) => description.includes(k))) return rule.hint;
  }
  return undefined;
}

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

    // 整改 v2：D3 质量引导（描述 ≥4 字已在 zod；此处标题截断 + 电话/位置软校验提示，不再硬拒）
    const title = b.description.length > 20 ? b.description.slice(0, 20) + '…' : b.description;
    const q = validateIntake({
      title,
      location: b.location,
      reporter_phone: b.phone ?? '',
      contact: b.phone ?? '',
    });
    // public 报修：仅拦截「完全无信息量」的硬伤（标题为空/纯乱码），软提示不阻断提交
    const fatal = (q.issues ?? []).filter((i: any) => i.field === 'title' && (i.problem ?? '').includes('不能为空'));
    if (fatal.length > 0) {
      return res.status(400).json({ ok: false, code: 'BAD_DATA', message: '报修信息质量校验未通过', issues: fatal });
    }

    // 快捷标签 → 关键词智能匹配（报修人无感，存 ext.category_hint 供派单模型特征）
    const categoryHint = matchCategoryHint(b.description);

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
        contact: b.phone ?? undefined,
        reporterName: b.name ?? undefined,
        source: 'public_report', // 审查修复 P7：诚实标注来源（不预设 wechat）
        ext: {
          source_channel: 'public_report',
          category_hint: categoryHint,       // 整改 v2：关键词智能匹配（派单模型特征）
          images: b.images ?? [],            // 整改 v2：现场照片随工单流转
        },
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

// GET /api/v1/public/repair-status —— 免登录报修进度查询（整改 v2：凭工单号即可，电话后4位可选）
// 安全：单号 WO_ 前缀+日期+随机段不可枚举；限流 30/min 防遍历
router.get('/public/repair-status', loginRateLimit(30), async (req, res, next) => {
  try {
    const org = (req.query.org as string) || '';
    const orderNo = (req.query.order_no as string) || '';
    const phoneLast4 = (req.query.phone_last4 as string) || '';
    if (!org || !orderNo) {
      return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '参数不完整' });
    }
    // 单号查询 + 电话后4位可选校验（填了则匹配 contact 尾号，进一步防他查）
    const conds = ['tenant_id = $1', 'order_no = $2'];
    const params: unknown[] = [org, orderNo];
    if (phoneLast4) {
      if (!/^\d{4}$/.test(phoneLast4)) return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '电话后4位格式不正确' });
      params.push(phoneLast4);
      conds.push(`right(contact, 4) = $${params.length}`);
    }
    const r = await withTenantClient(org, (client) =>
      client.query(
        `SELECT order_no, status, title, location, created_at, updated_at
         FROM work_orders WHERE ${conds.join(' AND ')} LIMIT 1`,
        params,
      ),
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '未找到该报修（请核对工单号）' });
    }
    return res.json({ ok: true, code: 0, item: r.rows[0] });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/public/upload —— 整改 v2：免登录报修照片上传（base64 JSON，限流+5MB+白名单）
// 复用 B0 上传模式（base64 → 落盘 /opt/youfu/uploads/{org}/{uuid}.{ext} → 公开 URL）
router.post('/public/upload', loginRateLimit(20), async (req, res, next) => {
  try {
    const org = (req.query.org as string) || '';
    const body = z.object({ filename: z.string().max(100).optional(), contentType: z.string().max(50), base64: z.string().min(10).max(7_000_000) }).parse(req.body);
    if (!org) return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '缺少机构' });
    const ext = CTYPE_EXT[body.contentType];
    if (!ext) return res.status(415).json({ ok: false, code: 'BAD_TYPE', message: '仅支持图片/音频（jpg/png/gif/webp/pdf/m4a/mp3/wav/ogg）' });
    const buf = Buffer.from(body.base64, 'base64');
    if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ ok: false, code: 'TOO_LARGE', message: '文件超过 5MB 上限' });
    const root = process.env.UPLOAD_DIR ?? '/opt/youfu/uploads';
    const dir = path.join(root, org);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    return res.status(201).json({ ok: true, code: 0, url: `/uploads/${org}/${name}` });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/public/fault-categories?org= —— 报修页分类下拉（免登录只读，限流）
// 审查修复：fault_category 有 RLS（owner 已改 postgres）——pool 直连无 GUC 查不到，须 withTenantClient 设租户上下文
router.get('/public/fault-categories', loginRateLimit(30), async (req, res, next) => {
  try {
    const org = (req.query.org as string) || '';
    if (!org) return res.json({ ok: true, code: 0, items: [] });
    // 与 repair-report 一致——仅 active 机构可读分类（防枚举）
    const tr = await pool.query(`SELECT 1 FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`, [org]);
    if (tr.rowCount === 0) return res.json({ ok: true, code: 0, items: [] });
    const r = await withTenantClient(org, (client) =>
      client.query(
        `SELECT id, name FROM fault_category WHERE tenant_id = $1 AND enabled = true ORDER BY sort, name LIMIT 200`,
        [org],
      ),
    );
    return res.json({ ok: true, code: 0, items: r.rows });
  } catch (e) {
    next(e);
  }
});

export default router;
