// 角色/权限/流程三层可配置 —— 地基第二步（代码层）契约护栏。
//
// 【用户设计原意（逐条对齐）】
//   ① 角色可配置：租户可自建岗位（如"维修组长"），不必受限于内置 6 角色；
//   ② 权限可配置：什么角色行使什么权限，租户自配；
//   ③ 流程可配置：什么角色参与什么流程、行使什么权限；
//   ④ **审核不是一个人，是一个权限属性**——可以挂给任何角色，或配自动审核规则。
//
// 【改造前的事实（实测）】
//   src/repo/ticket.ts:196 门禁 = `tdef.allowedRoles.includes(role)`，
//   纯角色名白名单 → approve/reject 写死 ['admin','reviewer']，审核被绑死成一个岗位。
//
// 【改法】转移门禁支持 allowedRoles ∪ allowedPerms 并集：
//   存量 allowedRoles 一行不改（零回归），新增 allowedPerms 承载"可叠加的能力属性"。
//
// 全部断言零 DB 依赖（纯函数 + 静态声明扫描），任何环境可跑。
import { describe, it, expect } from 'vitest';
import {
  RICH_WORK_ORDER_DEF,
  isTransitionAllowed,
  type WorkflowTransition,
} from '../engine/stateMachine.js';
import { roleRank, canAssignRole, ROLE_CODE_RE, CUSTOM_ROLE_RANK, ROLE_RANK } from '../middleware/role.js';

const t = (over: Partial<WorkflowTransition>): WorkflowTransition => ({
  from: 'a',
  to: 'b',
  event: 'e',
  ...over,
});

describe('转移门禁 —— allowedRoles ∪ allowedPerms 并集', () => {
  it('未声明任何门禁 → 放行（向后兼容，绝不门死自己）', () => {
    expect(isTransitionAllowed(t({}), { role: 'worker' })).toBe(true);
    expect(isTransitionAllowed(t({ allowedRoles: [] }), { role: 'worker' })).toBe(true);
    expect(isTransitionAllowed(t({ allowedPerms: [] }), { role: 'worker' })).toBe(true);
  });

  it('角色命中 → 放行（存量行为零变更）', () => {
    expect(isTransitionAllowed(t({ allowedRoles: ['admin', 'reviewer'] }), { role: 'reviewer' })).toBe(true);
  });

  it('角色不命中且无权限门禁 → 拒（存量行为零变更）', () => {
    expect(isTransitionAllowed(t({ allowedRoles: ['admin', 'reviewer'] }), { role: 'worker' })).toBe(false);
  });

  it('🔴核心：权限命中即放行 —— 审核成为可叠加属性，不再绑死岗位', () => {
    const approve = t({ allowedRoles: ['admin', 'reviewer'], allowedPerms: ['workflow.approve'] });
    // 自定义岗位"维修组长"不在 allowedRoles，但被授予 workflow.approve → 放行
    expect(isTransitionAllowed(approve, { role: 'repair_lead', perms: ['workflow.approve'] })).toBe(true);
    // worker 未被授权 → 仍拒（最小权限不放松）
    expect(isTransitionAllowed(approve, { role: 'worker', perms: ['inspect.execute'] })).toBe(false);
    // reviewer 即使不靠权限点也放行（存量 allowedRoles 依旧有效）
    expect(isTransitionAllowed(approve, { role: 'reviewer', perms: [] })).toBe(true);
  });

  it('纯权限门禁（不写 allowedRoles）：只有持权限点者可走', () => {
    const only = t({ allowedPerms: ['workflow.approve'] });
    expect(isTransitionAllowed(only, { role: 'anyone', perms: ['workflow.approve'] })).toBe(true);
    expect(isTransitionAllowed(only, { role: 'anyone', perms: ['ticket.manage'] })).toBe(false);
  });

  it('role 缺失 → 不命中角色门禁（R9-003：缺失视同不在白名单，不得短路放行）', () => {
    expect(isTransitionAllowed(t({ allowedRoles: ['admin'] }), {})).toBe(false);
    expect(isTransitionAllowed(t({ allowedRoles: ['admin'] }), { role: '' })).toBe(false);
  });

  it('并集不是交集：任一命中即放行', () => {
    const both = t({ allowedRoles: ['admin'], allowedPerms: ['workflow.approve'] });
    expect(isTransitionAllowed(both, { role: 'admin', perms: [] })).toBe(true); // 仅角色命中
    expect(isTransitionAllowed(both, { role: 'x', perms: ['workflow.approve'] })).toBe(true); // 仅权限命中
    expect(isTransitionAllowed(both, { role: 'x', perms: ['y'] })).toBe(false); // 都不命中
  });
});

describe('审核 = 权限属性（RICH 模板声明）', () => {
  const find = (event: string) => RICH_WORK_ORDER_DEF.transitions.find((x) => x.event === event)!;

  it('approve / reject 均挂 allowedPerms: workflow.approve', () => {
    expect(find('approve').allowedPerms).toEqual(['workflow.approve']);
    expect(find('reject').allowedPerms).toEqual(['workflow.approve']);
  });

  it('approve / reject 保留原 allowedRoles（存量零回归）', () => {
    expect(find('approve').allowedRoles).toEqual(['admin', 'reviewer']);
    expect(find('reject').allowedRoles).toEqual(['admin', 'reviewer']);
  });

  it('端到端语义：自定义岗位持 workflow.approve 可审，普通 worker 不可审', () => {
    const approve = find('approve');
    expect(isTransitionAllowed(approve, { role: 'repair_lead', perms: ['workflow.approve'] })).toBe(true);
    expect(isTransitionAllowed(approve, { role: 'worker', perms: ['inspect.execute'] })).toBe(false);
  });

  it('师傅接单（claim）仍然放行 —— 不得因本次改造门死执行侧', () => {
    const claim = RICH_WORK_ORDER_DEF.transitions.find((x) => x.event === 'claim')!;
    expect(claim.allowedRoles).toContain('worker');
    expect(isTransitionAllowed(claim, { role: 'worker', perms: ['inspect.execute'] })).toBe(true);
  });
});

