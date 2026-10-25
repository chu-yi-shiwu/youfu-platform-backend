// workflowDefAutoTuneNoFalsePositive.test.ts —— T1-A 第二批：auto-tune 飞轮**不得**被在途单新闸误伤。
//
// 【为什么加这条】
//   services/optimizer.ts 的 applyWorkflowOptimizations 走的是同一个 saveWorkflowDef，
//   且**从不传** allowInflightLoss（optimizer.ts:507 / :519）——它没有任何逃生口。
//   今天 applyRecommendationToDef（:416）只做**纯加法**：加状态、加边，原边用 `{...t}` 整份复制，
//   既不删边、也不动 allowedRoles / requiredFields ⇒ 三场景 diff 恒空 ⇒ 新闸不触发。
//
//   但"不触发"目前只是**读代码得出的结论**，没有被测试钉住。风险在将来：
//   谁给 optimizer 加一条"删边/收紧角色"类推荐（比如"合并多余复核边""收紧超时边角色"），
//   飞轮就会在某个夜里静默 409 —— 无人值守、无人知道，建议一直保持 pending，
//   看上去像"模型没产出"，实际是新闸把自动优化整条链路掐死了。
//   这条测试把「纯加法 ⇒ 不触发」钉死：一旦推荐开始产生非加法 diff，这里立刻红。
//
// 【防"空断言恒绿"的两道自检】
//   ① `expect(res.applied).toBe(1)` —— 证明推荐真的落库生效了（不是被守卫跳过的假绿）；
//   ② **同库对照组**：同一份库、同一批在途单，手工做一次删边 save ⇒ 必须 409。
//      没有对照组的话，"auto-tune 没被拦"可能只是因为夹具里根本没有在途单。
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { saveWorkflowDef } from '../engine/workflowDef.js';
import { applyWorkflowOptimizations } from '../services/optimizer.js';
import type { WorkflowDef } from '../engine/stateMachine.js';

const ROOT = join(__dirname, '..', '..');
const TENANT = 't-autotune';
const ENTITY = 'transport_task'; // ENTITY_STATE_TABLE → transport_order（真实清点面）

/** 取迁移文件里某张表的 CREATE TABLE 段（到 `\n);` 为止）：用真实建表口径，不自己另写一份。 */
function createTableBlock(file: string, table: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`迁移 ${file} 里找不到 ${table} 的建表语句（护栏已失效，请同步本测试）`);
  const end = text.indexOf('\n);', start);
  return text.slice(start, end < 0 ? text.length : end + 3);
}

/** 剥掉整行的 `--` 注释；按 ';' 切分后下一段常以前一条语句的行尾注释开头，不剥就匹配不到。 */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** 取迁移文件里某张表的全部 ALTER 语句（建表迁移只给首版列，后续列分散在其它迁移里）。 */
function alterBlocksFor(file: string, table: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  return text
    .split(';')
    .map((s) => stripSqlComments(s).trim())
    .filter((s) => s.startsWith(`ALTER TABLE ${table}`))
    .map((s) => `${s};`);
}

