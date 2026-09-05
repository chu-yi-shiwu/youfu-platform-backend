// publicReportCreate.ts —— 免登录报修建单服务层（#935 承接 #930 审计可维护性建议）。
// 背景：routes/publicReport.ts 的 POST /public/repair-report handler 曾达 275 行，
// 集扫码解析/LLM 推断/分类链/建单/派单/合规 ext 于一体。本文件把「建单核心」抽为服务层，
// route 只留编排与响应；拆分纪律 = 纯搬运（SQL、调用序、幂等语义零变化），
// 回归护栏 = publicReport.http.test.ts 10 例（mock 按模块解析路径打桩，对本文件同样生效）。
// 架构不变量（拆分时逐条保留）：
//   R5-BUG-001：LLM 推断整体在事务外（先短连接读开关+词表并归还，再无连接调 LLM，最后开事务纯 DB）；
//   R9-001：幂等重放（created=false）不重跑派单；
//   AL-003：派单入参 business_type 按分类名/描述推断，dispatch_rule skill_match 才能命中；
//   DMR：报修人只给种子，分类/优先级/资产服务端补全；媒体原文件无损耗落盘。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import type { PoolClient } from 'pg';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { createWithIdem } from '../repo/ticket.js';
import { matchCategoryHint, resolveFaultCategory, inferPriority, resolveAsset, generateTitle, businessTypeForCategory } from './intakeEnrich.js';
import { llmInferCategory } from './llm.js';
import { resolveScanFromDb } from '../scan.js'; // ⑤ 扫码关联：复用 DB 权威解析
import { getLlmEnabled } from '../repo/tenantSettings.js';
import { autoDispatchAfterCreate } from '../routes/workOrder.js';
import { downloadMedia } from './wechat.js'; // ③ 微信真录音：下载原始 amr 无损耗留存
import { attachmentSchema, reportSchema, CTYPE_EXT } from '../routes/publicReportSchema.js';

export type PublicReportBody = z.infer<typeof reportSchema>;
export type PublicReportAttachment = z.infer<typeof attachmentSchema>;

export interface CreatePublicReportResult {
  row: any;
  created: boolean;
  catalogName: string | undefined;
  priority: 'urgent' | 'normal' | 'low';
  assetName: string | null;
  scanResolved: boolean;
  location: string;
  dispatch: Awaited<ReturnType<typeof autoDispatchAfterCreate>> | null;
  finalAttachments: NonNullable<PublicReportBody['attachments']>;
}

// ③ 微信真录音：voice_media_ids(serverId) → 服务端经微信媒体接口下载原始 amr 无损耗留存。
// best-effort：下载失败不阻断建单（录音可重录），但必须留错误日志便于排查（诚实降级，绝不假装已留存）。
async function downloadWechatVoices(tenantId: string, mediaIds: string[]): Promise<PublicReportAttachment[]> {
  const out: PublicReportAttachment[] = [];
  if (!mediaIds.length) return out;
  const root = process.env.UPLOAD_DIR ?? '/opt/youfu/uploads';
  const dir = path.join(root, tenantId);
  await fs.promises.mkdir(dir, { recursive: true });
  for (const mediaId of mediaIds) {
    try {
      const { buf, contentType } = await downloadMedia(mediaId);
      const ext = CTYPE_EXT[contentType] || 'amr';
      const name = `${crypto.randomUUID()}.${ext}`;
      await fs.promises.writeFile(path.join(dir, name), buf);
      out.push({ kind: 'audio', url: `/uploads/${tenantId}/${name}`, name: '微信录音', size: buf.length });
      console.log('[wechat-voice] saved mediaId=%s size=%d', mediaId, buf.length);
    } catch (e) {
      console.error('[wechat-voice] download failed mediaId=%s err=%s', mediaId, (e as Error).message);
    }
  }
  return out;
}

// LLM 推断（B 档）——必须在事务外执行（R5-BUG-001 修复，见文件头架构不变量）。
async function inferOutsideTransaction(
  tenantId: string,
  desc: string,
): Promise<{ category: string | null; priority: string | null; asset: string | null; location: string | null } | null> {
  if (!desc || !(await getLlmEnabled(tenantId))) return null;
  const catNames = (
    await withTenantClient(tenantId, (client) =>
      client.query<{ name: string }>(
        `SELECT name FROM fault_category WHERE tenant_id = $1 AND enabled = true`,
        [tenantId],
      ),
    )
  ).rows.map((r) => r.name);
  return llmInferCategory(desc, catNames);
}

