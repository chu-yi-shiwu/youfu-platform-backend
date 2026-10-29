/**
 * label_dict_tenant（098） + ensureTenantStateLabels —— PGlite 真跑验证
 *
 * 【为什么补这份】
 *   跨维度冲突 #1 的落点是「租户自定义状态要有中文名」。保存联动是这个能力的入口：
 *     · 若写成 ON CONFLICT DO UPDATE ⇒ 管理员改好的中文名（如 rated→已评价）会在下次保存流程时
 *       被悄悄冲回裸 key，用户看到的是"改了又变回去"，且无从归因；
 *     · 若 label 缺省写成空串/null ⇒ 界面显示空白，比显示裸 key 更难排查。
 *   这两条读代码看不出来，只有真跑才验得到。
 *
 * 【验证口径】真建库 → 真执行 098 的 DDL（PGlite 不认 GRANT/RLS 策略段，单独走静态断言）→ 真 upsert → 查真行。
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureTenantStateLabels } from '../engine/labelDictTenant.js';
import { scopeFor } from '../engine/workflowDef.js';

const ROOT = join(__dirname, '..', '..');
const SQL = readFileSync(join(ROOT, '098_label_dict_tenant.sql'), 'utf8');
const SQL073 = readFileSync(join(ROOT, '073_label_dict.sql'), 'utf8');

/** 截取 PGlite 可执行段：CREATE TABLE + 两个 CREATE INDEX（GRANT / RLS 段 PGlite 不支持，走静态断言）。 */
function ddl(): string {
  const start = SQL.indexOf('CREATE TABLE IF NOT EXISTS label_dict_tenant');
  const marker = 'CREATE INDEX IF NOT EXISTS idx_label_dict_tenant_lookup';
  const end = SQL.indexOf(';', SQL.indexOf(marker));
  if (start < 0 || end < 0) throw new Error('098 迁移结构变了：截取 DDL 失败，请同步本测试');
  return SQL.slice(start, end + 1);
}

/**
 * 073 的建表段（**不含种子**）。
 * 写侧要判重的对象就是这张平台字典表，表不存在时 NOT EXISTS 子查询会直接报错——
 * 所以必须真建，不能靠 mock。种子按需在每个用例里插，保持各用例的平台字典内容显式可见。
 */
function ddl073(): string {
  const start = SQL073.indexOf('CREATE TABLE IF NOT EXISTS label_dict');
  const marker = 'CREATE UNIQUE INDEX IF NOT EXISTS ux_label_dict_scope_key';
  const end = SQL073.indexOf(';', SQL073.indexOf(marker));
  if (start < 0 || end < 0) throw new Error('073 迁移结构变了：截取 DDL 失败，请同步本测试');
  return SQL073.slice(start, end + 1);
}

async function freshDb() {
  const db = new PGlite();
  await db.exec(ddl());
  await db.exec(ddl073()); // 平台字典（空表）：种子由各用例按需插
  // T0（101 迁移）：覆盖表新增 updated_by（变更人）+ version（并发锚）。
  // 本文件的库必须跟生产迁移同形状，否则写语句引用了不存在的列 ⇒ 假红。
  await db.exec(`
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS updated_by text;
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
  `);
  return db;
}

/** 按 073 真实口径播平台字典种子（scope='wo_status'）。 */
async function seedPlatform(db: PGlite, pairs: Array<[string, string]>) {
  for (const [k, label] of pairs) {
    await db.query(`INSERT INTO label_dict (scope, key, label) VALUES ('wo_status', $1, $2)`, [k, label]);
  }
}

async function labelsOf(db: PGlite): Promise<Array<{ key: string; label: string }>> {
  const r = await db.query<{ key: string; label: string }>(
    'SELECT key, label FROM label_dict_tenant ORDER BY key',
  );
  return r.rows;
}

/**
 * 按 **scope** 取覆盖行（tenantId 缺省取各用例惯用的 T1）。
 * 「落在哪个域」是本次改动的验收对象：labelsOf 不区分 scope，同名 key 跨域会互相掩盖。
 */
async function labelsInScope(
  db: PGlite,
  scope: string,
  tenantId = 'T1',
): Promise<Array<{ key: string; label: string }>> {
  const r = await db.query<{ key: string; label: string }>(
    'SELECT key, label FROM label_dict_tenant WHERE tenant_id = $1 AND scope = $2 ORDER BY key',
    [tenantId, scope],
  );
  return r.rows;
}

