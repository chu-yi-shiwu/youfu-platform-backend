// 责任部门自动解析（部门必填，但不让运营逐单选）。
//
// 顺序：
//   1. 显式 department_id（人工覆盖）
//   2. department_route_rule（priority 从高到低，第一条命中）
//   3. 租户默认部门 dept.is_default
//
// 规则匹配信号：business_type / catalog / location / asset / reporter / source / description。
// 规则是“一次配置、长期生效”；不命中只落默认部门，不阻断建单。
import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { safeParseJsonb } from '../util/jsonb.js';
import { businessTypeForCategory } from '../services/intakeEnrich.js';

export interface DepartmentResolveInput {
  departmentId?: string | null;
  catalog?: string | null;
  location?: string | null;
  description?: string | null;
  businessType?: string | null;
  assets?: unknown[];
  contact?: string | null;
  reporterName?: string | null;
  source?: string | null;
}

export interface DepartmentResolution {
  departmentId: string;
  source: string;
  ruleId?: string;
  signals: Record<string, unknown>;
}

interface RuleRow {
  id: string;
  name: string;
  priority: number;
  match_json: unknown;
  department_id: string;
}

interface MatchContext {
  business_type: string;
  catalog_id: string;
  catalog_code: string;
  catalog_name: string;
  location_id: string;
  location_name: string;
  asset_id: string;
  asset_code: string;
  reporter_id: string;
  source: string;
  description: string;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function includesAny(haystack: string, needle: unknown): boolean {
  if (Array.isArray(needle)) return needle.some((x) => typeof x === 'string' && haystack.includes(x));
  return typeof needle === 'string' && haystack.includes(needle);
}

function matchRule(match: Record<string, unknown>, ctx: MatchContext): boolean {
  if (match.business_type && match.business_type !== ctx.business_type) return false;
  if (match.catalog_id && match.catalog_id !== ctx.catalog_id) return false;
  if (match.catalog_code && match.catalog_code !== ctx.catalog_code) return false;
  if (match.catalog_name_contains && !includesAny(ctx.catalog_name, match.catalog_name_contains)) return false;
  if (match.location_id && match.location_id !== ctx.location_id) return false;
  if (match.location_name_contains && !includesAny(ctx.location_name, match.location_name_contains)) return false;
  if (match.asset_id && match.asset_id !== ctx.asset_id) return false;
  if (match.asset_code && match.asset_code !== ctx.asset_code) return false;
  if (match.reporter_id && match.reporter_id !== ctx.reporter_id) return false;
  if (match.source && match.source !== ctx.source) return false;
  if (match.description_contains && !includesAny(ctx.description, match.description_contains)) return false;
  return true;
}

export async function resolveDepartment(
  client: PoolClient,
  tenantId: string,
  input: DepartmentResolveInput,
): Promise<DepartmentResolution> {
  // 1) 显式覆盖：必须存在且属于当前租户
  if (input.departmentId) {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM dept WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [tenantId, input.departmentId],
    );
    if (r.rowCount === 0) {
      throw new AppError('BAD_PARAM', `department_id 不存在或不属于当前租户: ${input.departmentId}`, 422);
    }
    return { departmentId: input.departmentId, source: 'explicit', signals: {} };
  }

  const signals: Record<string, unknown> = {};
  let catalogId = '';
  let catalogCode = '';
  let catalogName = '';
  let locationId = '';
  let locationName = '';
  let assetId = '';
  let assetCode = '';
  let reporterId = '';

  // 2) 分类（id 或 code）
  if (input.catalog) {
    const r = await client.query<{ id: string; code: string | null; name: string | null }>(
      `SELECT id, code, name FROM fault_category
        WHERE tenant_id = $1 AND enabled = true AND (id::text = $2 OR code = $2)
        LIMIT 1`,
      [tenantId, input.catalog],
    );
    if (r.rows[0]) {
      catalogId = r.rows[0].id;
      catalogCode = text(r.rows[0].code);
      catalogName = text(r.rows[0].name);
      signals.catalog = { id: catalogId, code: catalogCode, name: catalogName };
    }
  }

