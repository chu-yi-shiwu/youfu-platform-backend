/**
 * T1-B 批 0：`getWorkflowDefAtVersion` / `getDefsForVersions` —— PGlite 真跑验证
 *
 * 【为什么必须有这份】
 *   这两个函数是"版本锁"的全部读路径。批 0 里它们零调用点（零行为变化），
 *   但**批 1/2/3 的全部正确性都压在它们身上** ⇒ 批 0 就必须把它们的语义钉死，
 *   不能等到接进业务流之后再验（那时出错会表现为"用户点了按钮 422"，归因成本极高）。
 *
 * 【验证口径】
 *   ① version <= 0（未记录）⇒ 走 live def（= 今天的逐字节行为）
 *   ② version == live.version ⇒ 读 live —— **补「当前 live 不在 history 里」这个缺口**
 *      （saveWorkflowDef 只在被覆盖那一刻才写 history，live 版本本身不在 history 内）
 *   ③ version 在 history ⇒ 读该版本快照，且**不是** live
 *   ④ 版本查不到 ⇒ **降级到 live + console.warn，不抛 500**（R-6）
 *   ⑤ R-5：取历史版本时也必须注入 claim_hall（withMechanismStates），否则工单出厅 422
 *   ⑥ R-2：getDefsForVersions 按版本分组 ⇒ history 查询次数 = 不同版本数，不是行数
 */
import { describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PoolClient } from 'pg';
import {
  getWorkflowDefAtVersion,
  getDefsForVersions,
  getWorkflowDefVersion,
  getWorkflowDefOrDefault,
  getDefsAcrossAllVersions,
  unionStates,
  intersectStates,
} from '../engine/workflowDef.js';
// 批 3 的写侧就长在 transitionEntity 里，且它是可直调的共享函数 ⇒ 真库里直接调真产品代码，
// 不像批 1 那样只能模拟 INSERT（批 1 的三处 INSERT 藏在 route handler 里，够不着）。
import { transitionEntity } from '../engine/transition.js';
// A3 要用真引擎判定「available 里的 event 能不能真走通」，不是另写一份判定逻辑。
import { applyEvent, availableTransitions } from '../engine/stateMachine.js';
// 批 4（工单）：写侧两个函数都在 repo/ticket.ts 里且可直调 ⇒ 真库里直接调真产品代码，
// 连「盖章」都验的是真链路（不像批 1/3 只能模拟 INSERT）。
import { createWithIdem, transition } from '../repo/ticket.js';
// 批 6：要验的是「调用点有没有真的取交集」，不是复算一遍口径 ⇒ 直接调真产品函数 processMetrics。
import { processMetrics, clearStatsCache } from '../repo/stats.js';
// 项目统一的业务错误（errorMiddleware:107 按 `err instanceof AppError` 取 err.status ⇒ 决定 HTTP 码）。
import { AppError } from '../middleware/error.js';
// WorkflowDef 定义在 stateMachine.ts，workflowDef.ts 只是 import 它、并未 re-export。
import {
  DEFAULT_WORK_ORDER_DEF,
  doneStates,
  terminalStates,
  activeStates,
  type WorkflowDef,
  type WorkOrderStatus,
} from '../engine/stateMachine.js';

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
  it('① version <= 0（未记录）⇒ 走 live def（与今天逐字节一致）', async () => {
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

  it('⑧ 全为 0（未记录）⇒ 一个版本都不查 history，直接走 live', async () => {
    const db = await freshDb();
    const { client, stats } = wrap(db);
    const m = await getDefsForVersions(client, T, ET, [{ def_version: 0 }, { def_version: 0 }], FALLBACK);
    expect(m.size).toBe(1);
    expect(m.get(0)?.transitions[0]?.event).toBe('assign_v3');
    expect(stats.history).toBe(0);
  });

  it('⑨ 含未记录 + 已记录 + 失效版本 ⇒ 各归各位（0 与 999 都落到 live）', async () => {
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

// ============================================================
// 批4 · work_orders 在途工单锁版本（真库 A1-W / A2-W / A5-W）
//
// 【与前两批的形状差异】
//   ① 迁移是 **103**（不是 102）—— 工单单独成份 file，值得独立回退（见 103 文件头注释）；
//   ② 实体类型固定为 `'work_order'` ⇒ **机制态注入（withMechanismStates）会生效**，
//      而 inspection_task / cycle_check 不走注入 ⇒ A5-W 是工单独有的验收点；
//   ③ 本批**不停留在「模拟 INSERT」**：上面两批的三处 INSERT 藏在 route handler 里够不着，
//      而工单的写侧 createWithIdem / transition 都是可直调的导出函数 ⇒ 这里直接调真产品代码，
//      连「盖章」都验的是真链路（不再需要在注释里交代「本条不覆盖盖章」）。
//
// 【表为什么按迁移序号顺序拼】001 的 work_orders 建表带 `CHECK (status IN (4 态))`，
//   022 才把它放宽；且某些 ADD COLUMN 自带 CHECK —— 022 的 DO 块用
//   `SELECT conname ... LIMIT 1` 取约束名 ⇒ **必须在带 CHECK 的新列之前跑**，否则会误删到别的约束。
//   ⇒ 严格按迁移序号贴：001 → 002 → 020 → 022 → 025 → 028 → 031 → 047 → 074 → 103。
// ============================================================
const UP_103 = readFileSync(join(ROOT, '103_inflight_def_version_workorder.sql'), 'utf8');
const WO_ET = 'work_order';

/** v1：draft→assigned→processing→completed，三条边。 */
const WO_V1: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'completed'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'processing', event: 'start' },
    { from: 'processing', to: 'completed', event: 'complete' },
  ] as any,
  config: { doneStates: ['completed'] },
} as WorkflowDef;

/**
 * v2 = v1 + 两处改动，正好对应「改流程坑在途单」的两种典型形态：
 *   ① **新增一条 v1 没有的边** assigned --fast_close--> completed
 *      ⇒ 锁版本失效时的症状：老单的按钮凭空多出来、点了还真能过。
 *   ② 给**已存在**的边加必填 assigned --start--> processing requiredFields: ['safety_note']
 *      ⇒ 锁版本失效时的症状：老单被要求一个它建单那天根本不存在的字段，提交必 422（卡死）。
 */
const WO_V2: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'completed'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'processing', event: 'start', requiredFields: ['safety_note'] },
    { from: 'processing', to: 'completed', event: 'complete' },
    { from: 'assigned', to: 'completed', event: 'fast_close' },
  ] as any,
  config: { doneStates: ['completed'] },
} as WorkflowDef;