describe('098 label_dict_tenant：保存流程联动落标签', () => {
  it('首次保存：新状态落行，label 缺省 = key（至少不再是空白）', async () => {
    const db = await freshDb();
    const n = await ensureTenantStateLabels(db, 'T1', ['draft', 'rated']);
    expect(n).toBe(2);
    const rows = await labelsOf(db);
    expect(rows).toEqual([
      { key: 'draft', label: 'draft' },
      { key: 'rated', label: 'rated' },
    ]);
  });

  it('管理员已改的中文名不被下次保存冲回裸 key（DO NOTHING，不是 DO UPDATE）', async () => {
    const db = await freshDb();
    await ensureTenantStateLabels(db, 'T1', ['draft', 'rated']);
    // 管理员把 rated 改成「已评价」
    await db.query(`UPDATE label_dict_tenant SET label = '已评价' WHERE tenant_id = 'T1' AND key = 'rated'`);
    // 再次保存同一流程（states 不变）+ 顺带新增一个状态
    const n = await ensureTenantStateLabels(db, 'T1', ['draft', 'rated', 'escalated']);
    expect(n).toBe(1); // 只落新增的那条
    const rows = await labelsOf(db);
    expect(rows.find((r) => r.key === 'rated')?.label).toBe('已评价'); // 没被冲回 'rated'
    expect(rows.find((r) => r.key === 'escalated')?.label).toBe('escalated');
  });

  it('多租户隔离：T1 的覆盖不影响 T2（同 key 各存各的行）', async () => {
    const db = await freshDb();
    await ensureTenantStateLabels(db, 'T1', ['rated']);
    await db.query(`UPDATE label_dict_tenant SET label = '已评价' WHERE tenant_id = 'T1' AND key = 'rated'`);
    await ensureTenantStateLabels(db, 'T2', ['rated']);
    const r = await db.query<{ tenant_id: string; label: string }>(
      `SELECT tenant_id, label FROM label_dict_tenant WHERE key = 'rated' ORDER BY tenant_id`,
    );
    expect(r.rows).toEqual([
      { tenant_id: 'T1', label: '已评价' },
      { tenant_id: 'T2', label: 'rated' },
    ]);
  });

  it('非法输入不炸：空数组 / 空串 / 非字符串一律跳过', async () => {
    const db = await freshDb();
    const n = await ensureTenantStateLabels(db, 'T1', []);
    expect(n).toBe(0);
    const n2 = await ensureTenantStateLabels(db, 'T1', ['', 'ok'] as string[]);
    expect(n2).toBe(1);
    expect((await labelsOf(db)).map((r) => r.key)).toEqual(['ok']);
  });

  /**
   * 【为什么这条最关键】读侧 /meta/labels/me 是「平台字典 ∪ 租户覆盖，覆盖优先」。
   * 若写侧把 draft/assigned 这些**标准状态**也落成 label='draft'，租户保存一次流程后，
   * 界面上的「草稿」就变成 draft —— 本改动是为了消灭裸 key，全覆盖反而给所有标准状态制造裸 key。
   * 这里锚的就是"只落自定义状态"，落错方向的代价是整屏变英文。
   */
  it('平台字典已有的状态一个都不落（标准状态不被冲成裸 key）', async () => {
    const db = await freshDb();
    await seedPlatform(db, [['draft', '草稿'], ['assigned', '已派单']]);
    const n = await ensureTenantStateLabels(db, 'T1', ['draft', 'assigned', 'rated', 'escalated']);
    expect(n).toBe(2); // 只落两个自定义状态
    const keys = (await labelsOf(db)).map((r) => r.key);
    expect(keys).toEqual(['escalated', 'rated']);
    expect(keys).not.toContain('draft');
    expect(keys).not.toContain('assigned');
    await db.close();
  });

  it('同一次保存里重复出现的状态只落一行（def.states 去重后再写）', async () => {
    const db = await freshDb();
    expect(await ensureTenantStateLabels(db, 'T1', ['rated', 'rated'])).toBe(1);
    expect((await labelsOf(db)).map((r) => r.key)).toEqual(['rated']);
    await db.close();
  });

  /**
   * 【巡检独立字典域 insp_status 的验收锚点①】巡检状态集与工单状态集是**两套枚举**：
   * 073 的 wo_status 域只有工单那 19 条，不含巡检的 pending / in_progress / done / exception。
   * 此前 scope 硬编码 'wo_status'，巡检的这 5 个状态一律以裸 key 落进**工单域**——
   * 写侧造出跨文档脏数据，读侧无从分辨某行到底属于工单还是巡检。
   */
  it('巡检走自己的域：传 scope=insp_status 时只落 insp_status，工单域零新增', async () => {
    const db = await freshDb();
    const n = await ensureTenantStateLabels(db, 'T1', ['pending', 'in_progress', 'done'], 'alice', 'insp_status');
    expect(n).toBe(3);
    // 巡检域：三条都在，label 缺省 = key（有行可改，不是空白）
    const insp = await labelsInScope(db, 'insp_status');
    expect(insp).toEqual([
      { key: 'done', label: 'done' },
      { key: 'in_progress', label: 'in_progress' },
      { key: 'pending', label: 'pending' },
    ]);
    // 工单域：**零新增**（这条是本次改动的成败线——多脏一行工单域就白改）
    expect(await labelsInScope(db, 'wo_status')).toEqual([]);
    await db.close();
  });

  /**
   * 【验收锚点②：向后兼容锁定】scope 是**可选第 5 参、默认 wo_status**，
   * 现有调用点（以及所有将来不显式传域的调用）行为必须与改前**逐字一致**。
   * 没有这条，改默认域时手抖把默认值写成新域 = 全部既有调用点悄悄换域。
   */
  it('不传第 5 参 ⇒ 仍落 wo_status（默认域不动，现有调用点零改动）', async () => {
    const db = await freshDb();
    const n = await ensureTenantStateLabels(db, 'T1', ['pending', 'done'], 'alice');
    expect(n).toBe(2);
    expect(await labelsInScope(db, 'wo_status')).toEqual([
      { key: 'done', label: 'done' },
      { key: 'pending', label: 'pending' },
    ]);
    expect(await labelsInScope(db, 'insp_status')).toEqual([]);
    // 库里出现过的 scope 只能有 wo_status 一个
    const r = await db.query<{ scope: string }>(`SELECT DISTINCT scope FROM label_dict_tenant`);
    expect(r.rows.map((x) => x.scope)).toEqual(['wo_status']);
    await db.close();
  });

  it('同名 key 跨域各占一行：改巡检的 done 译名不动工单的 done', async () => {
    const db = await freshDb();
    await ensureTenantStateLabels(db, 'T1', ['done'], 'a', 'insp_status');
    await ensureTenantStateLabels(db, 'T1', ['done'], 'a'); // 默认域 wo_status
    await db.query(
      `UPDATE label_dict_tenant SET label = '巡检完成' WHERE tenant_id='T1' AND scope='insp_status' AND key='done'`,
    );
    // 再次保存巡检流程：同 key 只在此域幂等（DO NOTHING 是按 (tenant_id, scope, key) 判重的）
    expect(await ensureTenantStateLabels(db, 'T1', ['done'], 'b', 'insp_status')).toBe(0);
    expect((await labelsInScope(db, 'insp_status')).map((r) => r.label)).toEqual(['巡检完成']);
    // 工单域的 done 没被巡检的中文名带跑（这正是混域时会发生的串号）
    expect((await labelsInScope(db, 'wo_status')).map((r) => r.label)).toEqual(['done']);
    await db.close();
  });
});

