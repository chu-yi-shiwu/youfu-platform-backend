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
import {
  getWorkflowDefAtVersion,
  getDefsForVersions,
  getWorkflowDefVersion,
  getWorkflowDefOrDefault,
} from '../engine/workflowDef.js';
// 批 3 的写侧就长在 transitionEntity 里，且它是可直调的共享函数 ⇒ 真库里直接调真产品代码，
// 不像批 1 那样只能模拟 INSERT（批 1 的三处 INSERT 藏在 route handler 里，够不着）。
import { transitionEntity } from '../engine/transition.js';
// A3 要用真引擎判定「available 里的 event 能不能真走通」，不是另写一份判定逻辑。
import { applyEvent, availableTransitions } from '../engine/stateMachine.js';
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

// ============================================================
// T1-B 批 1 · 「锁版本」的真库验收（A1 / A2 / A3 / A4-真值）
//
// 【为什么这几条必须在真库里验，不能在 http 桩里验】
//   src/test/inspection.http.test.ts 把 workflowDef 整体替换成桩了 ⇒ 在那里断言
//   "版本号 == live version"验的是桩不是实现，属纸面验证。这里业务表 / workflow_def /
//   history 全是真的，102 迁移也是**真跑**的 ⇒ 验的是真版本链。
// 【与 http 那份的分工】那边验"参数从哪来"（IN­SERT 是否带列、是否写在循环外），
//   这边验"值是多少、锁了之后行为对不对"。两边互补，缺一边都会留缝。
// ============================================================
const UP_102 = readFileSync(join(ROOT, '102_inflight_def_version.sql'), 'utf8');

/** v1：pending → in_progress → done，两条边。 */
const INSP_V1: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'in_progress', 'done'],
  transitions: [
    { from: 'pending', to: 'in_progress', event: 'checkin' },
    { from: 'in_progress', to: 'done', event: 'complete' },
  ] as any,
  config: {},
} as WorkflowDef;
/** v2 = v1 + 一条新边（pending --cancel--> cancelled）。**这条边是 A1/A2/A3 的判别关键**。 */
const INSP_V2: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'in_progress', 'done', 'cancelled'],
  transitions: [
    { from: 'pending', to: 'in_progress', event: 'checkin' },
    { from: 'in_progress', to: 'done', event: 'complete' },
    { from: 'pending', to: 'cancelled', event: 'cancel' },
  ] as any,
  config: {},
} as WorkflowDef;

/**
 * 真建库：三张业务表（真建表口径）+ workflow_def + history，然后**真跑 102 迁移**加列。
 * 三张表都建起来，102 才能按原文整份跑（缺一张 ALTER TABLE 就会报错，与真实上线同构）。
 * 布置：live = v1（version=1），history 此刻为空（v1 即 live，本身不在 history 里）。
 */
async function freshInspDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('022_workflow_def.sql', 'workflow_def'));
  await db.exec(createTableBlock('047_basic_data_consolidate.sql', 'workflow_def_history'));
  await db.exec(createTableBlock('011_inspection.sql', 'inspection_task'));
  await db.exec(createTableBlock('034_emergency_transport.sql', 'transport_order'));
  await db.exec(createTableBlock('030_business_flow.sql', 'business_flow_tasks'));
  await db.exec(UP_102);
  await db.query(`INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1, $2, $3::jsonb, 1)`, [
    T,
    ET,
    JSON.stringify(INSP_V1),
  ]);
  return db;
}

/** 模拟批 1 的三处 INSERT：取当时的 live 版本号盖章（真 getWorkflowDefVersion，非桩）。 */
async function createTask(db: PGlite, c: PoolClient, title: string) {
  const v = await getWorkflowDefVersion(c, T, ET);
  const r = await db.query(
    `INSERT INTO inspection_task (tenant_id, title, status, def_version) VALUES ($1,$2,'pending',$3) RETURNING *`,
    [T, title, v],
  );
  return r.rows[0] as { id: string; title: string; def_version: number; status: string };
}

