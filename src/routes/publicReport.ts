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
import { matchCategoryHint, resolveFaultCategory, inferPriority, resolveAsset, generateTitle } from '../services/intakeEnrich.js';
import { llmInferCategory } from '../services/llm.js';
import { getLlmEnabled } from '../repo/tenantSettings.js';
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
    // ④ 回收闭环：为每单生成不可枚举的公开查看凭证（view_token），用户凭其在「我的报修」查看并重纠偏
    const viewToken = crypto.randomBytes(24).toString('hex');

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
    // 语音直译失败标记（方言/噪声/识别不清）：前端显式声明，用于主题诚实降级
    const voiceUnclear = Boolean(b.voice_unclear);
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
      // LLM 语义推断（B 档）：租户已授权 + 有描述 → 调 DeepSeek；失败/未授权返回 null → 走 A 档规则
      let llmInferred: { category: string | null; priority: string | null; asset: string | null } | null = null;
      if (desc && (await getLlmEnabled(tenantId))) {
        const catNames = (
          await client.query<{ name: string }>(
            `SELECT name FROM fault_category WHERE tenant_id = $1 AND enabled = true`,
            [tenantId],
          )
        ).rows.map((r) => r.name);
        llmInferred = await llmInferCategory(desc, catNames);
      }

      // 分类：前端显式指定则校验归属，否则 LLM → 规则引擎
      let catalogId: string | undefined = b.catalog;
      let catalogName: string | undefined;
      if (b.catalog) {
        const cat = await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM fault_category WHERE id = $1 AND tenant_id = $2 AND enabled = true LIMIT 1`,
          [b.catalog, tenantId],
        );
        if (cat.rowCount === 0) throw new AppError('BAD_DATA', '所选问题类型无效，请刷新后重试', 400);
        catalogName = cat.rows[0].name;
      } else if (llmInferred && llmInferred.category) {
        // LLM 返回分类名 → 精确匹配到租户分类（匹配不到则保留名称但不绑定 id，诚实标注）
        const m = await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM fault_category WHERE tenant_id = $1 AND enabled = true AND name = $2 LIMIT 1`,
          [tenantId, llmInferred.category],
        );
        if (m.rowCount) {
          catalogId = m.rows[0].id;
          catalogName = m.rows[0].name;
        } else {
          catalogId = undefined;
          catalogName = llmInferred.category;
        }
      } else {
        const inferred = await resolveFaultCategory(client, tenantId, desc);
        catalogId = inferred?.id;
        catalogName = inferred?.name;
      }
      // 优先级：LLM 有结果优先，否则规则引擎
      const llmPriority = llmInferred?.priority as 'urgent' | 'normal' | 'low' | null | undefined;
      let priority: 'urgent' | 'normal' | 'low' =
        llmPriority || inferPriority(desc);
      // 关联资产：LLM 有结果优先，否则规则引擎
      let asset: { id: string; name: string } | null = await resolveAsset(client, tenantId, desc);
      if (llmInferred && llmInferred.asset && !asset) {
        const m = await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM asset WHERE tenant_id = $1 AND (name = $2 OR name ILIKE $3) LIMIT 1`,
          [tenantId, llmInferred.asset, `%${llmInferred.asset}%`],
        );
        if (m.rowCount) asset = { id: m.rows[0].id, name: m.rows[0].name };
      }
      // 主题命名（DMR：从表述提炼，分类前缀兜底，识别失败诚实标记）
      const title = generateTitle({
        description: desc,
        hasAudio,
        hasImage,
        categoryName: catalogName,
        voiceUnclear,
      });

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
          public_view_token: viewToken, // ④ 回收闭环：公开查看/纠偏凭证（capability token）
          // 无损耗原始媒体附件：随工单整行流转（任何读取 work_orders 的接口都带出 ext）
          attachments: finalAttachments,
          images: finalAttachments.filter((a) => a.kind === 'image').map((a) => a.url), // 兼容旧逻辑
          inferred: { category: catalogName ?? null, priority, asset: asset?.name ?? null },
          // ④ 回收闭环：把模型初始补全落库为 ext.filled，使「我的报修」可读到 AI 识别结果，用户再纠偏
          filled: { category: catalogName ?? null, priority, asset: asset?.name ?? null },
          // ⑤ 手机号身份锚点：留存报修人手机（与 contact 列一致），支持换设备凭「手机号+工单号」安全找回
          reporter_phone: b.phone ?? null,
          // 微信用户授权带入的报修人信息：服务侧可明确服务对象（派单/回访）；未授权则为 null
          reporter_nickname: b.nickname ?? null,
          reporter_avatar: b.avatar ?? null,
          // 语音直译诚实标记：识别失败（方言/噪声）时记录，主题不硬猜语义
          stt: { voice_unclear: voiceUnclear, at: new Date().toISOString() },
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
      view_token: viewToken, // ④ 回收闭环：前端存本地，凭此在「我的报修」查看与纠偏
      reporter_phone: b.phone ?? null, // ⑤ 手机号身份锚点：返回报修人，前端脱敏展示并用作找回凭据
      reporter_nickname: b.nickname ?? null, // 微信授权带入：服务侧可明确服务对象
      reporter_avatar: b.avatar ?? null,
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
    // SEC-735 CRITICAL: 校验 org 必须是已激活租户，防路径穿越写任意目录
    const { rows: orgRows } = await pool.query('SELECT 1 FROM tenant_registry WHERE tenant_id = $1 AND status = $2', [org, 'active']);
    if (orgRows.length === 0) {
      return res.status(404).json({ ok: false, code: 'ORG_404', message: '机构不存在或未激活' });
    }
    if (/[/\\]/.test(org) || org.includes('..')) {
      return res.status(400).json({ ok: false, code: 'BAD_ORG', message: 'invalid org' });
    }
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

// ④ 回收闭环 + ⑤ 手机号身份：GET /api/v1/public/my-reports —— 免登录查看本人报修
// 两种凭证任选其一：
//   A) tokens=view_token 列表（主链路，凭本地存储凭证，不可枚举）
//   B) phone + order_no（换设备/清缓存后，凭手机号 + 任一工单号安全找回）
// 安全：org 显式指定；token 不可枚举；phone 路径须先验证 (phone, order_no) 配对所有权，否则静默返回空（不暴露该手机是否有报修）；限流 30/min
router.get('/public/my-reports', loginRateLimit(30), async (req, res, next) => {
  try {
    const org = (req.query.org as string) || '';
    const raw = (req.query.tokens as string) || '';
    const phone = (req.query.phone as string) || '';
    const orderNo = (req.query.order_no as string) || '';
    if (!org) return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '缺少机构' });
    const tr = await pool.query(`SELECT 1 FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`, [org]);
    if (tr.rowCount === 0) return res.json({ ok: true, code: 0, items: [] });

    const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 100);
    let sql: string;
    let params: unknown[];
    if (tokens.length > 0) {
      sql = `SELECT order_no, status, title, description, location, created_at, ext
             FROM work_orders WHERE tenant_id = $1 AND ext->>'public_view_token' = ANY($2::text[])
             ORDER BY created_at DESC LIMIT 200`;
      params = [org, tokens];
    } else if (phone && orderNo) {
      // ⑤ 安全找回：先验证 (phone, order_no) 配对存在（所有权证明）；不存在则静默返回空，不暴露该手机是否有报修
      const proof = await withTenantClient(org, (client) =>
        client.query(
          `SELECT 1 FROM work_orders WHERE tenant_id = $1 AND order_no = $2 AND (ext->>'reporter_phone' = $3 OR contact = $3) LIMIT 1`,
          [org, orderNo, phone],
        ),
      );
      if (proof.rowCount === 0) return res.json({ ok: true, code: 0, items: [] });
      sql = `SELECT order_no, status, title, description, location, created_at, ext
             FROM work_orders WHERE tenant_id = $1 AND (ext->>'reporter_phone' = $2 OR contact = $2)
             ORDER BY created_at DESC LIMIT 200`;
      params = [org, phone];
    } else {
      return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '缺少查询凭证（token 或 手机号+工单号）' });
    }

    const r = await withTenantClient(org, (client) => client.query(sql, params));
    const items = r.rows.map((row: any) => {
      const ext = row.ext || {};
      const filled = ext.filled || {};
      const atts = Array.isArray(ext.attachments) ? ext.attachments : [];
      return {
        order_no: row.order_no,
        status: row.status,
        title: row.title,
        description: row.description || '',
        location: row.location,
        created_at: row.created_at,
        view_token: ext.public_view_token || '',
        reporter_phone: ext.reporter_phone || null, // ⑤ 手机号身份锚点（本人数据，脱敏展示）
        filled: {
          category: filled.category ?? null,
          priority: filled.priority ?? null,
          asset: filled.asset ?? null,
        },
        attachments: atts,
        corrections_count: Array.isArray(ext.corrections) ? ext.corrections.length : 0,
      };
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// ④ 回收闭环：PATCH /api/v1/public/report-correct —— 用户纠偏 AI 自动补全（分类/优先级/资产）+ 反馈入 ext.corrections（共振飞轮）
// 安全：必须持有效 view_token；更新 filled 为「人工校正后真值」，并追加 corrections 记录（不删历史）
const correctSchema = z.object({
  org: z.string().min(2).max(40),
  token: z.string().min(8).max(120),
  category: z.string().max(60).optional(),
  priority: z.enum(['urgent', 'normal', 'low']).optional(),
  asset_name: z.string().max(120).optional(),
  note: z.string().max(300).optional(),
});
router.patch('/public/report-correct', loginRateLimit(20), async (req, res, next) => {
  try {
    const b = correctSchema.parse(req.body);
    const tr = await pool.query(`SELECT 1 FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`, [b.org]);
    if (tr.rowCount === 0) return res.status(404).json({ ok: false, code: 'ORG_404', message: '机构不存在或未启用' });
    const result = await withTenantClient(b.org, async (client) => {
      const cur = await client.query(
        `SELECT id, ext FROM work_orders WHERE tenant_id = $1 AND ext->>'public_view_token' = $2 LIMIT 1`,
        [b.org, b.token],
      );
      if (cur.rowCount === 0) return null;
      const ext = cur.rows[0].ext || {};
      const filled = ext.filled || {};
      if (b.category !== undefined) filled.category = b.category;
      if (b.priority !== undefined) filled.priority = b.priority;
      if (b.asset_name !== undefined) filled.asset = b.asset_name;
      const corrections = Array.isArray(ext.corrections) ? ext.corrections : [];
      corrections.push({
        corrected_at: new Date().toISOString(),
        category: b.category ?? null,
        priority: b.priority ?? null,
        asset_name: b.asset_name ?? null,
        note: b.note ?? null,
      });
      const newExt = { ...ext, filled, corrections };
      await client.query(`UPDATE work_orders SET ext = $1 WHERE id = $2`, [newExt, cur.rows[0].id]);
      return { filled, corrections_count: corrections.length };
    });
    if (!result) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '凭证无效或报修不存在' });
    return res.json({ ok: true, code: 0, filled: result.filled, corrections_count: result.corrections_count });
  } catch (e) {
    next(e);
  }
});

export default router;