/**
 * scopeFor —— 业务文档 → 字典域的映射（纯函数，无库）。
 * 上面的用例验的是"传进来的域被正确落成行"，这一组验的是"**谁**该走哪个域"——
 * 映射写错（或将来有人把它删掉回落默认域）不会有任何字典行报错，只会悄悄重新混域。
 */
describe('scopeFor：业务文档 → 字典域', () => {
  it('巡检 inspection_task → insp_status（不进工单域）', () => {
    expect(scopeFor('inspection_task')).toBe('insp_status');
  });

  it('工单及其余业务一律回落 wo_status（向后兼容，未知业务不因展示层 500）', () => {
    for (const t of ['work_order', 'transport_order', 'volunteer_activity', 'feedback', '未登记的新业务']) {
      expect(scopeFor(t)).toBe('wo_status');
    }
  });
});

/**
 * 098 治理段（RLS / 唯一键）—— **真跑**，不是正则扫文本。
 *
 * 【为什么不写正则断言】正则只能证明"文件里有这行字"，证明不了"库里真的生效了"：
 * 拼错表名、策略建到别的表上、RLS 忘了 ENABLE，正则全绿。
 * 下面全部查**真实系统表**：pg_tables.rowsecurity / pg_policy / pg_indexes。
 *
 * 【为什么这里能真验 RLS】migration097 那份注释说"PGlite 是 superuser，恒绕过 RLS"——
 * 那是没降权的情况。先 CREATE ROLE youfu_app 再 SET ROLE 过去，就是普通非超户连接，
 * RLS 照常生效（已实测：换 app.tenant_id 观察到的行集确实跟着变）。
 */
async function freshGovernedDb() {
  const db = new PGlite();
  // 098 的 CREATE POLICY ... TO youfu_app / GRANT ... TO youfu_app 要求该角色已存在（生产由 001 建）
  await db.exec(`CREATE ROLE youfu_app NOLOGIN;`);
  await db.exec(`
    CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS text AS $$
      SELECT coalesce(current_setting('app.tenant_id', true), '')
    $$ LANGUAGE sql STABLE;
  `);
  await db.exec(SQL); // 真执行 098 全文（含 RLS / GRANT）
  return db;
}

