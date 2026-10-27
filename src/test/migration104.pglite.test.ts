/**
 * 104_inflight_def_version_index —— 反向迁移**实跑**闭环验证（PGlite 真库 + 真 SQL）
 *
 * 【为什么必须有这份】
 *   rollback/104_inflight_def_version_index_down.sql:71-74 自己写着「已实跑验证，
 *   见 src/test/migration104.pglite.test.ts」。本文件就是那个被点名的验证。
 *   写了没跑过的反向迁移**不算回退方案**（总则 E1 的镜像：事前写了但没验过，同样不算）
 *   ⇒ 本文件是 104 上线的**前置条件**，不是可选护栏。
 *
 * 【🔴 与 103 那份同构，但有一处更容易被忽略的后果】
 *   103 那种「只删列不擦账」重新上线会炸 42703 ⇒ 500，**会响**；
 *   104 这种「只删索引不擦账」重新上线 → migrate 因已记账永久 skip → 索引永远回不来
 *   → 版本探测**永久停在"全表扫"，功能完全正常、不报错、不告警**（down 文件 :34-35）
 *   ⇒ **静默退化**，比 103 更隐蔽。所以第 3 步必须走真实通道才测得出来。
 *
 * 【🔴 第 3 步为什么必须走真实通道（103 上踩过的坑，别重蹈）】
 *   migration102.pglite.test.ts 的旧版 103-⑧ 第 3 步是 `await db.exec(UP103)`
 *   —— **无条件**执行。真实通道是 `src/db/migrate.ts:61 if (applied.has(file)) continue`。
 *   无条件 exec 会把 SQL 硬跑一遍 ⇒ 「只删不擦账」在它下面**仍然绿**。
 *   ⇒ 本文件用 apply104ViaMigrate() 复刻 skip 语义，变异下第 3 步**真红**。
 *
 * 【真库口径】真 PGlite + 真 SQL，不 mock、不只断言文件内容。
 *   104 的 CREATE INDEX 引用 def_version 列 ⇒ 库里必须**先有列**：
 *   本文件真建 4 张表（001/011/034/030 建表原文）+ 真跑 102（3 表加列）+ 真跑 103（工单加列），
 *   再跑 104。这也顺带钉住「104 依赖 102/103」这个真实前提。
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const UP_PATH = join(ROOT, '104_inflight_def_version_index.sql');
const DOWN_PATH = join(ROOT, 'rollback', '104_inflight_def_version_index_down.sql');
const UP = readFileSync(UP_PATH, 'utf8');
const DOWN = readFileSync(DOWN_PATH, 'utf8');
/** 记账 key = 正向迁移的**文件名**（migrate.ts:87 / shell :40 存的都是文件名，不带路径）。 */
const UP_NAME = '104_inflight_def_version_index.sql';

/** 104 涉及的 4 张表 → 期望的索引名（与 104 文件 :40/:44/:48/:52 逐条对应）。 */
const INDEXES: ReadonlyArray<{ table: string; index: string }> = [
  { table: 'work_orders', index: 'idx_work_orders_tenant_defver' },
  { table: 'transport_order', index: 'idx_transport_order_tenant_defver' },
  { table: 'business_flow_tasks', index: 'idx_business_flow_tasks_tenant_defver' },
  { table: 'inspection_task', index: 'idx_inspection_task_tenant_defver' },
];
const COL = 'def_version';

/** 取迁移文件里某张表的 CREATE TABLE 段（含收尾的 `\n);`）：用真实建表口径，不另写一份。 */
function createTableBlock(file: string, table: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`迁移 ${file} 里找不到 ${table} 的建表语句（护栏已失效，请同步本测试）`);
  const end = text.indexOf('\n);', start);
  return text.slice(start, end < 0 ? text.length : end + 3);
}

/** 剥掉整行注释（`--` 开头）：断言要盯语句本体，注释措辞不该能左右断言结果。 */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');
}

