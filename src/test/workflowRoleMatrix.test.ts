// 工作流角色 × 动作矩阵（富 13 态模板 RICH_WORK_ORDER_DEF）
//
// 背景（2026-11-10 真机实锤）：
//   - worker 在小程序能点到「取消 / 复核通过 / 复核退回」，但后端全部 403；
//   - 这说明前端按钮可见性与后端 allowedRoles 门禁脱节。
//
// 本测试固定「富 13 态模板」的角色门禁语义，防止后续改边时把 worker 不该有的动作放开：
//   - cancel：仅 admin（或持 ticket.manage 的角色）
//   - approve / reject：admin / reviewer（或持 workflow.approve 的角色）
//   - suspend：不限角色，但必须带 suspend_reason
//   - submit_review：admin / worker
//   - forward：admin（或持 dispatch.override 的角色）
//
// 注意：这是「默认 def」的契约测试。租户可在 workflow_def 覆盖，但覆盖后仍应遵守
// 「allowedRoles 是唯一事实源」；租户级矩阵由 scripts/pilot-role-action-e2e.mjs 实测。
import { describe, it, expect } from 'vitest';
import {
  RICH_WORK_ORDER_DEF,
  isTransitionAllowed,
  type WorkflowTransition,
} from '../engine/stateMachine.js';

const DEF = RICH_WORK_ORDER_DEF;
const ROLES = ['admin', 'operator', 'worker', 'reviewer', 'dispatcher', 'service_desk'] as const;

// 默认权限矩阵（与 middleware/role.ts 的 PERM_DEFS 对齐；只列与本矩阵相关的点）
const PERMS: Record<string, string[]> = {
  admin: [],
  operator: ['intake.create', 'ticket.manage', 'dispatch.override'],
  worker: ['intake.create', 'inspect.execute', 'asset.scan', 'consumable.consume'],
  reviewer: ['workflow.approve'],
  dispatcher: ['dispatch.override', 'inspect.execute'],
  service_desk: ['ticket.manage', 'dispatch.override'],
};

function can(edge: WorkflowTransition, role: string): boolean {
  return isTransitionAllowed(edge, { role, perms: PERMS[role] ?? [] });
}

function edgesByEvent(event: string): WorkflowTransition[] {
  const list = DEF.transitions.filter((t) => t.event === event);
  expect(list.length, `默认流程缺少事件 ${event}`).toBeGreaterThan(0);
  return list;
}

describe('富 13 态模板：角色 × 动作矩阵', () => {
  it('cancel：worker 不可取消；admin 可取消；每条取消边都要求 cancel_reason', () => {
    for (const edge of edgesByEvent('cancel')) {
      expect(can(edge, 'admin'), `${edge.from}->cancel admin`).toBe(true);
      expect(can(edge, 'worker'), `${edge.from}->cancel worker`).toBe(false);
      expect(can(edge, 'operator'), `${edge.from}->cancel operator`).toBe(true); // ticket.manage
      expect(can(edge, 'reviewer'), `${edge.from}->cancel reviewer`).toBe(false);
      expect(edge.requiredFields).toContain('cancel_reason');
    }
  });

  it('approve / reject：worker、operator 不可复核；admin、reviewer 可复核', () => {
    for (const event of ['approve', 'reject']) {
      for (const edge of edgesByEvent(event)) {
        expect(can(edge, 'admin'), `${edge.from}->${event} admin`).toBe(true);
        expect(can(edge, 'reviewer'), `${edge.from}->${event} reviewer`).toBe(true);
        expect(can(edge, 'worker'), `${edge.from}->${event} worker`).toBe(false);
        expect(can(edge, 'operator'), `${edge.from}->${event} operator`).toBe(false);
      }
    }
  });

  it('submit_review：worker / admin 可提交；operator / reviewer 不可', () => {
    for (const edge of edgesByEvent('submit_review')) {
      expect(can(edge, 'admin')).toBe(true);
      expect(can(edge, 'worker')).toBe(true);
      expect(can(edge, 'operator')).toBe(false);
      expect(can(edge, 'reviewer')).toBe(false);
    }
  });

  it('suspend：不限制角色，但必须带 suspend_reason', () => {
    for (const edge of edgesByEvent('suspend')) {
      for (const role of ROLES) expect(can(edge, role), `${edge.from}->suspend ${role}`).toBe(true);
      expect(edge.requiredFields).toContain('suspend_reason');
    }
  });

  it('forward：worker 不可改派；admin 可改派（operator 经 dispatch.override 可）', () => {
    for (const edge of edgesByEvent('forward')) {
      expect(can(edge, 'admin')).toBe(true);
      expect(can(edge, 'worker')).toBe(false);
      expect(can(edge, 'operator')).toBe(true); // dispatch.override
      expect(can(edge, 'reviewer')).toBe(false);
    }
  });

  it('return：不限制角色，但必须带 return_reason', () => {
    for (const edge of edgesByEvent('return')) {
      for (const role of ROLES) expect(can(edge, role), `${edge.from}->return ${role}`).toBe(true);
      expect(edge.requiredFields).toContain('return_reason');
    }
  });
});