describe('098 治理段真跑：RLS + 唯一键（查真实系统表，不扫文本）', () => {
  it('表已建且 RLS 真的开启（pg_tables.rowsecurity = true）', async () => {
    const db = await freshGovernedDb();
    const r = await db.query<{ rowsecurity: boolean }>(
      `SELECT rowsecurity FROM pg_tables WHERE tablename = 'label_dict_tenant'`,
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].rowsecurity).toBe(true);
    await db.close();
  });

  it('租户隔离策略真实存在，且 USING 表达式绑定 app_tenant_id()', async () => {
    const db = await freshGovernedDb();
    const r = await db.query<{ polname: string; using_expr: string }>(
      `SELECT polname, pg_get_expr(polqual, polrelid) AS using_expr
         FROM pg_policy WHERE polrelid = 'label_dict_tenant'::regclass`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows[0].using_expr).toContain('app_tenant_id()');
    expect(r.rows[0].using_expr).toContain('tenant_id');
    await db.close();
  });

  it('唯一键 (tenant_id, scope, key) 真实存在（少了 tenant_id 就退回全局字典老问题）', async () => {
    const db = await freshGovernedDb();
    const r = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'label_dict_tenant'`,
    );
    const uniq = r.rows.map((x) => x.indexdef).filter((d) => d.includes('UNIQUE'));
    expect(uniq.length).toBeGreaterThan(0);
    expect(uniq.join(' ')).toContain('tenant_id, scope, key');
    await db.close();
  });

  it('RLS 实测①：降权为 youfu_app 后，换 tenantId 只能看到自己的行', async () => {
    const db = await freshGovernedDb();
    await db.query(
      `INSERT INTO label_dict_tenant (tenant_id, scope, key, label) VALUES
       ('T1','wo_status','draft','待提交'), ('T2','wo_status','draft','暂存')`,
    );
    await db.exec(`SET ROLE youfu_app;`);

    await db.exec(`SET app.tenant_id = 'T1';`);
    const a = await db.query<{ tenant_id: string; label: string }>(`SELECT tenant_id, label FROM label_dict_tenant`);
    expect(a.rows).toEqual([{ tenant_id: 'T1', label: '待提交' }]);

    await db.exec(`SET app.tenant_id = 'T2';`);
    const b = await db.query<{ tenant_id: string; label: string }>(`SELECT tenant_id, label FROM label_dict_tenant`);
    expect(b.rows).toEqual([{ tenant_id: 'T2', label: '暂存' }]); // 看不到 T1 的行
    await db.close();
  });

  it('RLS 实测②：拿不到别人的覆盖（换个 tenantId 查别人的 key → 0 行）', async () => {
    const db = await freshGovernedDb();
    await db.query(
      `INSERT INTO label_dict_tenant (tenant_id, scope, key, label) VALUES ('T1','wo_status','rated','已评价')`,
    );
    await db.exec(`SET ROLE youfu_app;`);
    await db.exec(`SET app.tenant_id = 'T2';`);
    const r = await db.query<{ key: string }>(
      `SELECT key FROM label_dict_tenant WHERE key = 'rated'`,
    );
    expect(r.rows).toEqual([]); // 越权读 → 空集（不是报错，是静默空 —— 更要断言）
    await db.close();
  });

  it('RLS 实测③：未带租户身份 → 0 行（无身份即无数据，fail-closed）', async () => {
    const db = await freshGovernedDb();
    await db.query(
      `INSERT INTO label_dict_tenant (tenant_id, scope, key, label) VALUES ('T1','wo_status','rated','已评价')`,
    );
    await db.exec(`SET ROLE youfu_app;`);
    await db.exec(`SET app.tenant_id = '';`);
    const r = await db.query(`SELECT key FROM label_dict_tenant`);
    expect(r.rows).toEqual([]);
    await db.close();
  });

  it('RLS WITH CHECK 实测④：降权后写入别家租户被拒（防写穿隔离）', async () => {
    const db = await freshGovernedDb();
    await db.exec(`SET ROLE youfu_app;`);
    await db.exec(`SET app.tenant_id = 'T1';`);
    await expect(
      db.query(
        `INSERT INTO label_dict_tenant (tenant_id, scope, key, label) VALUES ('T2','wo_status','x','X')`,
      ),
    ).rejects.toThrow();
    await db.close();
  });

  it('098 幂等：连续执行三次不报错（重复部署安全）', async () => {
    const db = await freshGovernedDb();
    await db.exec(SQL);
    await db.exec(SQL);
    const r = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM label_dict_tenant`);
    expect(r.rows[0].c).toBe(0);
    await db.close();
  });
});
