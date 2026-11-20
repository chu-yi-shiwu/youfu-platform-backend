// pilotPreflight.test.ts —— 试点上线前自检的判定逻辑（不连真库）。
//
// 覆盖：环境（prod/密钥/PG 参数）、迁移记账、租户 active、admin、worker 绑定、
// 错绑/悬空 account_id、RLS 开启数；以及 fail/warn 对最终 ok 的影响。
import { describe, it, expect } from 'vitest';
import { runPreflight, formatPreflightReport, type PreflightQuery } from '../pilot/preflight.js';

const T = 'zixing-hospital';
const secret = 'x'.repeat(32);

function env(over: Partial<Record<string, string>> = {}) {
  return {
    AUTH_MODE: 'prod',
    NODE_ENV: 'production',
    JWT_SECRET: secret,
    PGHOST: '127.0.0.1',
    PGDATABASE: 'youfu',
    PGUSER: 'youfu_app',
    PGPASSWORD: 'p',
    ...over,
  };
}

interface Fake {
  migrations?: number;
  tenantStatus?: string | null;
  admins?: number;
  workers?: number;
  unbound?: number;
  badBindings?: number;
  rls?: number;
}

function fakeQuery(f: Fake = {}): PreflightQuery {
  return async (sql: string) => {
    const row = (o: Record<string, unknown>) => ({ rows: [o], rowCount: 1 });
    if (sql.includes('FROM _migrations')) return row({ n: f.migrations ?? 116 });
    if (sql.includes('FROM tenant_registry')) {
      const status = f.tenantStatus === undefined ? 'active' : f.tenantStatus;
      return status === null ? { rows: [], rowCount: 0 } : row({ status });
    }
    if (sql.includes('LEFT JOIN account_user au')) return row({ n: f.badBindings ?? 0 });
    if (sql.includes('FROM account_user')) return row({ n: f.admins ?? 1 });
    if (sql.includes('FROM worker WHERE')) {
      return row({ total: f.workers ?? 3, unbound: f.unbound ?? 0 });
    }
    if (sql.includes('FROM pg_class')) return row({ n: f.rls ?? 80 });
    return { rows: [], rowCount: 0 };
  };
}

function run(f: Fake = {}, e = env(), expectedRlsTables?: number) {
  return runPreflight({ tenantId: T, expectedMigrationCount: 116, expectedRlsTables, env: e, query: fakeQuery(f) });
}

describe('P0-9 · 试点上线前自检', () => {
  it('① 全部满足 → ok=true，所有检查为 pass', async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(r.checks.map((c) => c.id)).toEqual([
      'env.auth_mode',
      'env.jwt_secret',
      'env.pg',
      'db.migrations',
      'tenant.active',
      'account.admin',
      'worker.binding',
      'worker.binding_valid',
      'rls.enabled',
    ]);
  });

  it('② AUTH_MODE=dev → 直接 fail（试点红线）', async () => {
    const r = await run({}, env({ AUTH_MODE: 'dev' }));
    expect(r.ok).toBe(false);
    const c = r.checks.find((x) => x.id === 'env.auth_mode');
    expect(c?.status).toBe('fail');
    expect(c?.detail).toContain('dev');
  });

  it('③ JWT_SECRET 过短 → fail', async () => {
    const r = await run({}, env({ JWT_SECRET: 'short' }));
    expect(r.ok).toBe(false);
    expect(r.checks.find((x) => x.id === 'env.jwt_secret')?.status).toBe('fail');
  });

  it('④ 迁移记账不完整 → fail（禁止跳迁移）', async () => {
    const r = await run({ migrations: 115 });
    expect(r.ok).toBe(false);
    const c = r.checks.find((x) => x.id === 'db.migrations');
    expect(c?.status).toBe('fail');
    expect(c?.detail).toContain('115');
    expect(c?.detail).toContain('116');
  });

  it('⑤ 租户 pending / 不存在 → fail', async () => {
    const pending = await run({ tenantStatus: 'pending' });
    expect(pending.ok).toBe(false);
    expect(pending.checks.find((x) => x.id === 'tenant.active')?.status).toBe('fail');

    const missing = await run({ tenantStatus: null });
    expect(missing.ok).toBe(false);
    expect(missing.checks.find((x) => x.id === 'tenant.active')?.detail).toBe('租户不存在');
  });

  it('⑥ 无 admin → fail', async () => {
    const r = await run({ admins: 0 });
    expect(r.ok).toBe(false);
    expect(r.checks.find((x) => x.id === 'account.admin')?.status).toBe('fail');
  });

  it('⑦ 尚未建 worker 档案 → warn，但不阻断', async () => {
    const r = await run({ workers: 0, unbound: 0 });
    expect(r.ok).toBe(true);
    expect(r.checks.find((x) => x.id === 'worker.binding')?.status).toBe('warn');
  });

  it('⑧ worker 未绑定 / 悬空 account_id → fail', async () => {
    const unbound = await run({ workers: 3, unbound: 1 });
    expect(unbound.ok).toBe(false);
    expect(unbound.checks.find((x) => x.id === 'worker.binding')?.status).toBe('fail');

    const bad = await run({ badBindings: 2 });
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((x) => x.id === 'worker.binding_valid')?.status).toBe('fail');
  });

  it('⑨ RLS 未开启 → fail；少于基线 → warn', async () => {
    const none = await run({ rls: 0 });
    expect(none.ok).toBe(false);
    expect(none.checks.find((x) => x.id === 'rls.enabled')?.status).toBe('fail');

    const low = await run({ rls: 70 });
    expect(low.ok).toBe(true);
    expect(low.checks.find((x) => x.id === 'rls.enabled')?.status).toBe('warn');
  });

  it('⑩ 按迁移文件计算 RLS 基线：76 张 → pass，少于基线 → warn', async () => {
    const exact = await run({ rls: 76 }, env(), 76);
    expect(exact.ok).toBe(true);
    expect(exact.checks.find((x) => x.id === 'rls.enabled')?.status).toBe('pass');
    expect(exact.checks.find((x) => x.id === 'rls.enabled')?.detail).toContain('基线 76');

    const low = await run({ rls: 70 }, env(), 76);
    expect(low.ok).toBe(true);
    expect(low.checks.find((x) => x.id === 'rls.enabled')?.status).toBe('warn');
  });

  it('⑪ 报告文本包含 FAIL 与阻断结论', async () => {
    const r = await run({}, env({ AUTH_MODE: 'dev' }));
    const text = formatPreflightReport(r);
    expect(text).toContain('[FAIL] env.auth_mode');
    expect(text).toContain('自检失败');
  });
});
