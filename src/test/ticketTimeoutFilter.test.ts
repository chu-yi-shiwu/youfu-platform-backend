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
import { getDefsAcrossAllVersions, unionStates, intersectStates, getWorkflowDefOrDefault } from '../engine/workflowDef.js';
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
 * @param opts.createdAtMin 建单时刻偏移量（负 = 更早）。分页用例必须显式给，
 *   否则所有行 created_at 都落在同一瞬间，`ORDER BY created_at DESC` 在并列时间戳上
 *   **顺序不确定** ⇒ 分页断言会随机翻绿翻红（假 flaky，不是真判别力）。
 */
async function seedOrder(
  db: PGlite,
  id: string,
  status: string,
  opts: { defVersion?: number; dueOffsetMin?: number; department?: string; createdAtMin?: number } = {},
): Promise<void> {
  const due = opts.dueOffsetMin;
  const dueSql = due === undefined ? 'NULL' : `now() + (${Number(due) || 0} || ' minutes')::interval`;
  const createdSql = `now() + (${Number(opts.createdAtMin) || 0} || ' minutes')::interval`;
  await db.query(
    `INSERT INTO work_orders (id, tenant_id, business_type, status, order_no, def_version, sla_due_at, department, created_at)
     VALUES ($1,$2,'repair',$3,$4,$5,${dueSql},$6,${createdSql})`,
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

/**
 * 真调 list() 拿**单页**：items 保持 `ORDER BY created_at DESC` 的原序（分页用例要看的就是这个序），
 * total 是全局总数。
 */
async function listPage(
  db: PGlite,
  limit: number,
  offset: number,
  extra: Record<string, unknown> = {},
): Promise<{ items: string[]; total: number }> {
  const res = await list(asClient(db), T, { timeoutOnly: true, limit, offset, ...extra } as never);
  return { items: res.items.map((r) => r.id), total: res.total };
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

    // —— 真调产品函数：老单必须在，且**只**留真正未闭环的
    const ids = await listTimeoutOnly(db);
    expect(ids, 'X 在 v1 里是活跃态 ⇒ 这张老单是真的没闭环').toContain('wo-old-v1-x');
    expect(ids, 'X 在 v2 里已是终态 ⇒ 这张锁 v2 的单已闭环，不该再报超时').not.toContain('wo-live-x');
    expect(ids).not.toContain('wo-old-v1-done');
    expect(ids).not.toContain('wo-legacy-cancelled');
    expect(ids).not.toContain('wo-future'); // 未过期
    expect(ids).toEqual(['wo-live-assigned', 'wo-old-v1-x']);
  });

  it('🔴 不多显示：wo-live-x（X 在 v2 已终态）必须消失 —— 这正是旧交集口径的误报', async () => {
    const db = await freshMultiVersionDb();
    const c = asClient(db);
    await seedOrder(db, 'wo-old-v1-x', 'X', { defVersion: 1, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-live-x', 'X', { defVersion: 2, dueOffsetMin: -60 });

    // —— 红对照：旧口径（各版交集 = ['done','cancelled']，不含 X）会把两张 X 单都放行
    const defs = await getDefsAcrossAllVersions(c, T, WO_ET, 'work_orders', DEFAULT_WORK_ORDER_DEF);
    const byIntersection = intersectStates(defs.map(excludeSetOf));
    expect(byIntersection, '旧口径交集里确实不含 X（否则本例无判别力）').not.toContain('X');
    const oldIds = await idsUnderPredicate(db, byIntersection);
    expect(oldIds, '🔴 旧口径把已闭环的 wo-live-x 也报成超时').toContain('wo-live-x');

    // —— 新口径：逐单按自己锁定的版本判定 ⇒ 同一个 X，两张单判词相反
    const ids = await listTimeoutOnly(db);
    expect(ids).toEqual(['wo-old-v1-x']);
  });
});

// ============================================================
// ③ 同一个状态在两个版本里判词相反（旧交集口径必然误报）
// ============================================================

/**
 * v1（旧，落 history）：终态 = done（assigned→done，done 无出边）。
 * v2（live）：租户改名，终态 = finished；**done 降级为中间态**（done→finished，有出边）。
 *
 * ⇒ 两版终态集的交集只剩机制态 cancelled ⇒ 旧口径下 `done` / `finished` **都不被排除**
 *   ⇒ 两张早已闭环的单（`wo-v1-done`、`wo-v2-finished`）被误报成超时。
 *   逐单判定下：同样是 `status='done'`，锁 v1 的排除、锁 v2 的保留 ——
 *   **这个对偶是任何"全局一套排除集"的口径都做不出来的**，是本节的判别力核心。
 */
const DEF_V1_DONE_TERMINAL: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'done'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'done', event: 'finish' },
  ] as any,
  config: {},
} as WorkflowDef;

const DEF_V2_FINISHED_TERMINAL: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'done', 'finished'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'done', event: 'finish' },
    { from: 'done', to: 'finished', event: 'archive' }, // ← done 降级为中间态
  ] as any,
  config: {},
} as WorkflowDef;

/** 真库：live = v2(version=2)，history 有 v1。 */
async function freshDisjointDb(): Promise<PGlite> {
  const db = await freshDb();
  await putHistory(db, 1, DEF_V1_DONE_TERMINAL);
  await setLive(db, DEF_V2_FINISHED_TERMINAL, 2);
  return db;
}