// ⑤ 扫码关联解析（事务内）：先解析报修人透传的 asset_code / catalog_code（DB 权威）。
async function resolveScanContext(
  client: PoolClient,
  tenantId: string,
  b: PublicReportBody,
): Promise<{ scannedAssetId?: string; scannedAssetName?: string; scannedCatalogCode?: string; scanResolved: boolean }> {
  if (!b.asset_code && !b.catalog_code) return { scanResolved: false };
  const scanRaw = b.asset_code
    ? (b.asset_code.toUpperCase().startsWith('AST-') ? b.asset_code : 'AST-' + b.asset_code)
    : (b.catalog_code!.toUpperCase().startsWith('CAT-') ? b.catalog_code! : 'CAT-' + b.catalog_code!);
  const sr = await resolveScanFromDb(tenantId, scanRaw);
  if (!sr.asset.resolved) return { scanResolved: false };
  const scannedCatalogCode = sr.asset.catalog; // 资产/目录命中都可能带 catalog 线索
  let scannedAssetId: string | undefined;
  let scannedAssetName: string | undefined;
  if (sr.asset.kind === 'asset' && sr.asset.qr) {
    const key = sr.asset.qr.replace(/^AST-/, '');
    const ar = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM asset_registry WHERE tenant_id = $1 AND UPPER(asset_code) = UPPER($2) LIMIT 1`,
      [tenantId, key],
    );
    if (ar.rowCount) { scannedAssetId = ar.rows[0].id; scannedAssetName = ar.rows[0].name; }
  }
  return { scannedAssetId, scannedAssetName, scannedCatalogCode, scanResolved: true };
}

// 分类解析链（事务内）：前端显式指定则校验归属，否则扫描码 → category_name → LLM → 规则引擎。
// 每条通道匹配不到时诚实保留名称、不绑定 id（绝不臆造归属）。
async function resolveCatalogChain(
  client: PoolClient,
  tenantId: string,
  b: PublicReportBody,
  desc: string,
  llmInferred: { category: string | null; priority: string | null; asset: string | null; location: string | null } | null,
  scannedCatalogCode: string | undefined,
): Promise<{ catalogId: string | undefined; catalogName: string | undefined }> {
  let catalogId: string | undefined = b.catalog;
  let catalogName: string | undefined;
  if (b.catalog) {
    const cat = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM fault_category WHERE id = $1 AND tenant_id = $2 AND enabled = true LIMIT 1`,
      [b.catalog, tenantId],
    );
    if (cat.rowCount === 0) throw new AppError('BAD_DATA', '所选问题类型无效，请刷新后重试', 400);
    catalogName = cat.rows[0].name;
  } else if (scannedCatalogCode) {
    // 扫描命中目录码：把线索映射成租户分类名（诚实：匹配不到则保留 code 不绑定 id）
    const m = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM fault_category WHERE tenant_id = $1 AND (code = $2 OR code ILIKE $3) AND enabled = true LIMIT 1`,
      [tenantId, scannedCatalogCode, '%' + scannedCatalogCode + '%'],
    );
    if (m.rowCount) { catalogId = m.rows[0].id; catalogName = m.rows[0].name; }
    else catalogName = scannedCatalogCode;
  } else if (b.category_name) {
    // 报修端点选分类（兜底通道）：按名精确匹配租户分类；匹配不到则诚实保留名称、不绑定 id
    const m = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM fault_category WHERE tenant_id = $1 AND enabled = true AND name = $2 LIMIT 1`,
      [tenantId, b.category_name],
    );
    if (m.rowCount) { catalogId = m.rows[0].id; catalogName = m.rows[0].name; }
    else catalogName = b.category_name;
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
  return { catalogId, catalogName };
}

