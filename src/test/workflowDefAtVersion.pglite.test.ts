/**
 * T1-B 批 0：`getWorkflowDefAtVersion` / `getDefsForVersions` —— PGlite 真跑验证
 *
 * 【为什么必须有这份】
 *   这两个函数是"版本锁"的全部读路径。批 0 里它们零调用点（零行为变化），
 *   但**批 1/2/3 的全部正确性都压在它们身上** ⇒ 批 0 就必须把它们的语义钉死，
 *   不能等到接进业务流之后再验（那时出错会表现为"用户点了按钮 422"，归因成本极高）。
 *
 * 【验证口径】
 *   ① version <= 0（未锁定）⇒ 走 live def（= 今天的逐字节行为）
 *   ② version == live.version ⇒ 读 live —— **补「当前 live 不在 history 里」这个缺口**
 *      （saveWorkflowDef 只在被覆盖那一刻才写 history，live 版本本身不在 history 内）
 *   ③ version 在 history ⇒ 读该版本快照，且**不是** live
 *   ④ 版本查不到 ⇒ **降级到 live + console.warn，不抛 500**（R-6）
 *   ⑤ R-5：取历史版本时也必须注入 claim_hall（withMechanismStates），否则工单出厅 422
 *   ⑥ R-2：getDefsForVersions 按版本分组 ⇒ history 查询次数 = 不同版本数，不是行数
 */
import { describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { getWorkflowDefAtVersion, getDefsForVersions } from '../engine/workflowDef.js';
// WorkflowDef 定义在 stateMachine.ts，workflowDef.ts 只是 import 它、并未 re-export。
import type { WorkflowDef } from '../engine/stateMachine.js';

const ROOT = join(__dirname, '..', '..');

/** 取迁移文件里某张表的 CREATE TABLE 段（到 `\n);` 为止）：用真实建表口径。 */
function createTableBlock(file: string, table: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`迁移 ${file} 里找不到 ${table} 的建表语句`);
  const end = text.indexOf('\n);', start);
  return text.slice(start, end < 0 ? text.length : end + 3);
}

const T = 'tenant-t1';
const ET = 'inspection_task';

/** v1：最简三态，只有一条边。 */
const V1: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'done'],
  transitions: [{ from: 'draft', to: 'assigned', event: 'assign' } as any],
  config: {},
} as WorkflowDef;
/** v2：比 v1 多一个 processing 态和一条边。 */
const V2: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'done'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'processing', event: 'start' },
  ] as any,
  config: {},
} as WorkflowDef;
/** v3 = 当前 live：三态，但边与 v1 不同（用 event 名区分，便于断言拿到的是哪一份）。 */
const V3: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'done'],
  transitions: [{ from: 'draft', to: 'assigned', event: 'assign_v3' } as any],
  config: {},
} as WorkflowDef;

const FALLBACK: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'fallback_state'],
  transitions: [],
  config: {},
} as WorkflowDef;

/**
 * 真建两张表（022 workflow_def / 047 workflow_def_history），
 * 并布置：live = v3（version=3），history 里有 v1、v2（**刻意不含 v3**）。
 * ⇒ 这是真实的版本链形态：live 版本本身不在 history 里。
 */
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('022_workflow_def.sql', 'workflow_def'));
  await db.exec(createTableBlock('047_basic_data_consolidate.sql', 'workflow_def_history'));
  await db.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version)
     VALUES ($1, $2, $3::jsonb, 3)`,
    [T, ET, JSON.stringify(V3)],
  );
  for (const [v, d] of [
    [1, V1],
    [2, V2],
  ]) {
    await db.query(
      `INSERT INTO workflow_def_history (tenant_id, entity_type, version, def)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [T, ET, v, JSON.stringify(d)],
    );
  }
  return db;
}

/** 把 PGlite 包装成 PoolClient，并统计查询次数（按是否查 history 表分开计）。 */
function wrap(db: PGlite) {
  const stats = { total: 0, history: 0 };
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      stats.total++;
      if (/workflow_def_history/i.test(sql)) stats.history++;
      return db.query(sql, params as any[]);
    },
  } as unknown as PoolClient;
  return { client, stats };
}

const asClient = (db: PGlite) => db as unknown as PoolClient;