describe('③ 逐单判定：同一个 status 在两个版本里判词必须相反', () => {
  it('🔴 对偶：锁 v1 的 done 不出现，锁 v2 的 done 必须出现（旧交集口径两者都放行）', async () => {
    const db = await freshDisjointDb();
    const c = asClient(db);
    await seedOrder(db, 'wo-v1-done', 'done', { defVersion: 1, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-v2-done', 'done', { defVersion: 2, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-v2-finished', 'finished', { defVersion: 2, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-v1-assigned', 'assigned', { defVersion: 1, dueOffsetMin: -60 });
    await seedOrder(db, 'wo-v2-assigned', 'assigned', { defVersion: 2, dueOffsetMin: -60 });

    // —— 夹具自检：两版终态集的交集只剩机制态 cancelled（不是我们写错 states 才空的）
    const defs = await getDefsAcrossAllVersions(c, T, WO_ET, 'work_orders', DEFAULT_WORK_ORDER_DEF);
    const byIntersection = intersectStates(defs.map(excludeSetOf));
    expect(byIntersection.sort(), '旧口径交集只剩机制态 cancelled').toEqual(['cancelled']);

    // —— 红对照：旧口径（全局一套排除集 = ['cancelled']）把这 5 张全放行 ⇒ 两张已闭环的被误报
    const oldIds = await idsUnderPredicate(db, byIntersection);
    expect(oldIds, '🔴 旧口径把 wo-v1-done（在 v1 里已闭环）误报成超时').toContain('wo-v1-done');
    expect(oldIds, '🔴 旧口径把 wo-v2-finished（在 v2 里已闭环）误报成超时').toContain('wo-v2-finished');
    expect(oldIds.length).toBe(5);

    // —— 真调产品函数：逐单判定 ⇒ 同是 'done'，锁 v1 排除、锁 v2 保留
    const ids = await listTimeoutOnly(db);
    expect(ids).not.toContain('wo-v1-done');
    expect(ids).toContain('wo-v2-done');
    expect(ids).not.toContain('wo-v2-finished');
    expect(ids).toContain('wo-v1-assigned');
    expect(ids).toContain('wo-v2-assigned');
    expect(ids).toEqual(['wo-v1-assigned', 'wo-v2-assigned', 'wo-v2-done']);
  });
});

// ============================================================
// ④ 分页：判定必须在 SQL 里完成，不能下沉到 JS（否则分页必坏）
// ============================================================

/**
 * 【为什么必须有这一节】
 *   list() 的分页全在 SQL 侧：`total` = `COUNT(*) WHERE <同一 where>`，
 *   items = 同一 where + `ORDER BY created_at DESC LIMIT n OFFSET m`。
 *   若把逐单判定做成「SQL 粗筛 → JS 逐行精筛」，两件事同时坏：
 *     ① `total` 是粗筛口径、items 是精筛口径 ⇒ 总数虚高，前端"共 N 条"说谎；
 *     ② LIMIT 在精筛**之前**截断 ⇒ 每页行数随机变少（本例页 1 会只剩 0 条），
 *        而被 SQL 漏进来的行把真正该显示的行挤到后面几页 ⇒ 用户翻到的前几页是错的。
 *   本节的断言专门钉这两条，且用**页面上真实返回的条数**判定，不是只看内容。
 */
describe('④ 分页：timeoutOnly 的判定必须发生在 LIMIT 之前', () => {
  it('🔴 total 必须是逐单精确口径，且每页都必须满页、不重不漏', async () => {
    const db = await freshDisjointDb();
    const c = asClient(db);
    // created_at 显式错开（见 seedOrder 注释）：并列时间戳会让 ORDER BY 不确定
    await seedOrder(db, 'wo-v1-done', 'done', { defVersion: 1, dueOffsetMin: -60, createdAtMin: -1 });
    await seedOrder(db, 'wo-v2-finished', 'finished', { defVersion: 2, dueOffsetMin: -60, createdAtMin: -2 });
    await seedOrder(db, 'wo-v1-assigned', 'assigned', { defVersion: 1, dueOffsetMin: -60, createdAtMin: -3 });
    await seedOrder(db, 'wo-v2-done', 'done', { defVersion: 2, dueOffsetMin: -60, createdAtMin: -4 });
    await seedOrder(db, 'wo-v2-assigned', 'assigned', { defVersion: 2, dueOffsetMin: -60, createdAtMin: -5 });

    // —— 红对照：粗筛口径会算成 5 条（两张其实已闭环的也被算进总数）
    const defs = await getDefsAcrossAllVersions(c, T, WO_ET, 'work_orders', DEFAULT_WORK_ORDER_DEF);
    const coarse = await idsUnderPredicate(db, intersectStates(defs.map(excludeSetOf)));
    expect(coarse.length, '🔴 粗筛口径总数 = 5').toBe(5);

    // ① total 必须是精筛口径 3，不是粗筛口径 5
    const p1 = await listPage(db, 2, 0);
    expect(p1.total, 'total 必须是逐单精确口径，不是粗筛口径').toBe(3);

    // ② 页 1 必须满 2 条，且正好是最新的两条**真正未闭环**的单
    //    （JS 精筛会在 LIMIT 之后才筛 ⇒ 页 1 只剩 0 条，这条断言立刻变红）
    expect(p1.items.length, '页 1 必须满页：判定若下沉到 JS，这里会不满页').toBe(2);
    expect(p1.items).toEqual(['wo-v1-assigned', 'wo-v2-done']);

    // ③ 后续页不重不漏；最后一页之后必须是空的
    const p2 = await listPage(db, 2, 2);
    expect(p2.items).toEqual(['wo-v2-assigned']);
    expect(p2.total).toBe(3);
    const p3 = await listPage(db, 2, 4);
    expect(p3.items, '翻过最后一页必须是空的（total 若虚高，这里会多出空页）').toEqual([]);

    const all = [...p1.items, ...p2.items].sort();
    expect(all, '分页拼起来必须正好等于精确全集，不重不漏').toEqual(['wo-v1-assigned', 'wo-v2-assigned', 'wo-v2-done']);
  });
});
