// 抢单池统一（2026-11-01）：巡检 / 运送 进抢单大厅
//
// 背景（实测，非推测）：抢单大厅此前只查 work_orders 单表，工人打开大厅永远只看到工单。
//   巡检单只能"建单时写死 assignee"，运送单只能管理端 dispatch（要求 dispatch.override），
//   两类都没有任何工人自助入口 ⇒ 没被指派时工人既看不见也接不了，要记三套归属规则。
//
// 本组钉住三件事（都是**设计决定**，不是实现细节，改它要先改产品口径）：
//   ① 两类实体的池态由 def 的 claim 边派生（与工单同一机制，不另起一套名单）
//   ② 认领边对 worker 放行（否则"进池"等于给工人看一堆点不动的按钮）
//   ③ 认领后的目标态各按业务语义：运送→assigned（有"已派单"态）；
//      巡检→仍是 pending（巡检没有"已派单"态，认领只落归属，"开始"是 checkin）
import { describe, it, expect } from 'vitest';
import { INSPECTION_DEF, TRANSPORT_DEF } from '../engine/themes.js';
import { claimableStates, isTransitionAllowed } from '../engine/stateMachine.js';

describe('① 池态由 claim 边派生（不写死名单）', () => {
  it('巡检：可认领态 = pending', () => {
    expect(claimableStates(INSPECTION_DEF)).toEqual(['pending']);
  });

  it('运送：可认领态 = pending', () => {
    expect(claimableStates(TRANSPORT_DEF)).toEqual(['pending']);
  });

  it('池态必须是 def.states 的子集（派生不出拓扑外的态）', () => {
    for (const [name, def] of [
      ['inspection', INSPECTION_DEF],
      ['transport', TRANSPORT_DEF],
    ] as const) {
      for (const s of claimableStates(def)) {
        expect(def.states, `${name} 的池态 ${s} 不在 states 里`).toContain(s);
      }
    }
  });
});

describe('② 认领边对 worker 放行（否则进池无意义）', () => {
  const claimEdge = (def: typeof INSPECTION_DEF) => def.transitions.find((t) => t.event === 'claim')!;

  it('巡检认领边存在且含 worker / admin', () => {
    const e = claimEdge(INSPECTION_DEF);
    expect(e).toBeDefined();
    expect(e.allowedRoles).toContain('worker');
    expect(e.allowedRoles).toContain('admin');
  });

  it('运送认领边存在且含 worker / admin', () => {
    const e = claimEdge(TRANSPORT_DEF);
    expect(e).toBeDefined();
    expect(e.allowedRoles).toContain('worker');
    expect(e.allowedRoles).toContain('admin');
  });

  it('worker 走两类认领边都放行；无关角色不放行', () => {
    for (const def of [INSPECTION_DEF, TRANSPORT_DEF]) {
      const e = claimEdge(def);
      expect(isTransitionAllowed(e, { role: 'worker' })).toBe(true);
      expect(isTransitionAllowed(e, { role: 'reviewer' })).toBe(false);
      expect(isTransitionAllowed(e, { role: undefined })).toBe(false);
    }
  });

  it('认领边不挂 dispatch.override（抢单是工人自助动作，不该要管理权限）', () => {
    for (const def of [INSPECTION_DEF, TRANSPORT_DEF]) {
      const e = claimEdge(def);
      expect(e.allowedPerms ?? []).not.toContain('dispatch.override');
    }
  });
});

describe('③ 认领后的目标态按各自业务语义', () => {
  it('运送：pending --claim--> assigned（与工单 assigned 同形，认领即可取货）', () => {
    const e = TRANSPORT_DEF.transitions.find((t) => t.from === 'pending' && t.event === 'claim');
    expect(e?.to).toBe('assigned');
  });

  it('巡检：pending --claim--> pending（认领只落归属，绝不替工人签到）', () => {
    const e = INSPECTION_DEF.transitions.find((t) => t.from === 'pending' && t.event === 'claim');
    expect(e?.to).toBe('pending');
    // 佐证：巡检的"开始"仍然是 checkin，且只从 pending 出发
    const checkin = INSPECTION_DEF.transitions.find((t) => t.event === 'checkin');
    expect(checkin?.from).toBe('pending');
    expect(checkin?.to).toBe('in_progress');
  });
});
