/**
 * labelDictTenantSave.test.ts —— 保存联动的**落点**验证（098 label_dict_tenant × saveWorkflowDef）
 *
 * 【为什么必须有这份】
 *   labelDictTenant.test.ts 验的是 ensureTenantStateLabels 这个函数本身对不对；
 *   但真正决定"租户自定义状态有没有中文名"的是**它有没有被接进保存链路**。
 *   接线漏了（或只接在 approve 一条路、漏掉 rollback/template/auto-tune/provision）
 *   ⇒ 函数再正确也是死代码，界面照样显示裸 key。这只能靠真跑 saveWorkflowDef 验：
 *   真建库（workflow_def + workflow_def_history + label_dict_tenant）→ 真调用 → 查真行。
 *
 * 【为什么联动要落在 saveWorkflowDef（engine 层）而不是某个路由】
 *   live 写边有五条：approve / rollback / template / auto-tune / provision（见 engine/workflowDef.ts
 *   SaveWorkflowDefOpts 注释），全部收敛到 saveWorkflowDef。挂在这一层 = 五条路全覆蓋；
 *   挂在任一单条路由 = 其余四条路保存的流程状态继续显示裸 key。
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveWorkflowDef } from '../engine/workflowDef.js';
import type { WorkflowDef } from '../engine/stateMachine.js';

const ROOT = join(__dirname, '..', '..');
const SQL098 = readFileSync(join(ROOT, '098_label_dict_tenant.sql'), 'utf8');

/** 098 里 PGlite 可执行段：CREATE TABLE + 两个 CREATE INDEX（GRANT / RLS 段见下方 RLS 用例）。 */
function ddl098(): string {
  const start = SQL098.indexOf('CREATE TABLE IF NOT EXISTS label_dict_tenant');
  const marker = 'CREATE INDEX IF NOT EXISTS idx_label_dict_tenant_lookup';
  const end = SQL098.indexOf(';', SQL098.indexOf(marker));
  if (start < 0 || end < 0) throw new Error('098 迁移结构变了：截取 DDL 失败，请同步本测试');
  return SQL098.slice(start, end + 1);
}