/** 取迁移文件里针对某表的全部 `ALTER TABLE <t> ADD COLUMN IF NOT EXISTS ...;` 原文（保持原序）。 */
function addColumnStatements(file: string, table: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const re = new RegExp(`^ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS .*;$`, 'gm');
  const lines = text.match(re) ?? [];
  if (lines.length === 0) throw new Error(`迁移 ${file} 里找不到 ${table} 的 ADD COLUMN 语句`);
  return lines.join('\n');
}

/**
 * 取迁移文件里的第一个 `DO $$ ... END $$;` 块原文。
 * 用「原文」而非自己重写 SQL：022 放宽 status CHECK / 002 加 order_no 都是产品真实迁移，
 * 测试里重复抄一份就等于给了漂移一处新真源（批 0 起就定的纪律）。
 */
function firstDoBlock(file: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf('DO $$');
  if (start < 0) throw new Error(`迁移 ${file} 里找不到 DO 块`);
  const end = text.indexOf('END $$;', start);
  if (end < 0) throw new Error(`迁移 ${file} 的 DO 块没有配对的 END $$;`);
  return text.slice(start, end + 'END $$;'.length);
}

/**
 * 真建库：work_orders / ticket_event（001）+ workflow_def（022）+ history（047）+
 * domain_event（020），按迁移序号补齐工单后续扩列，最后**真跑 103 迁移**加 def_version。
 * 布置：live = v1（version=1），history 此刻为空（v1 即 live，本身不在 history 里）。
 */
async function freshWoDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('001_init.sql', 'work_orders'));
  await db.exec(createTableBlock('001_init.sql', 'ticket_event'));
  await db.exec(firstDoBlock('002_add_order_no.sql')); // order_no（NOT NULL + 租户内唯一）
  await db.exec(createTableBlock('020_domain_event.sql', 'domain_event'));
  await db.exec(createTableBlock('022_workflow_def.sql', 'workflow_def'));
  await db.exec(firstDoBlock('022_workflow_def.sql')); // 放宽 status 枚举 CHECK（须早于下列带 CHECK 的新列）
  await db.exec(createTableBlock('047_basic_data_consolidate.sql', 'workflow_def_history'));
  await db.exec(addColumnStatements('025_work_order_granularity.sql', 'work_orders'));
  await db.exec(addColumnStatements('028_phase_a.sql', 'work_orders'));
  await db.exec(addColumnStatements('031_reporter_name.sql', 'work_orders'));
  await db.exec(addColumnStatements('074_work_order_milestone_timestamps.sql', 'work_orders'));
  await db.exec(UP_103); // 🔴 真跑迁移，不是自己手写 ALTER
  await db.query(`INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1,$2,$3::jsonb,1)`, [
    T,
    WO_ET,
    JSON.stringify(WO_V1),
  ]);
  return db;
}

let woSeq = 0;
/** 建单：直调真产品函数 createWithIdem（含 103 后的盖章）⇒ 盖章链路也在真库里被覆盖。 */
async function createWorkOrder(c: PoolClient, title: string) {
  woSeq += 1;
  const { row, created } = await createWithIdem(c, {
    id: `wo-b4-${woSeq}`,
    tenantId: T,
    businessType: 'repair',
    title,
  });
  expect(created, 'fixture：新建成功（非幂等命中）').toBe(true);
  return row;
}

/** 改版到 v2（work_order）：v1 落进 history，live 升到 version=2（真实 saveWorkflowDef 的形态）。 */
async function upgradeWoToV2(db: PGlite) {
  await db.query(`INSERT INTO workflow_def_history (tenant_id, entity_type, version, def) VALUES ($1,$2,1,$3::jsonb)`, [
    T,
    WO_ET,
    JSON.stringify(WO_V1),
  ]);
  await db.query(`UPDATE workflow_def SET def=$3::jsonb, version=2 WHERE tenant_id=$1 AND entity_type=$2`, [
    T,
    WO_ET,
    JSON.stringify(WO_V2),
  ]);
}

/** 直调产品侧共享写侧：repo/ticket.ts 的 transition()（批 4 的写就长在这里）。 */
function woTransition(c: PoolClient, id: string, to: string, opts?: Parameters<typeof transition>[4]) {
  return transition(c, T, id, to as WorkOrderStatus, opts);
}

