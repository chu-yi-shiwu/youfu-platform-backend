// x5InflightGuard.pglite.test.ts —— T5 / S6c：X5「删态硬闸」在**真库**上的护栏。
//
// 【为什么必须用 PGlite 真库，桩不行】
//   要验的是"删掉一个还有在途单的状态时，硬闸会不会拦"。拦不拦取决于
//   `countInflightByStates`（`workflowDef.ts:238`）**真去哪张表数**。
//   用桩数不出东西——桩只会按我写的 text 匹配回一个数字，等于我自己编答案。
//   ⇒ 照 `migration101.pglite.test.ts` 的口径：真建库 → 真写行 → 真数 → 真抛。
//
// 【X5 危害本体（改前为什么会"静默失联"）】
//   `ENTITY_STATE_TABLE`（`workflowDef.ts:232-236`）：
//       transport_task → **transport_order**
//   即"运送在途单"的清点面是**原生表**。而 T5 之前 `/flow/transport_task` 建的行落在
//   `business_flow_tasks` ⇒ 硬闸去 `transport_order` 数 ⇒ **数出 0** ⇒ 不抛 409
//   ⇒ 管理员删掉那个状态，一批在途单从此永远 422 失联，**系统一声不吭**。
//   T5 把 `/flow` 的落点收口到 `transport_order` 后，清点面才真正盖住这批行。
//
// 【本文件钉的三件事】
//   ① /flow 建行 → 推进到非 initial 态 X → 保存一个删掉 X 的 def ⇒ **必须抛 409 INFLIGHT_STATE_LOSS**
//   ② 清点函数确实在 `transport_order` 上数到这批行（映射没走偏）
//   ③ V3-D4 逃生口 `allowInflightLoss` **仍可用**（T5 不许顺手把它弄坏）
//   ④ 反面记录：行若落在 `business_flow_tasks`（T5 前落点）⇒ 清点数出 0 ⇒ 不抛
//      —— 这条断言的是"旧落点会静默失联"这个**事实**，用来说明 ①为什么必须守住。
//      ⚠️ 它不是"期望行为"，是"危害取证"：若哪天映射改成也扫 business_flow_tasks，
//      这条会转红，那时应把它改成与 ① 同向的护栏，而不是删掉。
//
// 【转红时的判断顺序】
//   ① 先确认 ② 绿不绿：② 红 ⇒ 清点面走偏了，先修映射；
//   ② ② 绿而 ① 红 ⇒ 落点又分裂了（/flow 没真正写到 transport_order），修 T5 落点；
//   ③ ③ 红 ⇒ 逃生口被弄坏，改 def 的审批流会卡死；
//   **不许靠改断言让它绿**。
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import type { AuthLocals } from '../middleware/auth.js';
import type { FlowProxyCtx } from '../engine/flowProxy.js';
import { transportAdapter } from '../routes/flowAdapters/transportAdapter.js';
import { countInflightByStates, saveWorkflowDef } from '../engine/workflowDef.js';
import { TRANSPORT_DEF } from '../engine/themes.js';
import type { WorkflowDef } from '../engine/stateMachine.js';

const ROOT = join(__dirname, '..', '..');
const TENANT = 't-x5';

/** 取迁移文件里某张表的 CREATE TABLE 段（到 `\n);` 为止）：用真实建表口径，不自己另写一份。 */
function createTableBlock(file: string, table: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`迁移 ${file} 里找不到 ${table} 的建表语句（护栏已失效，请同步本测试）`);
  const end = text.indexOf('\n);', start);
  // 必须把收尾的 '\n);' 一起切进来——只切到 end 会拿到一条没有右括号的 CREATE TABLE。
  return text.slice(start, end < 0 ? text.length : end + 3);
}

/**
 * 取迁移文件里某张表的全部 ALTER 语句（按 `;` 切分，保留以 `ALTER TABLE <table>` 开头的段）。
 *
 * 为什么需要：建表迁移只给"首版列"，后续列（如 `transport_order.item_category`、`work_order_id`、
 * `sla_due_at`、`workflow_def.updated_by`）分散在 037/041/076/101 里。
 * **只建首版表 ⇒ 代码里的 INSERT 会报 column does not exist**，那是夹具的锅不是产品的锅。
 * 用迁移原文而不是自己手写列定义，避免"测试里另有一份表结构"。
 */
