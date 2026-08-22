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
import { AppError } from '../middleware/error.js';
import { createWithIdem } from '../repo/ticket.js';
import { loginRateLimit } from '../middleware/auth.js';
import { matchCategoryHint, resolveFaultCategory, inferPriority, resolveAsset } from '../services/intakeEnrich.js';
import { downloadMedia } from '../services/wechat.js'; // ③ 微信真录音：下载原始 amr 无损耗留存
import { attachmentSchema, reportSchema, CTYPE_EXT, isAudioCType } from './publicReportSchema.js';

const router = Router();

// 合规脱敏钩子（与 #355 SMS_GATEWAY 同一诚实降级模式）：
// 若配置了 MEDIA_MASK_URL（人脸/车牌打码服务），图片上传时 best-effort 调用打码；
// 未配置或调用失败 → 原图直存并诚实标记 masked:false，绝不假装已脱敏。
import https from 'node:https';
import http from 'node:http';
const MEDIA_MASK_URL = process.env.MEDIA_MASK_URL || '';
function postBytes(urlStr: string, buf: Buffer, contentType: string, timeoutMs = 5000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(urlStr); } catch { reject(new Error('bad mask url')); return; }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'Content-Type': contentType, 'Content-Length': buf.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const code = res.statusCode ?? 500;
          if (code >= 200 && code < 300 && chunks.length > 0) resolve(Buffer.concat(chunks));
          else reject(new Error('mask status ' + code));
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('mask timeout')));
    req.write(buf);
    req.end();
  });
}
async function maskImageIfConfigured(buf: Buffer, contentType: string): Promise<{ buf: Buffer; masked: boolean }> {
  if (!MEDIA_MASK_URL || !contentType.startsWith('image/')) return { buf, masked: false };
  try {
    const masked = await postBytes(MEDIA_MASK_URL, buf, contentType);
    return { buf: masked, masked: true };
  } catch {
    return { buf, masked: false }; // 降级：原图直存（诚实标记）
  }
}

// 上传白名单与报修入参 schema 见 ./publicReportSchema.ts（抽到独立模块便于单测）

// 关键词 → 分类 hint 及服务端补全逻辑已抽到 src/services/intakeEnrich.ts（可单测、供复用）

