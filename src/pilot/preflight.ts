// 试点上线前自检（P0-9 / G1 辅助）。
//
// 目的：把「迁移是否真的执行完、租户是否 active、有没有 admin、worker 是否绑定账号、
// RLS 是否开启」这些上线当天最容易漏的项目，收敛成一条命令 + 一份 PASS/WARN/FAIL 清单。
//
// 设计约束：
//   - 只读：不建表、不改数据、不写 _migrations；
//   - 不依赖 Express：可由 scripts/pilot-preflight.ts 用真实 PG 调用，也可用 mock 单测；
//   - 有 fail 即 exit 1（scripts 层负责），warn 不阻断（例如尚未建 worker 档案）。
import type { PoolClient } from 'pg';

export type PreflightStatus = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  id: string;
  title: string;
  status: PreflightStatus;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

export type PreflightQuery = (sql: string, params?: unknown[]) => Promise<PreflightQueryResult>;

export interface PreflightInput {
  tenantId: string;
  /** 迁移文件总数（来自 listMigrationFiles，不读 pending-migrations）。 */
  expectedMigrationCount: number;
  /**
   * 迁移文件里显式 ENABLE ROW LEVEL SECURITY 的表数（由调用方扫描迁移文件得出）。
   * 不传时退回 2026-11-07 的静态基线 80；新库通常为 76（含尚未被 105 删除的坐席表）。
   */
  expectedRlsTables?: number;
  env: {
    AUTH_MODE?: string;
    NODE_ENV?: string;
    JWT_SECRET?: string;
    PGHOST?: string;
    PGDATABASE?: string;
    PGUSER?: string;
    PGPASSWORD?: string;
  };
  query: PreflightQuery;
}

const PASS = 'pass' as const;
const WARN = 'warn' as const;
const FAIL = 'fail' as const;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 执行全部自检。注意：调用方必须已把数据库会话切到目标租户上下文
 * （`SET LOCAL app.tenant_id` / `withTenantClient`），否则 RLS 会让
 * account_user / worker 查询恒为 0，产生“假通过”。
 */