describe('批4 · work_orders 在途工单锁版本（真库 A1-W / A2-W / A5-W）', () => {
  it('A1-W：v1 建的老单改版到 v2 后仍按 v1 流转 —— ① v2 新边 422；② v2 新加的必填不要求它（真 transition）', async () => {
    const db = await freshWoDb();
    const c = asClient(db);
    const old1 = await createWorkOrder(c, '老单');
    expect(old1.def_version, '建单时盖的章 = 当时的 live version').toBe(1);
    await upgradeWoToV2(db);

    // 改版**不许**顺手把在途单的版本号刷成新版本（R-3：那等于没锁）。
    const after = (await db.query(`SELECT def_version FROM work_orders WHERE id = $1`, [old1.id])).rows[0] as any;
    expect(after.def_version, '改版后老单的章必须还是 v1').toBe(1);

    // 先走到 assigned（v1/v2 都有的边 ⇒ 照走通，证明老单不是被整体冻死）
    const toAssigned = await woTransition(c, old1.id, 'assigned');
    expect(toAssigned.row.status).toBe('assigned');

    // ① v2 新增的边 assigned --fast_close--> completed：对 v1 老单必须 422
    await expect(woTransition(c, old1.id, 'completed')).rejects.toThrow(/illegal transition assigned -> completed/);
    const snapshot = (await db.query(`SELECT status FROM work_orders WHERE id = $1`, [old1.id])).rows[0] as any;
    expect(snapshot.status, '被拒的流转不许留下半截状态').toBe('assigned');

    // ② v2 给**已存在**的边加的必填 safety_note：对 v1 老单**不要求**（缺该字段也必须能过）。
    //    这是最阴的一种改动：边还在、按钮还在，只是提交时被一个老单根本没有的字段挡住。
    const started = await woTransition(c, old1.id, 'processing', { fields: {} });
    expect(started.row.status, '缺 v2 的必填项也必须放行（老单照 v1 走）').toBe('processing');
  });

  it('A2-W：改版后建的新单锁 v2 并按 v2 走（防「一律锁到最老版本」这种做反了也能绿 A1-W 的实现）', async () => {
    const db = await freshWoDb();
    const c = asClient(db);
    await createWorkOrder(c, '老单');
    await upgradeWoToV2(db);
    const fresh = await createWorkOrder(c, '新单');
    expect(fresh.def_version, '新单必须盖 v2 的章').toBe(2);

    await woTransition(c, fresh.id, 'assigned');
    const closed = await woTransition(c, fresh.id, 'completed');
    expect(closed.row.status, '新单应当用得上 v2 的新边').toBe('completed');

    // 反向对照（把 A1-W 的②补成闭环）：v2 给 start 边加的必填，对新单**必须**真的要求。
    //   少了这一段，「一律不校验必填」这种实现同样能让 A1-W 绿。
    const fresh2 = await createWorkOrder(c, '新单2');
    await woTransition(c, fresh2.id, 'assigned');
    await expect(woTransition(c, fresh2.id, 'processing', { fields: {} })).rejects.toThrow(
      /missing required fields: safety_note/,
    );
  });

  it('A4-W-真值：盖章取的就是当时的 live version，且真的落进了库（回库查，不信任 RETURNING）', async () => {
    const db = await freshWoDb();
    const c = asClient(db);
    expect(await getWorkflowDefVersion(c, T, WO_ET), '改版前 live version').toBe(1);
    await createWorkOrder(c, '老单');
    await upgradeWoToV2(db);
    expect(await getWorkflowDefVersion(c, T, WO_ET), '改版后 live version').toBe(2);
    await createWorkOrder(c, '新单');

    // 回库查，不信任 INSERT 的 RETURNING（RETURNING 拿的是写入值，不是落库值）。
    const rows = (
      await db.query(`SELECT title, def_version FROM work_orders WHERE tenant_id = $1 ORDER BY title`, [T])
    ).rows as any[];
    const byTitle = new Map<string, number>(rows.map((r) => [r.title, r.def_version]));
    expect(byTitle.get('老单'), '老单锁 v1').toBe(1);
    expect(byTitle.get('新单'), '新单锁 v2').toBe(2);
  });

  it('A5-W：R-5 机制态注入 —— 取 v1 **历史版本**的工单 def 仍含 claim_hall，且老单真的能出厅', async () => {
    const db = await freshWoDb();
    const c = asClient(db);
    const old1 = await createWorkOrder(c, '老单');
    await upgradeWoToV2(db);

    // ① 结构性断言：WO_V1 快照本身**不含** claim_hall（fixture 诚实），
    //    拿到手的 def 却必须含 ⇒ 增量完全来自 withMechanismStates(:18-21)。
    expect(WO_V1.states, 'fixture 自检：v1 快照里没有 claim_hall').not.toContain('claim_hall');
    const v1def = await getWorkflowDefAtVersion(c, T, WO_ET, Number(old1.def_version), DEFAULT_WORK_ORDER_DEF);
    expect(v1def.states, '取 v1 历史版本也必须经 withMechanismStates ⇒ 含 claim_hall').toContain('claim_hall');
    expect(
      v1def.transitions.some((t) => t.from === 'claim_hall' && t.event === 'claim'),
      '出厅边同样必须在历史版本里（否则「进得去出不来」）',
    ).toBe(true);

    // ② 功能性断言（比数数组更有说服力）：老单真的能进厅、再出厅。
    //    少了注入，这两步会先撞 isKnownState(:208) 的 422 —— 文档 §7 R-5 点名的历史事故。
    const inHall = await woTransition(c, old1.id, 'claim_hall');
    expect(inHall.row.status, '老单按 v1 必须能进大厅').toBe('claim_hall');
    // claim 边由机制注入带 allowedRoles:['worker','admin'] ⇒ 显式给 role，否则门禁正当拒绝。
    const out = await woTransition(c, old1.id, 'assigned', { role: 'worker', eventOverride: 'claim' });
    expect(out.row.status, '老单按 v1 必须能出大厅').toBe('assigned');
  });

  it('E4：103 迁移跑完后，先于它存在的存量工单 def_version 一律为 0（未记录，不伪造建单版本）', async () => {
    const db = new PGlite();
    await db.exec(createTableBlock('001_init.sql', 'work_orders'));
    await db.exec(firstDoBlock('022_workflow_def.sql')); // 放宽 status CHECK，与线上同序（022 < 103）
    await db.query(`INSERT INTO work_orders (id, tenant_id, business_type) VALUES ('wo-legacy',$1,'repair')`, [T]);
    await db.exec(UP_103); // 真跑迁移

    const rows = (await db.query(`SELECT def_version FROM work_orders WHERE tenant_id = $1`, [T])).rows as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].def_version, '存量行必须是哨兵 0，不是被伪造的 1').toBe(0);
  });

  /**
   * A7（行级端到端）：手工把**某一行**的 def_version 改成 99999 ⇒ 真实流转仍成功且按 live 走 + warn。
   *
   * 【与用例 ④ 的分工 —— 为什么 ④ 不够、必须再补这一条】
   *   ④（:175）是**函数级**：直接把 999 当参数传给 getWorkflowDefAtVersion，验的是
   *   「函数收到一个不存在的版本号会怎样」。但产品里没人会凭空传版本号——版本号是**从行上读出来的**。
   *   ⇒ ④ 验不到「行上的脏版本号真的会流到读路径」这一段（读行 → Number(cur.def_version) → 取 def），
   *     也验不到「降级之后**整条流转**还能走完」。设计 §8 A7 要的是后者，故补这一条行级端到端。
   *
   * 【判别关键】升级到 v2 后，`assigned --fast_close--> completed` 是**只有 v2(live) 才有**的边，
   *   v1 里根本没有（A1-W 已验证：锁 v1 的老单走这条边会 422）。
   *   ⇒ 脏版本号(99999)若按 live(v2) 降级 ⇒ 该边走得通；
   *     若降级错了（退回 v1）或干脆抛 500 ⇒ 这里立刻红。
   */
  it('A7-行级：某行 def_version 被手工改成 99999 ⇒ 真实流转成功且按 live(v2) 走 + warn（不抛 500）', async () => {
    const db = await freshWoDb();
    const c = asClient(db);
    const wo = await createWorkOrder(c, '脏版本单');
    expect(wo.def_version, '建单时盖的章 = 当时的 live version（正常锁定值）').toBe(1);
    await upgradeWoToV2(db); // live 升到 v2、v1 落进 history ⇒ 99999 既不是 live 也不在 history 里

    // —— 手工把**这一行**的版本号改成一个不存在的版本（模拟 live 被绕过 saveWorkflowDef 直改 / 脏数据）
    await db.query(`UPDATE work_orders SET def_version = 99999 WHERE id = $1`, [wo.id]);
    const dirty = (await db.query(`SELECT def_version FROM work_orders WHERE id = $1`, [wo.id])).rows[0] as any;
    expect(dirty.def_version, 'fixture 自检：脏版本号确实落库了（回库查，不信任 UPDATE 返回值）').toBe(99999);

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // ① 真实流转路径：走 repo/ticket.ts 的 transition（:207 按行上的 def_version 取 def），
      //    不是直接调读取函数 ⇒ 这才证明「行上的脏版本号」真的流到了读路径、且没把流转搞成 500。
      const toAssigned = await woTransition(c, wo.id, 'assigned');
      expect(toAssigned.row.status, '脏版本号不得让流转失败').toBe('assigned');

      // ② 结果按 live(v2) 走：用只有 v2 才有的边 assigned --fast_close--> completed 判别。
      const closed = await woTransition(c, wo.id, 'completed');
      expect(closed.row.status, '降级到 live(v2) ⇒ v2 的新边可用（未降级/退回 v1 则 422）').toBe('completed');
      const back = (await db.query(`SELECT status FROM work_orders WHERE id = $1`, [wo.id])).rows[0] as any;
      expect(back.status, '落库状态同样是 completed（不信任 RETURNING）').toBe('completed');

      // ③ 不静默失败（E3）：warn 必须出现，且日志里能带得出来是哪个租户 / 实体 / 版本号。
      expect(spy.mock.calls.length, '失效版本号必须打 warn，不能静默降级').toBeGreaterThanOrEqual(1);
      const hit = spy.mock.calls.some((args: unknown[]) => {
        const blob = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        return blob.includes(T) && blob.includes(WO_ET) && blob.includes('99999');
      });
      expect(hit, `warn 必须能定位到租户/实体/版本号，实际调用：${JSON.stringify(spy.mock.calls)}`).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// ===================== 批 5 · 多版本并存的「名单兜底」 =====================
/**
 * 【为什么必须有这份】
 *   T1-B 把「针对某一张具体行」的流转锁住了，但有一类写法是**先按状态集合拼 SQL / 过滤条件、
 *   再去查行**——此刻手上还没有具体行，只能读 live def。租户改流程后，老单（锁着 v1）
 *   可能既不在 v2 的「包含集」里、也不在 v2 的「排除集」里 ⇒ **这批老单从名单里凭空消失**
 *   （单还在库里，但超时不告警、结算报状态不对、工人负载少算 ⇒ 派单派多）。
 *   这是版本化改造**自己引入**的洞：改造前只有一份 def，谁也不会掉队。
 *
 * 【兜底原则】宁可多显示，绝不静默丢单：包含集取各版本**并集**，排除集取各版本**交集**。
 *
 * 【样本设计】v1（旧）：X 是活跃态（有出边 X→done）；v2（新/live）：X 变成终态（无出边）。
 *   ⇒ 老单 status='X' def_version=1：
 *      · live-only 排除集 = done(v2) ∪ terminal(v2) = ['X','done'] ⇒ 老单被排除（**丢单**）
 *      · 交集排除集      = ['X','done'] ∩ ['done']              = ['done']      ⇒ 老单保留
 */
const DEF_V1_X_ACTIVE: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'X', 'done'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'X', event: 'to_x' },
    { from: 'X', to: 'done', event: 'finish' },
  ] as any,
  config: {},
} as WorkflowDef;
/** v2 = 当前 live：X 不再有出边 ⇒ X 变终态、且不再算活跃态。 */
const DEF_V2_X_TERMINAL: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'X', 'done'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'done', event: 'finish' },
  ] as any,
  config: {},
} as WorkflowDef;

