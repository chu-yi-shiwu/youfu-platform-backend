// #583 归属守卫单测：requireAssigneeOrConfig 权限模型
// 覆盖：admin/operator 放行；worker 归属本人放行；worker 非本人 403；孤儿任务 worker 403；dev 放行
import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { requireAssigneeOrConfig } from '../middleware/role.js';
import type { AuthLocals } from '../middleware/auth.js';

function fakeClient(rowsBySql: (sql: string, params: unknown[]) => { rows: any[]; rowCount: number }): PoolClient {
  return { query: async (sql: string, params: unknown[] = []) => rowsBySql(sql, params) } as unknown as PoolClient;
}

// worker 反查 client：account_id=uid → worker.id='w-1'
const workerClient = fakeClient((sql) => {
  if (sql.includes('FROM worker')) return { rows: [{ id: 'w-1' }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
});
// worker 反查未命中（无档案）
const noProfileClient = fakeClient((sql) => {
  if (sql.includes('FROM worker')) return { rows: [], rowCount: 0 };
  return { rows: [], rowCount: 0 };
});

function auth(role: string, userId = 'u-1', mode: 'prod' | 'dev' = 'prod'): AuthLocals {
  return {
    tenantId: 't1',
    requestId: 'r1',
    idempotencyKey: undefined,
    userId,
    username: 'u',
    role,
    authMode: mode,
  };
}

describe('requireAssigneeOrConfig · admin/operator 恒放行', () => {
  it('admin 不查 worker 直接放行', async () => {
    const c = fakeClient(() => { throw new Error('should not query'); });
    await expect(requireAssigneeOrConfig(c, auth('admin'), 'w-other', 'task')).resolves.toBeUndefined();
  });
  it('operator 不查 worker 直接放行', async () => {
    const c = fakeClient(() => { throw new Error('should not query'); });
    await expect(requireAssigneeOrConfig(c, auth('operator'), null, 'task')).resolves.toBeUndefined();
  });
});

describe('requireAssigneeOrConfig · worker 归属校验', () => {
  it('归属本人（assignee=w-1）→ 放行', async () => {
    await expect(requireAssigneeOrConfig(workerClient, auth('worker'), 'w-1', 'inspection task')).resolves.toBeUndefined();
  });
  it('非本人（assignee=w-2）→ 403', async () => {
    const err = await requireAssigneeOrConfig(workerClient, auth('worker'), 'w-2', 'inspection task').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(403);
  });
  it('孤儿任务（assignee 为空）→ 403', async () => {
    const err = await requireAssigneeOrConfig(workerClient, auth('worker'), '', 'inspection task').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(403);
  });
  it('worker 无档案（account_id 查不到）→ 403', async () => {
    const err = await requireAssigneeOrConfig(noProfileClient, auth('worker'), 'w-1', 'inspection task').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(403);
  });
  it('dispatcher（非 worker 非管理）→ 403', async () => {
    const err = await requireAssigneeOrConfig(workerClient, auth('dispatcher'), 'w-1', 'inspection task').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(403);
  });
});

describe('requireAssigneeOrConfig · dev 模式', () => {
  it('dev 模式放行（本地联调/测试兼容）', async () => {
    const c = fakeClient(() => { throw new Error('should not query'); });
    await expect(requireAssigneeOrConfig(c, auth('worker', 'u-1', 'dev'), 'w-any', 'task')).resolves.toBeUndefined();
  });
});