// 关联资产：扫描码优先（DMR 补充录入通道），否则 LLM → 规则引擎。
async function resolveAssetChain(
  client: PoolClient,
  tenantId: string,
  desc: string,
  llmInferred: { category: string | null; priority: string | null; asset: string | null; location: string | null } | null,
  scannedAssetId?: string,
  scannedAssetName?: string,
): Promise<{ id: string; name: string } | null> {
  if (scannedAssetId) return { id: scannedAssetId, name: scannedAssetName! };
  let asset = await resolveAsset(client, tenantId, desc);
  if (llmInferred && llmInferred.asset && !asset) {
    const m = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM asset WHERE tenant_id = $1 AND (name = $2 OR name ILIKE $3) LIMIT 1`,
      [tenantId, llmInferred.asset, `%${llmInferred.asset}%`],
    );
    if (m.rowCount) asset = { id: m.rows[0].id, name: m.rows[0].name };
  }
  return asset;
}

/**
 * 免登录报修建单核心（原 POST /public/repair-report handler 主体，#935 拆分为服务层）。
 * 职责：媒体下载 → 事务外 LLM → 事务内（扫码/分类/优先级/资产补全 + 幂等建单 + 自动派单）。
 * 机构归属校验、org 级配额、view_token 生成与响应组装仍由 route 层负责。
 */
export async function createPublicRepairReport(
  tenantId: string,
  b: PublicReportBody,
  opts: { idempotencyKey?: string; viewToken: string },
): Promise<CreatePublicReportResult> {
  // 质量闸门：仅拦截「完全无信息量」的空描述（其余交给模型补全，不硬拒）
  // 支持纯语音/纯图片报修：无描述时用媒体生成标题
  const desc = (b.description ?? '').trim();
  const hasAudio = (b.attachments ?? []).some((a) => a.kind === 'audio') || (b.voice_media_ids?.length ?? 0) > 0;
  const hasImage = (b.attachments ?? []).some((a) => a.kind === 'image');
  // 语音直译失败标记（方言/噪声/识别不清）：前端显式声明，用于主题诚实降级
  const voiceUnclear = Boolean(b.voice_unclear);

  const finalAttachments: NonNullable<PublicReportBody['attachments']> = [...(b.attachments ?? [])];
  if (b.voice_media_ids && b.voice_media_ids.length) {
    finalAttachments.push(...(await downloadWechatVoices(tenantId, b.voice_media_ids)));
  }

  // R5-BUG-001 修复：LLM 推断整体移出事务（架构不变量，见文件头）。
  const llmInferred = await inferOutsideTransaction(tenantId, desc);
  // location：前端透传优先（报修端已把用户语音/扫码位置带来）；前端未给则取服务端 LLM 抽取
  // （DMR 服务端自动补全，不依赖前端）；两者皆无则诚实置「待核实」，不臆造。
  const location = (b.location?.trim()) || llmInferred?.location || '待核实';

  const result = await withTenantClient(tenantId, async (client) => {
    // ⑤ 扫码关联（DMR 补充录入通道）：先解析报修人透传的 asset_code / catalog_code（DB 权威）
    const scan = await resolveScanContext(client, tenantId, b);

    // LLM 语义推断（B 档）：已移到事务外执行（R5-BUG-001 修复），此处只消费 llmInferred
    const { catalogId, catalogName } = await resolveCatalogChain(client, tenantId, b, desc, llmInferred, scan.scannedCatalogCode);
    // 优先级：报修端点选优先（用户明确意图，尊重覆盖），否则 LLM，否则规则引擎
    const llmPriority = llmInferred?.priority as 'urgent' | 'normal' | 'low' | null | undefined;
    const priority: 'urgent' | 'normal' | 'low' = b.priority || llmPriority || inferPriority(desc);
    const asset = await resolveAssetChain(client, tenantId, desc, llmInferred, scan.scannedAssetId, scan.scannedAssetName);
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
        // ④ 回收闭环：公开查看/纠偏凭证由 route 层生成后经 opts 透传（capability token）
        public_view_token: opts.viewToken ?? '',
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
        // ⑤ 扫码关联：记录扫到的码与解析结果（DB 权威，诚实不臆造）
        scan: {
          asset_code: b.asset_code ?? null,
          catalog_code: b.catalog_code ?? null,
          resolved: scan.scanResolved,
          asset_id: scan.scannedAssetId ?? null,
          catalog: scan.scannedCatalogCode ?? null,
        },
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
      idempotencyKey: opts.idempotencyKey,
    });
    // DMR 自动派单：公开报修单与后台建单同一引擎待遇（2026-08-29 修复"卡 draft/无通知/小程序点不开"断链）。
    // 幂等重放（created=false）不重跑派单（R9-001 同款纪律：绝不重置在途工单/虚增负载）。
    let dispatch: Awaited<ReturnType<typeof autoDispatchAfterCreate>> | null = null;
    if (created) {
      // AL-003 修复（2026-09-04 对齐审查）：此前硬编码 'repair'，8 条技能派单规则对 C 端永不命中
      //（实证：空调单派给电工）。改为按分类名/描述推断 business_type（空调维修→hvac 等），
      // 使 dispatch_rule 的 skill_match 规则真正接上真实流量；全不中回落 'repair' 保持旧行为。
      // 注：work_orders.business_type 落库域保持 'repair'（报修业务归属不变），仅派单入参细化。
      const dispatchBusinessType = businessTypeForCategory(catalogName, desc);
      dispatch = await autoDispatchAfterCreate(client, tenantId, row, { business_type: dispatchBusinessType, priority, catalog: catalogId });
    }
    return { row, created, catalogName, priority, assetName: asset?.name ?? null, scanResolved: scan.scanResolved, location, dispatch };
  });

  return { ...result, finalAttachments };
}