/** 改版到 v2：v1 落进 history，live 升到 version=2（真实 saveWorkflowDef 的形态）。 */
async function upgradeToV2(db: PGlite) {
  await db.query(`INSERT INTO workflow_def_history (tenant_id, entity_type, version, def) VALUES ($1,$2,1,$3::jsonb)`, [
    T,
    ET,
    JSON.stringify(INSP_V1),
  ]);
  await db.query(`UPDATE workflow_def SET def = $3::jsonb, version = 2 WHERE tenant_id = $1 AND entity_type = $2`, [
    T,
    ET,
    JSON.stringify(INSP_V2),
  ]);
}

describe('批1 · inspection_task 在途单锁版本（真库 A1/A2/A3/A4）', () => {
  it('A1：v1 建的单，改版到 v2 后仍按 v1 流转；且它的章没被改版顺手改掉（R-3）', async () => {
    const db = await freshInspDb();
    const c = asClient(db);
    const t1 = await createTask(db, c, '老单');
    expect(t1.def_version, '建单时盖的章 = 当时的 live version').toBe(1);
    await upgradeToV2(db);

    // 改版**不许**顺手把在途单的版本号刷成新版本（那等于没锁）。
    const after = (await db.query(`SELECT def_version FROM inspection_task WHERE id = $1`, [t1.id])).rows[0] as any;
    expect(after.def_version, '改版后老单的章必须还是 v1').toBe(1);

    const def = await getWorkflowDefAtVersion(c, T, ET, t1.def_version, INSP_V2);
    expect(applyEvent(def, 'pending', 'checkin'), 'v1 自己的边照走').toBe('in_progress');
    expect(applyEvent(def, 'pending', 'cancel'), 'v2 新增的边不能对 v1 老单生效（提交即 422）').toBeNull();
  });

  it('A2：改版后建的新单锁 v2 并按 v2 走（防「一律锁老版本」这种做反了也能绿 A1 的实现）', async () => {
    const db = await freshInspDb();
    const c = asClient(db);
    await createTask(db, c, '老单');
    await upgradeToV2(db);
    const t2 = await createTask(db, c, '新单');
    expect(t2.def_version, '新单必须盖 v2 的章').toBe(2);

    const def = await getWorkflowDefAtVersion(c, T, ET, t2.def_version, INSP_V2);
    expect(applyEvent(def, 'pending', 'cancel'), '新单应当用得上 v2 的新边').toBe('cancelled');
  });

  it('A3：读侧 available 不含 v2 独有的 event，且每个 event 都能真走通（抓 R-1）', async () => {
    const db = await freshInspDb();
    const c = asClient(db);
    const t1 = await createTask(db, c, '老单');
    await upgradeToV2(db);

    // 🔴 刻意**分两次独立取**，一次当读侧（详情渲染按钮）、一次当写侧（流转校验）。
    //   不能图省事复用同一个 def 对象 —— 那会让「读侧漏改、仍读 live」变成永真断言
    //   （读侧与写侧拿到同一个对象，available 天然与写侧一致，永远绿）。
    const readDef = await getWorkflowDefAtVersion(c, T, ET, t1.def_version, INSP_V2);
    const writeDef = await getWorkflowDefAtVersion(c, T, ET, t1.def_version, INSP_V2);
    const liveDef = await getWorkflowDefOrDefault(c, T, ET, INSP_V2);

    const available = availableTransitions(readDef, 'pending').map((x: any) => x.event);
    const liveAvailable = availableTransitions(liveDef, 'pending').map((x: any) => x.event);
    // 若读侧漏改（读成 live = v2），available 会与 live 完全一致且多出 cancel ⇒ 这条必红。
    expect(available, 'available 不能等于 live 的 available，否则读侧根本没走版本锁').not.toEqual(liveAvailable);
    expect(available).not.toContain('cancel');
    // A3 本体：available 给出的每个 event，逐个用**写侧**的 def 真走一遍 ⇒ 不得 422。
    for (const ev of available) {
      expect(applyEvent(writeDef, 'pending', ev), `available 给出的 ${ev} 必须真能流转`).not.toBeNull();
    }
  });

  it('A4-真值：盖章取的就是 getWorkflowDefVersion 的返回值，且真的落进了库', async () => {
    const db = await freshInspDb();
    const c = asClient(db);
    expect(await getWorkflowDefVersion(c, T, ET), '改版前 live version').toBe(1);
    await createTask(db, c, '老单');
    await upgradeToV2(db);
    expect(await getWorkflowDefVersion(c, T, ET), '改版后 live version').toBe(2);
    await createTask(db, c, '新单');

    // 回库查，不信任 INSERT 的 RETURNING（RETURNING 拿的是写入值，不是落库值）。
    const rows = (
      await db.query(`SELECT title, def_version FROM inspection_task WHERE tenant_id = $1 ORDER BY title`, [T])
    ).rows as any[];
    const byTitle = new Map<string, number>(rows.map((r) => [r.title, r.def_version]));
    expect(byTitle.get('老单'), '老单锁 v1').toBe(1);
    expect(byTitle.get('新单'), '新单锁 v2').toBe(2);
  });

  it('E4：102 迁移跑完后，先于它存在的行 def_version 一律为 0（未记录，不伪造建单版本）', async () => {
    const db = new PGlite();
    await db.exec(createTableBlock('011_inspection.sql', 'inspection_task'));
    await db.exec(createTableBlock('034_emergency_transport.sql', 'transport_order'));
    await db.exec(createTableBlock('030_business_flow.sql', 'business_flow_tasks'));
    // 迁移前就存在的存量行
    await db.query(`INSERT INTO inspection_task (tenant_id, title, status) VALUES ($1,'存量单','pending')`, [T]);
    await db.exec(UP_102); // 真跑迁移

    const rows = (await db.query(`SELECT def_version FROM inspection_task WHERE tenant_id = $1`, [T])).rows as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].def_version, '存量行必须是哨兵 0，不是被伪造的 1').toBe(0);
    // 哨兵 0 ⇒ 走 live ⇒ 与改前行为逐字节一致。该语义已由本文件 ① 钉死（version<=0 ⇒ 走 live），
    // 此处不重复验；本节只负责锁住「迁移不改存量行」这条 E4 底线。
  });
});