describe('自定义角色 —— 层级与分配', () => {
  it('内置角色层级不变', () => {
    expect(roleRank('worker')).toBe(ROLE_RANK.worker);
    expect(roleRank('admin')).toBe(ROLE_RANK.admin);
  });

  it('自定义角色取兜底层级（最低），不得为 undefined/NaN', () => {
    expect(roleRank('repair_lead')).toBe(CUSTOM_ROLE_RANK);
    expect(Number.isFinite(roleRank('repair_lead'))).toBe(true);
    expect(CUSTOM_ROLE_RANK).toBeLessThanOrEqual(ROLE_RANK.worker);
  });

  it('🔴operator 可分配自定义角色（改造前因 rank=undefined 恒 false，自定义岗位根本建不出）', () => {
    expect(canAssignRole('operator', 'repair_lead')).toBe(true);
  });

  it('admin 恒可分配任意角色；非 admin 绝不可铸造 admin', () => {
    expect(canAssignRole('admin', 'repair_lead')).toBe(true);
    expect(canAssignRole('operator', 'admin')).toBe(false);
    expect(canAssignRole('worker', 'admin')).toBe(false);
  });

  it('worker 不得分配高于自身的角色', () => {
    expect(canAssignRole('worker', 'operator')).toBe(false);
    expect(canAssignRole('worker', 'repair_lead')).toBe(true); // 同层（兜底=worker 层）
  });
});

describe('角色 code 形状校验（与 090 role_def CHECK 同口径）', () => {
  it('合法 code', () => {
    for (const c of ['repair_lead', 'a1', 'x_2', 'site_ops_1']) expect(ROLE_CODE_RE.test(c)).toBe(true);
  });

  it('非法 code：大写 / 数字开头 / 含连字符 / 空 / 超长', () => {
    for (const c of ['Repair_Lead', '1lead', 'repair-lead', '', 'a'.repeat(33)]) {
      expect(ROLE_CODE_RE.test(c)).toBe(false);
    }
  });

  it('内置 6 角色本身也满足该形状（内置与自定义同口径，避免双标）', () => {
    for (const r of ['admin', 'operator', 'dispatcher', 'worker', 'reviewer', 'service_desk']) {
      expect(ROLE_CODE_RE.test(r)).toBe(true);
    }
  });
});

// ============ 用户原始诉求②："师傅不能接单谁接单？师傅的职能就是接单执行" ============
// 根因（实测）：accept 边（pending_accept → pending_dispatch，即"接单"）allowedRoles 原为
// ['admin','dispatcher','service_desk'] —— **不含 worker**，真正干活的师傅接不了单。
// 本组把"师傅必须能接单 + 存量三方权限一字不动"钉成回归护栏。
describe('师傅（worker）能接单 —— 用户原始诉求②', () => {
  const acceptEdge = () =>
    RICH_WORK_ORDER_DEF.transitions.find((x) => x.event === 'accept' && x.from === 'pending_accept');

  it('accept（接单）边存在且 allowedRoles 含 worker', () => {
    const e = acceptEdge();
    expect(e, 'RICH 模板应有 accept 边').toBeDefined();
    expect(e?.allowedRoles).toContain('worker');
  });

  it('worker 走 accept 边 → 放行（师傅能接单）', () => {
    const e = acceptEdge()!;
    expect(isTransitionAllowed(e, { role: 'worker' })).toBe(true);
  });

  it('admin 的接单权限保留（管理兜底不能丢）', () => {
    const e = acceptEdge()!;
    expect(e.allowedRoles).toContain('admin');
    expect(isTransitionAllowed(e, { role: 'admin' })).toBe(true);
  });

  // 【用户要求①】dispatcher / service_desk 退场：接单权回归"谁干活谁接"（师傅 + 管理兜底）。
  // 语义变更说明（不是回归）：改造前 accept 边含这两个待退场角色，等于"派单员能接单、师傅不能"，
  // 与用户原话「师傅的职能就是接单执行」相悖。此处摘除是**纠正**，不是破坏。
  // ⚠️ 真实影响（已如实告知用户）：存量 role='dispatcher'/'service_desk' 的账号将不能再接单，
  //    需管理员改派为 worker（他们本就在干执行的活）；存量数据一个不动，改派由人决策。
  it('退场角色（dispatcher/service_desk）不再出现在接单门禁里 —— 拿掉已生效', () => {
    const e = acceptEdge()!;
    expect(e.allowedRoles).not.toContain('dispatcher');
    expect(e.allowedRoles).not.toContain('service_desk');
    expect(isTransitionAllowed(e, { role: 'dispatcher' })).toBe(false);
    expect(isTransitionAllowed(e, { role: 'service_desk' })).toBe(false);
  });

  it('存量退场账号的出路：改派 worker 后即可接单（有解，不是把人卡死）', () => {
    const e = acceptEdge()!;
    expect(isTransitionAllowed(e, { role: 'worker' })).toBe(true);
  });

  it('无关角色仍不得接单（不得因补 worker 而放宽成谁都能接）', () => {
    const e = acceptEdge()!;
    expect(isTransitionAllowed(e, { role: 'reviewer' })).toBe(false);
    expect(isTransitionAllowed(e, { role: 'repair_lead' })).toBe(false);
    expect(isTransitionAllowed(e, { role: undefined })).toBe(false);
  });
});
