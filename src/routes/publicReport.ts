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
import { loginRateLimit } from '../middleware/auth.js';
import { resolveFaultCategory, inferPriority, resolveAsset } from '../services/intakeEnrich.js'; // /public/infer 规则引擎兜底
import { llmInferCategory } from '../services/llm.js';
import { resolveScanFromDb } from '../scan.js'; // ⑤ 扫码关联：复用 DB 权威解析
import { getLlmEnabled } from '../repo/tenantSettings.js';
import { autoDispatchAfterCreate } from './workOrder.js'; // 2026-08-29：公开报修单复用后台建单的自动派单（修复卡 draft 无通知断链）
import { mpConfigured, decryptPhoneCode, genMpCode } from '../services/wechatMp.js';
import { reportSchema, CTYPE_EXT, isAudioCType } from './publicReportSchema.js';
import { createPublicRepairReport } from '../services/publicReportCreate.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { doneStates } from '../engine/stateMachine.js';
import { emitDomainEvent } from '../db/eventBus.js';

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

// ⑤ 扫码关联（DMR 补充录入通道）：GET /public/scan?org=&code=
// 报修人扫设备码(AST-)/目录码(CAT-)后调用，DB 权威解析出资产/目录并回带 label，
// 前端把 label 展示并回传 asset_code/catalog_code → repair-report 精确关联（不臆造）。
router.get('/public/scan', loginRateLimit(60), async (req, res, next) => {
  try {
    const org = (req.query.org as string || '').trim();
    const raw = (req.query.code as string || '').trim();
    if (!org) return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '缺少机构' });
    if (!raw) return res.json({ ok: true, code: 0, resolved: false, note: '码为空，请重新扫码', qr: '' });
    const tr = await pool.query(`SELECT 1 FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`, [org]);
    if (tr.rowCount === 0) return res.json({ ok: true, code: 0, resolved: false, note: '机构不存在或未启用', qr: raw });
    const r = await resolveScanFromDb(org, raw);
    const a = r.asset;
    return res.json({
      ok: true, code: 0,
      resolved: a.resolved,
      qr: a.qr,
      kind: a.kind ?? null,
      label: a.label ?? null,
      catalog: a.catalog ?? null,
      note: a.note ?? '',
    });
  } catch (e) { next(e); }
});

