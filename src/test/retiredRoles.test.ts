/**
 * 退场角色回归（用户要求①：拿掉 dispatcher / service_desk）。
 *
 * 本文件回答两个必须同时成立的问题，缺一不可：
 *   甲、**拿掉了**：两角色不再可新建、不再可分配、不出现在下拉、不出现在任何流程门禁；
 *   乙、**能力没断**：摘角色后，原本靠这两个角色干活的人（存量账号 / operator）依然干得了
 *       ——因为职能已改由**权限点**承载（dispatch.override / ticket.manage），
 *         门禁是 allowedRoles ∪ allowedPerms 并集。
 * 只做甲不做乙 = 把存量业务打死；只做乙不做甲 = 没拿掉。两组断言一起才是"零破坏地拿掉"。
 */
import { describe, it, expect } from 'vitest';
import {
  ROLES,
  RETIRED_ROLES,
  ASSIGNABLE_BUILTIN_ROLES,
  isRetiredRole,
  DEFAULT_PERM_MATRIX,
  OPS_ROLES,
  type Role,
} from '../middleware/role.js';
import { RICH_WORK_ORDER_DEF, isTransitionAllowed } from '../engine/stateMachine.js';
import { CLAIM_HALL_EDGES } from '../engine/claimHallEdges.js';
import { TRANSPORT_DEF } from '../engine/themes.js';

const RETIRED = ['dispatcher', 'service_desk'];

/** 取某角色的默认权限点集合（模拟 listPerms 在无租户覆盖行时的回退结果）。 */
const permsOf = (role: string): readonly string[] => DEFAULT_PERM_MATRIX[role as Role] ?? [];

const edges = (event: string) =>
  RICH_WORK_ORDER_DEF.transitions.filter((t) => t.event === event);

describe('甲 · 拿掉了 —— 退场角色从所有可选面消失', () => {
  it('退场清单就是这两个，不多不少', () => {
    expect([...RETIRED_ROLES].sort()).toEqual(['dispatcher', 'service_desk']);
  });

  it('ROLES 保留 6 个值（存量账号仍在 DB 里，删常量会让存量行变非法）', () => {
    expect(ROLES).toHaveLength(6);
    for (const r of RETIRED) expect(ROLES).toContain(r);
  });

  it('可分配内置角色 = 4 个（6 − 退场 2）', () => {
    expect([...ASSIGNABLE_BUILTIN_ROLES].sort()).toEqual(['admin', 'operator', 'reviewer', 'worker']);
  });

  it('isRetiredRole 判定准确（不误伤未退场角色）', () => {
    for (const r of RETIRED) expect(isRetiredRole(r)).toBe(true);
    for (const r of ['admin', 'operator', 'worker', 'reviewer', 'repair_lead']) {
      expect(isRetiredRole(r)).toBe(false);
    }
    expect(isRetiredRole(undefined)).toBe(false);
    expect(isRetiredRole('')).toBe(false);
  });

  it('运维角色 OPS_ROLES 已摘除 dispatcher', () => {
    expect(OPS_ROLES).not.toContain('dispatcher');
    expect(OPS_ROLES).toContain('admin');
    expect(OPS_ROLES).toContain('operator');
  });

  it('RICH 模板：任何边的 allowedRoles 都不得再出现退场角色', () => {
    for (const t of RICH_WORK_ORDER_DEF.transitions) {
      for (const r of RETIRED) {
        expect(t.allowedRoles ?? [], `边 ${t.from}--${t.event}-->${t.to} 仍含 ${r}`).not.toContain(r);
      }
    }
  });

  it('抢单大厅三条出边：同样不得再出现退场角色', () => {
    for (const t of CLAIM_HALL_EDGES) {
      for (const r of RETIRED) {
        expect(t.allowedRoles ?? [], `大厅边 ${t.event} 仍含 ${r}`).not.toContain(r);
      }
    }
  });

  it('主题模板 TRANSPORT_DEF 同样不得再出现退场角色', () => {
    for (const t of TRANSPORT_DEF.transitions) {
      for (const r of RETIRED) {
        expect(t.allowedRoles ?? []).not.toContain(r);
      }
    }
  });
});

