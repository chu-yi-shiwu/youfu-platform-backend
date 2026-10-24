import { describe, it, expect, vi } from 'vitest';
import {
  canAssignRole,
  ROLE_RANK,
  hasPermDefault,
  requireAnyPermission,
  hasPerm,
  requirePermission,
  permBase,
  assertEntityTypeScope,
} from '../middleware/role.js';

describe('role: 层级定义', () => {
  it('ROLE_RANK 严格递增 worker<dispatcher<operator<admin', () => {
    expect(ROLE_RANK.worker).toBeLessThan(ROLE_RANK.dispatcher);
    expect(ROLE_RANK.dispatcher).toBeLessThan(ROLE_RANK.operator);
    expect(ROLE_RANK.operator).toBeLessThan(ROLE_RANK.admin);
  });
});

describe('role: canAssignRole（R15-005 提权门禁）', () => {
  it('admin 可分配任意角色（含 admin）', () => {
    expect(canAssignRole('admin', 'admin')).toBe(true);
    expect(canAssignRole('admin', 'operator')).toBe(true);
    expect(canAssignRole('admin', 'worker')).toBe(true);
  });

  it('operator 不可分配 admin（核心防线：防铸造管理员）', () => {
    expect(canAssignRole('operator', 'admin')).toBe(false);
  });

  it('operator 可分配同级及以下（operator/dispatcher/worker）', () => {
    expect(canAssignRole('operator', 'operator')).toBe(true);
    expect(canAssignRole('operator', 'dispatcher')).toBe(true);
    expect(canAssignRole('operator', 'worker')).toBe(true);
  });

  it('operator 不可越级（无更高角色可分配，仅 admin 更高）', () => {
    // operator 之上只有 admin，已在上一条断言覆盖
    expect(canAssignRole('operator', 'admin')).toBe(false);
  });

  it('dispatcher 不可分配 operator / admin', () => {
    expect(canAssignRole('dispatcher', 'operator')).toBe(false);
    expect(canAssignRole('dispatcher', 'admin')).toBe(false);
    expect(canAssignRole('dispatcher', 'dispatcher')).toBe(true);
    expect(canAssignRole('dispatcher', 'worker')).toBe(true);
  });

  it('未定义调用方按 worker 处理，不可分配任何管理角色', () => {
    expect(canAssignRole(undefined, 'admin')).toBe(false);
    expect(canAssignRole(undefined, 'operator')).toBe(false);
    expect(canAssignRole(undefined, 'worker')).toBe(true);
  });
});

// AL-002 修复回归（2026-09-04）：reviewer / service_desk 两角色进入权限体系。
describe('role: reviewer / service_desk（AL-002）', () => {
  it('层级序保持 worker ≤ service_desk=dispatcher ≤ reviewer=operator < admin', () => {
    expect(ROLE_RANK.service_desk).toBe(ROLE_RANK.dispatcher);
    expect(ROLE_RANK.reviewer).toBe(ROLE_RANK.operator);
    expect(ROLE_RANK.worker).toBeLessThan(ROLE_RANK.service_desk);
    expect(ROLE_RANK.reviewer).toBeLessThan(ROLE_RANK.admin);
  });

  it('admin 可分配新角色；operator 可分配 reviewer/service_desk', () => {
    expect(canAssignRole('admin', 'reviewer')).toBe(true);
    expect(canAssignRole('admin', 'service_desk')).toBe(true);
    expect(canAssignRole('operator', 'reviewer')).toBe(true);
    expect(canAssignRole('operator', 'service_desk')).toBe(true);
  });

  it('dispatcher 可分配 service_desk（同层）但不可分配 reviewer（越级）', () => {
    expect(canAssignRole('dispatcher', 'service_desk')).toBe(true);
    expect(canAssignRole('dispatcher', 'reviewer')).toBe(false);
  });

  it('新角色不可自我越级分配 admin', () => {
    expect(canAssignRole('reviewer', 'admin')).toBe(false);
    expect(canAssignRole('service_desk', 'admin')).toBe(false);
    expect(canAssignRole('service_desk', 'reviewer')).toBe(false);
  });
});

describe('role: 建单权限（#942 R15 陪检登记 403 修复）', () => {
  it('worker 默认矩阵含 intake.create（录入面）且不含 ticket.manage（管理面）', () => {
    expect(hasPermDefault('worker', 'intake.create')).toBe(true);
    expect(hasPermDefault('worker', 'ticket.manage')).toBe(false);
  });

  it('requireAnyPermission：worker 命中 intake.create → 放行（陪检登记链路）', async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as any;
    const auth = { authMode: 'prod', role: 'worker', tenantId: 't-demo' } as any;
    await expect(requireAnyPermission(auth, client, ['intake.create', 'ticket.manage'])).resolves.toBeUndefined();
  });

  it('requireAnyPermission：reviewer 仅 ticket.manage → 仍放行（不回归既有能力）', async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as any;
    const auth = { authMode: 'prod', role: 'reviewer', tenantId: 't-demo' } as any;
    await expect(requireAnyPermission(auth, client, ['intake.create', 'ticket.manage'])).resolves.toBeUndefined();
  });

  it('requireAnyPermission：worker 对纯 ticket.manage 守卫 → 403（无权限放大）', async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as any;
    const auth = { authMode: 'prod', role: 'worker', tenantId: 't-demo' } as any;
    await expect(requireAnyPermission(auth, client, ['ticket.manage'])).rejects.toThrow(/permission denied/);
  });

  it('租户覆盖表模式：worker 覆盖行含 intake.create → 放行（交集判定）', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ perm: 'intake.create' }], rowCount: 1 })) } as any;
    const auth = { authMode: 'prod', role: 'worker', tenantId: 't-demo' } as any;
    await expect(requireAnyPermission(auth, client, ['intake.create', 'ticket.manage'])).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 实例级权限（2026-10-24）：`perm@entityType` 只对指定单据类型生效。
