// T303a：能耗采集任务状态图（ENERGY_COLLECTION_DEF，能源派单镜像态）种子到试点租户。
// 与 seed-workflow-def.ts 同一通道：saveWorkflowDef（版本自增 + workflow_def_history
// 快照），绝不手写一次性 SQL——把"配置驱动零代码状态机"验证得可复现、可回滚。
//
// 运行：
//   npm run seed:energy-collection            # 种子到 t-verification
//   SEED_TENANT=xxx npm run seed:energy-collection   # 指定租户
//   npm run seed:energy-collection -- --reset # 回退为 ENERGY_COLLECTION 内置兜底（同图，重置版本）
//
// 需先跑迁移 022_workflow_def.sql（建表）。
import { withTenantClient } from '../src/db/pool.js';
import { saveWorkflowDef } from '../src/engine/workflowDef.js';
import { ENERGY_COLLECTION_DEF, type WorkflowDef } from '../src/engine/themes.js';

const TENANT = process.env.SEED_TENANT ?? 't-verification';
const ENTITY = 'energy_collection';
const RESET = process.argv.includes('--reset');
// 深拷贝，避免写坏被导出的常量（engine 内部以 JSON 往返消费，防御性克隆）。
const def: WorkflowDef = JSON.parse(JSON.stringify(ENERGY_COLLECTION_DEF));

async function main() {
  const label = RESET ? '重置(内置镜像态)' : '内置镜像态(能源派单)';
  await withTenantClient(TENANT, async (client) => {
    await saveWorkflowDef(client, TENANT, ENTITY, def, { reason: RESET ? 't303a-reset' : 't303a-seed' });
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