describe('乙 · 能力没断 —— 职能改由权限点承载', () => {
  it('派单（dispatch）边补挂了 dispatch.override', () => {
    const es = edges('dispatch');
    expect(es.length).toBeGreaterThan(0);
    for (const e of es) expect(e.allowedPerms).toContain('dispatch.override');
  });

  it('转派（forward）边补挂了 dispatch.override', () => {
    for (const e of edges('forward')) expect(e.allowedPerms).toContain('dispatch.override');
  });

  it('撤销（cancel）边补挂了 ticket.manage', () => {
    for (const e of edges('cancel')) expect(e.allowedPerms).toContain('ticket.manage');
  });

  it('🔴 operator 仍能派单（默认矩阵本就含 dispatch.override → 零损失）', () => {
    const e = RICH_WORK_ORDER_DEF.transitions.find(
      (t) => t.event === 'dispatch' && t.from === 'pending_dispatch',
    )!;
    expect(isTransitionAllowed(e, { role: 'operator', perms: permsOf('operator') })).toBe(true);
  });

  it('🔴 operator 仍能撤销（默认矩阵本就含 ticket.manage → 零损失）', () => {
    const e = edges('cancel')[0];
    expect(isTransitionAllowed(e, { role: 'operator', perms: permsOf('operator') })).toBe(true);
  });

  it('🔴 存量 dispatcher 账号仍能派单 —— 摘掉边上的角色名后靠权限点放行（零破坏核心论证）', () => {
    const e = RICH_WORK_ORDER_DEF.transitions.find(
      (t) => t.event === 'dispatch' && t.from === 'pending_dispatch',
    )!;
    expect(e.allowedRoles).not.toContain('dispatcher'); // 角色确实拿掉了
    expect(isTransitionAllowed(e, { role: 'dispatcher', perms: permsOf('dispatcher') })).toBe(true); // 但人还能干活
  });

  it('🔴 存量 service_desk 账号仍能派单（同上，靠 dispatch.override）', () => {
    const e = RICH_WORK_ORDER_DEF.transitions.find(
      (t) => t.event === 'dispatch' && t.from === 'pending_dispatch',
    )!;
    expect(isTransitionAllowed(e, { role: 'service_desk', perms: permsOf('service_desk') })).toBe(true);
  });

  it('🔴 存量 service_desk 账号仍能撤销（默认矩阵含 ticket.manage）', () => {
    const e = edges('cancel')[0];
    expect(isTransitionAllowed(e, { role: 'service_desk', perms: permsOf('service_desk') })).toBe(true);
  });

  it('师傅能接单、能抢单（接单/抢单归干活的人，与退场无关）', () => {
    expect(isTransitionAllowed(edges('accept')[0], { role: 'worker' })).toBe(true);
    expect(isTransitionAllowed(edges('claim')[0], { role: 'worker' })).toBe(true);
  });

  it('无权限者也进不来（不得因改挂权限点而放宽成谁都能派单）', () => {
    const e = RICH_WORK_ORDER_DEF.transitions.find(
      (t) => t.event === 'dispatch' && t.from === 'pending_dispatch',
    )!;
    // worker 默认权限不含 dispatch.override / ticket.manage
    expect(isTransitionAllowed(e, { role: 'worker', perms: permsOf('worker') })).toBe(false);
    expect(isTransitionAllowed(e, { role: 'reviewer', perms: permsOf('reviewer') })).toBe(false);
    expect(isTransitionAllowed(e, { role: undefined, perms: [] })).toBe(false);
  });

  it('接单/抢单边**没有**挂 dispatch.override（防把 operator 扩权进执行动作）', () => {
    for (const e of [...edges('accept'), ...edges('claim')]) {
      expect(e.allowedPerms ?? []).not.toContain('dispatch.override');
    }
  });
});