describe('getWorkflowDefAtVersion 支取判定', () => {
  it('① version <= 0（未锁定）⇒ 走 live def（与今天逐字节一致）', async () => {
    const db = await freshDb();
    const d = await getWorkflowDefAtVersion(asClient(db), T, ET, 0, FALLBACK);
    expect(d.transitions[0]?.event).toBe('assign_v3'); // = V3，不是 FALLBACK
  });

  it('② version == live.version ⇒ 读 live（补「live 不在 history」的缺口）', async () => {
    const db = await freshDb();
    const { client, stats } = wrap(db);
    // v3 只存在于 live、不存在于 history。若实现只查 history，这里会拿到 FALLBACK 或降级。
    const d = await getWorkflowDefAtVersion(client, T, ET, 3, FALLBACK);
    expect(d.transitions[0]?.event).toBe('assign_v3');
    expect(d.states).toEqual(V3.states);
    // 🔴 **路径断言（本条的存在理由）**：只断言"拿到 v3"是不够的——
    //   「走 live 分支直接返回」与「查 history 落空再降级到 live」结果完全相同，
    //   少了这条，把 live 分支删掉本测试仍然全绿（实测 M1 变异确实漏网）。
    //   ⇒ 必须钉住"一次 history 都没查"，才能证明走的是 live 分支。
    expect(stats.history, '锁定 live 版本时不应查 history').toBe(0);
  });

  it('③ version 在 history ⇒ 读该版本快照，**不是** live', async () => {
    const db = await freshDb();
    const d1 = await getWorkflowDefAtVersion(asClient(db), T, ET, 1, FALLBACK);
    expect(d1.transitions[0]?.event).toBe('assign');
    expect(d1.states).toEqual(V1.states);
    expect(d1.states).not.toContain('processing');

    const d2 = await getWorkflowDefAtVersion(asClient(db), T, ET, 2, FALLBACK);
    expect(d2.states).toContain('processing');
    expect(d2.transitions.map((t) => t.event).sort()).toEqual(['assign', 'start']);
    // 关键：v2 与 live(v3) 是不同版本，拿到的必须不是 live
    expect(d2.transitions[0]?.event).not.toBe('assign_v3');
  });

  it('④ 版本查不到 ⇒ 降级到 live + console.warn，**不抛 500**（R-6）', async () => {
    const db = await freshDb();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { client, stats } = wrap(db);
      const d = await getWorkflowDefAtVersion(client, T, ET, 999, FALLBACK);
      expect(d.transitions[0]?.event).toBe('assign_v3'); // 降级到 live，行为 = 改动前
      expect(spy).toHaveBeenCalled();
      // 路径断言：必须**真的去 history 查过**才发现失效，而不是偷懒直接降级。
      expect(stats.history, '失效版本必须真的去 history 查一次').toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('⑤ R-5：取历史版本也要注入 claim_hall（工单出厅不 422）', async () => {
    const db = await freshDb();
    // 给 work_order 单独布一条 v1 历史：快照里**不含** claim_hall
    await db.query(
      `INSERT INTO workflow_def_history (tenant_id, entity_type, version, def)
       VALUES ($1, 'work_order', 1, $2::jsonb)`,
      [T, JSON.stringify(V1)],
    );
    const d = await getWorkflowDefAtVersion(asClient(db), T, 'work_order', 1, FALLBACK);
    expect(d.states, '历史快照经 withMechanismStates 后必须含 claim_hall').toContain('claim_hall');
  });

  it('⑥ 租户/实体无定义时 ⇒ 落 fallback（不抛、不返回空 def）', async () => {
    const db = await freshDb();
    const d = await getWorkflowDefAtVersion(asClient(db), 'tenant-nobody', ET, 0, FALLBACK);
    expect(d.states).toEqual(FALLBACK.states);
  });
});

describe('getDefsForVersions 分组（R-2）', () => {
  it('⑦ 3 行 / 2 个不同版本 ⇒ history 查询次数 = 2，不是 3', async () => {
    const db = await freshDb();
    const { client, stats } = wrap(db);
    const rows = [{ def_version: 1 }, { def_version: 2 }, { def_version: 1 }];
    const m = await getDefsForVersions(client, T, ET, rows, FALLBACK);
    expect(m.size, '不同版本数').toBe(2);
    expect(m.get(1)?.states).toEqual(V1.states);
    expect(m.get(2)?.states).toEqual(V2.states);
    // 分组的核心收益：N 行里只有 2 个不同版本 ⇒ 只查 2 次 history，不是 3 次。
    expect(stats.history, 'history 查询次数必须等于不同版本数').toBe(2);
  });

  it('⑧ 全为 0（未锁定）⇒ 一个版本都不查 history，直接走 live', async () => {
    const db = await freshDb();
    const { client, stats } = wrap(db);
    const m = await getDefsForVersions(client, T, ET, [{ def_version: 0 }, { def_version: 0 }], FALLBACK);
    expect(m.size).toBe(1);
    expect(m.get(0)?.transitions[0]?.event).toBe('assign_v3');
    expect(stats.history).toBe(0);
  });

  it('⑨ 含未锁定 + 锁定 + 失效版本 ⇒ 各归各位（0 与 999 都落到 live）', async () => {
    const db = await freshDb();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const m = await getDefsForVersions(
        asClient(db),
        T,
        ET,
        [{ def_version: 0 }, { def_version: 1 }, { def_version: 999 }],
        FALLBACK,
      );
      // 每个版本保留自己的 key；失效版本(999)的值 = 降级后的 live def
      // ⇒ 调用侧 defs.get(r.def_version ?? 0) 永远命中，不会 undefined。
      expect(m.get(0)?.transitions[0]?.event).toBe('assign_v3');
      expect(m.get(1)?.states).toEqual(V1.states);
      expect(m.get(999)?.transitions[0]?.event).toBe('assign_v3'); // 失效 ⇒ 降级到 live
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