/** 真库：live = v2（version=2），history 里有 v1；两行工单分别锁 v1 / v2。 */
async function freshMultiVersionDb(): Promise<PGlite> {
  const db = await freshWoDb(); // 已含 103 迁移（def_version 列）+ live v1
  await db.query(
    `INSERT INTO workflow_def_history (tenant_id, entity_type, version, def) VALUES ($1,$2,1,$3::jsonb)`,
    [T, WO_ET, JSON.stringify(DEF_V1_X_ACTIVE)],
  );
  await db.query(
    `UPDATE workflow_def SET def=$3::jsonb, version=2 WHERE tenant_id=$1 AND entity_type=$2`,
    [T, WO_ET, JSON.stringify(DEF_V2_X_TERMINAL)],
  );
  // order_no 由 002 迁移加为 NOT NULL + 租户内唯一 ⇒ 手工插行必须给，不能靠默认值。
  await db.query(
    `INSERT INTO work_orders (id, tenant_id, business_type, status, def_version, order_no)
     VALUES ('wo-old-v1',$1,'repair','X',1,'NO-OLD-V1')`,
    [T],
  );
  await db.query(
    `INSERT INTO work_orders (id, tenant_id, business_type, status, def_version, order_no)
     VALUES ('wo-new-v2',$1,'repair','assigned',2,'NO-NEW-V2')`,
    [T],
  );
  return db;
}

/** 用排除集去真查行——SLA 扫描 / 逾期统计就是这么筛的。 */
async function idsNotIn(db: PGlite, exclude: string[]): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `SELECT id FROM work_orders WHERE tenant_id=$1 AND status <> ALL($2::text[]) ORDER BY id`,
    [T, exclude],
  );
  return r.rows.map((x) => x.id);
}