// POST /api/v1/public/repair-report —— 免登录报修（扫码/链接直报）
// DMR 整改 v3：极简输入（描述种子）+ 服务端模型自动补全成完整工单。
// #935 拆分：建单核心（媒体下载/LLM 事务外推断/扫码/分类链/优先级/资产/ext/派单）
// 抽到 services/publicReportCreate.ts（纯搬运，SQL 与调用序零变化）；本 handler 只留
// 机构归属校验、org 级配额、view_token 生成与响应组装。
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

    const result = await createPublicRepairReport(tenantId, b, {
      // 幂等（前端 Idempotency-Key header，防重复提交重复建单）
      idempotencyKey: (req.header('Idempotency-Key') as string | undefined) || undefined,
      viewToken,
    });
    const { finalAttachments, ...core } = result;

    // ④ 回收闭环：幂等重复提交时 createWithIdem 返回【原工单】（created:false），须回原 view_token，
    // 否则纠偏/自查凭新 token 查不到（🔴 审查修复：之前每次都用新生成的 viewToken，重复提交即断裂）
    const rowExt: any = (core.row as any).ext;
    const storedToken = (rowExt && rowExt.public_view_token) || viewToken;

    return res.status(core.created ? 201 : 200).json({
      ok: true, code: 0,
      id: core.row.id, order_no: core.row.order_no,
      // 2026-08-29：返回自动派单后的真实状态（assigned/claim_hall），前端与「我的报修」不再误显 draft
      status: core.dispatch ? core.dispatch.dispatchTarget : core.row.status,
      auto_flow: core.dispatch?.autoFlow ?? false,
      assignee: core.dispatch?.assignee ?? null,
      view_token: storedToken, // ④ 回收闭环：前端存本地，凭此在「我的报修」查看与纠偏（幂等重复提交回原 token）
      reporter_phone: b.phone ?? null, // ⑤ 手机号身份锚点：返回报修人，前端脱敏展示并用作找回凭据
      reporter_nickname: b.nickname ?? null, // 微信授权带入：服务侧可明确服务对象
      reporter_avatar: b.avatar ?? null,
      org_name: tr.rows[0].name,
      filled: {
        category: core.catalogName ?? null,
        priority: core.priority,
        asset: core.assetName,
        location: core.location,
      },
      // ⑤ 扫码关联回执：前端据此显式告知用户"已关联资产/目录"（诚实：未解析则 resolved:false）
      scan: {
        resolved: core.scanResolved,
        asset_code: b.asset_code ?? null,
        catalog_code: b.catalog_code ?? null,
        asset: core.assetName,
        catalog: core.catalogName ?? null,
        note: core.scanResolved ? '已关联' : (b.asset_code || b.catalog_code ? '未识别到登记资产/目录' : ''),
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
    // 审查修复 #735-CRITICAL：公开上传必须校验机构合法性，防路径穿越写任意目录。
    // 与同文件其它公开端点一致——仅 active 机构允许上传。
    const tr = await pool.query(
      `SELECT 1 FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`,
      [org],
    );
    if (tr.rowCount === 0) {
      return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '机构不存在或未激活' });
    }
    // 纵深防御：机构标识不得含路径分隔符或上级引用（防 org='../../../etc' 穿越）
    if (org.includes('/') || org.includes('\\') || org.includes('..')) {
      return res.status(400).json({ ok: false, code: 'BAD_ORG', message: '非法机构标识' });
    }
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
    await fs.promises.mkdir(dir, { recursive: true });
    const name = `${crypto.randomUUID()}.${ext}`;
    await fs.promises.writeFile(path.join(dir, name), outBuf);
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

// DMR 极致：POST /api/v1/public/infer —— 输入即识别的实时语义推断（提交前预识别）
// 前端语音直译/打字时实时调用：返回分类/优先级/资产（LLM 优先，规则引擎兜底）。
// 设计：报修人零动作——说话/打字即看到"系统识别为：XX"，可确认可纠正；提交时仍走完整推断。
// 合规：只收描述，绝不收手机号/姓名等个人信息；不建单、不落库、无副作用。
// 成本控制：同 (org, description) 30 秒内命中缓存直接返回，避免击键反复调 LLM 烧钱。
const INFER_CACHE = new Map<string, { at: number; body: unknown }>();
const INFER_CACHE_TTL = 30 * 1000;
router.post('/public/infer', loginRateLimit(30), async (req, res, next) => {
  try {
    const { org, description } = z
      .object({
        org: z.string().min(3).max(64),
        description: z.string().min(1).max(500),
      })
      .parse(req.body ?? {});
    const desc = (description || '').trim();
    if (!desc) return res.json({ ok: true, code: 0, source: 'empty', category: null, priority: null, asset: null });
    // 缓存命中直接返回（同描述 30s 内）
    const cacheKey = `${org}\u0001${desc}`;
    const cached = INFER_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.at < INFER_CACHE_TTL) {
      return res.json({ ok: true, code: 0, ...(cached.body as object), cached: true });
    }
    // 仅 active 机构可推断（防枚举）
    const tr = await pool.query(`SELECT 1 FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`, [org]);
    if (tr.rowCount === 0) return res.status(404).json({ ok: false, code: 'TENANT_404', message: '机构不存在或未启用' });

    // R5-BUG-001 修复：LLM 推断移出事务（同 createWithIdem）——避免嵌套取池 + 事务内网络调用耗尽连接池
    let llm: Awaited<ReturnType<typeof llmInferCategory>> = null;
    if (await getLlmEnabled(org)) {
      const catNames = (
        await withTenantClient(org, (client) =>
          client.query<{ name: string }>(
            `SELECT name FROM fault_category WHERE tenant_id = $1 AND enabled = true`,
            [org],
          ),
        )
      ).rows.map((r) => r.name);
      llm = await llmInferCategory(desc, catNames);
    }

    const result = await withTenantClient(org, async (client) => {
      // LLM 优先（租户已授权 + 有 KEY），失败回退规则引擎
      let source: 'llm' | 'rule' = 'rule';
      let categoryName: string | null = null;
      let priority: 'urgent' | 'normal' | 'low' | null = null;
      let assetName: string | null = null;
      let location: string | null = null;
      if (llm) {
        source = 'llm';
        categoryName = llm.category;
        priority = llm.priority;
        assetName = llm.asset;
        location = llm.location ?? null;
      }
      // LLM 未命中/未授权 → 规则引擎（规则引擎不抽 location，交由前端引导/扫码带位置）
      if (source === 'rule') {
        const inferred = await resolveFaultCategory(client, org, desc);
        categoryName = inferred?.name ?? null;
        priority = inferPriority(desc);
        const asset = await resolveAsset(client, org, desc);
        assetName = asset?.name ?? null;
      }
      return { source, category: categoryName, priority, asset: assetName, location };
    });

    // 写缓存 + 防缓存无限增长（超过 500 条清一半）
    INFER_CACHE.set(cacheKey, { at: Date.now(), body: result });
    if (INFER_CACHE.size > 500) {
      const keys = [...INFER_CACHE.keys()];
      for (const k of keys.slice(0, keys.length >> 1)) INFER_CACHE.delete(k);
    }
    return res.json({ ok: true, code: 0, ...result });
  } catch (e) {
    next(e);
  }
});

