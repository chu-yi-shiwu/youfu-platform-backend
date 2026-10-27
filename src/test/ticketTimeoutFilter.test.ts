/**
 * `repo/ticket.ts` 的 `list({ timeoutOnly: true })` —— PGlite 真库 + 真调 list()
 *
 * 【为什么必须有这份测试】
 *   src/repo/ticket.ts:569-594 的 timeoutOnly 分支此前**全仓零覆盖**（`list()` 没有任何测试文件）。
 *   它里面手抄了一份「各版本终态集求交集」的逻辑，是 engine/workflowDef.ts:745
 *   `intersectStates` 的**第二真源**。本次要把这份手抄收敛掉，前提是有机器验收 ——
 *   所以本文件先落地，**再**去做替换。
 *
 * 【为什么必须 pglite 真库、真调 list()，而不是 mock 掉 SQL】
 *   timeoutOnly 的全部语义都压在那半句 SQL 谓词上：
 *     `wo.sla_due_at IS NOT NULL AND wo.sla_due_at < now() AND wo.status <> ALL($n::text[])`
 *   mock 掉 client.query ⇒ 谓词根本没被执行 ⇒ 无论谓词写成什么样测试都绿。
 *   本仓已在别处踩过两次「mock 不执行 SQL 谓词 ⇒ 那道闸在测试里隐形」的假绿，此处不再重蹈：
 *   每条结论都来自**真库里真的查出来的行 id 集合**，且每条都附「红对照」（把错法的 SQL
 *   在**同一份 fixture** 上真跑一遍，证明它会给出不同结果 ⇒ 这些断言不是永真式）。
 *
 * 【口径】timeoutOnly 是**排除**判定（status <> ALL），按本仓兜底原则
 *   「宁可多显示（误报），绝不静默丢单」⇒ 排除集必须取各版本交集（空集 = 不排除任何状态）。
 *
 * 【三条主线】
 *   ① 单版本回归基线：只回「已过期 且 状态不在该版终态集里」的工单；
 *   ② 多版本不静默丢单：排除集必须取各版本**交集**，取并集 / 只读 live 都会把锁老版本的单排掉；
 *   ③ 交集为空时保守：`<> ALL('{}')` 恒真 ⇒ 所有过期单都返回，绝不静默清空。
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { list } from '../repo/ticket.js';
import { getDefsAcrossAllVersions, unionStates, getWorkflowDefOrDefault } from '../engine/workflowDef.js';
import { DEFAULT_WORK_ORDER_DEF, doneStates, terminalStates, type WorkflowDef } from '../engine/stateMachine.js';

const ROOT = join(__dirname, '..', '..');
const T = 't-timeout-filter';
const WO_ET = 'work_order';

/** 取迁移文件里某张表的 CREATE TABLE 段（到 `\n);` 为止）：用真实建表口径，不手抄 DDL。 */
function createTableBlock(file: string, table: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`迁移 ${file} 里找不到 ${table} 的建表语句`);
  const end = text.indexOf('\n);', start);
  return text.slice(start, end < 0 ? text.length : end + 3);
}

/** 取迁移文件里针对某表的全部 `ALTER TABLE <t> ADD COLUMN IF NOT EXISTS ...;` 原文（保持原序）。 */
function addColumnStatements(file: string, table: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const re = new RegExp(`^ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS .*;$`, 'gm');
  const lines = text.match(re) ?? [];
  if (lines.length === 0) throw new Error(`迁移 ${file} 里找不到 ${table} 的 ADD COLUMN 语句`);
  return lines.join('\n');
}

/** 取迁移文件里的第一个 `DO $$ ... END $$;` 块原文（022 用它放宽 status 枚举 CHECK）。 */
function firstDoBlock(file: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf('DO $$');
  if (start < 0) throw new Error(`迁移 ${file} 里找不到 DO 块`);
  const end = text.indexOf('END $$;', start);
  if (end < 0) throw new Error(`迁移 ${file} 的 DO 块没有配对的 END $$;`);
  return text.slice(start, end + 'END $$;'.length);
}

const UP_103 = readFileSync(join(ROOT, '103_inflight_def_version_workorder.sql'), 'utf8');

