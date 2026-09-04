import { describe, it, expect } from 'vitest';
import { canAssignRole, ROLE_RANK } from '../middleware/role.js';

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
