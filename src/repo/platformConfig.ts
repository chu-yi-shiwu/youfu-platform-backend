// 平台级配置读写（097_platform_config.sql）。
//
// 【与 system_config 的分工】
//   system_config  = **租户级**（带 tenant_id + RLS），客户自己在界面上能改（品牌名/热线/开关）。
//   platform_config = **平台级**（无 tenant_id），只有平台运维经 /api/v1/platform/* 能改。
//   "谁能改流程"这类**治理开关**必须放这里：放租户表里，客户自己就能把锁拨开，等于没锁。
//
// 【连接】一律 pool 直连（不经 withTenantClient）。平台层与 platform_admin / platform_audit
//   同款治理：隔离靠"端点必须过 platformAdminAuth"，不靠 RLS（本表也无 RLS）。
//
// 【失败方向】读不到行 / 查询报错 一律回退**最严侧** 'platform'（与 F7 AUTH_MODE fail-closed
//   同款纪律）：宁可暂时谁都改不了流程，也不能因为一次数据库抖动把配置权限悄悄放开给客户。
import pool from '../db/pool.js';

/** 流程配置权限归属开关的键名。 */
export const WORKFLOW_CONFIG_OWNER_KEY = 'workflow_config_owner';

/** 归属取值：platform=仅平台运维；tenant=租户按权限点自治。 */
export type WorkflowConfigOwner = 'platform' | 'tenant';

/** 缺省归属（最严侧）。常量单一事实源，勿在别处另写字面量。 */
export const DEFAULT_WORKFLOW_CONFIG_OWNER: WorkflowConfigOwner = 'platform';

/**
 * 读取流程配置归属。
 * @param client 可选：调用方已在某连接上时复用（测试注入用）。
 */
export async function getWorkflowConfig_owner_env(): Promise<WorkflowConfigOwner | null> {
  const env = process.env.WORKFLOW_CONFIG_OWNER;
  if (env === 'platform' || env === 'tenant') return env;
  return null;
}

export async function getWorkflowConfigOwner(client?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ value: string }> }> }): Promise<WorkflowConfigOwner> {
  // 环境变量优先（与 isAutoTuneEffective / MODEL_AUTO_TUNE 同款：env 是紧急熔断层）。
  //   WORKFLOW_CONFIG_OWNER=platform → 强制锁死（出事时一键收口，不必等改库）；
  //   WORKFLOW_CONFIG_OWNER=tenant  → 强制放开（灰度单实例给客户自助时用）；
  //   env 未设 → 以 platform_config 表为准（平台运维在后台切换，无需发版）。
  const forced = await getWorkflowConfig_owner_env();
  if (forced) return forced;
  const q = client ?? pool;
  try {
    const r = await q.query(`SELECT value FROM platform_config WHERE key = $1`, [WORKFLOW_CONFIG_OWNER_KEY]);
    const raw = r.rows[0]?.value;
    return raw === 'tenant' ? 'tenant' : 'platform';
  } catch (e) {
    // 表未建 / 连接异常：不静默放开，回退最严侧并告警（E3 不静默失败）。
    console.warn('[platformConfig] 读取 workflow_config_owner 失败，回退最严侧 platform', {
      err: e instanceof Error ? e.message : String(e),
    });
    return DEFAULT_WORKFLOW_CONFIG_OWNER;
  }
}

/** 写入任意平台级配置（UPSERT）。actor 留痕。 */
export async function setPlatformConfig(key: string, value: string, actor: string): Promise<void> {
  await pool.query(
    `INSERT INTO platform_config (key, value, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, value, actor],
  );
}

/** 设置流程配置归属（平台运维专用）。 */
export async function setWorkflowConfigOwner(owner: WorkflowConfigOwner, actor: string): Promise<WorkflowConfigOwner> {
  await setPlatformConfig(WORKFLOW_CONFIG_OWNER_KEY, owner, actor);
  return owner;
}
