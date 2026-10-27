// statusVocabDerived.test.ts —— 状态口径派生（2026-10-21）
//
// 起因：审查上轮「四条旁路清零」结论时发现，旁路虽干净，但**统计口径里的状态名仍写死在 SQL 里**：
//   - routes/workOrder.ts GET /api/v1/open/me/summary（工人端「我的」页）
//     `status NOT IN ('completed','cancelled','claim_hall')` / `status IN ('completed')`
//     → ① 其它终态（closed / evaluated / 客户自定义终态）**全被算成在办**
//        （生产实测 t-verification 有 4 张 evaluated + 1 张 closed 正被报成「在办」）；
//     ② 客户改完成态名 → done_count 恒 0，且那些单倒灌进 active_count（双重错）；
//     ③ 完全没排除挂起态。
//   - repo/stats.ts ticketStats：`status = 'cancelled'` 写死（同查询里 completed 早已派生，对照鲜明）。
//
// 本文件钉两件事：① 取消态口径确实由流转边派生；② me/summary 的 SQL 参数确实来自派生、
//   且 SQL 里不再残留任何写死的状态名（拔掉根）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import {
  cancelledStates, activeStates, doneStates,
  type WorkflowDef,
} from '../engine/stateMachine.js';

const h = vi.hoisted(() => ({
  def: null as unknown,
  // 批 6：多版本样本（v1 = 老单锁的旧版本，versions = 库里真实存在的 def_version 列表）
  defV1: null as unknown,
  versions: null as unknown,
  captured: [] as Array<{ text: string; params: unknown[] }>,
}));

vi.mock('../db/pool.js', () => ({
  default: {
    query: async () => ({ rows: [{ status: 'active' }], rowCount: 1 }),
  },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) =>
    fn({
      query: async (text: string, params: unknown[] = []) => {
        h.captured.push({ text, params });
        // 批 6：让 getDefsAcrossAllVersions 真的拿到**两个不同版本**（否则只有哨兵 0 一版）
        if (text.includes('SELECT DISTINCT def_version')) {
          const rows = (h.versions as Array<{ def_version: number }> | null) ?? [];
          return { rows, rowCount: rows.length };
        }
        if (text.includes('SELECT version FROM workflow_def')) return { rows: [{ version: 2 }], rowCount: 1 };
        if (text.includes('FROM workflow_def_history')) {
          const d = Number(params[2]) === 1 ? h.defV1 : h.def;
          return { rows: d ? [{ def: JSON.stringify(d) }] : [], rowCount: d ? 1 : 0 };
        }
        if (text.includes('FROM workflow_def')) {
          return { rows: h.def ? [{ def: JSON.stringify(h.def) }] : [], rowCount: h.def ? 1 : 0 };
        }
        if (text.includes('FROM worker WHERE tenant_id')) {
          return {
            rows: [{ id: 'w-1', name: '甲', skill_tags: ['repair'], load: 1, active: true }],
            rowCount: 1,
          };
        }
        return { rows: [{ active_count: '0', done_count: '0', today_new: '0' }], rowCount: 1 };
      },
    }),
}));

import { authMiddleware, signJwt, __setAuthModeForTest } from '../middleware/auth.js';
import workOrderRouter from '../routes/workOrder.js';

// 与 stateMachine RICH 模板同源的最小 def（含 cancel 边 → cancelled）
const RICH_LIKE: WorkflowDef = {
  initial: 'draft',
  states: [
    'draft', 'pending_accept', 'assigned', 'arrived', 'processing',
    'paused', 'completed', 'closed', 'evaluated', 'cancelled',
  ],
  transitions: [
    { from: 'draft', to: 'pending_accept', event: 'submit' },
    { from: 'pending_accept', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'arrived', event: 'arrive' },
    { from: 'arrived', to: 'processing', event: 'start' },
    { from: 'processing', to: 'paused', event: 'hold', sideEffects: ['pause_sla'] },
    { from: 'paused', to: 'processing', event: 'resume', sideEffects: ['resume_sla'] },
    { from: 'processing', to: 'completed', event: 'finish' },
    { from: 'completed', to: 'closed', event: 'close' },
    { from: 'closed', to: 'evaluated', event: 'evaluate' },
    { from: 'processing', to: 'cancelled', event: 'cancel', allowedRoles: ['admin'] },
  ],
  config: { doneStates: ['completed'] },
} as WorkflowDef;

describe('取消态口径由流转边派生（cancelledStates）', () => {
  it('① 默认模板：包含 cancel 入边的目标态被识别为取消态（与旧硬编码零差异）', () => {
    expect(cancelledStates(RICH_LIKE)).toEqual(['cancelled']);
  });

  it('② 客户自定义取消态名（如 voided）：随 event=cancel 的边自动跟随', () => {
    const def: WorkflowDef = {
      initial: 'draft',
      states: ['draft', 'doing', 'voided', 'done_x'],
      transitions: [
        { from: 'draft', to: 'doing', event: 'assign' },
        { from: 'doing', to: 'done_x', event: 'finish' },
        { from: 'doing', to: 'voided', event: 'cancel', allowedRoles: ['admin'] },
      ],
      config: { doneStates: ['done_x'] },
    } as WorkflowDef;
    // 旧实现恒为 'cancelled' → 客户流程下 cancelled 统计恒 0（静默错）
    expect(cancelledStates(def)).toEqual(['voided']);
  });

  it('③ def 无 cancel 边时兜底内置名（存量与极端自定义 def 行为零变化）', () => {
    const def: WorkflowDef = {
      initial: 'draft',
      states: ['draft', 'cancelled'],
      transitions: [{ from: 'draft', to: 'cancelled', event: 'abort' }],
      config: {},
    } as WorkflowDef;
    expect(cancelledStates(def)).toEqual(['cancelled']);
  });
});