// POST /api/v1/public/repair-report —— 免登录报修（扫码/链接直报）
// DMR 整改 v3：极简输入（描述种子）+ 服务端模型自动补全成完整工单
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

    // org 级每日配额（防跨机构灌单）
    const dailyLimit = Number(tr.rows[0].quota?.repair_daily) || 500;
    const cnt = await pool.query(
      `SELECT count(*)::int AS c FROM work_orders WHERE tenant_id = $1 AND source = 'public_report' AND created_at > now() - interval '1 day'`,
      [tenantId],
    );
    if (cnt.rows[0].c >= dailyLimit) {
      return res.status(429).json({ ok: false, code: 'QUOTA_001', message: '该机构今日报修量已达上限，请稍后再试' });
    }

    // 质量闸门：仅拦截「完全无信息量」的空描述（其余交给模型补全，不硬拒）
    // 支持纯语音/纯图片报修：无描述时用媒体生成标题
    const desc = (b.description ?? '').trim();
    const hasAudio = (b.attachments ?? []).some((a) => a.kind === 'audio') || (b.voice_media_ids?.length ?? 0) > 0;
    const hasImage = (b.attachments ?? []).some((a) => a.kind === 'image');
    const title = desc
      ? desc.length > 20 ? desc.slice(0, 20) + '…' : desc
      : hasAudio && hasImage ? '现场报修（含录音与照片）'
      : hasAudio ? '现场报修（含录音）'
      : hasImage ? '现场报修（含照片）'
      : '现场报修';
    const location = b.location?.trim() || '待核实';

    // ③ 微信真录音：voice_media_ids(serverId) → 服务端经微信媒体接口下载原始 amr 无损耗留存。
    // best-effort：下载失败不阻断建单（录音可重录），但必须留错误日志便于排查（诚实降级，绝不假装已留存）。
    const finalAttachments: NonNullable<typeof b.attachments> = [...(b.attachments ?? [])];
    if (b.voice_media_ids && b.voice_media_ids.length) {
      const root = process.env.UPLOAD_DIR ?? '/opt/youfu/uploads';
      const dir = path.join(root, tenantId);
      fs.mkdirSync(dir, { recursive: true });
      for (const mediaId of b.voice_media_ids) {
        try {
          const { buf, contentType } = await downloadMedia(mediaId);
          const ext = CTYPE_EXT[contentType] || 'amr';
          const name = `${crypto.randomUUID()}.${ext}`;
          fs.writeFileSync(path.join(dir, name), buf);
          finalAttachments.push({ kind: 'audio', url: `/uploads/${tenantId}/${name}`, name: '微信录音', size: buf.length });
          console.log('[wechat-voice] saved mediaId=%s size=%d', mediaId, buf.length);
        } catch (e) {
          console.error('[wechat-voice] download failed mediaId=%s err=%s', mediaId, (e as Error).message);
        }
      }
    }

    const result = await withTenantClient(tenantId, async (client) => {
      // 分类：前端显式指定则校验归属，否则服务端推断（无描述时返回待分类）
      let catalogId: string | undefined = b.catalog;
      let catalogName: string | undefined;
      if (b.catalog) {
        const cat = await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM fault_category WHERE id = $1 AND tenant_id = $2 AND enabled = true LIMIT 1`,
          [b.catalog, tenantId],
        );
        if (cat.rowCount === 0) throw new AppError('BAD_DATA', '所选问题类型无效，请刷新后重试', 400);
        catalogName = cat.rows[0].name;
      } else {
        const inferred = await resolveFaultCategory(client, tenantId, desc);
        catalogId = inferred?.id;
        catalogName = inferred?.name;
      }
      // 优先级推断（模型：关键词；无描述默认 normal）
      const priority = inferPriority(desc);
      // 关联资产推断（描述命中资产名/编号 → 绑定，工单更完整可追溯）
      const asset = await resolveAsset(client, tenantId, desc);

      const { row, created } = await createWithIdem(client, {
        id: crypto.randomUUID(),
        tenantId,
        businessType: 'repair',
        catalog: catalogId,
        priority,
        location,
        title,
        description: desc || undefined,
        contact: b.phone ?? undefined,
        reporterName: b.name ?? undefined,
        source: 'public_report',
        assets: asset ? [asset.id] : undefined,
        ext: {
          source_channel: 'public_report',
          category_hint: matchCategoryHint(desc),
          // 无损耗原始媒体附件：随工单整行流转（任何读取 work_orders 的接口都带出 ext）
          attachments: finalAttachments,
          images: finalAttachments.filter((a) => a.kind === 'image').map((a) => a.url), // 兼容旧逻辑
          inferred: { category: catalogName ?? null, priority, asset: asset?.name ?? null },
          // 合规硬护栏：隐私授权与留存策略（提交即同意，落库即留痕）
          consent: true,
          consent_at: new Date().toISOString(),
          retention: {
            days: Number(process.env.REPAIR_RETENTION_DAYS || 365),
            purge_after: new Date(Date.now() + Number(process.env.REPAIR_RETENTION_DAYS || 365) * 864e5).toISOString().slice(0, 10),
            basis: '《隐私与录音照片留存告知》：原始记录用于分类/派单/追溯，届满统一清理',
          },
        },
        // 幂等（前端 Idempotency-Key header，防重复提交重复建单）
        idempotencyKey: (req.header('Idempotency-Key') as string | undefined) || undefined,
      });
      return { row, created, catalogName, priority, assetName: asset?.name ?? null };
    });

    return res.status(result.created ? 201 : 200).json({
      ok: true, code: 0,
      id: result.row.id, order_no: result.row.order_no, status: result.row.status,
      org_name: tr.rows[0].name,
      filled: {
        category: result.catalogName ?? null,
        priority: result.priority,
        asset: result.assetName,
        location,
      },
      // 无损耗原始媒体附件随工单返回（前端可播放/查看）
      attachments: finalAttachments,
      note: '报修已提交，系统已自动补全工单信息',
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

// POST /api/v1/public/upload —— 免登录报修媒体上传（图片 / 录音，base64 JSON，限流+白名单）
// 复用 B0 上传模式（base64 → 落盘 /opt/youfu/uploads/{org}/{uuid}.{ext} → 公开 URL）
// 无损耗：原文件直存，不转码、不压缩；图片 ≤5MB，录音 ≤20MB；返回 kind/size 供前端展示
router.post('/public/upload', loginRateLimit(20), async (req, res, next) => {
  try {
    const org = (req.query.org as string) || '';
    const body = z.object({
      filename: z.string().max(100).optional(),
      contentType: z.string().max(50),
      base64: z.string().min(10).max(30_000_000), // 含音频(≤20MB)base64 余量
    }).parse(req.body);
    if (!org) return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '缺少机构' });
    const ext = CTYPE_EXT[body.contentType];
    if (!ext) return res.status(415).json({ ok: false, code: 'BAD_TYPE', message: '仅支持图片/音频（jpg/png/gif/webp/pdf/m4a/mp3/wav/ogg/webm/amr）' });
    const buf = Buffer.from(body.base64, 'base64');
    const isAudio = isAudioCType(body.contentType);
    const maxBytes = isAudio ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
    if (buf.length > maxBytes) return res.status(413).json({ ok: false, code: 'TOO_LARGE', message: isAudio ? '录音超过 20MB 上限' : '图片超过 5MB 上限' });
    // 合规脱敏：图片 best-effort 打码（未配置 MEDIA_MASK_URL 或失败 → 原图直存，诚实标记 masked）
    const { buf: outBuf, masked } = await maskImageIfConfigured(buf, body.contentType);
    const root = process.env.UPLOAD_DIR ?? '/opt/youfu/uploads';
    const dir = path.join(root, org);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(dir, name), outBuf);
    return res.status(201).json({ ok: true, code: 0, url: `/uploads/${org}/${name}`, kind: isAudio ? 'audio' : 'image', size: outBuf.length, masked });
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