/** 真库：workflow_def / workflow_def_history / label_dict_tenant，均取自真实迁移的建表口径。 */
async function freshDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_def (
      id bigserial PRIMARY KEY, tenant_id text NOT NULL, entity_type text NOT NULL,
      def jsonb NOT NULL DEFAULT '{}'::jsonb, version int NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, entity_type)
    );
    CREATE TABLE IF NOT EXISTS workflow_def_history (
      id bigserial PRIMARY KEY, tenant_id text NOT NULL, entity_type text NOT NULL,
      version int NOT NULL, def jsonb NOT NULL, operator text, reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, entity_type, version)
    );
    -- V3-D4 删态清点会扫的状态表（本文件只做新增态，不触发，但保留以便后续用例扩展）
    CREATE TABLE IF NOT EXISTS work_orders (
      id bigserial PRIMARY KEY, tenant_id text NOT NULL, status text NOT NULL DEFAULT 'draft'
    );
    CREATE TABLE IF NOT EXISTS role_def (tenant_id text NOT NULL, code text NOT NULL, UNIQUE (tenant_id, code));
    -- 平台字典（073）：写侧落标签前要用 NOT EXISTS 查它判重，缺表则子查询直接报错被吞 → 测试就成了假绿
    CREATE TABLE IF NOT EXISTS label_dict (scope text NOT NULL, key text NOT NULL, label text NOT NULL, sort int NOT NULL DEFAULT 0);
  `);
  await db.exec(ddl098());
  return db;
}

function def(states: string[], initial = states[0]): WorkflowDef {
  return {
    initial,
    states,
    // 转移只用内置事件名、不带 allowedRoles ⇒ 不触碰 role_def 校验，聚焦标签联动本身
    transitions: states.slice(1).map((s, i) => ({ from: states[i], to: s, event: `e${i}` })),
  };
}

async function dictRows(db: PGlite) {
  const r = await db.query<{ scope: string; key: string; label: string }>(
    `SELECT scope, key, label FROM label_dict_tenant WHERE tenant_id = 'T1' ORDER BY key`,
  );
  return r.rows;
}

describe('保存流程 → 状态名自动落进租户覆盖字典（saveWorkflowDef 真跑）', () => {
  it('首次保存：该 def 的每个状态都落行，label 缺省 = key（不再是空白）', async () => {
    const db = await freshDb();
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'assigned', 'rated']), {
      operator: 'alice',
      reason: 'test:init',
    });
    const rows = await dictRows(db);
    expect(rows.map((r) => [r.key, r.label])).toEqual([
      ['assigned', 'assigned'],
      ['draft', 'draft'],
      ['rated', 'rated'],
    ]);
    // scope 必须是 wo_status（读侧 /meta/labels/me 按 scope 合并）
    expect(rows.every((r) => r.scope === 'wo_status')).toBe(true);
    await db.close();
  });

  it('管理员改好的中文名不被下次保存冲回裸 key（DO NOTHING，不是 DO UPDATE）', async () => {
    const db = await freshDb();
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'assigned', 'rated']), {
      operator: 'alice',
      reason: 'test:init',
    });
    await db.query(`UPDATE label_dict_tenant SET label = '已评价' WHERE tenant_id = 'T1' AND key = 'rated'`);
    // 再保存同一流程（states 不变）
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'assigned', 'rated']), {
      operator: 'bob',
      reason: 'test:resave',
    });
    expect((await dictRows(db)).find((r) => r.key === 'rated')?.label).toBe('已评价');
    await db.close();
  });

  it('重复保存不分裂出行（幂等，同 key 仍 1 行）', async () => {
    const db = await freshDb();
    const d = def(['draft', 'assigned', 'rated']);
    for (const reason of ['r1', 'r2', 'r3']) {
      await saveWorkflowDef(db as never, 'T1', 'work_order', d, { operator: 'alice', reason });
    }
    const c = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM label_dict_tenant WHERE tenant_id = 'T1'`,
    );
    expect(c.rows[0].n).toBe(3);
    await db.close();
  });

  it('多租户各存各的：T1 与 T2 同 key 互不干扰', async () => {
    const db = await freshDb();
    const d = def(['draft', 'rated']);
    await saveWorkflowDef(db as never, 'T1', 'work_order', d, { operator: 'a', reason: 'r' });
    await saveWorkflowDef(db as never, 'T2', 'work_order', d, { operator: 'b', reason: 'r' });
    await db.query(`UPDATE label_dict_tenant SET label = '已评价' WHERE tenant_id = 'T1' AND key = 'rated'`);
    const r = await db.query<{ tenant_id: string; label: string }>(
      `SELECT tenant_id, label FROM label_dict_tenant WHERE key = 'rated' ORDER BY tenant_id`,
    );
    expect(r.rows).toEqual([
      { tenant_id: 'T1', label: '已评价' },
      { tenant_id: 'T2', label: 'rated' },
    ]);
    await db.close();
  });

  it('标签联动失败不得连坐：覆盖表不存在时保存流程仍然成功（纯加法，不引入新故障点）', async () => {
    // 098 未应用的库（老环境）：saveWorkflowDef 必须照常写 workflow_def，只是没有覆盖行
    const db = new PGlite();
    await db.exec(`
      CREATE TABLE workflow_def (
        id bigserial PRIMARY KEY, tenant_id text NOT NULL, entity_type text NOT NULL,
        def jsonb NOT NULL DEFAULT '{}'::jsonb, version int NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, entity_type)
      );
      CREATE TABLE workflow_def_history (
        id bigserial PRIMARY KEY, tenant_id text NOT NULL, entity_type text NOT NULL,
        version int NOT NULL, def jsonb NOT NULL, operator text, reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, entity_type, version)
      );
    `);
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'rated']), {
      operator: 'alice',
      reason: 'test:no098',
    });
    const w = await db.query<{ version: number }>(
      `SELECT version FROM workflow_def WHERE tenant_id = 'T1' AND entity_type = 'work_order'`,
    );
    expect(w.rows[0].version).toBe(1); // 流程照样生效，没被标签联动拖挂
    await db.close();
  });

  /**
   * 【这条是 R1-B2 的验收锚点】/meta/labels/me 是「平台字典 ∪ 租户覆盖，覆盖优先」。
   * 保存流程若把 draft/assigned 一并落成 label='draft'，租户保存一次流程，界面上的
   * 「草稿」就变成 draft —— 联动的意义是消灭裸 key，落错方向会让标准状态整屏变英文。
   */
  it('保存流程只落自定义状态：标准状态（草稿/已派单）不进覆盖表', async () => {
    const db = await freshDb();
    await db.query(
      `INSERT INTO label_dict (scope, key, label) VALUES ('wo_status','draft','草稿'),('wo_status','assigned','已派单')`,
    );
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'assigned', 'rated']), {
      operator: 'alice',
      reason: 'test:custom-only',
    });
    const rows = await dictRows(db);
    expect(rows.map((r) => r.key)).toEqual(['rated']); // 只有平台字典里没有的
    expect(rows[0].label).toBe('rated'); // 有行可改（不再永远裸 key）
    await db.close();
  });
});
