// A+ Phase2：把富 13 态模板（RICH_WORK_ORDER_DEF，取 UOne 工单全生命周期之所长）种子到试点租户 t-verification。
// 仅种子具体租户，不污染全局默认（DEFAULT 仍是最小儿 4 态兜底，保证其他租户不受影响）—— 落实"不重新写死流程"。
// 兼容：RICH 保留旧 4 态兼容路径，历史工单(draft/assigned/processing/completed)在富模板下仍可流转，孤儿风险低。
//
// 运行：
//   npm run seed:workflow            # 种子 RICH 富模板到 t-verification
//   SEED_TENANT=xxx npm run seed:workflow   # 指定租户
//   npm run seed:workflow:reset      # 回退为 DEFAULT 最小 4 态（一键还原，staging 保护）
//
// 需先跑迁移 022_workflow_def.sql（建表）+ 026_work_order_sla_paused.sql（side-effect 落库列）。
import { withTenantClient } from '../src/db/pool.js';
import { saveWorkflowDef } from '../src/engine/workflowDef.js';
import { RICH_WORK_ORDER_DEF, DEFAULT_WORK_ORDER_DEF, type WorkflowDef } from '../src/engine/stateMachine.js';

const TENANT = process.env.SEED_TENANT ?? 't-verification';
const ENTITY = 'work_order';
const RESET = process.argv.includes('--reset');
const source: WorkflowDef = RESET ? DEFAULT_WORK_ORDER_DEF : RICH_WORK_ORDER_DEF;
// 深拷贝，避免写坏被导出的常量（engine 内部以 JSON 往返消费，但此处防御性克隆）。
const def: WorkflowDef = JSON.parse(JSON.stringify(source));

async function main() {
  const label = RESET ? 'DEFAULT(最小4态)' : 'RICH(富13态·UOne颗粒度)';
  await withTenantClient(TENANT, async (client) => {
    await saveWorkflowDef(client, TENANT, ENTITY, def);
    const r = await client.query<{ version: number }>(
      `SELECT version FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2`,
      [TENANT, ENTITY],
    );
    console.log(`[seed] workflow_def ${TENANT}/${ENTITY} ← ${label} (version=${r.rows[0]?.version ?? 1})`);
    console.log(`[seed] states(${def.states.length}): ${def.states.join(' / ')}`);
    console.log(`[seed] transitions(${def.transitions.length}): ${def.transitions.map((t) => `${t.from}→${t.to}`).join(', ')}`);
  });
  console.log('[seed] done.');
}

main().catch((e) => {
  console.error('[seed] failed:', e);
  process.exit(1);
});
