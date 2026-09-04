// 启动自检：role_permission.role CHECK 角色白名单门（架构评审 R1 · 注册制批次二）。
// ───────────────────────────────────────────────────────────────────────────
// 背景：046 内联建表时 role_permission.role 的 CHECK 仅放行 4 角色，069 只放宽了
// account_user.role 未同步本表 → 批次二开通第④步按 6 角色写权限行必报 23514，
// 新租户开通事务整体回滚。修复靠 070 迁移（superuser 部署时真跑）；
// 本模块在应用启动时核对 DB 侧 CHECK 是否已放行全部 6 角色，未放行则拒绝启动（fail-fast）。
// 诚实边界：连不上 DB 时不在此处炸（沿用既有启动行为——首请求自然报错），
// 自检只在成功取得连接后判定；用真实 pool 客户端跑完即释放。
// ───────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import pool from '../db/pool.js';
import { ROLES } from '../middleware/role.js';

export const ROLE_CHECK_SQL =
  `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint` +
  ` WHERE conrelid = 'role_permission'::regclass AND contype = 'c'`;

/**
 * 纯函数：从 CHECK 约束定义文本解析放行的角色集合。
 * pg_get_constraintdef 对 046/069 两种写法均渲染为
 * `CHECK (role = ANY (ARRAY['admin'::text, ...]))` 形态，约束文本内的带引号字面量即角色清单。
 */
export function parseRoleCheckAllowlist(defText: string): string[] {
  if (!defText) return [];
  const matches = defText.match(/'([^']*)'/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

/**
 * 在给定 client 上执行白名单判定（不释放连接，由调用方管理生命周期）。
 * 返回 missing = ROLES 中未被 CHECK 放行的角色；missing 为空即自检通过。
 */
export async function checkRoleWhitelist(
  client: PoolClient,
): Promise<{ ok: boolean; missing: string[]; constraints: Array<{ conname: string; def: string }> }> {
  const r = await client.query(ROLE_CHECK_SQL);
  const constraints = r.rows.map((row: { conname: string; def: string }) => ({
    conname: row.conname,
    def: row.def ?? '',
  }));
  const allow = new Set<string>();
  for (const c of constraints) {
    for (const role of parseRoleCheckAllowlist(c.def)) allow.add(role);
  }
  const missing = ROLES.filter((role) => !allow.has(role));
  return { ok: missing.length === 0, missing, constraints };
}

// 连接超时护栏：DB 不可达时自检最多等 10s 后放弃（不炸、不阻塞调度器启动）。
const SELF_CHECK_CONNECT_TIMEOUT_MS = 10_000;

/**
 * 启动门：查询 DB 侧 role_permission CHECK 并断言 6 角色全部放行；
 * 任一缺失 → 输出明确修复命令并 process.exit(1)（拒绝启动，避免开通中途 23514 整体回滚）。
 */
export async function verifyRoleWhitelist(): Promise<void> {
  let client: PoolClient | null = null;
  try {
    client = await Promise.race([
      pool.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('role whitelist self-check connect timeout')), SELF_CHECK_CONNECT_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    // 连不上 DB：沿用既有启动行为（不在此处炸），交给首个请求自然报错。
    console.warn(`[startup] 角色白名单自检跳过：DB 连接不可用（${(e as Error).message}）`);
    return;
  }
  let rejectStartup = false;
  try {
    const res = await checkRoleWhitelist(client);
    if (!res.ok) {
      rejectStartup = true; // 先标记，finally 释放连接后再 exit（QA 修正：exit 在 try 内会绕过 release）
      console.error(
        `🔴 070 迁移未应用：role_permission.role CHECK 缺角色 ${res.missing.join('、')}，` +
          `拒绝启动（新租户开通会整体回滚）。` +
          `修复：在数据库服务器以 superuser 执行 sudo -u postgres psql youfu -f 070_role_permission_roles_widen.sql，然后重启本服务。` +
          `（当前 CHECK：${res.constraints.map((c) => `${c.conname}: ${c.def}`).join(' | ') || '无 CHECK 约束'}）`,
      );
    } else {
      console.log('[startup] role_permission.role CHECK 含全部 6 角色白名单，自检通过');
    }
  } finally {
    client.release();
  }
  if (rejectStartup) process.exit(1);
}