describe('批5 · 多版本并存名单兜底（静默丢单洞）', () => {
  it('🔴 穿透：老单在 live-only 排除集下消失，在交集排除集下保留', async () => {
    const db = await freshMultiVersionDb();
    const c = asClient(db);

    // —— 旧算法（改造前的写法）：只读 live
    const liveOnly = Array.from(
      new Set([
        ...doneStates(DEF_V2_X_TERMINAL),
        ...terminalStates(DEF_V2_X_TERMINAL),
      ]),
    );
    // 这里用的是手写常量（未经机制态注入），终态 = [X, done]；
    // 真代码走 getWorkflowDef 会多注入 cancelled，但**结论不变**：X 在排除集里 ⇒ 老单被漏掉。
    expect(liveOnly).toEqual(['X', 'done']); // X 在新流程里已是终态
    const oldHit = await idsNotIn(db, liveOnly);
    expect(oldHit, '🔴 旧算法把锁 v1 的老单整个漏掉了（复现丢单）').not.toContain('wo-old-v1');

    // —— 新算法（本次修复）：各版本取交集
    const defs = await getDefsAcrossAllVersions(c, T, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
    const fixed = intersectStates(defs.map((d) => Array.from(new Set([...doneStates(d), ...terminalStates(d)]))));
    expect(fixed, '交集只保留所有版本都认的终态 ⇒ X 被排除出排除集').toEqual(['done', 'cancelled']);
    const newHit = await idsNotIn(db, fixed);
    expect(newHit, '修复后老单必须还在名单里').toContain('wo-old-v1');
    expect(newHit, '新单照常命中').toContain('wo-new-v2');
  });

  it('🔴 穿透：老单在 live-only 活跃集下被过滤，在并集活跃集下保留', async () => {
    const db = await freshMultiVersionDb();
    const c = asClient(db);

    const liveActive = activeStates(DEF_V2_X_TERMINAL); // v2 里 X 已不算活跃
    expect(liveActive).not.toContain('X');
    expect(liveActive.includes('X'), '🔴 旧算法：老单的状态不在 live 活跃集 ⇒ 被 slaScan 过滤掉').toBe(false);

    const defs = await getDefsAcrossAllVersions(c, T, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
    const unionActive = unionStates(defs.map(activeStates));
    expect(unionActive, '并集必须把 v1 的活跃态 X 收回来').toContain('X');
    const rows = await db.query<{ id: string }>(
      `SELECT id FROM work_orders WHERE tenant_id=$1 AND status = ANY($2::text[]) ORDER BY id`,
      [T, unionActive],
    );
    expect(rows.rows.map((r) => r.id), '修复后老单重新进入活跃名单').toContain('wo-old-v1');
  });

  it('getDefsAcrossAllVersions：v1 / v2 / 哨兵 0 三个版本都在（0 不能漏，否则存量老单整批消失）', async () => {
    const db = await freshMultiVersionDb();
    const c = asClient(db);
    const defs = await getDefsAcrossAllVersions(c, T, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
    // ⚠️ 读路径会注入机制态（claim_hall + cancelled，见 workflowDef.ts:19 withMechanismStates）
    //   ⇒ 终态集比我手写的 def 多出 cancelled，断言必须按**注入后**的真实结果写。
    const termSets = defs.map((d) => terminalStates(d));
    expect(termSets.some((s) => !s.includes('X')), 'v1（旧）的终态不含 X —— X 在旧流程里还是活跃态').toBe(true);
    expect(termSets.some((s) => s.includes('X')), 'v2（live）的终态含 X —— X 已变成终态').toBe(true);
    // 哨兵 0 → live(v2)，v1，v2 ⇒ 三个 key 各一份（0 与 2 是同一份 def，但都必须在）
    expect(defs.length, '哨兵 0 / v1 / v2 三个 key 各一份，缺 0 会整批漏掉存量老单').toBe(3);
  });

  it('单版本不回归：只有 live 一版时，交集 = 该版集合（与改造前逐字节等价）', async () => {
    const db = await freshWoDb(); // 只有 live = WO_V1，无任何 def_version>0 的行
    const c = asClient(db);
    const defs = await getDefsAcrossAllVersions(c, T, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
    const liveDef = await getWorkflowDefOrDefault(c, T, 'work_order', DEFAULT_WORK_ORDER_DEF);
    expect(defs.length, '单版本 ⇒ 只有一份 def').toBe(1);
    expect(intersectStates(defs.map(terminalStates))).toEqual(terminalStates(liveDef));
    expect(unionStates(defs.map(activeStates))).toEqual(activeStates(liveDef));
  });

  it('纯函数边界：unionStates 去重 / intersectStates 无交集则为空（空集=不排除=保守侧）', () => {
    expect(unionStates([['a', 'b'], ['b', 'c']])).toEqual(['a', 'b', 'c']);
    expect(intersectStates([['a', 'b'], ['b', 'c']])).toEqual(['b']);
    expect(intersectStates([['a'], ['b']]), '无共同终态 ⇒ 一个都不排除（宁可多显示）').toEqual([]);
    expect(intersectStates([])).toEqual([]);
  });

  it('未登记的表必须报错（表名不可参数化，白名单是唯一能挡注入的写法）', async () => {
    const db = await freshWoDb();
    const c = asClient(db);
    let threw: unknown = null;
    try {
      await getDefsAcrossAllVersions(c, T, 'work_order', 'work_orders; DROP TABLE work_orders--', DEFAULT_WORK_ORDER_DEF);
    } catch (e) {
      threw = e;
    }
    expect(threw, '未登记的表必须抛错，不能静默拼进 SQL').not.toBeNull();
    expect(String((threw as Error)?.message)).toMatch(/未登记/);
    // 表还在 ⇒ 注入没生效
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM work_orders`);
    expect(r.rows[0].n).toBe(0);
  });

  /**
   * 【为什么单独补这一条】上一条只断言「抛了」+「表没被注入」。但**抛什么**是有语义的：
   *   裸 `Error` 会穿过 errorMiddleware 落到 :121 的兜底 ⇒ **500 INTERNAL**。
   *   500 语义是"我们系统坏了" ⇒ 触发告警、排障时被当成线上故障查。
   *   而"表没登记进 VERSIONED_TABLES"是**开发期登记漏了 / 调用方传错表名** ⇒ 应当 422。
   *   （现实风险：energy_collection 目前就不在白名单里，只走 getWorkflowDefAtVersion /
   *    getDefsForVersions 才没撞到；哪天有人给它写跨版本扫描统计，就会直接 500。）
   */
  it('未登记表必须抛 422（AppError），不能是裸 Error ⇒ 500（开发期漏登记 ≠ 线上故障）', async () => {
    const db = await freshWoDb();
    const c = asClient(db);
    let threw: unknown = null;
    try {
      await getDefsAcrossAllVersions(c, T, 'work_order', 'energy_collection', DEFAULT_WORK_ORDER_DEF);
    } catch (e) {
      threw = e;
    }
    // 🔴 判别点 1：必须是 AppError（errorMiddleware 只认它才取 err.status）
    expect(threw, '未登记的表必须抛错').toBeInstanceOf(AppError);
    // 🔴 判别点 2：必须是 422，不是兜底的 500
    expect((threw as AppError).status, '登记漏了是调用方传错 ⇒ 422，不能落 500').toBe(422);
    // 🔴 判别点 3：错误信息要说清「没登记在哪」+「开发者该做什么」
    expect((threw as AppError).message).toMatch(/VERSIONED_TABLES/);
    expect((threw as AppError).message).toMatch(/getWorkflowDefAtVersion/);
    expect((threw as AppError).message).toMatch(/getDefsForVersions/);
  });
});

// ===================== 批 6 · 口径方向（独立评审 C1：排除判定用成了并集） =====================
/**
 * 【为什么必须有这份】
 *   批 5 的验收是「我在测试里手写正确写法，再断言它对」——那只验了 `intersectStates` 这个
 *   纯函数，**没验调用点真的用了它**。结果 `repo/stats.ts:207` 我实际写成了 `unionStates`，
 *   批 5 的 6 条测试全绿、tsc 全绿，方向错了一整轮没人发现（独立评审才抓出来）。
 *   ⇒ 本节改成**直接调真产品函数 `processMetrics`**，让「调用点写错」立刻变红。
 *
 * 【判定方向怎么定】`terminals` 落到 `stats.ts:252` 是 `status <> ALL($2::text[])`
 *   ⇒ 这是**排除**判定 ⇒ 按本批自定原则必须取**交集**（只排除所有版本都认是终态的状态）。
 *   取并集会让排除集变大 ⇒ 老单被排掉 ⇒ 大屏「瓶颈定位/活跃堆积」少报。
 *
 * 【样本】沿用批 5 的 v1/v2：v1 里 X 是活跃态（有出边），v2 里 X 变终态（无出边）。
 *   老单 status='X' def_version=1 ⇒ 并集排除集含 X ⇒ 被漏；交集排除集不含 X ⇒ 保留。
 */
async function freshMetricsDb(): Promise<PGlite> {
  const db = await freshMultiVersionDb(); // 已含 live=v2、history v1、两单（wo-old-v1='X'/v1，wo-new-v2='assigned'/v2）
  await db.exec(addColumnStatements('004_sla.sql', 'work_orders')); // sla_due_at（SLA 达成率口径要用）
  // processMetrics 的瓶颈定位是 5 张表的 UNION ALL ⇒ 表都得在，否则真库直接报错。
  await db.exec(createTableBlock('001_init.sql', 'worker'));
  await db.exec(createTableBlock('011_inspection.sql', 'inspection_task'));
  await db.exec(createTableBlock('012_volunteer.sql', 'volunteer_record'));
  await db.exec(createTableBlock('013_feedback.sql', 'feedback'));
  await db.exec(createTableBlock('014_monitor.sql', 'monitor_alert'));
  return db;
}

describe('批6 · processMetrics 活跃堆积（排除判定必须取交集）', () => {
  it('🔴 穿透：老单不能在活跃堆积里消失（排除集当前取交集；若退回并集则期望 2 实得 1）', async () => {
    clearStatsCache(); // 缓存按 tenantId 键，跨用例会串味
    const db = await freshMetricsDb();

    // —— 先证明旧算法（并集）确实会漏，作为红对照
    const c = asClient(db);
    const defs = await getDefsAcrossAllVersions(c, T, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
    const byUnion = unionStates(defs.map(terminalStates));
    expect(byUnion, '并集排除集含 X（v2 里 X 已是终态）').toContain('X');
    const lost = await db.query<{ id: string }>(
      `SELECT id FROM work_orders WHERE tenant_id=$1 AND status <> ALL($2::text[]) ORDER BY id`,
      [T, byUnion],
    );
    expect(lost.rows.map((r) => r.id), '🔴 并集 ⇒ 锁 v1 的老单被排掉（复现少报）').not.toContain('wo-old-v1');

    // —— 真调产品函数：它必须把老单算进活跃堆积
    const m = await processMetrics(c, T);
    const wo = m.bottleneck.find((b) => b.entity_type === 'work_order');
    expect(wo?.active, '两单都在活跃堆里 ⇒ 排除集必须是交集，不能是并集').toBe(2);
  });
});

// ===================== 批 5b · 模板效果回写的多版本口径（全仓唯一 0% 覆盖的改动点） =====================
/**
 * 【为什么必须补这一节】
 *   覆盖率实测（180 文件 / 2180 用例全绿的那轮）：`src/services/templateEffects.ts`
 *   **语句覆盖 0%（1-92 行全红）**，它仅有的两个调用方 `routes/templateMarket.ts`、
 *   `scheduler/templateEffectScheduler.ts` 同样 0%。三个文件都不是死代码——
 *   `server.ts:148` 挂了路由、`server.ts:61` 起了 cron。
 *   ⇒ 批 5 在 `templateEffects.ts:27-29` 做的「多版本并集」改动**此前没有任何测试验证过**，
 *     tsc 通过只证明类型对，不证明口径对。本节用真库把它钉死。
 *
 * 【为什么写在这里、不新建文件】本轮硬约束：验收一律扩在既有测试文件里。
 *   本文件已有 pglite 真库基建（freshWoDb / asClient / createTableBlock / addColumnStatements）。
 *
 * 【样本设计】v1（旧）显式声明 `config.doneStates = ['done','X']` ⇒ X 算完成态；
 *   v2（live）只认 `['done']` ⇒ X 不再是完成态。
 *   老单 `status='X' def_version=1` 在「只读 live」口径下**不算完成** ⇒ 闭环率被低估
 *   ⇒ 模板效果 Δ 失真、模板评分被压低。这正是批 5 要修的。
 *
 * 【为什么必须真调 refreshApplyEffect 而不是复算一遍口径】
 *   要验的是「调用点有没有真的把并集传进 SQL」，不是「并集函数对不对」（已在上一节验过）。
 *   复算一遍等价于自己给自己盖章 ⇒ 用 `vi.doMock` 把 pool 指向真 pglite，再动态 import 真产品代码。
 */
const TPL_ID = '11111111-1111-1111-1111-111111111111';
const APPLY_ID = '22222222-2222-2222-2222-222222222222';

/** v1（旧）：X 也算完成态。 */
const TPL_DEF_V1: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'X', 'done'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'done', event: 'finish' },
  ] as any,
  config: { doneStates: ['done', 'X'] } as any,
} as WorkflowDef;
/** v2（live）：只认 done，X 被降级为非完成态。 */
const TPL_DEF_V2: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'X', 'done'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'done', event: 'finish' },
  ] as any,
  config: { doneStates: ['done'] } as any,
} as WorkflowDef;

/** 真库：live=v2、history 有 v1，两单分别锁 v1(X) / v2(done)，外加模板与应用记录。 */
async function freshTplDb(multiVersion: boolean): Promise<PGlite> {
  const db = await freshWoDb(); // 已含 103 迁移 + live v1
  await db.exec(addColumnStatements('004_sla.sql', 'work_orders')); // sla_due_at（效果回写的逾期率口径要用）
  await db.exec(createTableBlock('053_platform_template.sql', 'platform_template'));
  await db.exec(createTableBlock('053_platform_template.sql', 'platform_template_apply'));
  await db.exec(addColumnStatements('053b_review_fixes.sql', 'platform_template_apply')); // refreshed_at
  if (multiVersion) {
    await db.query(
      `INSERT INTO workflow_def_history (tenant_id, entity_type, version, def) VALUES ($1,$2,1,$3::jsonb)`,
      [T, WO_ET, JSON.stringify(TPL_DEF_V1)],
    );
    await db.query(
      `UPDATE workflow_def SET def=$3::jsonb, version=2 WHERE tenant_id=$1 AND entity_type=$2`,
      [T, WO_ET, JSON.stringify(TPL_DEF_V2)],
    );
  }
  // order_no 由 002 迁移加为 NOT NULL + 租户内唯一 ⇒ 手工插行必须给。
  await db.query(
    `INSERT INTO work_orders (id, tenant_id, business_type, status, def_version, order_no)
     VALUES ('wo-old-v1',$1,'repair',$2,$3,'NO-OLD-V1')`,
    [T, 'X', multiVersion ? 1 : 0],
  );
  await db.query(
    `INSERT INTO work_orders (id, tenant_id, business_type, status, def_version, order_no)
     VALUES ('wo-new-v2',$1,'repair','done',0,'NO-NEW-V2')`,
    [T],
  );
  await db.query(`INSERT INTO platform_template (id, name, entity_type) VALUES ($1,'模板A','work_order')`, [TPL_ID]);
  await db.query(
    `INSERT INTO platform_template_apply (id, template_id, tenant_id, entity_type, before_metrics, status)
     VALUES ($1,$2,$3,'work_order',$4::jsonb,'applied')`,
    [APPLY_ID, TPL_ID, T, JSON.stringify({ close_rate: 0 })],
  );
  return db;
}

/** 把 db/pool 指向真 pglite 后动态 import 真产品代码，调一次效果回写。 */
async function runRefreshApplyEffect(db: PGlite): Promise<{ refreshed: boolean; effect_rating: number | null }> {
  vi.resetModules();
  vi.doMock('../db/pool.js', () => ({
    default: {
      query: async (text: unknown, params?: unknown[]) => {
        const r: any = await db.query(String(text), (params ?? []) as any[]);
        return { ...r, rowCount: r.rows?.length ?? 0 };
      },
    },
    withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) =>
      fn({ query: (text: unknown, params?: unknown[]) => db.query(String(text), (params ?? []) as any[]) }),
    assertSafeTenantId: (t: string) => t,
  }));
  const mod = await import('../services/templateEffects.js');
  return mod.refreshApplyEffect(APPLY_ID);
}

async function readAfterMetrics(db: PGlite): Promise<any> {
  const r = await db.query<{ after_metrics: any }>(
    `SELECT after_metrics FROM platform_template_apply WHERE id = $1`,
    [APPLY_ID],
  );
  const raw = r.rows[0]?.after_metrics;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** 老口径（只读 live）下的闭环率：同一份真库数据，不调产品代码。 */
async function closeRateLiveOnly(db: PGlite): Promise<number> {
  const r = await db.query<{ v: string | null }>(
    `SELECT count(*) FILTER (WHERE status = ANY($2::text[]))::numeric / nullif(count(*),0) AS v
     FROM work_orders WHERE tenant_id = $1`,
    [T, doneStates(TPL_DEF_V2)],
  );
  return Number(r.rows[0]?.v ?? 0);
}

describe('批5b · 模板效果回写（templateEffects.ts，0% 覆盖区）', () => {
  it('🔴 穿透：旧口径把锁 v1 的老单漏出完成率，并集口径必须计回来', async () => {
    const db = await freshTplDb(true);

    // —— 旧算法：只认 live(v2) 的 done 集 ⇒ X 不算完成
    expect(doneStates(TPL_DEF_V2)).toEqual(['done']);
    const oldRate = await closeRateLiveOnly(db);
    expect(oldRate, '🔴 旧算法：2 单里只认 1 单完成（复现效果 Δ 被低估）').toBe(0.5);

    // —— 新代码：真调 refreshApplyEffect，看它写回库的 after_metrics
    await runRefreshApplyEffect(db);
    const after = await readAfterMetrics(db);
    expect(after.total, '两单都要进样本').toBe(2);
    expect(Number(after.close_rate), '并集口径把 v1 的完成态 X 收回来 ⇒ 2/2 = 1').toBe(1);
  });

  it('单版本不回归：库里只有一个版本时，回写结果与旧口径一致（与改造前逐字节等价）', async () => {
    const db = await freshTplDb(false); // 无 history、无 def_version>0 ⇒ 只有 live 一版
    await runRefreshApplyEffect(db);
    const after = await readAfterMetrics(db);
    expect(after.total).toBe(2);
    // live = WO_V1（freshWoDb 默认，未覆盖成 v2）⇒ 完成态由该 def 派生；
    // 老单 status='X' 不在其中 ⇒ 完成率 0.5，与「只读 live」必然相同（无第二版本可并）。
    const c = asClient(db);
    const liveDef = await getWorkflowDefOrDefault(c, T, 'work_order', DEFAULT_WORK_ORDER_DEF);
    const r = await db.query<{ v: string | null }>(
      `SELECT count(*) FILTER (WHERE status = ANY($2::text[]))::numeric / nullif(count(*),0) AS v
       FROM work_orders WHERE tenant_id = $1`,
      [T, doneStates(liveDef)],
    );
    expect(Number(after.close_rate), '单版本 ⇒ 并集 = 该版集合，与旧口径逐字节相同').toBe(Number(r.rows[0]?.v ?? 0));
  });
});

// ===================== 批 1b · inspection_task 真实写路径（穿透 routes/inspection.ts） =====================
/**
 * 【为什么补这一节】
 *   上面「批1」的 A1/A2 是**引擎级**的：直接 `applyEvent(getWorkflowDefAtVersion(...))`，
 *   绕开了 `src/routes/inspection.ts:40` 这个真正的写侧调用点 ⇒ 把 :40 改回读 live，
 *   上面那几条**实测仍然全绿**（只有 inspection.http.test.ts:505 的静态计数会红）。
 *   ⇒ 本节把 express app 挂在**真 PGlite** 上，用**真 HTTP** 打
 *     `POST /api/v1/inspection/tasks` 与 `POST /api/v1/inspection/tasks/:id/transition`
 *     ⇒ 走的是真 routes/inspection.ts：真盖章 + 真 transitionTask + 真 applyEvent + 真落库。
 *
 * 【为什么放本文件、不放 inspection.http.test.ts】
 *   那份把 `../engine/workflowDef.js` **整体 vi.mock 成桩**（:91-112）：
 *   `getWorkflowDefAtVersion` 与 `getWorkflowDefOrDefault` 都返回同一个 `stubDef`
 *   ⇒ 在那里「读锁定版本」与「读 live」结果**逐字节相同**，:40 的变异构造上不可能被抓住。
 *   本文件 workflowDef 是真模块、版本链是真的（live/history 真表）⇒ 才验得到。
 *
 * 【为什么用 dev authMode】requirePermission（role.ts:458）/ requireAssigneeOrConfig
 *   （role.ts:622）在 dev 下恒放行 ⇒ 守卫不参与判定，只让「流转校验」本身说话。
 *   守卫本身由 inspection.http.test.ts 的 prod 分支覆盖，此处不重复。
 */
async function freshRouteDb(): Promise<PGlite> {
  const db = await freshInspDb(); // live = v1 + 102 迁移 + inspection_task 真表
  // 011 只有骨架列，路由要写的 items_json / updated_at / scan_meta 是后续迁移加的
  // ⇒ 按迁移序号补齐（原文照搬，不自抄一份 SQL）。
  for (const f of ['029_inspection_updated_at.sql', '040_inspection_items.sql', '048_inspection_rfid.sql']) {
    await db.exec(addColumnStatements(f, 'inspection_task'));
  }
  // transitionTask 末尾 emitDomainEvent 是**裸 INSERT、不吞错**（eventBus.ts:16-29）
  // ⇒ 缺这张表会假红成产品 bug。
  await db.exec(createTableBlock('020_domain_event.sql', 'domain_event'));
  return db;
}

/**
 * 把 db/pool.js 指向真 PGlite 后**动态 import 真路由**，挂成 express app 并起真端口。
 * （沿用本文件批 5b 的 `vi.resetModules + vi.doMock + 动态 import` 既有套路。）
 */
async function mountInspectionApp(db: PGlite): Promise<{ base: string; close: () => Promise<void> }> {
  vi.resetModules();
  vi.doMock('../db/pool.js', () => ({
    default: {
      query: async (text: unknown, params?: unknown[]) => db.query(String(text), (params ?? []) as any[]),
    },
    // 真库没有 RLS / GUC ⇒ 不开事务，直接把真 pglite client 交给 handler。
    withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) =>
      fn({ query: (text: unknown, params?: unknown[]) => db.query(String(text), (params ?? []) as any[]) }),
    assertSafeTenantId: (t: string) => t,
  }));
  const [inspMod, errMod] = await Promise.all([
    import('../routes/inspection.js'),
    import('../middleware/error.js'),
  ]);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.locals.auth = { tenantId: T, role: 'operator', userId: 'u-1', requestId: 'r-1', authMode: 'dev' };
    next();
  });
  app.use('/api/v1/inspection', inspMod.default);
  app.use(errMod.errorMiddleware);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** 真 HTTP 请求（与 inspection.http.test.ts 同款，不引新依赖）。 */
function httpJson(method: 'POST', url: string, body: unknown) {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 走真 `POST /tasks` 建单，并返回**回库查**到的行（不信任响应体 / RETURNING）。 */
async function createTaskViaRoute(base: string, db: PGlite, title: string) {
  const r = await httpJson('POST', `${base}/api/v1/inspection/tasks`, { title });
  expect(r.status, `POST /tasks(${title}) 应 201`).toBe(201);
  const rows = (await db.query(`SELECT id, def_version, status FROM inspection_task WHERE tenant_id = $1 AND title = $2`, [T, title])).rows as any[];
  expect(rows.length, `${title} 必须真的落库`).toBe(1);
  return rows[0] as { id: string; def_version: number; status: string };
}

/** 走真 `POST /tasks/:id/transition` 流转（inspection.ts:570 → transitionTask:28 → :40）。 */
function transitionViaRoute(base: string, id: string, event: string) {
  return httpJson('POST', `${base}/api/v1/inspection/tasks/${id}/transition`, { event });
}

describe('批1b · inspection_task 真实写路径（穿透 routes/inspection.ts 的 /transition）', () => {
  it('🔴 穿透 A1：v1 老单 —— v2 新增的 cancel 边被 422 拒掉，v1 自己的 checkin 照走（真 HTTP + 真库）', async () => {
    const db = await freshRouteDb();
    const { base, close } = await mountInspectionApp(db);
    try {
      const old1 = await createTaskViaRoute(base, db, '老单'); // 走 inspection.ts:363 盖章
      expect(old1.def_version, '建单盖的章 = 当时的 live version').toBe(1);
      await upgradeToV2(db); // live 升到 v2：新增 pending --cancel--> cancelled

      // 🔴 变异点：若 :40 被改回「读 live」（如第 4 实参写成 0 ⇒ 走 live），
      //   这里会拿到 v2 的 def ⇒ cancel 合法 ⇒ 200 而不是 422 ⇒ 本条立刻红。
      const bad = await transitionViaRoute(base, old1.id, 'cancel');
      expect(bad.status, 'v2 新增的边不许对 v1 老单生效').toBe(422);
      expect(((await bad.json()) as any).code).toBe('BAD_STATE');
      // 被拒的流转不许留下半截状态
      const afterBad = (await db.query(`SELECT status FROM inspection_task WHERE id = $1`, [old1.id])).rows[0] as any;
      expect(afterBad.status).toBe('pending');

      // 老单不是被整体冻死：v1 自己的边照走、且真落库。
      const ok = await transitionViaRoute(base, old1.id, 'checkin');
      expect(ok.status, 'v1 自己的边必须照常走通').toBe(200);
      const afterOk = (await db.query(`SELECT status FROM inspection_task WHERE id = $1`, [old1.id])).rows[0] as any;
      expect(afterOk.status, '真落库，不是只回了个 200').toBe('in_progress');
    } finally {
      await close();
    }
  });

  it('🔴 穿透 A2（反向防做反）：改版后新建的单盖 v2 并按 v2 走 —— cancel 边放行', async () => {
    const db = await freshRouteDb();
    const { base, close } = await mountInspectionApp(db);
    try {
      await createTaskViaRoute(base, db, '老单');
      await upgradeToV2(db);
      const fresh = await createTaskViaRoute(base, db, '新单');
      expect(fresh.def_version, '改版后建的新单必须盖 v2 的章').toBe(2);

      // 少了这条，「一律锁到最老版本 / 版本号写死 1」这种做反了的实现也能让 A1 全绿。
      const r = await transitionViaRoute(base, fresh.id, 'cancel');
      expect(r.status, '新单应当用得上 v2 的新边').toBe(200);
      const row = (await db.query(`SELECT status FROM inspection_task WHERE id = $1`, [fresh.id])).rows[0] as any;
      expect(row.status).toBe('cancelled');
    } finally {
      await close();
    }
  });
});
