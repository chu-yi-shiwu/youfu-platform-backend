/**
 * 103_inflight_def_version_workorder —— 反向迁移**实跑**闭环验证（PGlite 真库 + 真 SQL）
 *
 * 【为什么必须有这份】
 *   rollback/103_inflight_def_version_workorder_down.sql:83-87 自己写着：
 *   「本文件尚未实跑验证……上线前必须补 migration103.pglite.test.ts 走完
 *     『应用 103 → 确认列在 → 应用本文件 → 确认列没了且记账也没了 →
 *       再应用 103 → 确认列能加回来』这条闭环。」
 *   写了没跑过的反向迁移**不算回退方案**（总则 E1 的镜像：事前写了但没验过，同样不算）
 *   ⇒ 本文件是 103 上线的**前置条件**，不是可选护栏。
 *
 * 【🔴 与 migration102.pglite.test.ts 里 103-①~⑮ 的关系（重要，别当重复删掉）】
 *   那份文件里的 103-①~⑮ 是「102 口径逐条搬到 work_orders」的镜像，覆盖列形状 /
 *   幂等 / E4 / 文件位置等静态面。但它的第 3 步（103-⑧）是这样写的：
 *       await db.exec(UP103);   // ← **无条件**执行
 *   而**真实的 migrate 通道不是无条件执行的**：
 *       src/db/migrate.ts:61    if (applied.has(file)) continue;      ← 已记账就 skip
 *       scripts/migrate-as-owner.sh:22-25  查到 exists=1 就 skip
 *   ⇒ 「只删列不擦账」这种**假回退**，在 103-⑧ 那种无条件 exec 下**仍然绿**
 *     （SQL 被硬跑了一遍，列当然回来了），纸面上看不出洞。
 *   本文件因此把第 3 步建模成**真实的迁移通道**（apply103 = 先查账，已记账就 skip），
 *   ⇒ 假回退会让第 3 步**真红**。这是本文件相对既有 103-⑧ 唯一的、也是关键的增量。
 *   （变异实测：去掉 down 里的 DELETE 后，既有 103-⑧ 绿、本文件第 3 步红 —— 见报告。）
 *
 * 【验证口径（团队要求的最小闭环，缺一步不算完成）】
 *   ① 应用 103（走真实通道）→ 列在 + 记账在
 *   ② 应用反向迁移（人工 psql -f）→ 列没了 **且记账也没了**
 *   ③ 再次应用 103（走真实通道）→ 列**能加回来**（= "退回去还能再上来"）
 *   ④ 反向幂等、⑤ 其它列一行不动
 *   ⑥ 🔴 假回退钉死：把「只删列不擦账」的变体跑一遍，证明 ③ 会失败且落到 42703
 *
 * 【真库口径】真 PGlite + 真 SQL，不 mock、不只断言文件内容。
 *   work_orders 建表取 001_init.sql 原文（全仓仅此一处 CREATE TABLE work_orders）。
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const UP_PATH = join(ROOT, '103_inflight_def_version_workorder.sql');
const DOWN_PATH = join(ROOT, 'rollback', '103_inflight_def_version_workorder_down.sql');
const UP = readFileSync(UP_PATH, 'utf8');
const DOWN = readFileSync(DOWN_PATH, 'utf8');
/** 记账 key = 正向迁移的**文件名**（migrate.ts:87 / shell :40 存的都是文件名，不带路径）。 */
const UP_NAME = '103_inflight_def_version_workorder.sql';
const TABLE = 'work_orders';
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

/** 真建 work_orders（001 建表原文）+ 真建 _migrations 记账表。 */
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('001_init.sql', TABLE));
  await db.exec(MIGRATIONS_TABLE);
  return db;
}