/** _migrations 记账表建表原文（与 src/db/migrate.ts:31-34 同款）。 */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS _migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`;

/**
 * 真建 4 张业务表 + 真跑 102/103 加列 + 真建 _migrations。
 * 【为什么必须先跑 102/103】104 的 CREATE INDEX 引用 def_version 列，
 *   列不存在 ⇒ 104 直接 42704/42703 ⇒ 后面的断言全是假红。这是真依赖，不是测试洁癖。
 */
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('001_init.sql', 'work_orders'));
  await db.exec(createTableBlock('034_emergency_transport.sql', 'transport_order'));
  await db.exec(createTableBlock('030_business_flow.sql', 'business_flow_tasks'));
  await db.exec(createTableBlock('011_inspection.sql', 'inspection_task'));
  await db.exec(MIGRATIONS_TABLE);
  // 102：给后三张表加列；103：给工单加列（都是根目录迁移文件原文）
  await db.exec(readFileSync(join(ROOT, '102_inflight_def_version.sql'), 'utf8'));
  await db.exec(readFileSync(join(ROOT, '103_inflight_def_version_workorder.sql'), 'utf8'));
  return db;
}

async function ledgerHas(db: PGlite, name: string): Promise<boolean> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM _migrations WHERE name = $1`, [name]);
  return Number(r.rows[0]?.n ?? 0) > 0;
}