// 微信授权自动获取手机号：POST /api/v1/public/mp-phone
// 初一定调："授权时候就获取基本信息，不要让用户去手填"——小程序端 open-type=getPhoneNumber
// 授权后拿 phone_code → 后端解密 → 返回真手机号 → 前端自动填入，用户零手填。
// 合规：手机号为用户显式点按钮授权；解密结果仅返回本次请求，不落明文日志。
router.post('/public/mp-phone', loginRateLimit(20), async (req, res, next) => {
  try {
    const { phone_code } = z.object({ phone_code: z.string().min(1).max(256) }).parse(req.body ?? {});
    if (!mpConfigured()) {
      return res.status(409).json({ ok: false, code: 'MP_NOT_CONFIGURED', message: '小程序手机号能力未配置，请改用手动输入' });
    }
    const phone = await decryptPhoneCode(phone_code);
    if (!phone) {
      return res.status(422).json({ ok: false, code: 'PHONE_DECRYPT_FAIL', message: '手机号解密失败，请重试或手动输入' });
    }
    return res.json({ ok: true, code: 0, phone });
  } catch (e) {
    next(e);
  }
});
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
    // R29-F3：tokens 路径（view_token 可被分享给第三方，如发给维修工）不返回 reporter_phone 明文，防分享越权泄露；
    // phone 路径（本人已通过 (phone, order_no) 配对证明所有权）保留明文作找回凭据，前端 maskPhone 脱敏展示。
    const isTokenPath = tokens.length > 0;
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
      // ⑤ 手机号身份：兼容两种来源（ext.reporter_phone 优先，老工单 contact 列兜底）
      // 修复：之前只读 ext.reporter_phone，老工单没存到该字段时会显示"空"
      const reporterPhone = ext.reporter_phone || row.contact || null;
      return {
        order_no: row.order_no,
        status: row.status,
        title: row.title,
        description: row.description || '',
        location: row.location,
        created_at: row.created_at,
        view_token: ext.public_view_token || '',
        reporter_phone: isTokenPath ? undefined : reporterPhone, // R29-F3：token 路径（可分享）不返明文；phone 路径（本人找回）保留——前端 maskPhone(undefined)→'—' 已兼容
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

// ⑤ 扫码带基本信息：GET /public/dict/lookup?org=&loc=&role=
// 报修人扫码进入小程序时携带的二维码参数自动解析：位置/报修人基本信息（v0.4.0 架构调整）
// 2026-08-23 初一反馈：位置/姓名是租户预录入基本信息，扫码即知你是谁、在哪，不应让用户手填或授权
// R29-F1：本端点仅返回 name/role 做身份展示，**不返回 phone 明文**（手机号改由 /public/mp-phone consent 通道获取）
// 路人场景：loc/role 缺失或查不到 → 返回 { found:false }，前端走"临时身份"路径
router.get('/public/dict/lookup', loginRateLimit(30), async (req, res, next) => {
  try {
    const org = (req.query.org as string || '').trim();
    const locCode = (req.query.loc as string || '').trim();
    const roleCode = (req.query.role as string || '').trim();
    if (!org) return res.json({ ok: true, code: 0, found: false, reason: 'no_org' });
    // 仅 active 机构可查
    const tr = await pool.query(`SELECT 1 FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`, [org]);
    if (tr.rowCount === 0) return res.json({ ok: true, code: 0, found: false, reason: 'org_inactive' });
    const result = await withTenantClient(org, async (client) => {
      // 查位置（按 code 唯一）
      let location: { id: string; code: string; name: string; category: string | null; default_reporter_id: string | null } | null = null;
      if (locCode) {
        const lr = await client.query(
          `SELECT id, code, name, category, default_reporter_id
           FROM location_dict WHERE tenant_id = $1 AND code = $2 AND enabled = true LIMIT 1`,
          [org, locCode],
        );
        location = lr.rows[0] || null;
      }
      // 查报修人（按 code 唯一）。R29-F1 修复：本公开端点不再返回 phone 明文——
      // 手机号统一由合规 consent 通道 /public/mp-phone（微信 getPhoneNumber 授权解密）获取，
      // 避免零鉴权枚举收割报修人手机号（与 R19-005 同类 PII 泄漏）。
      let reporter: { id: string; code: string; name: string; role: string | null } | null = null;
      if (roleCode) {
        const rr = await client.query(
          `SELECT id, code, name, role
           FROM reporter_dict WHERE tenant_id = $1 AND code = $2 AND enabled = true LIMIT 1`,
          [org, roleCode],
        );
        reporter = rr.rows[0] || null;
      }
      // 若没传 role，但 location 有 default_reporter_id → 取出来（兜底）
      // 🔴 修复（审查 2026-08-23）：必须带 tenant_id 条件，防止跨租户泄露其他租户的姓名+手机号
      if (!reporter && location?.default_reporter_id) {
        const rr2 = await client.query(
          `SELECT id, code, name, role
           FROM reporter_dict WHERE id = $1 AND tenant_id = $2 AND enabled = true LIMIT 1`,
          [location.default_reporter_id, org],
        );
        reporter = rr2.rows[0] || null;
      }
      return { location, reporter };
    });
    const found = Boolean(result.location || result.reporter);
    return res.json({ ok: true, code: 0, found, ...result });
  } catch (e) { next(e); }
});

// v0.4.0 调试端点：生成带参小程序码（v0.4.0 扫码带 org/loc/role）
// 用法：GET /public/mp-qrcode?path=pages/index/index?org=t-verification&loc=3F-A01&role=zhangsan
// 返回 image/png 二进制
// 🔴 审查修复（2026-08-23）：加限流(10/min)防刷爆微信配额 + path 白名单（仅允许报修首页，防任意路径探测）
router.get('/public/mp-qrcode', loginRateLimit(10), async (req, res, next) => {
  try {
    const path = (req.query.path as string || '').trim();
    if (!path) return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '缺少 path' });
    // path 白名单：仅 pages/index/index 允许（二维码只用于报修入口，带参也必须是它）
    if (!path.startsWith('pages/index/index')) {
      return res.status(403).json({ ok: false, code: 'PATH_FORBIDDEN', message: '仅允许生成报修首页二维码' });
    }
    if (!mpConfigured()) return res.status(409).json({ ok: false, code: 'MP_NOT_CONFIGURED', message: '小程序能力未配置' });
    const buf = await genMpCode(path);
    if (!buf) return res.status(502).json({ ok: false, code: 'QRCODE_GEN_FAIL', message: '小程序码生成失败（可能是体验版未发布该页面或小程序码配额/限频）' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(buf);
  } catch (e) { next(e); }
});

// ============ §6.2 服务台「平台动态卡」（免登录聚合公开指标，脱敏） ============
// 设计：报修人端首页底部小卡——今日已处理 / 平均响应 / 服务热线。
// 口径（诚实）：今日已处理 = 今日进入完成态（workflow_def doneStates）的工单数；
//   平均响应 = ticket_event 中 assign→processing 时长的分钟均值（无事件数据返回 0 + note，不编造）；
//   服务热线 = system_config.hotline（未配置返回空串，前端不显示该项）。
router.get('/public/service-status', loginRateLimit(30), async (req, res, next) => {
  try {
    const org = String(req.query.org || '').trim();
    if (!org) return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '缺少 org' });
    const tr = await pool.query(
      `SELECT tenant_id FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`,
      [org],
    );
    if (tr.rowCount === 0) return res.status(404).json({ ok: false, code: 'ORG_404', message: '机构不存在或未启用' });
    const tenantId = org;
    const data = await withTenantClient(tenantId, async (client) => {
      const def = await getWorkflowDef(client, tenantId, 'work_order');
      const done = doneStates(def);
      const t = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM work_orders
         WHERE tenant_id = $1 AND status = ANY($2::text[]) AND updated_at::date = CURRENT_DATE`,
        [tenantId, done],
      );
      const resp = await client.query<{ secs: string | null }>(
        `SELECT EXTRACT(EPOCH FROM AVG(e.created_at - t.created_at))::text AS secs
         FROM ticket_event e
         JOIN work_orders t ON t.id = e.work_order_id AND t.tenant_id = e.tenant_id
         WHERE e.tenant_id = $1 AND e.type = 'assign'
           AND e.created_at >= t.created_at AND e.created_at - t.created_at < interval '30 days'`,
        [tenantId],
      );
      const cfg = await client.query<{ value: string }>(
        `SELECT value FROM system_config WHERE tenant_id = $1 AND key = 'hotline' LIMIT 1`,
        [tenantId],
      );
      const secs = resp.rows[0]?.secs != null ? Number(resp.rows[0].secs) : null;
      return {
        today_done: Number(t.rows[0].c),
        avg_response_min: secs != null ? Math.round(secs / 60) : 0,
        avg_response_note: secs == null ? '暂无派单响应事件数据，平均响应不可计算（返回 0，不编造）' : '',
        hotline: cfg.rows[0]?.value ?? '',
      };
    });
    return res.json({ ok: true, code: 0, data });
  } catch (e) { next(e); }
});

// ============ §6.1 报修人意见反馈（免登录，轻量收集，不派单不进状态机） ============
// 设计：报修人端「我的报修」→ 意见反馈（星级 1-5 + 意见 ≤200 + 可选关联工单号）。
// 复用 feedback 表（type='opinion'/'satisfaction'，status='new'），与登录用户反馈同一统计出口。
const feedbackSchema = z.object({
  org: z.string().min(3).max(64),
  content: z.string().min(1).max(200),
  rating: z.number().int().min(1).max(5).optional(),
  order_no: z.string().max(64).optional(), // 可选关联工单号（纯文本记录，不校验存在性，防枚举探测）
  consent: z.boolean().refine((v) => v === true, { message: '提交即表示同意《隐私告知》' }),
});
router.post('/public/feedback', loginRateLimit(20), async (req, res, next) => {
  try {
    const b = feedbackSchema.parse(req.body);
    const tr = await pool.query(
      `SELECT tenant_id FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`,
      [b.org],
    );
    if (tr.rowCount === 0) return res.status(404).json({ ok: false, code: 'ORG_404', message: '机构不存在或未启用' });
    const item = await withTenantClient(b.org, async (client) => {
      const r = await client.query(
        `INSERT INTO feedback (tenant_id, type, content, rating, channel, status, created_by)
         VALUES ($1,'opinion',$2,$3,'mobile','new',$4) RETURNING id, created_at`,
        [b.org, b.content, b.rating ?? null, b.order_no ? `order:${b.order_no}` : 'public_user'],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, {
        tenantId: b.org, entityType: 'feedback', entityId: row.id,
        type: 'submit', actor: 'public_user', payload: { rating: b.rating ?? null },
      });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item: { id: item.id, created_at: item.created_at } });
  } catch (e) { next(e); }
});

export default router;
