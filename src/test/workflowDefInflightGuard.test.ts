// workflowDefInflightGuard.test.ts —— T1-A：保存流程定义的「三场景在途单防呆硬闸」。
//
// 【背景：为什么要有这个文件】
//   流程定义存在 workflow_def.def（jsonb），客户在后台可改。改坏会让**在途单走不下去**，
//   且日志无报错（静默失败）。V3-D4 已经有了一道硬闸：删掉有在途单的状态 ⇒ 409。
//   但它只覆盖「删状态」一个场景，以下三个场景**完全不拦**：
//     ① 删 transition 边      —— 在途单当前状态再也走不到下一个状态
//     ② 收紧 allowedRoles     —— 原本能操作的人被踢掉
//     ③ 新增 requiredFields   —— 在途单缺这个字段，提交必失败
//   本文件把这三道闸钉死。
//
// 【为什么用 PGlite 真库，桩不行】
//   与 `x5InflightGuard.pglite.test.ts` 同款理由：闸拦不拦，取决于
//   `countInflightByStates`（workflowDef.ts）**真去哪张表数了多少行**。
//   桩只会按我写的 SQL 文本回一个数字 = 我自己编答案 ⇒ 断言恒绿、毫无意义。
//
// 【定点：运送 transport_task → transport_order】
//   ENTITY_STATE_TABLE（workflowDef.ts:232）把 transport_task 映射到原生表 transport_order；
//   经 transportAdapter 建单/流转，行的落点与清点面同源 ⇒ 数得到。
//
// 【防"空断言恒绿"的三条自检】
//   · 每个红用例都必须经历「实现前红 → 实现后绿」（见交付记录里的红→绿原文）；
//   · 每个红用例都做过**变异验证**（故意改坏实现/传错参数 ⇒ 必须转红）；
//   · 绿用例不是"没在途单所以什么都不跑"，而是**真的走到了闸口、清点数为 0 才放行**——
//     为此每个绿用例都把单停在别的态（pending），让 `from` 态清点结果确实是 0。
//
// 【转红时的判断顺序】
//   ① 先看「绿用例」红不红：绿用例红 ⇒ 闸误伤了（判定面扩太大），先收窄判定；
//   ② 绿用例绿、红用例红 ⇒ 闸失效（实现被摘/传参错），修实现；
//   ③ 逃生口用例红 ⇒ allowInflightLoss 语义被改坏，审批流会卡死；
//   **不许靠改断言让它绿**。
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import type { AuthLocals } from '../middleware/auth.js';
import type { FlowProxyCtx } from '../engine/flowProxy.js';
import { transportAdapter } from '../routes/flowAdapters/transportAdapter.js';
import { saveWorkflowDef } from '../engine/workflowDef.js';
import { TRANSPORT_DEF } from '../engine/themes.js';
import type { WorkflowDef } from '../engine/stateMachine.js';

const ROOT = join(__dirname, '..', '..');
const TENANT = 't-ifg';

/** 取迁移文件里某张表的 CREATE TABLE 段（到 `\n);` 为止）：用真实建表口径，不自己另写一份。 */
function createTableBlock(file: string, table: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`迁移 ${file} 里找不到 ${table} 的建表语句（护栏已失效，请同步本测试）`);
  const end = text.indexOf('\n);', start);
  // 必须把收尾的 '\n);' 一起切进来——只切到 end 会拿到一条没有右括号的 CREATE TABLE。
  return text.slice(start, end < 0 ? text.length : end + 3);
}

/** 剥掉整行的 `--` 注释（不做引号内特判：迁移注释只在行首，够用且不会误伤字符串）。 */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/**
 * 取迁移文件里某张表的全部 ALTER 语句（按 `;` 切分，保留以 `ALTER TABLE <table>` 开头的段）。
 * 建表迁移只给"首版列"，后续列分散在 037/041/076/101 里 ⇒ 只建首版表会让 INSERT 报
 * "column does not exist"，那是夹具的锅不是产品的锅。
 */