// ============================================================
// 批3 · business_flow_tasks 在途单锁版本（真库 A1/A2/A3/A4）
// 【与批 1 那组的分工】批 1 的三处 INSERT 藏在 route handler 里，只能用同款 INSERT 模拟盖章
//   （「真 INSERT 是否带列」由 http 侧静态断言补上）。批 3 的**写侧 transitionEntity 可直调**，
//   ⇒ 这里直接拿真 PGlite client 调真产品代码，验的是真路径。
// 【实体名为什么选 cycle_check】最典型的「未代理」泛型实体（t5TransportProxy.http.test.ts:228
//   已在用它）。刻意不用 transport_task —— 那一条已被 flowProxy 代理去 transport_order，
//   根本落不到本表（businessFlow.ts:214 就分派走了）。
//   🔴 这也是批 3 与批 1/2 的形状差异：**def 口径是变量 entityType，不是常量**。
// ============================================================
const ET3 = 'cycle_check';

/** v1：pending → doing → done，两条边。 */
const BF_V1: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'doing', 'done'],
  transitions: [
    { from: 'pending', to: 'doing', event: 'start' },
    { from: 'doing', to: 'done', event: 'finish' },
  ] as any,
  config: {},
} as WorkflowDef;
/** v2 = v1 + 一条新边（doing --cancel--> cancelled）。**这条边是 A1/A2/A3 的判别关键**。 */
const BF_V2: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'doing', 'done', 'cancelled'],
  transitions: [
    { from: 'pending', to: 'doing', event: 'start' },
    { from: 'doing', to: 'done', event: 'finish' },
    { from: 'doing', to: 'cancelled', event: 'cancel' },
  ] as any,
  config: {},
} as WorkflowDef;

/**
 * 真建库：三张业务表 + workflow_def + history + domain_event，然后**真跑 102 迁移**加列。
 * 比 freshInspDb 多建 `domain_event` —— transitionEntity 内部会 emitDomainEvent
 * （src/db/eventBus.ts:16-29 是裸 INSERT，**不吞错**）⇒ 缺表会假红成产品 bug。
 */
async function freshFlowDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('022_workflow_def.sql', 'workflow_def'));
  await db.exec(createTableBlock('047_basic_data_consolidate.sql', 'workflow_def_history'));
  await db.exec(createTableBlock('011_inspection.sql', 'inspection_task'));
  await db.exec(createTableBlock('034_emergency_transport.sql', 'transport_order'));
  await db.exec(createTableBlock('030_business_flow.sql', 'business_flow_tasks'));
  await db.exec(createTableBlock('020_domain_event.sql', 'domain_event'));
  await db.exec(UP_102);
  await db.query(`INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1,$2,$3::jsonb,1)`, [
    T,
    ET3,
    JSON.stringify(BF_V1),
  ]);
  return db;
}