async function ledgerHas(db: PGlite, name: string): Promise<boolean> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM _migrations WHERE name = $1`, [name]);
  return Number(r.rows[0]?.n ?? 0) > 0;
}

async function columnsOf(db: PGlite, table: string): Promise<string[]> {
  const r = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
    [table],
  );
  return r.rows.map((x) => x.column_name);
}

/**
 * 🔴 **按真实迁移通道的口径**应用 103：已记账 ⇒ skip（migrate.ts:61 `continue`）。
 * 【为什么不能直接 db.exec(UP)】那是"无条件执行"，真实通道不是这样 ——
 * 无条件 exec 会把「只删列不擦账」这个假回退**洗绿**（列被硬跑一遍加回来了），
 * 恰恰是这个洞最需要被钉住的地方。故本函数必须复刻 migrate.ts 的 skip 语义。
 * @returns 是否真的执行了（false = 被记账 skip 掉）
 */
async function apply103ViaMigrate(db: PGlite): Promise<boolean> {
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

/** 造「只删列不擦账」的变体：把 down 里擦账那一条 DELETE 去掉（其余一字不改）。 */
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

describe('103 反向迁移实跑闭环（应用103 → 应用down → 再应用103）', () => {
  it('① 应用 103：列在 + 记账在', async () => {
    const db = await freshDb();
    expect(await columnsOf(db, TABLE), '迁移前不该有 def_version').not.toContain(COL);
    expect(await ledgerHas(db, UP_NAME), '迁移前不该有记账').toBe(false);

    const ran = await apply103ViaMigrate(db);
    expect(ran, '103 应真的被执行（不该被 skip）').toBe(true);
    expect(await columnsOf(db, TABLE), '迁移后必须有 def_version').toContain(COL);
    expect(await ledgerHas(db, UP_NAME), '迁移后必须有记账').toBe(true);
  });

  it('② 应用反向迁移：列没了 **且记账也没了**（只删列不擦账 = 假回退）', async () => {
    const db = await freshDb();
    await apply103ViaMigrate(db);
    await applyDownViaPsql(db);

    expect(await columnsOf(db, TABLE), '反向后列必须没了').not.toContain(COL);
    // 🔴 这一条就是"假回退"唯一的机器拦截点：
    //    账还在 ⇒ 下次 migrate 永久 skip ⇒ 列永远回不来 ⇒ 代码 INSERT def_version ⇒ 42703 ⇒ 500
    expect(await ledgerHas(db, UP_NAME), '反向后记账仍在 ⇒ 假回退').toBe(false);
  });

  it('③ 再次应用 103（走真实通道）：列能加回来 —— "退回去还能再上来"', async () => {
    const db = await freshDb();
    await apply103ViaMigrate(db);
    await applyDownViaPsql(db);
    expect(await columnsOf(db, TABLE)).not.toContain(COL);

    // 🔴 关键：走真实通道。若 ② 没擦账，这里会被 skip ⇒ ran=false ⇒ 列回不来 ⇒ 本条红。
    const ran = await apply103ViaMigrate(db);
    expect(ran, '重新上线时 103 不该被记账 skip 掉').toBe(true);
    expect(await columnsOf(db, TABLE), '再应用 103 后列必须加回来').toContain(COL);
    expect(await ledgerHas(db, UP_NAME), '重新记账').toBe(true);
  });

  it('④ 反向幂等：连续执行 2 次不报错，列仍不在', async () => {
    const db = await freshDb();
    await apply103ViaMigrate(db);
    await applyDownViaPsql(db);
    await applyDownViaPsql(db);
    expect(await columnsOf(db, TABLE)).not.toContain(COL);
    expect(await ledgerHas(db, UP_NAME)).toBe(false);
  });

  it('⑤ 反向只动 def_version，work_orders 其它列一行不动', async () => {
    const db = await freshDb();
    const before = await columnsOf(db, TABLE);
    await apply103ViaMigrate(db);
    await applyDownViaPsql(db);
    expect(await columnsOf(db, TABLE), '反向后列集合必须与迁移前逐项相等').toEqual(before);
  });

  it('⑥ 🔴 假回退钉死：只删列不擦账 ⇒ 再上线被 skip ⇒ 读列 42703', async () => {
    const db = await freshDb();
    await apply103ViaMigrate(db);
    // 先插一行真实业务数据，好让 42703 真的炸在查询上（空表 SELECT 未必触发）。
    await db.exec(
      `INSERT INTO work_orders (id, tenant_id, business_type, title, status)
       VALUES ('wo-1', 'tenant-1', 'repair', '在途单', 'draft')`,
    );

    // 变体：把擦账那一条 DELETE 去掉（只改内存里的 SQL，**不动仓库里的 down 文件**）
    await applyDownViaPsql(db, withoutLedgerWipe(DOWN));

    // 假回退的表象：列确实没了……
    expect(await columnsOf(db, TABLE), '变体下列应被删掉').not.toContain(COL);
    // ……但账还在 ⇒ 真实通道会 skip ⇒ 列永远回不来
    expect(await ledgerHas(db, UP_NAME), '变体下记账应残留（这正是假回退的特征）').toBe(true);
    const ran = await apply103ViaMigrate(db);
    expect(ran, '假回退后重新上线，103 被 skip（列回不来）').toBe(false);
    expect(await columnsOf(db, TABLE), '列没被加回来').not.toContain(COL);

    // 落到生产症状：读 def_version ⇒ 42703 ⇒ 500
    let err: unknown = null;
    try {
      await db.query(`SELECT ${COL} FROM ${TABLE} WHERE id = 'wo-1'`);
    } catch (e) {
      err = e;
    }
    expect(err, '列不在却没报错 ⇒ 洞没被钉住').not.toBeNull();
    expect(String((err as { message?: string } | null)?.message ?? '')).toMatch(/def_version/i);
  });
});

describe('103 反向文件形态（静态断言，闭环成立的前提）', () => {
  it('⑦ 正向在根目录（两条通道扫得到）；反向绝不能在根目录', () => {
    expect(existsSync(UP_PATH)).toBe(true);
    // 放根目录会被当成正向迁移紧跟着 103 跑 ⇒ 刚加的列被同一次 migrate 删掉。
    expect(existsSync(join(ROOT, '103_inflight_def_version_workorder_down.sql')), 'down 不该在根目录').toBe(false);
    expect(existsSync(DOWN_PATH), 'down 应在 rollback/ 下').toBe(true);
  });

  it('⑧ 顺序硬要求：擦账 DELETE 排在 DROP COLUMN 之前', () => {
    const body = stripSqlComments(DOWN);
    const del = body.search(/DELETE\s+FROM\s+_migrations/i);
    const drop = body.search(/DROP\s+COLUMN/i);
    expect(del, 'down 里找不到擦账 DELETE').toBeGreaterThan(-1);
    expect(drop, 'down 里找不到 DROP COLUMN').toBeGreaterThan(-1);
    // 失败态必须落在「列还在 + 账已擦」那一侧（可自愈），不能落在「列已删 + 账还在」。
    expect(del, '擦账必须排在删列之前').toBeLessThan(drop);
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
});