  // 3) 位置（名称或编码；location_dict 目前 code/name 都有）
  if (input.location) {
    const r = await client.query<{ id: string; name: string | null }>(
      `SELECT id, name FROM location_dict
        WHERE tenant_id = $1 AND enabled = true AND (name = $2 OR code = $2)
        LIMIT 1`,
      [tenantId, input.location],
    );
    if (r.rows[0]) {
      locationId = r.rows[0].id;
      locationName = text(r.rows[0].name);
      signals.location = { id: locationId, name: locationName };
    } else {
      // 未登记的位置仍然保留原文，供 location_name_contains 规则使用
      locationName = input.location;
      signals.location = { name: input.location, registered: false };
    }
  }

  // 4) 资产（assets 目前可能是 asset.id；扫描码路径可能给 asset_no）
  const firstAsset = Array.isArray(input.assets)
    ? input.assets.find((x): x is string => typeof x === 'string' && x.length > 0)
    : undefined;
  if (firstAsset) {
    const r = await client.query<{ id: string; asset_no: string | null; name: string | null }>(
      `SELECT id, asset_no, name FROM asset
        WHERE tenant_id = $1 AND (id::text = $2 OR asset_no = $2)
        LIMIT 1`,
      [tenantId, firstAsset],
    );
    if (r.rows[0]) {
      assetId = r.rows[0].id;
      assetCode = text(r.rows[0].asset_no);
      signals.asset = { id: assetId, code: assetCode, name: text(r.rows[0].name) };
    }
  }

  // 5) 报修人（手机号或姓名）
  if (input.contact || input.reporterName) {
    const r = await client.query<{ id: string; name: string | null }>(
      `SELECT id, name FROM reporter_dict
        WHERE tenant_id = $1
          AND enabled = true
          AND (
            ($2 <> '' AND phone = $2)
            OR ($3 <> '' AND name = $3)
          )
        LIMIT 1`,
      [tenantId, text(input.contact), text(input.reporterName)],
    );
    if (r.rows[0]) {
      reporterId = r.rows[0].id;
      signals.reporter = { id: reporterId, name: text(r.rows[0].name) };
    }
  }

  const derivedBusinessType =
    input.businessType && input.businessType !== 'repair'
      ? input.businessType
      : businessTypeForCategory(catalogName, input.description ?? '');
  const source = text(input.source) || 'backend';
  signals.business_type = derivedBusinessType;
  signals.source = source;

  const ctx: MatchContext = {
    business_type: derivedBusinessType,
    catalog_id: catalogId,
    catalog_code: catalogCode,
    catalog_name: catalogName,
    location_id: locationId,
    location_name: locationName,
    asset_id: assetId,
    asset_code: assetCode,
    reporter_id: reporterId,
    source,
    description: text(input.description),
  };

  // 6) 路由规则（priority 降序；第一条命中生效）
  const rules = await client.query<RuleRow>(
    `SELECT id, name, priority, match_json, department_id
       FROM department_route_rule
      WHERE tenant_id = $1 AND enabled = true
      ORDER BY priority DESC, created_at ASC`,
    [tenantId],
  );
  for (const rule of rules.rows) {
    const match = (safeParseJsonb(rule.match_json) ?? {}) as Record<string, unknown>;
    if (matchRule(match, ctx)) {
      return {
        departmentId: rule.department_id,
        source: `rule:${rule.name}`,
        ruleId: rule.id,
        signals: { ...signals, rule: { id: rule.id, name: rule.name, priority: rule.priority } },
      };
    }
  }

  // 7) 默认部门（迁移保证每租户一条；没有就是配置错误，明确 422，不静默 500）
  const def = await client.query<{ id: string }>(
    `SELECT id FROM dept WHERE tenant_id = $1 AND is_default = true LIMIT 1`,
    [tenantId],
  );
  if (def.rowCount === 0) {
    throw new AppError(
      'DEPARTMENT_UNRESOLVED',
      '租户未配置默认部门，无法自动归属；请先在部门管理中设置默认部门',
      422,
    );
  }
  return {
    departmentId: def.rows[0].id,
    source: 'default',
    signals,
  };
}