export async function runPreflight(input: PreflightInput): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const { tenantId, env } = input;

  // 1) 环境：试点禁止 dev；JWT_SECRET 必须足够长。
  const authMode = (env.AUTH_MODE ?? '').trim().toLowerCase();
  checks.push({
    id: 'env.auth_mode',
    title: 'AUTH_MODE=prod（试点禁止 dev）',
    status: authMode === 'prod' ? PASS : FAIL,
    detail: authMode === 'prod' ? 'prod' : `当前=${env.AUTH_MODE ?? '(未设置)'}`,
  });
  const secret = env.JWT_SECRET ?? '';
  checks.push({
    id: 'env.jwt_secret',
    title: 'JWT_SECRET 已配置且长度 >= 32',
    status: secret.length >= 32 ? PASS : FAIL,
    detail: secret.length >= 32 ? `长度 ${secret.length}` : `长度 ${secret.length}（过短或缺失）`,
  });
  const pgOk = !!(env.PGHOST || env.PGDATABASE) && !!env.PGUSER && !!env.PGPASSWORD;
  checks.push({
    id: 'env.pg',
    title: 'PG 连接参数完整',
    status: pgOk ? PASS : FAIL,
    detail: pgOk
      ? `user=${env.PGUSER} db=${env.PGDATABASE ?? '(默认)'}`
      : 'PGUSER/PGPASSWORD 或 PGHOST/PGDATABASE 缺失',
  });

  // 2) 迁移记账：_migrations 行数必须等于根目录迁移文件数。
  try {
    const r = await input.query('SELECT count(*)::int AS n FROM _migrations');
    const applied = num(r.rows[0]?.n);
    const expected = input.expectedMigrationCount;
    checks.push({
      id: 'db.migrations',
      title: '迁移记账完整',
      status: applied === expected ? PASS : FAIL,
      detail: `_migrations=${applied} / 文件=${expected}${applied === expected ? '' : '（不得跳迁移）'}`,
    });
  } catch (e) {
    checks.push({
      id: 'db.migrations',
      title: '迁移记账完整',
      status: FAIL,
      detail: `查询 _migrations 失败：${(e as Error).message}`,
    });
  }

  // 3) 租户必须存在且 active。
  try {
    const r = await input.query('SELECT status FROM tenant_registry WHERE tenant_id = $1', [tenantId]);
    const status = r.rows[0]?.status;
    checks.push({
      id: 'tenant.active',
      title: `租户 ${tenantId} 存在且 active`,
      status: status === 'active' ? PASS : FAIL,
      detail: status ? `status=${status}` : '租户不存在',
    });
  } catch (e) {
    checks.push({
      id: 'tenant.active',
      title: `租户 ${tenantId} 存在且 active`,
      status: FAIL,
      detail: `查询 tenant_registry 失败：${(e as Error).message}`,
    });
  }

  // 4) 至少一个启用的 admin。
  try {
    const r = await input.query(
      `SELECT count(*)::int AS n FROM account_user
       WHERE tenant_id = $1 AND role = 'admin' AND active = true`,
      [tenantId],
    );
    const n = num(r.rows[0]?.n);
    checks.push({
      id: 'account.admin',
      title: '存在启用的 admin 账号',
      status: n >= 1 ? PASS : FAIL,
      detail: `admin=${n}`,
    });
  } catch (e) {
    checks.push({
      id: 'account.admin',
      title: '存在启用的 admin 账号',
      status: FAIL,
      detail: `查询 account_user 失败：${(e as Error).message}`,
    });
  }

  // 5) worker 档案与账号绑定：无档案 → warn；有档案但未绑定 / 绑错 → fail。
  try {
    const r = await input.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE account_id IS NULL OR btrim(account_id) = '')::int AS unbound
       FROM worker WHERE tenant_id = $1`,
      [tenantId],
    );
    const total = num(r.rows[0]?.total);
    const unbound = num(r.rows[0]?.unbound);
    checks.push({
      id: 'worker.binding',
      title: 'worker 档案均已绑定账号',
      status: total === 0 ? WARN : unbound === 0 ? PASS : FAIL,
      detail: total === 0 ? '尚未建 worker 档案（试点初始化需补）' : `total=${total} unbound=${unbound}`,
    });
  } catch (e) {
    checks.push({
      id: 'worker.binding',
      title: 'worker 档案均已绑定账号',
      status: FAIL,
      detail: `查询 worker 失败：${(e as Error).message}`,
    });
  }

  // 6) account_id 必须能对上真实账号（text ↔ uuid 用 ::text 比较）。
  try {
    const r = await input.query(
      `SELECT count(*)::int AS n
       FROM worker w
       LEFT JOIN account_user au ON au.id::text = w.account_id AND au.tenant_id = w.tenant_id
       WHERE w.tenant_id = $1
         AND w.account_id IS NOT NULL AND btrim(w.account_id) <> ''
         AND au.id IS NULL`,
      [tenantId],
    );
    const n = num(r.rows[0]?.n);
    checks.push({
      id: 'worker.binding_valid',
      title: 'worker.account_id 均指向本租户真实账号',
      status: n === 0 ? PASS : FAIL,
      detail: `错绑/悬空=${n}`,
    });
  } catch (e) {
    checks.push({
      id: 'worker.binding_valid',
      title: 'worker.account_id 均指向本租户真实账号',
      status: FAIL,
      detail: `关联校验失败：${(e as Error).message}`,
    });
  }

  // 7) RLS：租户表应开启行级安全。少于 80 张只告警（可能尚未跑完全部迁移）。
  try {
    const r = await input.query(
      `SELECT count(*)::int AS n
       FROM pg_class c
       JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true`,
    );
    const n = num(r.rows[0]?.n);
    const expectedRls = input.expectedRlsTables ?? 80;
    checks.push({
      id: 'rls.enabled',
      title: '租户表已启用 RLS',
      status: n >= expectedRls ? PASS : n > 0 ? WARN : FAIL,
      detail: `启用 RLS 的表=${n}（迁移基线 ${expectedRls}）`,
    });
  } catch (e) {
    checks.push({
      id: 'rls.enabled',
      title: '租户表已启用 RLS',
      status: FAIL,
      detail: `查询 pg_class 失败：${(e as Error).message}`,
    });
  }

  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}

/** 供 scripts 打印的纯文本报告（不引入表格库）。 */
export function formatPreflightReport(result: PreflightResult): string {
  const icon: Record<PreflightStatus, string> = { pass: '[PASS]', warn: '[WARN]', fail: '[FAIL]' };
  const lines = result.checks.map((c) => `${icon[c.status]} ${c.id} — ${c.title}：${c.detail}`);
  lines.push(result.ok ? '自检通过：未发现阻断项。' : '自检失败：存在 FAIL 项，禁止进入试点验收。');
  return lines.join('\n');
}

/** 便捷重载：直接把 PoolClient.query 适配成 PreflightQuery。 */
export function queryFromClient(client: PoolClient): PreflightQuery {
  return async (sql, params) => {
    const r = await client.query(sql, params as unknown[] | undefined);
    return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rowCount };
  };
}