describe('工人端统计口径：流程派生的状态集真的进了 SQL（GET /api/v1/open/me/summary）', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    __setAuthModeForTest?.('dev');
    const app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.use((req, _res, next) => {
      (req as unknown as { res: { locals: Record<string, unknown> } }).res.locals.auth = {
        tenantId: 't-vocab', userId: 'u-1', role: 'worker', perms: [],
      };
      next();
    });
    app.use('/api/v1', workOrderRouter);
    app.use(errorMiddleware);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const call = async () => {
    h.captured.length = 0;
    const tok = signJwt(
      { tid: 't-vocab', sub: 'u-1', role: 'worker', exp: Math.floor(Date.now() / 1000) + 600 },
      'status-vocab-secret',
    );
    const res = await fetch(`${base}/api/v1/open/me/summary`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    return h.captured.find((c) => c.text.includes('AS today_new'));
  };

  it('④ SQL 文本里不得再直接拼状态名（只防「字面量回 SQL」这一种回归）', async () => {
    // ⚠️ 本例能力边界（自测实证）：把口径改回「一套写死的常量数组」时，本例**不会变红**——
    //    它只能逮住「把状态名字面量拼回 SQL 文本」的写法。真正的行为覆盖靠 ⑤（同样回退下 ⑤ 立刻红）。
    //    留着它是因为它堵的是另一条回归路径（参数化被拆掉 → SQL 注入面也回来了），不要误判它的强度。
    h.def = RICH_LIKE;
    const sql = await call();
    expect(sql).toBeTruthy();
    // 旧实现：NOT IN ('completed','cancelled','claim_hall') / IN ('completed')
    expect(sql!.text).not.toMatch(/'completed'|'cancelled'|'claim_hall'/);
    // 参数化仍在（防御有人把 ANY($n) 换回字面量拼接）
    expect(sql!.text).toContain('ANY($3::text[])');
    expect(sql!.text).toContain('ANY($4::text[])');
  });

  it('⑤ 在办/已完成两列的参数来自流程派生（客户改完成态名即生效）', async () => {
    const custom: WorkflowDef = {
      initial: 'draft',
      states: ['draft', 'doing', 'on_hold', 'finished', 'voided'],
      transitions: [
        { from: 'draft', to: 'doing', event: 'assign' },
        { from: 'doing', to: 'on_hold', event: 'hold', sideEffects: ['pause_sla'] },
        { from: 'on_hold', to: 'doing', event: 'resume', sideEffects: ['resume_sla'] },
        { from: 'doing', to: 'finished', event: 'finish' },
        { from: 'doing', to: 'voided', event: 'cancel', allowedRoles: ['admin'] },
      ],
      config: { doneStates: ['finished'] },
    } as WorkflowDef;
    h.def = custom;
    const sql = await call();
    expect(sql).toBeTruthy();
    const activeSet = (sql!.params as unknown[])[2] as string[];
    const doneSet = (sql!.params as unknown[])[3] as string[];

    // 完成态随客户配置（旧实现恒 'completed' → 恒 0）
    expect(doneSet).toEqual(['finished']);
    // 在办排除：完成态 finished、终态 voided、挂起态 on_hold
    expect(activeSet).not.toContain('finished');
    expect(activeSet).not.toContain('voided');
    expect(activeSet).not.toContain('on_hold');
    expect(activeSet).toContain('doing');
    // 与 load 净结算同源（ticket.ts 用的是同一个 activeStates）
    expect(activeSet).toEqual(
      activeStates(custom).filter((s) => s !== 'claim_hall' && s !== 'pending_dispatch'),
    );
    expect(doneSet).toEqual(doneStates(custom));
  });

  it('⑥ 多版本并存：在办集与已完成集不得相交（否则同一张单既算在办又算已完成）', async () => {
    // v1（老单锁着的旧版本）：X 还是活跃态；v2（live）：X 已被客户声明为完成态。
    // 两版的 states/transitions 完全相同，只有 config.doneStates 不同 ⇒ 差异纯粹来自口径。
    const shape = {
      initial: 'draft',
      states: ['draft', 'X', 'done'],
      transitions: [
        { from: 'draft', to: 'X', event: 'to_x' },
        { from: 'X', to: 'done', event: 'finish' },
      ],
    };
    const v1 = { ...shape, config: { doneStates: ['done'] } } as WorkflowDef;
    const v2 = { ...shape, config: { doneStates: ['done', 'X'] } } as WorkflowDef;

    h.def = v2;
    h.defV1 = v1;
    h.versions = [{ def_version: 1 }, { def_version: 2 }];
    try {
      const sql = await call();
      const activeSet = (sql!.params as unknown[])[2] as string[];
      const doneSet = (sql!.params as unknown[])[3] as string[];

      // —— 前提成立（否则本例是假绿）：两版的口径源里确实各自含 X，
      //     所以**并集**必然把 X 同时带进两个集合 —— 这正是要防的情况。
      expect(doneStates(v2), 'v2 把 X 声明为完成态').toContain('X');
      expect(activeStates(v1), 'v1 里 X 仍是活跃态').toContain('X');
      expect(doneSet, '并集后 X 进入已完成集').toContain('X');

      // 🔴 修前：X 同时命中 `COUNT FILTER status = ANY($3)` 与 `ANY($4)`
      //   ⇒ 同一张单既算在办又算已完成 ⇒ 在办 + 已完成 > 总数。
      expect(
        activeSet.filter((s) => doneSet.includes(s)),
        '在办集与已完成集不得相交（同一张单不能既在办又已完成）',
      ).toEqual([]);
    } finally {
      h.defV1 = null;
      h.versions = null;
    }
  });
});