// 验收重心是 **向后兼容**（存量只授全局的租户行为必须不变）与 **无权限放大**
//（只授实例级的人，在别的单据类型 / 无单据上下文时必须被拦）。
// ─────────────────────────────────────────────────────────────────────────────
describe('role/T3: permBase 与 entityType 白名单', () => {
  it('permBase：无 @ 原样返回；有 @ 去掉后缀', () => {
    expect(permBase('ticket.manage')).toBe('ticket.manage');
    expect(permBase('ticket.manage@transport_task')).toBe('ticket.manage');
  });

  it('assertEntityTypeScope：形状非法（大写/中文/空）⇒ 400，不静默放行', () => {
    expect(() => assertEntityTypeScope('Transport_Task')).toThrow(/invalid entity_type/);
    expect(() => assertEntityTypeScope('随便写')).toThrow(/invalid entity_type/);
    expect(() => assertEntityTypeScope('')).toThrow(/invalid entity_type/);
  });

  it('assertEntityTypeScope：形状合法但不在 known 清单 ⇒ 400（防"写错但合法"的垃圾进库）', () => {
    expect(() => assertEntityTypeScope('transport_tesk', ['transport_task'])).toThrow(/unknown entity_type/);
  });

  it('assertEntityTypeScope：形状合法且在 known 清单 ⇒ 放行', () => {
    expect(() => assertEntityTypeScope('transport_task', ['transport_task'])).not.toThrow();
    // 不传 known 时只校形状（调用方拿不到库连接时的降级口径）
    expect(() => assertEntityTypeScope('transport_task')).not.toThrow();
  });
});

describe('role/T3: hasPerm 实例级作用域判定', () => {
  const mkClient = (perms: string[]) =>
    ({ query: vi.fn(async () => ({ rows: perms.map((perm) => ({ perm })), rowCount: perms.length })) }) as any;
  const mkAuth = () => ({ authMode: 'prod', role: 'operator', tenantId: 't-demo' } as any);

  it('只授实例级 ⇒ 匹配的单据放行', async () => {
    await expect(hasPerm(mkAuth(), mkClient(['workflow.approve@transport_task']), 'workflow.approve', 'transport_task')).resolves.toBe(true);
  });

  it('只授实例级 ⇒ 别的单据被拦（无权限放大，这是本特性的全部意义）', async () => {
    await expect(hasPerm(mkAuth(), mkClient(['workflow.approve@transport_task']), 'workflow.approve', 'inspection_task')).resolves.toBe(false);
  });

  it('只授实例级 ⇒ 无单据上下文时也被拦（列表等全局端点不放行）', async () => {
    await expect(hasPerm(mkAuth(), mkClient(['workflow.approve@transport_task']), 'workflow.approve')).resolves.toBe(false);
  });

  it('🟢 向后兼容①：存量只授全局 ⇒ 传不传 entityType 都放行（行为不变）', async () => {
    await expect(hasPerm(mkAuth(), mkClient(['workflow.approve']), 'workflow.approve', 'transport_task')).resolves.toBe(true);
    await expect(hasPerm(mkAuth(), mkClient(['workflow.approve']), 'workflow.approve')).resolves.toBe(true);
  });

  it('🟢 向后兼容②：全局与实例级同时存在 ⇒ 全局优先，任何单据都放行', async () => {
    await expect(hasPerm(mkAuth(), mkClient(['workflow.approve', 'workflow.approve@transport_task']), 'workflow.approve', 'inspection_task')).resolves.toBe(true);
  });

  it('admin / dev 恒放行（不被实例级配置削弱）', async () => {
    const admin = { authMode: 'prod', role: 'admin', tenantId: 't-demo' } as any;
    const dev = { authMode: 'dev', role: 'operator', tenantId: 't-demo' } as any;
    await expect(hasPerm(admin, mkClient(['workflow.approve@transport_task']), 'workflow.approve', 'inspection_task')).resolves.toBe(true);
    await expect(hasPerm(dev, mkClient(['workflow.approve@transport_task']), 'workflow.approve', 'inspection_task')).resolves.toBe(true);
  });

  it('requirePermission 被拦时 403 消息带作用域（否则日志查不出"为什么批不了")', async () => {
    await expect(
      requirePermission(mkAuth(), mkClient(['workflow.approve@transport_task']), 'workflow.approve', 'inspection_task'),
    ).rejects.toThrow(/permission denied: workflow\.approve@inspection_task/);
  });
});