/** 真建库：运送单 + 状态图 + 历史 + 优化建议表 + 状态名字典。 */
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('034_emergency_transport.sql', 'transport_order'));
  for (const sql of alterBlocksFor('037_transport_feedback_granularity.sql', 'transport_order')) await db.exec(sql);
  for (const sql of alterBlocksFor('041_transport_workorder_link.sql', 'transport_order')) await db.exec(sql);
  for (const sql of alterBlocksFor('076_transport_sla.sql', 'transport_order')) await db.exec(sql);
  await db.exec(createTableBlock('022_workflow_def.sql', 'workflow_def'));
  for (const sql of alterBlocksFor('101_config_actor_and_version.sql', 'workflow_def')) await db.exec(sql);
  await db.exec(createTableBlock('047_basic_data_consolidate.sql', 'workflow_def_history'));
  await db.exec(createTableBlock('021_optimization.sql', 'optimization_feedback'));
  for (const sql of alterBlocksFor('063_optimization_feedback_no_match.sql', 'optimization_feedback')) await db.exec(sql);
  await db.exec(createTableBlock('020_domain_event.sql', 'domain_event'));
  await db.exec(createTableBlock('073_label_dict.sql', 'label_dict'));
  await db.exec(createTableBlock('098_label_dict_tenant.sql', 'label_dict_tenant'));
  for (const sql of alterBlocksFor('101_config_actor_and_version.sql', 'label_dict_tenant')) await db.exec(sql);
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_label_dict_tenant_tsk ON label_dict_tenant (tenant_id, scope, key)`);
  return db;
}

/**
 * 夹具用的状态图：一条四段主链（pending→assigned→transporting→processing→done）。
 * 刻意带 'processing' —— :auto_escalate 推荐的前置条件就是该租户流程里存在 processing，
 * 不带它 ⇒ 推荐只改 config、一条边都不加 ⇒ applied 仍是 1，但"纯加法不被拦"就没被真正验到。
 */
const BASE_DEF: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'assigned', 'transporting', 'processing', 'done'],
  transitions: [
    { from: 'pending', to: 'assigned', event: 'dispatch', allowedRoles: ['admin', 'operator'] },
    { from: 'assigned', to: 'transporting', event: 'receive', allowedRoles: ['admin', 'worker'] },
    { from: 'transporting', to: 'processing', event: 'process', allowedRoles: ['admin', 'worker'] },
    { from: 'processing', to: 'done', event: 'complete', allowedRoles: ['admin', 'worker'] },
  ],
  config: { name: '运送（auto-tune 夹具）' },
};

async function seedDef(db: PGlite): Promise<void> {
  await saveWorkflowDef(db as unknown as PoolClient, TENANT, ENTITY, BASE_DEF, {
    operator: 'autotune-tester',
    reason: 'seed',
  });
}

/** 落到指定状态的真实在途单（transport_order 只有 tenant_id / item_name 非空必需）。 */
async function seedInflight(db: PGlite, status: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await db.query(`INSERT INTO transport_order (tenant_id, item_name, status) VALUES ($1, $2, $3)`, [
      TENANT,
      `在途标本-${status}-${i + 1}`,
      status,
    ]);
  }
}

async function seedPendingRecommendation(db: PGlite, target: string): Promise<void> {
  await db.query(
    `INSERT INTO optimization_feedback (tenant_id, scope, target, recommendation, reason, status)
     VALUES ($1, 'workflow', $2, '{}'::jsonb, 'auto-tune 测试建议', 'pending')`,
    [TENANT, target],
  );
}

async function readDef(db: PGlite): Promise<WorkflowDef> {
  const r = await db.query<{ def: unknown }>(`SELECT def FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2`, [
    TENANT,
    ENTITY,
  ]);
  const raw = r.rows[0]?.def;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as WorkflowDef;
}

describe('T1-A 第二批③：auto-tune 飞轮不得被在途单新闸误伤', () => {
  it('纯加法推荐（:auto_escalate）落库不被拦：applied=1、def 真的改了，且同库手工删边对照组确实 409', async () => {
    const db = await freshDb();
    await seedDef(db);
    // 在途单铺在被推荐的边会经过的态上：processing（新边的 from）+ 主链上其它两个态。
    // 只要判定面将来被放宽成"碰过的态都算"，这里就会立刻炸出来。
    await seedInflight(db, 'processing', 2);
    await seedInflight(db, 'assigned', 3);
    await seedInflight(db, 'transporting', 1);
    await seedPendingRecommendation(db, `${ENTITY}:auto_escalate`);

    // 飞轮落库：**不带** allowInflightLoss（生产就是这么调的，optimizer.ts:507/519）
    const res = await applyWorkflowOptimizations(db as unknown as PoolClient, TENANT);

    // ① 推荐真的生效了（不是被守卫跳过 / 不是静默吞掉的假绿）
    expect(res.applied, `期望 1 条被应用，实际 ${JSON.stringify(res)}`).toBe(1);
    expect(res.targets).toEqual([`${ENTITY}:auto_escalate`]);

    // ② def 真的被改了：新增 escalated 终态 + processing→escalated 边，原边一条没少
    const after = await readDef(db);
    expect(after.states, '应新增 escalated 状态').toContain('escalated');
    const hasEscalate = (after.transitions ?? []).some(
      (t) => t.from === 'processing' && t.to === 'escalated' && t.event === 'auto_escalate',
    );
    expect(hasEscalate, '应新增 processing --auto_escalate--> escalated 边').toBe(true);
    for (const base of BASE_DEF.transitions ?? []) {
      const kept = (after.transitions ?? []).some(
        (t) => t.from === base.from && t.to === base.to && t.event === base.event,
      );
      expect(kept, `原边 ${base.from} --${base.event ?? ''}--> ${base.to} 必须原样保留（纯加法）`).toBe(true);
    }

    // ③ 对照组：同一份库、同一批在途单，手工删掉 assigned→transporting ⇒ 必须 409。
    //    没有这条，"auto-tune 没被拦"可能只是因为夹具里根本没有在途单。
    const dropEdge: WorkflowDef = {
      ...BASE_DEF,
      transitions: (BASE_DEF.transitions ?? []).filter(
        (t) => !(t.from === 'assigned' && t.to === 'transporting'),
      ),
    };
    const control = await saveWorkflowDef(db as unknown as PoolClient, TENANT, ENTITY, dropEdge, {
      operator: 'autotune-tester',
      reason: 'control group: manual edge drop',
    })
      .then(() => null)
      .catch((e: unknown) => e as { code?: string; status?: number });
    expect(control, '对照组：手工删边 + assigned 上有在途单 ⇒ 必须被拦').toBeTruthy();
    expect(String((control as { code?: string })?.code ?? '')).toBe('INFLIGHT_STATE_LOSS');
    expect(Number((control as { status?: number })?.status ?? 0)).toBe(409);
  });

  it('飞轮幂等重跑：同一条建议落两轮，第二轮零 diff —— 在途单就在新边的 from 态上也不许拦', async () => {
    const db = await freshDb();
    await seedDef(db);
    // 在途单压在 escalated 边的 from 态（processing）上：飞轮每周期都会重跑同一批建议，
    // 若"零 diff 的重复保存"被误判成改动，优化链路会在第二个周期就整个停摆。
    await seedInflight(db, 'processing', 3);
    await seedPendingRecommendation(db, `${ENTITY}:auto_escalate`);
    await seedPendingRecommendation(db, `${ENTITY}:auto_escalate`);

    const res = await applyWorkflowOptimizations(db as unknown as PoolClient, TENANT);

    expect(res.applied, `期望 2 条被应用，实际 ${JSON.stringify(res)}`).toBe(2);
    const after = await readDef(db);
    expect(after.states).toContain('escalated');
    const escalateEdges = (after.transitions ?? []).filter((t) => t.event === 'auto_escalate');
    expect(escalateEdges.length, '幂等：重跑不得堆出重复边').toBe(1);
  });
});
