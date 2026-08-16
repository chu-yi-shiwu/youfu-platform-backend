// 扫码解析模块（M3：真实后端解析，替代前端 MSW 写死 mock）。
//
// 职责：把现场扫码/手动输入的原始码 raw 解析成结构化结果，供主路径"选"步骤自动带入。
//  - CAT-<catalogCode>  -> 目录码（如电工/水工）：解析出 catalog 与建议业务类型
//  - AST-<assetId>      -> 资产码（如 3F-空调-01）：解析出资产台账条目，并推导 catalog 线索
//  - 其它               -> 未识别，诚实返回 resolved:false（不臆造，保住 Q 类红线）
//
// 生产化②（资产台账数据库化）：resolveScan 仍是纯函数（本地账本兜底 + 单测契约不变）；
// 线上路由改调 resolveScanFromDb —— 注入 tenant 后优先查 asset_catalog/asset_registry（006 迁移），
// DB 权威：查不到即诚实 unresolved，不再回退本地写死账本。本地账本仅作离线/单测 fixture。

import { withTenantClient } from './db/pool.js';

export type ScanKind = "catalog" | "asset";

export interface ScanAsset {
  qr: string; // 规范化的码（大写）
  resolved: boolean; // 是否成功解析
  note: string; // 人类可读说明 / 未识别原因
  kind?: ScanKind; // 解析成功时的类别
  catalog?: string; // 关联目录码（如 electrician），供前端自动带入
  label?: string; // 展示名（目录名 / 资产名）
  skill_tags?: string[]; // 资产解析时推导的派单技能线索（可选）
}

// 目录元数据账本（与前端 catalog.ts 同源；真实化后由元数据引擎/DB 提供）。
// 仅含 M1/M2 已出现的目录，保证单测与联调确定。
interface CatalogEntry {
  code: string;
  label: string;
  skill_tags: string[];
}

const CATALOGS: CatalogEntry[] = [
  { code: "electrician", label: "电工维修", skill_tags: ["electric"] },
  { code: "plumber", label: "水工维修", skill_tags: ["plumbing"] },
  { code: "specimen", label: "标本护送", skill_tags: ["transport"] },
  { code: "patient_escort", label: "病人陪检", skill_tags: ["escort"] },
];

// 资产台账（样例；真实化后来自资产服务/台账表）。
// key = 资产码去前缀大写；value 含展示名与推导目录/技能。
interface AssetEntry {
  label: string;
  catalog: string;
  skill_tags: string[];
}

const ASSETS: Record<string, AssetEntry> = {
  "3F-AIRCON-01": { label: "3F-空调-01", catalog: "electrician", skill_tags: ["electric"] },
  "5F-PUMP-02": { label: "5F-水泵-02", catalog: "plumber", skill_tags: ["plumbing"] },
  "2F-CRT-07": { label: "2F-离心机-07", catalog: "specimen", skill_tags: ["transport"] },
};

// 大小写不敏感查账本：把请求码统一转大写再比对（账本 code 存小写，比对用大写）
function findCatalogByCodeUpper(codeUpper: string): CatalogEntry | undefined {
  return CATALOGS.find((c) => c.code.toUpperCase() === codeUpper);
}
function findAssetByKeyUpper(keyUpper: string): AssetEntry | undefined {
  return ASSETS[keyUpper];
}

// 建议业务类型映射（用于自动带入主路径"选择业务类型"）：catalog -> business_type
const CATALOG_TO_TEMPLATE: Record<string, string> = {
  electrician: "repair",
  plumber: "repair",
  specimen: "transport",
  patient_escort: "escort",
};

export interface ScanResult {
  asset: ScanAsset;
  // 解析成功时附带的"建议主路径意图"，前端可据此自动带入
  suggested?: {
    kind: ScanKind;
    catalog: string;
    template?: string; // 建议业务类型（catalog/asset 命中时给出）
  };
}

/**
 * 解析扫码原始码（纯函数，确定式）。
 * @param raw 用户扫码或手动输入的原始串（如 "CAT-electrician" / "ast-3f-aircon-01" / "随便输的"）
 */