/** 模拟 businessFlow.ts:231 的 INSERT（盖章）。真 INSERT 是否带列由 http 侧 A4 静态断言钉住。 */
async function createFlowTask(db: PGlite, c: PoolClient, title: string, version?: number) {
  const v = version ?? (await getWorkflowDefVersion(c, T, ET3));
  const r = await db.query(
    `INSERT INTO business_flow_tasks (tenant_id, entity_type, title, status, created_by, def_version)
     VALUES ($1,$2,$3,'pending','t1-user',$4) RETURNING *`,
    [T, ET3, title, v],
  );
  return r.rows[0] as { id: string; title: string; def_version: number; status: string };
}

/** 改版到 v2（cycle_check）：v1 落进 history，live 升到 version=2（真实 saveWorkflowDef 的形态）。 */
async function upgradeFlowToV2(db: PGlite) {
  await db.query(`INSERT INTO workflow_def_history (tenant_id, entity_type, version, def) VALUES ($1,$2,1,$3::jsonb)`, [
    T,
    ET3,
    JSON.stringify(BF_V1),
  ]);
  await db.query(`UPDATE workflow_def SET def = $3::jsonb, version = 2 WHERE tenant_id = $1 AND entity_type = $2`, [
    T,
    ET3,
    JSON.stringify(BF_V2),
  ]);
}

/** 直调产品侧共享写侧：transitionEntity（批 3 的写就长在这里）。 */
function flowTransition(c: PoolClient, id: string, event: string) {
  return transitionEntity(c, T, {
    table: 'business_flow_tasks',
    id,
    event,
    entityType: ET3,
    fallbackDef: BF_V2,
    actor: 't1-user',
  });
}