/** 真查系统表：某条索引在不在（按名精确查，不靠猜）。 */
async function indexExists(db: PGlite, index: string): Promise<boolean> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = $1`, [index]);
  return Number(r.rows[0]?.n ?? 0) > 0;
}

/** 真查系统表取索引定义原文（indexdef 里含 USING 列序与 WHERE 谓词）。 */
async function indexDef(db: PGlite, index: string): Promise<string> {
  const r = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [index]);
  const row = r.rows[0];
  if (!row) throw new Error(`索引 ${index} 不存在`);
  return row.indexdef;
}

/**
 * 🔴 **按真实迁移通道的口径**应用 104：已记账 ⇒ skip（migrate.ts:61 `continue`）。
 * 【为什么不能直接 db.exec(UP)】那是"无条件执行"，真实通道不是这样 ——
 * 无条件 exec 会把「只删索引不擦账」这个假回退**洗绿**（索引被硬跑一遍建回来了），
 * 恰恰是这个洞最需要被钉住的地方。故本函数必须复刻 migrate.ts 的 skip 语义。
 * @returns 是否真的执行了（false = 被记账 skip 掉）
 */
async function apply104ViaMigrate(db: PGlite): Promise<boolean> {
  if (await ledgerHas(db, UP_NAME)) return false; // migrate.ts:61
  await db.exec(UP);
  // migrate.ts:87：跑完才记账，口径一致（ON CONFLICT DO NOTHING，只增不删）
  await db.query(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [UP_NAME]);
  return true;
}

/** 反向迁移的真实执行方式：人手工 `psql -v ON_ERROR_STOP=1 -f rollback/xxx_down.sql`（自带事务）。 */
async function applyDownViaPsql(db: PGlite, sql: string = DOWN): Promise<void> {
  await db.exec(sql);
}

/** 造「只删索引不擦账」的变体：把 down 里擦账那一条 DELETE 去掉（其余一字不改）。 */
function withoutLedgerWipe(sql: string): string {
  const out = stripSqlComments(sql)
    .split('\n')
    .filter((l) => !/DELETE\s+FROM\s+_migrations/i.test(l))
    .join('\n');
  if (out === stripSqlComments(sql)) {
    throw new Error('变体构造失败：down 文件里没找到擦账 DELETE（本测试已失效，请检查 down 文件）');
  }
  return out;
}

describe('104 反向迁移实跑闭环（应用104 → 应用down → 再应用104）', () => {
  it('① 应用 104：4 条索引都在 + 记账在', async () => {
    const db = await freshDb();
    for (const { index } of INDEXES) {
      expect(await indexExists(db, index), `迁移前不该有 ${index}`).toBe(false);
    }
    expect(await ledgerHas(db, UP_NAME), '迁移前不该有记账').toBe(false);

    const ran = await apply104ViaMigrate(db);
    expect(ran, '104 应真的被执行（不该被 skip）').toBe(true);
    for (const { index } of INDEXES) {
      expect(await indexExists(db, index), `迁移后必须有 ${index}`).toBe(true);
    }
    expect(await ledgerHas(db, UP_NAME), '迁移后必须有记账').toBe(true);
  });

  it('② 应用反向迁移：索引没了 **且记账也没了**（只删索引不擦账 = 假回退）', async () => {
    const db = await freshDb();
    await apply104ViaMigrate(db);
    await applyDownViaPsql(db);

    for (const { index } of INDEXES) {
      expect(await indexExists(db, index), `反向后 ${index} 必须没了`).toBe(false);
    }
    // 🔴 这一条就是"假回退"唯一的机器拦截点：
    //    账还在 ⇒ 下次 migrate 永久 skip ⇒ 索引永远回不来 ⇒ 永久全表扫，且不报错不告警。
    expect(await ledgerHas(db, UP_NAME), '反向后记账仍在 ⇒ 假回退').toBe(false);
  });

  it('③ 再次应用 104（走真实通道）：没被 skip、索引能重新建回来 —— "退回去还能再上来"', async () => {
    const db = await freshDb();
    await apply104ViaMigrate(db);
    await applyDownViaPsql(db);
    for (const { index } of INDEXES) {
      expect(await indexExists(db, index)).toBe(false);
    }

    // 🔴 关键：走真实通道。若 ② 没擦账，这里会被 skip ⇒ ran=false ⇒ 索引回不来 ⇒ 本条红。
    const ran = await apply104ViaMigrate(db);
    expect(ran, '重新上线时 104 不该被记账 skip 掉').toBe(true);
    for (const { index } of INDEXES) {
      expect(await indexExists(db, index), `再应用 104 后 ${index} 必须建回来`).toBe(true);
    }
    expect(await ledgerHas(db, UP_NAME), '重新记账').toBe(true);
  });

  it('④ 反向幂等：连续执行 2 次不报错，索引仍不在', async () => {
    const db = await freshDb();
    await apply104ViaMigrate(db);
    await applyDownViaPsql(db);
    await applyDownViaPsql(db);
    for (const { index } of INDEXES) {
      expect(await indexExists(db, index)).toBe(false);
    }
    expect(await ledgerHas(db, UP_NAME)).toBe(false);
  });

  it('⑤ 🔴 必须是**部分索引**：索引定义里带 WHERE def_version > 0', async () => {
    const db = await freshDb();
    await apply104ViaMigrate(db);
    for (const { table, index } of INDEXES) {
      const def = await indexDef(db, index);
      // 列序必须是 (tenant_id, def_version)：与查询条件同序才能走索引扫。
      expect(def, `${index} 列序`).toMatch(/USING\s+\w+\s*\(\s*tenant_id\s*,\s*def_version\s*\)/i);
      // 🔴 谓词必须带 def_version > 0：存量行全是 0 哨兵，普通复合索引会把 100% 的行
      //    塞进索引 ⇒ 索引体积≈全表 + 建单热路径写放大（104 文件 :14-25）。
      expect(def, `${index} 缺少部分索引谓词`).toMatch(/WHERE\s*\(?\s*def_version\s*>\s*0\s*\)?/i);
      expect(def, `${index} 应建在 ${table} 上`).toContain(table);
    }
  });

  it('⑥ 🔴 假回退钉死：只删索引不擦账 ⇒ 再上线被 skip ⇒ 索引回不来（且不报错，静默退化）', async () => {
    const db = await freshDb();
    await apply104ViaMigrate(db);
    // 插一行真实业务数据并把版本设为 > 0，好让"版本探测"查询真的有东西可查。
    await db.exec(
      `INSERT INTO work_orders (id, tenant_id, business_type, title, status, ${COL})
       VALUES ('wo-1', 'tenant-1', 'repair', '在途单', 'draft', 2)`,
    );

    // 变体：把擦账那一条 DELETE 去掉（只改内存里的 SQL，**不动仓库里的 down 文件**）
    await applyDownViaPsql(db, withoutLedgerWipe(DOWN));

    // 假回退的表象：索引确实没了……
    for (const { index } of INDEXES) {
      expect(await indexExists(db, index), `变体下 ${index} 应被删掉`).toBe(false);
    }
    // ……但账还在 ⇒ 真实通道会 skip ⇒ 索引永远回不来
    expect(await ledgerHas(db, UP_NAME), '变体下记账应残留（这正是假回退的特征）').toBe(true);
    const ran = await apply104ViaMigrate(db);
    expect(ran, '假回退后重新上线，104 被 skip（索引回不来）').toBe(false);
    expect(await indexExists(db, 'idx_work_orders_tenant_defver'), '索引没被建回来').toBe(false);

    // 🔴 最阴的部分：**功能完全正常**。这条热路径探测查询照常返回正确结果，
    //    只是退化成全表扫 —— 不报错、不告警，没人看得出来。
    const r = await db.query<{ v: number }>(
      `SELECT DISTINCT ${COL} AS v FROM work_orders WHERE tenant_id = $1 AND ${COL} > 0`,
      ['tenant-1'],
    );
    expect(r.rows.map((x) => x.v), '探测查询仍能返回正确结果 ⇒ 静默退化').toEqual([2]);
  });
});

describe('104 反向文件形态（静态断言，闭环成立的前提）', () => {
  it('⑦ 正向在根目录（两条通道扫得到）；反向绝不能在根目录', () => {
    expect(existsSync(UP_PATH)).toBe(true);
    // 放根目录会被当成正向迁移紧跟着 104 跑 ⇒ 刚建的 4 条索引被同一次 migrate 删掉。
    expect(existsSync(join(ROOT, '104_inflight_def_version_index_down.sql')), 'down 不该在根目录').toBe(false);
    expect(existsSync(DOWN_PATH), 'down 应在 rollback/ 下').toBe(true);
  });

  it('⑧ 顺序硬要求：擦账 DELETE 排在 DROP INDEX 之前', () => {
    const body = stripSqlComments(DOWN);
    const del = body.search(/DELETE\s+FROM\s+_migrations/i);
    const drop = body.search(/DROP\s+INDEX/i);
    expect(del, 'down 里找不到擦账 DELETE').toBeGreaterThan(-1);
    expect(drop, 'down 里找不到 DROP INDEX').toBeGreaterThan(-1);
    // 失败态必须落在「索引还在 + 账已擦」那一侧（可自愈），不能落在「索引已删 + 账还在」。
    expect(del, '擦账必须排在删索引之前').toBeLessThan(drop);
  });

  it('⑨ down 自带显式事务（禁止叠加 --single-transaction）', () => {
    expect(DOWN).toMatch(/^\s*BEGIN\s*;/im);
    expect(DOWN).toMatch(/^\s*COMMIT\s*;/im);
  });

  it('⑩ 擦账 key 写死文件名（两条通道存的都是文件名，不带路径）', () => {
    // 必须在**剥掉注释**的语句本体上断言：down 头注释本身就含这个文件名，原文 toContain 会被注释满足。
    const body = stripSqlComments(DOWN);
    const key = UP_NAME.replace(/\./g, '\\.');
    expect(body).toMatch(new RegExp(`DELETE\\s+FROM\\s+_migrations\\s+WHERE\\s+name\\s*=\\s*'${key}'`, 'i'));
  });

  it('⑪ 四条 DROP INDEX 与 104 的四条 CREATE INDEX 一一对应，不漏不重', () => {
    const downBody = stripSqlComments(DOWN);
    for (const { index } of INDEXES) {
      // 正向建了就得能反向删：名字写错（如少个 s）会让 DROP IF EXISTS 静敏空操作 ⇒ 索引残留。
      expect(UP, `104 里没有建 ${index}`).toMatch(new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${index}\\b`, 'i'));
      expect(downBody, `down 里没有删 ${index}`).toMatch(
        new RegExp(`DROP\\s+INDEX\\s+IF\\s+EXISTS\\s+${index}\\s*;`, 'i'),
      );
    }
    const created = (stripSqlComments(UP).match(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/gi) ?? []).length;
    const dropped = (downBody.match(/DROP\s+INDEX\s+IF\s+EXISTS/gi) ?? []).length;
    expect(created, '正向建索引条数').toBe(INDEXES.length);
    expect(dropped, '反向删索引条数').toBe(created);
  });
});
