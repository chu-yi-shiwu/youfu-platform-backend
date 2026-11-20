// transitionEntityGuards.test.ts —— P0-5 通用业务流流转门禁（真函数 + 假 DB）。
//
// 【修复前的真实洞】
//   `transitionEntity` 只校验拓扑（applyEvent），workflow_def 里配的 allowedRoles /
//   allowedPerms / requiredFields 对未进代理注册表的实体完全无效：
//   任意登录账号都能把自定义业务流推到任意合法状态。
//
// 本文件钉死：
//   ① allowedRoles 生效：白名单外 → 403，且不得 UPDATE；
//   ② 白名单内 → 放行；
//   ③ allowedPerms 生效（并集语义，租户 role_permission 授权后放行）；
//   ④ 无 allowedPerms 时零权限查询（与改造前等价，不打断存量）；
//   ⑤ requiredFields 缺失 → 422；
//   ⑥ systemAuto（HMAC webhook/调度器）跳过人类角色门禁；
//   ⑦ 两条门都未配置 → 向后兼容放行。
import { describe, it, expect, vi } from 'vitest';
import { transitionEntity } from '../engine/transition.js';
import type { WorkflowDef } from '../engine/stateMachine.js';

const T = 't-flow';

function makeClient(opts: { permRows?: Array<{ perm: string }>; updates?: { n: number } } = {}) {
  const updates = opts.updates ?? { n: 0 };
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes('FROM business_flow_tasks')) {
        return { rows: [{ id: 't-1', tenant_id: T, status: 'draft', def_version: 0, data: {} }], rowCount: 1 };
      }
      if (text.includes('FROM workflow_def')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT perm FROM role_permission')) {
        const rows = opts.permRows ?? [];
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith('UPDATE business_flow_tasks')) {
        updates.n += 1;
        return { rows: [{ id: 't-1', tenant_id: T, status: 'assigned', def_version: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return { client, calls, updates };
}

const defWith = (t: Partial<WorkflowDef['transitions'][number]>): WorkflowDef => ({
  initial: 'draft',
  states: ['draft', 'assigned'],
  transitions: [{ from: 'draft', to: 'assigned', event: 'assign', ...t }],
  config: {},
});

const base = {
  table: 'business_flow_tasks',
  id: 't-1',
  event: 'assign',
  entityType: 'custom_flow',
};

describe('P0-5 · transitionEntity 消费 allowedRoles / allowedPerms / requiredFields', () => {
  it('① allowedRoles 白名单外 → 403，且不 UPDATE', async () => {
    const { client, updates } = makeClient();
    await expect(
      transitionEntity(client as never, T, { ...base, fallbackDef: defWith({ allowedRoles: ['admin'] }), actorRole: 'worker' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(updates.n).toBe(0);
  });

  it('② allowedRoles 白名单内 → 放行', async () => {
    const { client, updates } = makeClient();
    const row = await transitionEntity(client as never, T, {
      ...base,
      fallbackDef: defWith({ allowedRoles: ['admin', 'worker'] }),
      actorRole: 'worker',
    });
    expect(row.status).toBe('assigned');
    expect(updates.n).toBe(1);
  });

  it('③ allowedPerms：租户显式授权后放行（与 allowedRoles 并集）', async () => {
    const { client, calls, updates } = makeClient({ permRows: [{ perm: 'workflow.approve' }] });
    const row = await transitionEntity(client as never, T, {
      ...base,
      fallbackDef: defWith({ allowedRoles: ['admin'], allowedPerms: ['workflow.approve'] }),
      actorRole: 'reviewer',
    });
    expect(row.status).toBe('assigned');
    expect(updates.n).toBe(1);
    expect(calls.some((c) => c.text.includes('SELECT perm FROM role_permission'))).toBe(true);
  });

  it('③b allowedPerms 未命中（默认矩阵无该点）→ 403', async () => {
    const { client, updates } = makeClient({ permRows: [] });
    await expect(
      transitionEntity(client as never, T, {
        ...base,
        fallbackDef: defWith({ allowedPerms: ['workflow.approve'] }),
        actorRole: 'reviewer',
        actorAuthMode: 'prod',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(updates.n).toBe(0);
  });

  it('④ 未声明 allowedPerms → 不查权限表（存量零额外查询）', async () => {
    const { client, calls } = makeClient();
    await transitionEntity(client as never, T, {
      ...base,
      fallbackDef: defWith({ allowedRoles: ['worker'] }),
      actorRole: 'worker',
    });
    expect(calls.some((c) => c.text.includes('SELECT perm FROM role_permission'))).toBe(false);
  });

  it('⑤ requiredFields 缺失 → 422，且不 UPDATE', async () => {
    const { client, updates } = makeClient();
    await expect(
      transitionEntity(client as never, T, {
        ...base,
        fallbackDef: defWith({ requiredFields: ['reason'] }),
        actorRole: 'admin',
        extra: {},
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 422 });
    expect(updates.n).toBe(0);
  });

  it('⑥ systemAuto（HMAC webhook/调度器）跳过人类角色门禁', async () => {
    const { client, updates } = makeClient();
    const row = await transitionEntity(client as never, T, {
      ...base,
      fallbackDef: defWith({ allowedRoles: ['admin', 'operator'] }),
      actor: 'energy-webhook',
      systemAuto: true,
    });
    expect(row.status).toBe('assigned');
    expect(updates.n).toBe(1);
  });

  it('⑦ 两条门都未配置 → 向后兼容放行（含 role 缺失）', async () => {
    const { client, updates } = makeClient();
    const row = await transitionEntity(client as never, T, { ...base, fallbackDef: defWith({}) });
    expect(row.status).toBe('assigned');
    expect(updates.n).toBe(1);
  });
});