function alterBlocksFor(file: string, table: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  return text
    .split(';')
    // 必须先剥掉 `--` 注释再判定：按 ';' 切分后下一段常常以前一条语句的行尾注释开头，
    // 不剥注释就一条 ALTER 都匹配不到 ⇒ 表现为"列不存在"这种看起来像产品问题的假红。
    .map((s) => stripSqlComments(s).trim())
    .filter((s) => s.startsWith(`ALTER TABLE ${table}`))
    .map((s) => `${s};`);
}

/** 真建库：运送 + 通用通道 + 状态图 + 事件 + 字典，并补齐后续迁移加的列。 */
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('034_emergency_transport.sql', 'transport_order'));
  await db.exec(createTableBlock('034_emergency_transport.sql', 'transport_track_point'));
  for (const sql of alterBlocksFor('037_transport_feedback_granularity.sql', 'transport_order')) await db.exec(sql);
  for (const sql of alterBlocksFor('041_transport_workorder_link.sql', 'transport_order')) await db.exec(sql);
  for (const sql of alterBlocksFor('076_transport_sla.sql', 'transport_order')) await db.exec(sql);
  for (const sql of alterBlocksFor('052_transport_track_photo.sql', 'transport_track_point')) await db.exec(sql);
  await db.exec(createTableBlock('030_business_flow.sql', 'business_flow_tasks'));
  await db.exec(createTableBlock('022_workflow_def.sql', 'workflow_def'));
  for (const sql of alterBlocksFor('101_config_actor_and_version.sql', 'workflow_def')) await db.exec(sql);
  await db.exec(createTableBlock('047_basic_data_consolidate.sql', 'workflow_def_history'));
  await db.exec(createTableBlock('020_domain_event.sql', 'domain_event'));
  // 缺这两张表 saveWorkflowDef 会打一条"状态名落租户覆盖字典失败"的 stderr（流程照样生效，
  // 但噪声会让人误以为保存失败）——生产上必然存在，夹具补齐。
  await db.exec(createTableBlock('073_label_dict.sql', 'label_dict'));
  await db.exec(createTableBlock('098_label_dict_tenant.sql', 'label_dict_tenant'));
  for (const sql of alterBlocksFor('101_config_actor_and_version.sql', 'label_dict_tenant')) await db.exec(sql);
  await db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_label_dict_tenant_tsk ON label_dict_tenant (tenant_id, scope, key)`,
  );
  return db;
}

function authFor(): AuthLocals {
  return { tenantId: TENANT, requestId: 'rid-ifg', role: 'admin', userId: 'u-admin', username: 'admin', authMode: 'prod' };
}

function ctxFor(db: PGlite): FlowProxyCtx {
  return {
    client: db as unknown as PoolClient,
    tenantId: TENANT,
    entityType: 'transport_task',
    auth: authFor(),
    actor: 'u-admin',
  };
}

// ── 三个"改坏"的 def：都只动一条边 assigned --receive--> transporting ────────────
// 状态集合一字不动 ⇒ 不会触发既有的「删态硬闸」，从而**隔离出**本次要补的三道闸。
// （若状态也删了，删态硬闸会先抛，本文件的断言就验不到新闸了。）

function mapReceiveEdge(fn: (t: (typeof TRANSPORT_DEF.transitions)[number]) => (typeof TRANSPORT_DEF.transitions)[number] | null): WorkflowDef {
  const out: (typeof TRANSPORT_DEF.transitions)[number][] = [];
  for (const t of TRANSPORT_DEF.transitions) {
    const isReceive = t.from === 'assigned' && t.to === 'transporting' && t.event === 'receive';
    const mapped = isReceive ? fn(t) : t;
    if (mapped) out.push(mapped);
  }
  return { ...TRANSPORT_DEF, states: [...TRANSPORT_DEF.states], transitions: out };
}

/** 场景①：删掉 assigned --receive--> transporting 这条边。 */
function defDropReceiveEdge(): WorkflowDef {
  return mapReceiveEdge(() => null);
}

/** 场景②：收紧 allowedRoles —— ['admin','worker'] ⇒ ['admin']（把真正干活的 worker 踢掉）。 */
function defTightenReceiveRoles(): WorkflowDef {
  return mapReceiveEdge((t) => ({ ...t, allowedRoles: ['admin'] }));
}

/** 场景③：新增 requiredFields —— receive 边要求 receive_note（存量单没有这个字段）。 */
function defAddReceiveRequired(): WorkflowDef {
  return mapReceiveEdge((t) => ({ ...t, requiredFields: ['receive_note'] }));
}

/** 落一份旧 def（让 saveWorkflowDef 有"旧 def"可比；首存无旧 def ⇒ 本就不该拦）。 */
async function seedDef(db: PGlite): Promise<void> {
  await saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', TRANSPORT_DEF, {
    operator: 'ifg-tester',
    reason: 'seed',
  });
}

/**
 * 落一张在途单到指定状态。
 *  · 'pending'  = 建单后的初态（**不在**被改那条边的 from 态上 ⇒ 三道闸都应当放行）
 *  · 'assigned' = 经真实 dispatch 边推进过去（**正在**被改那条边的 from 态上 ⇒ 三道闸都应当拦）
 */
async function seedOrderAt(db: PGlite, state: 'pending' | 'assigned'): Promise<string> {
  const created = await transportAdapter.create(ctxFor(db), { title: '运送标本到 3 楼检验科' });
  const id = String(created.id);
  expect(id, '夹具：建单应返回行 id').toBeTruthy();
  expect(String(created.status), '夹具：建单后应在初态 pending').toBe('pending');
  if (state === 'assigned') {
    const moved = await transportAdapter.transition(ctxFor(db), id, {
      event: 'dispatch',
      data: { assignee: 'w-1' }, // dispatch 边的 requiredFields 要求 assignee
    });
    expect(String(moved.status), '夹具：推进后应已在 assigned（= 被改边的 from 态）').toBe('assigned');
  }
  return id;
}

/** 保存 def，返回抛出的错误（没抛返回 null）——不吞异常，便于断言 code/status/message。 */
async function saveExpectingError(db: PGlite, def: WorkflowDef): Promise<any> {
  return saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', def, {
    operator: 'ifg-tester',
    reason: 'mutate',
  })
    .then(() => null)
    .catch((e: any) => e);
}

/** 断言"确实被 409 INFLIGHT_STATE_LOSS 拦下"，并校验 message 说的是哪个场景。 */
function expectBlocked(err: any, scenarioHint: RegExp, why: string): void {
  expect(err, why).toBeTruthy();
  expect(String(err?.code ?? ''), `${why}（错误码）`).toBe('INFLIGHT_STATE_LOSS');
  expect(Number(err?.status ?? 0), `${why}（HTTP 状态）`).toBe(409);
  expect(String(err?.message), `${why}（message 必须说清是哪个场景，运营要看懂）`).toMatch(scenarioHint);
}

describe('T1-A 保存流程定义·在途单防呆硬闸（删边 / 收紧角色 / 新增必填）', () => {
  // ── 场景①：删 transition 边 ────────────────────────────────────────────────
  it('①-红：删掉 assigned→transporting 的流转边 + assigned 上有在途单 ⇒ 409 拦下', async () => {
    const db = await freshDb();
    await seedDef(db);
    await seedOrderAt(db, 'assigned');

    const err = await saveExpectingError(db, defDropReceiveEdge());
    expectBlocked(err, /流转边/, '删边会让这批在途单永远走不到下一态，必须拦；不拦=静默失败');
    expect(String(err?.message), 'message 要能指出是哪个状态上的单被卡住').toMatch(/assigned/);
  });

  it('①-绿：同样删边，但 assigned 上无在途单（单还在 pending）⇒ 放行，不误伤', async () => {
    const db = await freshDb();
    await seedDef(db);
    await seedOrderAt(db, 'pending');

    await expect(
      saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', defDropReceiveEdge(), {
        operator: 'ifg-tester',
        reason: 'drop receive edge, no inflight on assigned',
      }),
    ).resolves.toBeUndefined();
  });

  // ── 场景②：收紧 allowedRoles ───────────────────────────────────────────────
  it('②-红：receive 边 allowedRoles 踢掉 worker + assigned 上有在途单 ⇒ 409 拦下', async () => {
    const db = await freshDb();
    await seedDef(db);
    await seedOrderAt(db, 'assigned');

    const err = await saveExpectingError(db, defTightenReceiveRoles());
    expectBlocked(err, /角色/, '收紧 allowedRoles 会让原本能操作的人被踢掉，必须拦');
    expect(String(err?.message), 'message 要能指出被踢掉的是哪个角色').toMatch(/worker/);
  });

  it('②-绿：同样收紧角色，但 assigned 上无在途单 ⇒ 放行，不误伤', async () => {
    const db = await freshDb();
    await seedDef(db);
    await seedOrderAt(db, 'pending');

    await expect(
      saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', defTightenReceiveRoles(), {
        operator: 'ifg-tester',
        reason: 'tighten roles, no inflight on assigned',
      }),
    ).resolves.toBeUndefined();
  });

  // ── 场景③：新增 requiredFields ─────────────────────────────────────────────
  it('③-红：receive 边新增必填 receive_note + assigned 上有在途单 ⇒ 409 拦下', async () => {
    const db = await freshDb();
    await seedDef(db);
    await seedOrderAt(db, 'assigned');

    const err = await saveExpectingError(db, defAddReceiveRequired());
    expectBlocked(err, /必填/, '新增 requiredFields 会让存量在途单提交必失败（缺字段），必须拦');
    expect(String(err?.message), 'message 要能指出新增的是哪个字段').toMatch(/receive_note/);
  });

  it('③-绿：同样新增必填，但 assigned 上无在途单 ⇒ 放行，不误伤', async () => {
    const db = await freshDb();
    await seedDef(db);
    await seedOrderAt(db, 'pending');

    await expect(
      saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', defAddReceiveRequired(), {
        operator: 'ifg-tester',
        reason: 'add required field, no inflight on assigned',
      }),
    ).resolves.toBeUndefined();
  });

  // ── 逃生口一致性：allowInflightLoss=true 时三个场景都能显式放行 ──────────────
  it('逃生口·删边：allowInflightLoss=true ⇒ 显式放行（与删态硬闸同一语义）', async () => {
    const db = await freshDb();
    await seedDef(db);
    await seedOrderAt(db, 'assigned');

    await expect(
      saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', defDropReceiveEdge(), {
        operator: 'ifg-tester',
        reason: 'drop receive edge with confirmation',
        allowInflightLoss: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('逃生口·收紧角色：allowInflightLoss=true ⇒ 显式放行', async () => {
    const db = await freshDb();
    await seedDef(db);
    await seedOrderAt(db, 'assigned');

    await expect(
      saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', defTightenReceiveRoles(), {
        operator: 'ifg-tester',
        reason: 'tighten roles with confirmation',
        allowInflightLoss: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('逃生口·新增必填：allowInflightLoss=true ⇒ 显式放行', async () => {
    const db = await freshDb();
    await seedDef(db);
    await seedOrderAt(db, 'assigned');

    await expect(
      saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', defAddReceiveRequired(), {
        operator: 'ifg-tester',
        reason: 'add required field with confirmation',
        allowInflightLoss: true,
      }),
    ).resolves.toBeUndefined();
  });
});