/**
 * 真建库：work_orders / ticket_event / worker（001）+ workflow_def（022）+ history（047）+
 * domain_event（020），按迁移序号补齐工单后续扩列，**真跑 103 迁移**加 def_version，
 * 再补 004 的 sla_due_at（timeoutOnly 的判定列）。
 *
 * 【为什么必须真跑迁移而不是手写 ALTER】手写等于给漂移开一处新真源；
 *   001 的 work_orders 自带 `CHECK (status IN (4 态))`，022 的 DO 块才放宽它，
 *   且必须早于任何带 CHECK 的新列执行 ⇒ 严格按迁移序号贴（与既有 pglite 测试同序）。
 */
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('001_init.sql', 'work_orders'));
  await db.exec(createTableBlock('001_init.sql', 'ticket_event'));
  await db.exec(createTableBlock('001_init.sql', 'worker'));
  await db.exec(firstDoBlock('002_add_order_no.sql')); // order_no（NOT NULL + 租户内唯一）
  await db.exec(addColumnStatements('004_sla.sql', 'work_orders')); // sla_due_at 等
  await db.exec(createTableBlock('020_domain_event.sql', 'domain_event'));
  await db.exec(createTableBlock('022_workflow_def.sql', 'workflow_def'));
  await db.exec(firstDoBlock('022_workflow_def.sql')); // 放宽 status 枚举 CHECK（须早于下列带 CHECK 的新列）
  await db.exec(createTableBlock('047_basic_data_consolidate.sql', 'workflow_def_history'));
  await db.exec(addColumnStatements('025_work_order_granularity.sql', 'work_orders'));
  await db.exec(addColumnStatements('028_phase_a.sql', 'work_orders'));
  await db.exec(addColumnStatements('031_reporter_name.sql', 'work_orders'));
  await db.exec(addColumnStatements('074_work_order_milestone_timestamps.sql', 'work_orders'));
  await db.exec(UP_103); // 🔴 真跑迁移加 def_version，不是自己手写 ALTER
  return db;
}

const asClient = (db: PGlite) => db as unknown as PoolClient;