export function resolveScan(raw: string): ScanResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { asset: { qr: "", resolved: false, note: "码为空，请重新扫码" } };
  }

  const norm = trimmed.toUpperCase();

  // 1) 目录码：CAT-<catalogCode>（大小写不敏感）
  if (norm.startsWith("CAT-")) {
    const code = norm.slice(4);
    const cat = findCatalogByCodeUpper(code);
    if (!cat) {
      return {
        asset: { qr: norm, resolved: false, note: `未知目录码：${code}` },
      };
    }
    return {
      asset: { qr: norm, resolved: true, note: "已识别为业务目录", kind: "catalog", catalog: cat.code, label: cat.label },
      suggested: { kind: "catalog", catalog: cat.code, template: CATALOG_TO_TEMPLATE[cat.code] },
    };
  }

  // 2) 资产码：AST-<assetId>（大小写不敏感）
  if (norm.startsWith("AST-")) {
    const id = norm.slice(4);
    const asset = findAssetByKeyUpper(id);
    if (!asset) {
      return {
        asset: { qr: norm, resolved: false, note: `资产台账未登记：${id}（可手动选择目录）` },
      };
    }
    return {
      asset: {
        qr: norm,
        resolved: true,
        note: "已识别为资产并关联目录",
        kind: "asset",
        catalog: asset.catalog,
        label: asset.label,
        skill_tags: asset.skill_tags,
      },
      suggested: { kind: "asset", catalog: asset.catalog, template: CATALOG_TO_TEMPLATE[asset.catalog] },
    };
  }

  // 3) 其它：不臆造，诚实降级（保住诚实红线，避免 Q 类误派）
  return {
    asset: { qr: norm, resolved: false, note: "未识别到有效资产，请确认码是否正确" },
  };
}

/**
 * 纯函数：从原始码解析出 {kind, key}（kind=catalog|asset，key=前缀后的码，已大写）。
 * 空串 / 非 CAT-/AST- 前缀 → 返回 null（调用方据此走"不臆造"降级，不查库）。
 */
export function parseScanCode(raw: string): { kind: ScanKind; key: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const norm = trimmed.toUpperCase();
  if (norm.startsWith("CAT-")) return { kind: "catalog", key: norm.slice(4) };
  if (norm.startsWith("AST-")) return { kind: "asset", key: norm.slice(4) };
  return null;
}

// DB 查询函数契约（可注入便于单测，无需真连库）
export type AssetQueryRow = { label: string; skill_tags: string[]; catalog_code?: string };
export type AssetQueryFn = (
  tenantId: string,
  kind: ScanKind,
  key: string,
) => Promise<AssetQueryRow | undefined>;

// 默认查询：按租户查 asset_catalog / asset_registry（RLS 经 withTenantClient 生效）
async function defaultDbQuery(tenantId: string, kind: ScanKind, key: string): Promise<AssetQueryRow | undefined> {
  return withTenantClient(tenantId, async (client) => {
    if (kind === "catalog") {
      const r = await client.query<AssetQueryRow>(
        `SELECT label, skill_tags FROM asset_catalog
         WHERE tenant_id = $1 AND UPPER(catalog_code) = UPPER($2)`,
        [tenantId, key],
      );
      return r.rows[0];
    }
    const r = await client.query<AssetQueryRow & { catalog_code: string }>(
      `SELECT label, catalog_code, skill_tags FROM asset_registry
       WHERE tenant_id = $1 AND UPPER(asset_code) = UPPER($2)`,
      [tenantId, key],
    );
    return r.rows[0];
  });
}

/**
 * 生产化② DB 版扫码解析（异步）。
 * - 非 CAT-/AST- 前缀或空串：转交纯函数 resolveScan（诚实降级，不查库）。
 * - 前缀合法但 DB 无记录：诚实 unresolved（DB 权威，不回退本地账本）。
 * - 命中：用 DB 行复用纯函数同款响应结构返回。
 * @param queryFn 可注入的查询函数（默认查真库），便于单测。
 */
export async function resolveScanFromDb(
  tenantId: string,
  raw: string,
  queryFn?: AssetQueryFn,
): Promise<ScanResult> {
  const parsed = parseScanCode(raw);
  if (!parsed) return resolveScan(raw); // 非前缀/空 → 纯函数处理（不查库）

  const q = queryFn ?? defaultDbQuery;
  const row = await q(tenantId, parsed.kind, parsed.key);
  const code = (parsed.kind === "catalog" ? "CAT-" : "AST-") + parsed.key;

  if (!row) {
    // DB 权威：未登记即诚实 unresolved
    if (parsed.kind === "catalog") {
      return { asset: { qr: code, resolved: false, note: `未知目录码：${parsed.key}` } };
    }
    return { asset: { qr: code, resolved: false, note: `资产台账未登记：${parsed.key}（可手动选择目录）` } };
  }

  const catCode = (parsed.kind === "catalog" ? parsed.key : row.catalog_code!).toLowerCase();
  return {
    asset: {
      qr: code,
      resolved: true,
      note: parsed.kind === "catalog" ? "已识别为业务目录" : "已识别为资产并关联目录",
      kind: parsed.kind,
      catalog: catCode,
      label: row.label,
      skill_tags: row.skill_tags,
    },
    suggested: { kind: parsed.kind, catalog: catCode, template: CATALOG_TO_TEMPLATE[catCode] },
  };
}
