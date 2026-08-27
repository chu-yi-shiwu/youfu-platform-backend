// ④ 自动改流程开关：每租户持久化 AUTO_TUNE 状态（用户可在界面自主翻转、实时生效、落库）。
// 默认 false（安全默认：不盲改生产流程定义）；界面一键即可开启。
import type { PoolClient } from 'pg';
import { withTenantClient } from '../db/pool.js';

export interface AutoTuneState {
  enabled: boolean;
  updatedAt: string | null;
}

// 读取租户 AUTO_TUNE 持久化开关；缺省 false。
export async function getAutoTune(tenantId: string): Promise<AutoTuneState> {
  return withTenantClient(tenantId, async (client) => {
    const r = await client.query(
      `SELECT auto_tune, updated_at FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    if (r.rowCount === 0) return { enabled: false, updatedAt: null };
    return { enabled: r.rows[0].auto_tune, updatedAt: r.rows[0].updated_at };
  });
}

// 设置并持久化 AUTO_TUNE 开关（UPSERT）—— client 版（供权限守卫同事务使用）。
export async function setAutoTuneWithClient(
  client: PoolClient,
  tenantId: string,
  enabled: boolean,
): Promise<AutoTuneState> {
  const r = await client.query(
    `INSERT INTO tenant_settings (tenant_id, auto_tune, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (tenant_id)
     DO UPDATE SET auto_tune = EXCLUDED.auto_tune, updated_at = now()
     RETURNING auto_tune, updated_at`,
    [tenantId, enabled],
  );
  return { enabled: r.rows[0].auto_tune, updatedAt: r.rows[0].updated_at };
}

// 兼容入口（自动开连接）。
export async function setAutoTune(tenantId: string, enabled: boolean): Promise<AutoTuneState> {
  return withTenantClient(tenantId, (client) => setAutoTuneWithClient(client, tenantId, enabled));
}

// 计算"自动改流程"是否实际生效（实时，无需重启）：
//  - 环境变量 MODEL_AUTO_TUNE=false 为全局紧急熔断（强制关，连界面开关也压不住，fail-safe）；
//  - 环境变量 MODEL_AUTO_TUNE=true 为全局强制开（兼容试点临时实例，覆盖租户设置）；
//  - 其余情况 = 租户持久化开关（界面控制）。
export async function isAutoTuneEffective(tenantId: string): Promise<boolean> {
  const env = process.env.MODEL_AUTO_TUNE;
  if (env === 'false') return false;
  if (env === 'true') return true;
  const { enabled } = await getAutoTune(tenantId);
  return enabled;
}

// 租户级 LLM 授权开关（管理侧控制，默认 false；settings.llm_enabled）
// 返回 true 才允许该租户走 LLM 语义推断，否则回退本地规则引擎。
export async function getLlmEnabled(tenantId: string): Promise<boolean> {
  return withTenantClient(tenantId, async (client) => {
    const r = await client.query(
      `SELECT settings->>'llm_enabled' AS llm_enabled FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    if (r.rowCount === 0) return false;
    return r.rows[0].llm_enabled === 'true';
  });
}

// I4 灰度总开关：控制「全部新 AI 能力」（工人端建议卡 /similar + 配置向导 AI 生成 /gen-config）。
// 默认 false（fail-safe：不显式开启则全部 AI 能力保持关闭，绝不偷偷启用新行为）。
// settings.ai_features_enabled 缺失或 'false' 一律视为关。
export async function getAiFeaturesEnabled(tenantId: string): Promise<boolean> {
  return withTenantClient(tenantId, async (client) => {
    const r = await client.query(
      `SELECT settings->>'ai_features_enabled' AS flag FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    if (r.rowCount === 0) return false;
    return r.rows[0].flag === 'true';
  });
}

// 设置并持久化 I4 灰度总开关（UPSERT settings jsonb，不影响其它 settings 字段）。
export async function setAiFeaturesEnabled(tenantId: string, enabled: boolean): Promise<boolean> {
  await withTenantClient(tenantId, async (client) => {
    await client.query(
      `INSERT INTO tenant_settings (tenant_id, settings, updated_at)
       VALUES ($1, jsonb_build_object('ai_features_enabled', $2::boolean), now())
       ON CONFLICT (tenant_id)
       DO UPDATE SET settings = COALESCE(tenant_settings.settings, '{}'::jsonb) || jsonb_build_object('ai_features_enabled', $2::boolean),
                     updated_at = now()`,
      [tenantId, enabled],
    );
  });
  return enabled;
}