function alterBlocksFor(file: string, table: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  return text
    .split(';')
    // ⚠️ 必须先剥掉 `--` 注释行再判定：迁移里大量写法是"语句;  -- 注释"，
    //    按 ';' 切分后**下一段是以前一条语句的行尾注释开头**的（本仓库迁移是 CRLF，
    //    注释还常常单独占一行）⇒ 不剥注释就一条 ALTER 都匹配不到，
    //    表现为"列不存在"这种看起来像产品问题的假红。
    .map((s) => stripSqlComments(s).trim())
    .filter((s) => s.startsWith(`ALTER TABLE ${table}`))
    .map((s) => `${s};`);
}

/** 剥掉整行的 `--` 注释（不做引号内特判：迁移注释只在行首，够用且不会误伤字符串）。 */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** 真建库：只建本用例需要的表（运送 + 通用通道 + 状态图 + 事件 + 历史），并补齐后续迁移加的列。 */
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('034_emergency_transport.sql', 'transport_order'));
  await db.exec(createTableBlock('034_emergency_transport.sql', 'transport_track_point'));
  for (const sql of alterBlocksFor('037_transport_feedback_granularity.sql', 'transport_order')) await db.exec(sql);
  for (const sql of alterBlocksFor('041_transport_workorder_link.sql', 'transport_order')) await db.exec(sql);
  for (const sql of alterBlocksFor('076_transport_sla.sql', 'transport_order')) await db.exec(sql);
  for (const sql of alterBlocksFor('052_transport_track_photo.sql', 'transport_track_point')) await db.exec(sql);
  await db.exec(createTableBlock('030_business_flow.sql', 'business_flow_tasks'));
  // 🔴 worker（运送线 load 结算）：transitionOrder 在流转时会结算 worker.load（与工单线
  //    repo/ticket.ts:305-315 同口径）。本夹具要经 transportAdapter.transition 走 dispatch 边
  //    （带 carrier）⇒ 不建这张表会直接报 "relation worker does not exist" —— 那是**夹具
  //    脱节的锅**，不是产品的锅（生产上 worker 必然存在）。
  await db.exec(createTableBlock('001_init.sql', 'worker'));
  // 🔴 102（T1-B）：给 transport_order / business_flow_tasks 加 def_version 列。
  //    T1-B 批 2 起 createOrder 的 INSERT 带上了这一列；夹具不跟进这条迁移 ⇒ INSERT 直接报
  //    "column def_version does not exist" —— 那是**夹具脱节的锅**，不是产品的锅。
  //    （inspection_task 本夹具不建，故只补这两张表，不整篇 exec 102。）
  for (const sql of alterBlocksFor('102_inflight_def_version.sql', 'transport_order')) await db.exec(sql);
  for (const sql of alterBlocksFor('102_inflight_def_version.sql', 'business_flow_tasks')) await db.exec(sql);
  await db.exec(createTableBlock('022_workflow_def.sql', 'workflow_def'));
  for (const sql of alterBlocksFor('101_config_actor_and_version.sql', 'workflow_def')) await db.exec(sql);
  await db.exec(createTableBlock('047_basic_data_consolidate.sql', 'workflow_def_history'));
  await db.exec(createTableBlock('020_domain_event.sql', 'domain_event'));
  // 不建这张表，saveWorkflowDef 会打一条"状态名落租户覆盖字典失败"的 stderr
  // （流程照样生效，但噪声会让人误以为保存失败）——生产上这张表必然存在。
  await db.exec(createTableBlock('073_label_dict.sql', 'label_dict'));
  await db.exec(createTableBlock('098_label_dict_tenant.sql', 'label_dict_tenant'));
  for (const sql of alterBlocksFor('101_config_actor_and_version.sql', 'label_dict_tenant')) await db.exec(sql);
  // saveWorkflowDef 顺手把状态名写进租户字典（ON CONFLICT），缺这个唯一索引会打一条
  // stderr（流程照样生效）——为了不让噪声盖住真错误，补齐它。
  await db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_label_dict_tenant_tsk ON label_dict_tenant (tenant_id, scope, key)`,
  );
  return db;
}

function authFor(): AuthLocals {
  // admin：requireConfigRole / requireAssigneeOrConfig 均放行（本测不验守卫，守卫由
  // transportAdapter.map.test.ts 的 R4 两道 403 用例负责）
  return { tenantId: TENANT, requestId: 'rid-x5', role: 'admin', userId: 'u-admin', username: 'admin', authMode: 'prod' };
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

/** 一个"删掉 assigned 态"的新 def：连同引用它的边一起删，否则 validateWorkflowDef 先 422。 */
function defWithoutAssigned(): WorkflowDef {
  return {
    initial: TRANSPORT_DEF.initial,
    states: ['pending', 'transporting', 'done', 'exception', 'cancelled'],
    transitions: [
      { from: 'transporting', to: 'done', event: 'complete' },
      { from: 'transporting', to: 'exception', event: 'exception' },
    ],
    config: {},
  };
}

describe('T5/S6c X5 删态硬闸（PGlite 真库）', () => {
  it('🔴 /flow 建行 → 推进到非 initial 态 → 保存删掉该态的 def ⇒ 抛 409 INFLIGHT_STATE_LOSS', async () => {
    const db = await freshDb();

    // ① 先落一份状态图（让 saveWorkflowDef 有"旧 def"可比）
    await saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', TRANSPORT_DEF, {
      operator: 'x5-tester',
      reason: 'seed',
    });

    // ② 经 /flow 通道建行（S5 后落点是 transport_order）
    const created = await transportAdapter.create(ctxFor(db), { title: '送标本到 3 楼检验科' });
    expect(created.id, '建单应当返回行 id').toBeTruthy();

    // ③ 推进到非 initial 态（pending --dispatch--> assigned）
    const moved = await transportAdapter.transition(ctxFor(db), String(created.id), {
      event: 'dispatch',
      data: { assignee: 'w-1' }, // dispatch 的 requiredFields 要求 assignee
    });
    expect(String(moved.status), '应当已推进到 assigned').toBe('assigned');

    // ④ 保存一个删掉 assigned 的 def ⇒ 有一张在途单 ⇒ 必须 409，不能静默放行
    const err = await saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', defWithoutAssigned(), {
      operator: 'x5-tester',
      reason: 'drop assigned',
    }).catch((e: any) => e);

    expect(err, '删掉有在途单的状态必须被硬闸拦下；不拦 = 这批单永久 422 失联且无人知晓').toBeTruthy();
    expect(String(err?.code ?? '') + '/' + String(err?.status ?? ''), '错误码必须是 INFLIGHT_STATE_LOSS/409').toMatch(
      /INFLIGHT_STATE_LOSS|409/,
    );
    expect(String(err?.message)).toMatch(/assigned/);
  });

  it('对照·绿：清点函数确实在 transport_order 上数到这批在途单（映射没走偏）', async () => {
    const db = await freshDb();
    const created = await transportAdapter.create(ctxFor(db), { title: '送标本' });
    await transportAdapter.transition(ctxFor(db), String(created.id), {
      event: 'dispatch',
      data: { assignee: 'w-1' },
    });

    const hits = await countInflightByStates(db as unknown as PoolClient, TENANT, 'transport_task', ['assigned']);
    // 🔴 改前这里会是 0：行在 business_flow_tasks，清点面却在 transport_order
    expect(hits.total, 'ENTITY_STATE_TABLE 把 transport_task 映射到 transport_order，落点一致才数得到').toBe(1);
    expect(hits.byState['assigned']).toBe(1);
  });

  it('对照·绿：V3-D4 逃生口仍可用 —— 显式 allowInflightLoss 时不抛（T5 不许把它弄坏）', async () => {
    const db = await freshDb();
    await saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', TRANSPORT_DEF, {
      operator: 'x5-tester',
      reason: 'seed',
    });
    const created = await transportAdapter.create(ctxFor(db), { title: '送标本' });
    await transportAdapter.transition(ctxFor(db), String(created.id), {
      event: 'dispatch',
      data: { assignee: 'w-1' },
    });

    await expect(
      saveWorkflowDef(db as unknown as PoolClient, TENANT, 'transport_task', defWithoutAssigned(), {
        operator: 'x5-tester',
        reason: 'drop assigned with confirmation',
        allowInflightLoss: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('危害取证·绿：行若仍落在 business_flow_tasks（T5 前落点）⇒ 清点数出 0 ⇒ 不抛 409', async () => {
    // ⚠️ 这条不是"期望行为"，是**危害取证**：它把"旧落点会让在途单静默失联"这个事实
    //    钉在测试里，解释第 1 条为什么必须守住。
    //    若将来映射改成也扫 business_flow_tasks，本条会转红 —— 那时应当把它改成
    //    与第 1 条同向的护栏，**而不是删掉它**。
    const db = await freshDb();
    await db.query(
      `INSERT INTO business_flow_tasks (tenant_id, entity_type, title, status, data)
       VALUES ($1,$2,$3,$4,$5)`,
      [TENANT, 'transport_task', '旧落点的在途单', 'assigned', JSON.stringify({})],
    );

    const hits = await countInflightByStates(db as unknown as PoolClient, TENANT, 'transport_task', ['assigned']);
    expect(
      hits.total,
      '映射只扫 transport_order ⇒ 落在 business_flow_tasks 的行数不到 ⇒ 删态时不会被拦 ⇒ 静默失联',
    ).toBe(0);
  });
});