describe('批3 · business_flow_tasks 在途单锁版本（真库 A1/A2/A3/A4）', () => {
  it('A1：v1 建的老单，改版到 v2 后仍按 v1 流转 —— v2 的新边对它 422（真 transitionEntity）', async () => {
    const db = await freshFlowDb();
    const c = asClient(db);
    const t1 = await createFlowTask(db, c, '老单');
    expect(t1.def_version, '建单时盖的章 = 当时的 live version').toBe(1);
    await upgradeFlowToV2(db);

    // 改版**不许**顺手把在途单的版本号刷成新版本（那等于没锁）。
    const after = (
      await db.query(`SELECT def_version FROM business_flow_tasks WHERE id = $1`, [t1.id])
    ).rows[0] as any;
    expect(after.def_version, '改版后老单的章必须还是 v1').toBe(1);

    // ① v1 自己的边：照常走通（真写侧、真落库）
    const doing = await flowTransition(c, t1.id, 'start');
    expect(doing.status).toBe('doing');
    // ② v2 新增的边：对 v1 老单必须 422 —— 否则就是「按钮凭空多出来、点了还能过」
    await expect(flowTransition(c, t1.id, 'cancel')).rejects.toThrow(/illegal transition/);
  });

  it('A2：改版后建的新单锁 v2 并按 v2 走（防「一律锁老版本」这种做反了也能绿 A1 的实现）', async () => {
    const db = await freshFlowDb();
    const c = asClient(db);
    await createFlowTask(db, c, '老单');
    await upgradeFlowToV2(db);
    const t2 = await createFlowTask(db, c, '新单');
    expect(t2.def_version, '新单必须盖 v2 的章').toBe(2);

    await flowTransition(c, t2.id, 'start');
    const cancelled = await flowTransition(c, t2.id, 'cancel');
    expect(cancelled.status, '新单应当用得上 v2 的新边').toBe('cancelled');
  });

  it('A3：读侧 available 按行给版本 —— 老单不含 v2 的 cancel，新单含（抓 R-1/R-2）', async () => {
    const db = await freshFlowDb();
    const c = asClient(db);
    const t1 = await createFlowTask(db, c, '老单');
    await upgradeFlowToV2(db);
    const t2 = await createFlowTask(db, c, '新单');

    // 🔴 刻意**分三次独立取**（老单读侧 / 新单读侧 / live），不复用同一个 def 对象 ——
    //   复用会让「读侧漏改、仍读 live」变成永真断言（两边拿到同一对象，天然一致）。
    const readDef1 = await getWorkflowDefAtVersion(c, T, ET3, t1.def_version, BF_V2);
    const readDef2 = await getWorkflowDefAtVersion(c, T, ET3, t2.def_version, BF_V2);
    const liveDef = await getWorkflowDefOrDefault(c, T, ET3, BF_V2);

    const av1 = availableTransitions(readDef1, 'doing').map((x: any) => x.event);
    const av2 = availableTransitions(readDef2, 'doing').map((x: any) => x.event);
    const avLive = availableTransitions(liveDef, 'doing').map((x: any) => x.event);

    // 若读侧漏改（读成 live = v2），av1 会与 avLive 完全一致 ⇒ 这条必红。
    expect(av1, '老单 available 不能等于 live 的（否则读侧压根没走版本锁）').not.toEqual(avLive);
    expect(av1).toEqual(['finish']);
    expect(av2, '新单拿得到 v2 的新边').toEqual(['finish', 'cancel']);
    // A3 本体：available 给出的每个 event，逐个用**写侧**的 def 真走一遍 ⇒ 不得 422。
    for (const ev of av1) {
      expect(applyEvent(readDef1, 'doing', ev), `available 给出的 ${ev} 必须真能流转`).not.toBeNull();
    }
  });

  // 🔴🔴 诚实声明（2026-10-28 变异验证发现后改写）：
  //   本条**不**覆盖「产品会把版本号盖进行里」这件事。这里的 INSERT 是本文件的夹具 helper
  //   （createFlowTask）自己做的 —— 把 src/routes/businessFlow.ts:228 的盖章改成写死 0，
  //   本条照样全绿（实测 19/19）。曾据此自称「盖章真值」，是纸面验收。
  //   产品盖章由 src/test/t5TransportProxy.http.test.ts 的「A4-盖章」穿透路由验收
  //   （10 参、末位 = 桩返的 5；改坏 ⇒ 那条红）。
  //   本条真正覆盖的是 R-3（改版不许顺手把在途单的章刷成新版本）+ 回库真值（不信任 RETURNING）。
  it('A4-R3：改版不许顺手把在途单的章刷成新版本；版本真值以回库查为准（不信任 RETURNING）', async () => {
    const db = await freshFlowDb();
    const c = asClient(db);
    expect(await getWorkflowDefVersion(c, T, ET3), '改版前 live version').toBe(1);
    await createFlowTask(db, c, '老单');
    await upgradeFlowToV2(db);
    expect(await getWorkflowDefVersion(c, T, ET3), '改版后 live version').toBe(2);
    await createFlowTask(db, c, '新单');

    // 回库查，不信任 INSERT 的 RETURNING（RETURNING 拿的是写入值，不是落库值）。
    const rows = (
      await db.query(`SELECT title, def_version FROM business_flow_tasks WHERE tenant_id = $1 ORDER BY title`, [T])
    ).rows as any[];
    const byTitle = new Map<string, number>(rows.map((r) => [r.title, r.def_version]));
    expect(byTitle.get('老单'), '老单锁 v1').toBe(1);
    expect(byTitle.get('新单'), '新单锁 v2').toBe(2);
  });

  it('E4：102 迁移跑完后，先于它存在的行 def_version 一律为 0（未记录，不伪造建单版本）', async () => {
    const db = new PGlite();
    await db.exec(createTableBlock('030_business_flow.sql', 'business_flow_tasks'));
    await db.exec(createTableBlock('011_inspection.sql', 'inspection_task'));
    await db.exec(createTableBlock('034_emergency_transport.sql', 'transport_order'));
    await db.query(
      `INSERT INTO business_flow_tasks (tenant_id, entity_type, title, status) VALUES ($1,$2,'存量单','doing')`,
      [T, ET3],
    );
    await db.exec(UP_102); // 真跑迁移

    const rows = (
      await db.query(`SELECT def_version FROM business_flow_tasks WHERE tenant_id = $1`, [T])
    ).rows as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].def_version, '存量行必须是哨兵 0，不是被伪造的 1').toBe(0);
  });
});