/** 写 live def（version 显式给定）。 */
async function setLive(db: PGlite, def: WorkflowDef, version: number): Promise<void> {
  await db.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (tenant_id, entity_type) DO UPDATE SET def = EXCLUDED.def, version = EXCLUDED.version`,
    [T, WO_ET, JSON.stringify(def), version],
  );
}

/** 把某版本快照写进 history（真实链路：被覆盖的旧版本才落 history）。 */
async function putHistory(db: PGlite, version: number, def: WorkflowDef): Promise<void> {
  await db.query(
    `INSERT INTO workflow_def_history (tenant_id, entity_type, version, def) VALUES ($1,$2,$3,$4::jsonb)
     ON CONFLICT (tenant_id, entity_type, version) DO UPDATE SET def = EXCLUDED.def`,
    [T, WO_ET, version, JSON.stringify(def)],
  );
}

/**
 * 手工插一行工单（order_no 由 002 加成 NOT NULL + 租户内唯一 ⇒ 必须给）。
 * @param opts.dueOffsetMin 相对当前时刻的分钟偏移（负 = 已过期）；不传 ⇒ sla_due_at = NULL。
 */
async function seedOrder(
  db: PGlite,
  id: string,
  status: string,
  opts: { defVersion?: number; dueOffsetMin?: number; department?: string } = {},
): Promise<void> {
  const due = opts.dueOffsetMin;
  const dueSql = due === undefined ? 'NULL' : `now() + (${Number(due) || 0} || ' minutes')::interval`;
  await db.query(
    `INSERT INTO work_orders (id, tenant_id, business_type, status, order_no, def_version, sla_due_at, department)
     VALUES ($1,$2,'repair',$3,$4,$5,${dueSql},$6)`,
    [id, T, status, `NO-${id}`, opts.defVersion ?? 0, opts.department ?? null],
  );
}

/**
 * 在真库上手工跑「谓词本体」拿 id 集合 —— 专供**红对照**用：
 *   把错法（union / live-only / 漏掉过期判定）在同一份 fixture 上真跑一遍。
 * @param ignoreDue true ⇒ 把 `sla_due_at IS NOT NULL AND sla_due_at < now()` 换成 TRUE（模拟漏掉过期判定）
 */
async function idsUnderPredicate(
  db: PGlite,
  exclude: string[],
  ignoreDue = false,
): Promise<string[]> {
  const dueCond = ignoreDue ? 'TRUE' : 'sla_due_at IS NOT NULL AND sla_due_at < now()';
  const r = await db.query<{ id: string }>(
    `SELECT id FROM work_orders
      WHERE tenant_id=$1 AND ${dueCond} AND status <> ALL($2::text[])
      ORDER BY id`,
    [T, exclude],
  );
  return r.rows.map((x) => x.id);
}

/** 真调产品函数 list()，返回按字典序排过的 id（避开 ORDER BY created_at DESC 的不确定性）。 */
async function listTimeoutOnly(db: PGlite, extra: Record<string, unknown> = {}): Promise<string[]> {
  const res = await list(asClient(db), T, { timeoutOnly: true, limit: 200, ...extra } as never);
  expect(res.total, 'total 与 items 必须同口径（同一个 WHERE 拼出来的）').toBe(res.items.length);
  return res.items.map((r) => r.id).sort();
}

/** 某版本 def 的排除集贡献 = done ∪ terminal（派生口径，供红对照复用，手工 Scratch 用）。 */
function excludeSetOf(d: WorkflowDef): string[] {
  return Array.from(new Set<string>([...doneStates(d), ...terminalStates(d)]));
}

// ============================================================
// ① 单版本回归基线
// ============================================================

/**
 * 单版本 def：draft→assigned→processing→completed，显式 doneStates=['completed']。
 * 经机制态注入后 terminalStates = ['completed','cancelled']（cancelled 由大厅 cancel 边引入、
 * 且无出边），doneStates = ['completed'] ⇒ **排除集 = ['completed','cancelled']**。
 */
const DEF_SINGLE: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'completed'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'processing', event: 'start' },
    { from: 'processing', to: 'completed', event: 'finish' },
  ] as any,
  config: { doneStates: ['completed'] },
} as WorkflowDef;

describe('① 单版本（修前修后行为一致）：timeoutOnly 回归基线', () => {
  it('只回「已过期 且 状态不在终态集里」的工单；已完成/已终结/未过期/无期限的一律不出现', async () => {
    const db = await freshDb();
    await setLive(db, DEF_SINGLE, 1);
    await seedOrder(db, 'wo-open-expired', 'assigned', { dueOffsetMin: -60 });
    await seedOrder(db, 'wo-open-processing', 'processing', { dueOffsetMin: -5 });
    await seedOrder(db, 'wo-completed-expired', 'completed', { dueOffsetMin: -120 });
    await seedOrder(db, 'wo-cancelled-expired', 'cancelled', { dueOffsetMin: -120 });
    await seedOrder(db, 'wo-open-future', 'assigned', { dueOffsetMin: 60 });
    await seedOrder(db, 'wo-open-nosla', 'assigned'); // sla_due_at IS NULL

    // —— 真调产品函数
    const ids = await listTimeoutOnly(db);
    expect(ids).toEqual(['wo-open-expired', 'wo-open-processing']);

    // —— 假绿防护：每一条被排除的行都必须有**可归因的专属理由**，不是碰巧没返回。
    //    把谓词的某一部分拿掉，那一行就必须回来 ⇒ 证明本断言不是永真式。
    const full = await getWorkflowDefOrDefault(asClient(db), T, WO_ET, DEFAULT_WORK_ORDER_DEF);
    const exclude = excludeSetOf(full);
    expect(exclude.sort(), 'fixture 自检：单版本排除集（已含机制态注入）').toEqual(['cancelled', 'completed']);

    // ① 缺 any 一个排除项 ⇒ 对应的已完成/已终结单立刻回来
    const withoutCompleted = await idsUnderPredicate(db, exclude.filter((s) => s !== 'completed'));
    expect(withoutCompleted).toContain('wo-completed-expired');
    const withoutCancelled = await idsUnderPredicate(db, exclude.filter((s) => s !== 'cancelled'));
    expect(withoutCancelled).toContain('wo-cancelled-expired');
    expect(ids).not.toContain('wo-completed-expired');
    expect(ids).not.toContain('wo-cancelled-expired');

    // ② 漏掉过期判定 ⇒ 未过期单与无期限单立刻回来
    const ignoringDue = await idsUnderPredicate(db, exclude, true);
    expect(ignoringDue).toContain('wo-open-future');
    expect(ignoringDue).toContain('wo-open-nosla');
    expect(ids).not.toContain('wo-open-future');
    expect(ids).not.toContain('wo-open-nosla');
  });

  it('fixture 自检：单版本下「并集 / live-only / 交集」三者逐字相同 ⇒ 本节**判别不了**口径方向（ motivates ②③ ）', async () => {
    const db = await freshDb();
    await setLive(db, DEF_SINGLE, 1);
    await seedOrder(db, 'wo-open-expired', 'assigned', { dueOffsetMin: -60 });

    const defs = await getDefsAcrossAllVersions(asClient(db), T, WO_ET, 'work_orders', DEFAULT_WORK_ORDER_DEF);
    const perVersion = defs.map(excludeSetOf);
    expect(defs.length, '只有 live 一版（无 def_version>0 的行）').toBe(1);
    expect(unionStates(perVersion).sort(), '并集').toEqual(excludeSetOf(defs[0] as WorkflowDef).sort());
    // 诚实声明：这条**同时**说明 ① 那两条断言对「口径方向」零判别力 ——
    // 把实现改成 union 或 live-only，① 依然全绿。方向由 ② ③ 独担。
  });

  it('参数占位符互不打架：timeoutOnly 与 department 等占位过滤同用时结果正确（$n 索引）', async () => {
    const db = await freshDb();
    await setLive(db, DEF_SINGLE, 1);
    await seedOrder(db, 'wo-dept-a', 'assigned', { dueOffsetMin: -60, department: 'dept-a' });
    await seedOrder(db, 'wo-dept-b', 'assigned', { dueOffsetMin: -60, department: 'dept-b' });
    await seedOrder(db, 'wo-dept-b-done', 'completed', { dueOffsetMin: -60, department: 'dept-b' });

    expect(await listTimeoutOnly(db, { department: 'dept-a' })).toEqual(['wo-dept-a']);
    expect(await listTimeoutOnly(db, { department: 'dept-b' })).toEqual(['wo-dept-b']);
    // 占位符错位（比如把 tenant_id 的位置挤掉）会在这里表现为 SQL 报错或全表命中，两者都会红。
    expect(await listTimeoutOnly(db, { department: 'dept-none' })).toEqual([]);
  });
});

// ============================================================
// ② 多版本不静默丢单（排除集必须取交集）
// ============================================================

/**
 * v1（旧，落 history）：X 是**活跃态**（有出边 X→done）⇒ X 不算终态、也不算完成。
 * v2（live）：X 变成**终态**（没有出边）⇒ X 进了 v2 的排除集。
 *
 * ⇒ 一张 `status='X' def_version=1` 的老工单：
 *     · 交集排除集（正确）= ['done','cancelled']         ⇒ X 不被排除 ⇒ **老单在名单里**
 *     · 并集排除集（错）  = ['X','done','cancelled']     ⇒ X 被排除   ⇒ 🔴 老单消失
 *     · 只读 live（错）   = set_v2 = ['X','done','cancelled'] ⇒ 🔴 老单消失
 *   两种错法在同一份 fixture 上给出**不同**结果 ⇒ 本节的断言有牙。
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

const DEF_V2_X_TERMINAL: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'X', 'done'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'done', event: 'finish' },
  ] as any,
  config: {},
} as WorkflowDef;

/** 真库：live = v2(version=2)，history 有 v1；若干张工单分别锁 v1 / v2 / 哨兵 0。 */
async function freshMultiVersionDb(): Promise<PGlite> {
  const db = await freshDb();
  await putHistory(db, 1, DEF_V1_X_ACTIVE);
  await setLive(db, DEF_V2_X_TERMINAL, 2);
  return db;
}

describe('② 多版本：老单不得静默消失（排除集必须是交集，不能是并集 / live-only）', () => {
  it('🔴 穿透：锁 v1、status=X 的过期老单必须出现在结果里', async () => {
    const db = await freshMultiVersionDb();
    const c = asClient(db);
    await seedOrder(db, 'wo-old-v1-x', 'X', { defVersion: 1, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-old-v1-done', 'done', { defVersion: 1, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-live-assigned', 'assigned', { defVersion: 2, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-live-x', 'X', { defVersion: 2, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-legacy-cancelled', 'cancelled', { defVersion: 0, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-future', 'assigned', { defVersion: 2, dueOffsetMin: 60 });

    // —— 红对照 A：取**并集** ⇒ X 进排除集 ⇒ 两种版本的 X 单（含那张锁 v1 的老单）全被排掉
    const defs = await getDefsAcrossAllVersions(c, T, WO_ET, 'work_orders', DEFAULT_WORK_ORDER_DEF);
    expect(defs.length, '哨兵 0 / v1 / v2 三个版本都在').toBe(3);
    const byUnion = unionStates(defs.map(excludeSetOf));
    expect(byUnion).toContain('X');
    const unionIds = await idsUnderPredicate(db, byUnion);
    expect(unionIds, '🔴 并集 ⇒ 锁 v1 的老单被排掉（复现丢单）').not.toContain('wo-old-v1-x');

    // —— 红对照 B：只**读 live**（v2）⇒ 同一个洞
    const liveDef = await getWorkflowDefOrDefault(c, T, WO_ET, DEFAULT_WORK_ORDER_DEF);
    const liveOnlyIds = await idsUnderPredicate(db, excludeSetOf(liveDef));
    expect(liveOnlyIds, '🔴 live-only ⇒ 锁 v1 的老单被排掉（复现丢单）').not.toContain('wo-old-v1-x');

    // —— 真调产品函数：老单必须还在
    const ids = await listTimeoutOnly(db);
    expect(ids).toContain('wo-old-v1-x');
    expect(ids).not.toContain('wo-old-v1-done'); // done 是所有版本都认的完成态 ⇒ 交集仍排除
    expect(ids).not.toContain('wo-legacy-cancelled'); // cancelled 同上
    expect(ids).not.toContain('wo-future'); // 未过期
    // 诚实标注：wo-live-x 也会被带回（X 不在交集里）。这是交集的**已知代价**——
    // 宁可让一张在 v2 下其实已闭环的单多显示一次（人复核关闭），也不让 v1 老单静默消失。
    expect(ids).toEqual(['wo-live-assigned', 'wo-live-x', 'wo-old-v1-x']);
  });

  it('夹具自检：两种错法确实给出**不同**结果（否则本节的 Green 没有说服力）', async () => {
    const db = await freshMultiVersionDb();
    const c = asClient(db);
    await seedOrder(db, 'wo-old-v1-x', 'X', { defVersion: 1, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-old-v1-done', 'done', { defVersion: 1, dueOffsetMin: -60 });

    const defs = await getDefsAcrossAllVersions(c, T, WO_ET, 'work_orders', DEFAULT_WORK_ORDER_DEF);
    const wrongUnion = await idsUnderPredicate(db, unionStates(defs.map(excludeSetOf)));
    const rightIds = await listTimeoutOnly(db);
    expect(wrongUnion, '错法（并集）把老单整个漏掉').not.toContain('wo-old-v1-x');
    expect(rightIds, '正确实现把老单留下').toContain('wo-old-v1-x');
    // 二者差异必须是**非空且正好差这张老单**（不是整体都乱了）
    expect(rightIds.filter((x) => !wrongUnion.includes(x)).sort()).toEqual(['wo-old-v1-x']);
  });
});

// ============================================================
// ③ 交集为空时保守：`<> ALL('{}')` 恒真 ⇒ 所有过期单都返回
// ============================================================

/**
 * v1（旧，落 history）：**每个状态都有出边**（含 cancelled 都可重开）⇒
 *   terminalStates(v1) = [] 且无显式 doneStates ⇒ 该版本对排除集的**贡献为空集**。
 *   （现实形态：老流程把所有状态都配了可回退边，例如「已取消还能重新打开」。）
 * v2（live）：正常有终态 done / cancelled。
 *
 * ⇒ 交集 = [] ⇒ `status <> ALL('{}'::text[])` 恒真 ⇒ **所有过期单都返回**
 *   （连 completed 也回来）。这正是「空集 = 不排除任何状态 = 保守侧」的落地。
 *   若实现错用并集或只读 live ⇒ completed / cancelled 被排除 ⇒ 结果不同 ⇒ 本节有牙。
 */
const DEF_CYCLE_V1: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'X', 'cancelled'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'X', event: 'to_x' },
    { from: 'X', to: 'draft', event: 'cycle_back' },
    { from: 'cancelled', to: 'draft', event: 'reopen' }, // ← 连 cancelled 都有出边
  ] as any,
  config: {},
} as WorkflowDef;

const DEF_HAS_TERMINAL_V2: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'done'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'done', event: 'finish' },
  ] as any,
  config: {},
} as WorkflowDef;

async function freshEmptyIntersectionDb(): Promise<PGlite> {
  const db = await freshDb();
  await putHistory(db, 1, DEF_CYCLE_V1);
  await setLive(db, DEF_HAS_TERMINAL_V2, 2);
  return db;
}

describe('③ 交集为空 ⇒ 保守（不排除任何状态，绝不静默清空）', () => {
  it('🔴 穿透：连 completed / cancelled 的过期单都要回来（空排除集 = 全部保留）', async () => {
    const db = await freshEmptyIntersectionDb();
    const c = asClient(db);
    await seedOrder(db, 'wo-open-v1', 'assigned', { defVersion: 1, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-open-v2', 'assigned', { defVersion: 2, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-done-v2', 'done', { defVersion: 2, dueOffsetMin: -120 });
    await seedOrder(db, 'wo-cancelled-v1', 'cancelled', { defVersion: 1, dueOffsetMin: -30 });
    await seedOrder(db, 'wo-future', 'assigned', { defVersion: 2, dueOffsetMin: 60 });

    // —— 夹具自检：v1 的排除集贡献真的是空集（不是因为我们写错了 states）
    const defs = await getDefsAcrossAllVersions(c, T, WO_ET, 'work_orders', DEFAULT_WORK_ORDER_DEF);
    const perVersion = defs.map(excludeSetOf);
    const v1Idx = perVersion.findIndex((s) => s.length === 0);
    expect(v1Idx, '必须存在至少一个版本贡献空集').toBeGreaterThanOrEqual(0);
    expect(perVersion.some((s) => s.length > 0), '且另一个版本贡献非空集（否则两版皆空，本例无判别力）').toBe(true);

    // —— 红对照 A：并集 ⇒ completed/cancelled 被排除 ⇒ 结果变小
    const unionIds = await idsUnderPredicate(db, unionStates(perVersion));
    expect(unionIds).not.toContain('wo-done-v2');
    expect(unionIds).not.toContain('wo-cancelled-v1');

    // —— 红对照 B：只读 live ⇒ 同上
    const liveDef = await getWorkflowDefOrDefault(c, T, WO_ET, DEFAULT_WORK_ORDER_DEF);
    const liveOnlyIds = await idsUnderPredicate(db, excludeSetOf(liveDef));
    expect(liveOnlyIds).not.toContain('wo-done-v2');

    // —— 真调产品函数：空交集 ⇒ 一个都不排除 ⇒ 全部过期单回来
    const ids = await listTimeoutOnly(db);
    expect(ids).toContain('wo-done-v2');
    expect(ids).toContain('wo-cancelled-v1');
    expect(ids).toContain('wo-open-v1');
    expect(ids).toContain('wo-open-v2');
    expect(ids).not.toContain('wo-future'); // 过期判定依然有效：这条不能被"空交集"顺手放过
    expect(ids).toEqual(['wo-cancelled-v1', 'wo-done-v2', 'wo-open-v1', 'wo-open-v2']);
  });
});
