/**
 * 102 / 103_inflight_def_version —— PGlite 真跑验证（正向 + **反向**）
 *
 * 【为什么必须有这份】
 *   T1-B 的回退 = ① git revert 代码提交 + ② 反向迁移 DROP COLUMN。
 *   **git revert 掉不掉加列**：迁移由 _migrations 按文件名追踪（src/db/migrate.ts），
 *   回滚代码不会撤销已执行的 ALTER TABLE，重跑 migrate 也不会自动撤。
 *   ⇒ 只 revert 不跑反向迁移 = 代码回退了、库里多 3 列，属于"回退不彻底"。
 *   而**写了没跑过的反向迁移不算回退方案**（总则 E1 的镜像：事前写了但没验过，同样不算）。
 *   与 093/094/095/096/097/101 同款口径：真建库 → 真执行 → 查真列。
 *
 * 【验证口径】
 *   ① 正向：3 列都在，且 **int NOT NULL DEFAULT 0**
 *   ② 幂等：重复执行 3 次不报错
 *   ③ 新行默认值 = 0；且**存量行跑完迁移后仍为 0**（E4：不伪造建单版本）
 *   ④ 🔴 E4 硬闸：迁移文件里**不含任何 UPDATE <业务表> SET def_version**
 *   ⑤ 反向：3 列全没了，且**表的其它列一行不动**
 *   ⑥ 正 → 反 → 正：3 列去而复返（= "退回去还能再上来"）
 *   ⑦ 记账往返：反向必须把 _migrations 里 102 的账也擦掉（只删列不擦账 = 假回退）
 *   ⑧ 反向幂等
 *   ⑨ 位置：正向在仓库根目录（两条自动通道扫得到），反向在 rollback/（扫不到）
 *   ⑩ 顺序：down 文件里「擦账 DELETE」必须排在「DROP COLUMN」之前
 *   ⑪ 自带显式事务 BEGIN/COMMIT（禁止叠加 --single-transaction）
 *
 * 【103（work_orders）为什么也在这份文件里，不另开一个文件】
 *   T1-B 批 4 给 work_orders 加同名列 def_version，口径与 102 逐条相同。
 *   本轮硬约束是「**不许新增任何护栏/探针/自检项，验收一律扩在既有测试文件里**」
 *   ⇒ 103 的正向 + 反向验证就长在本文件里（编号 103-① ~ 103-⑮），不新建测试文件。
 *
 * 【103 与 102 的形状差异（其余口径完全相同）】
 *   · 102 管 **3 张表**（inspection_task / transport_order / business_flow_tasks）；
 *   · 103 只管 **1 张表**（work_orders）—— 工单单独成一份迁移，为的是这一列能
 *     **独立回退**、不牵连已上线的那三张表（理由见 103 迁移文件头注释 :33-40）。
 *   ⇒ 把上面 ①~⑮ 逐条搬到 work_orders 上即得 103-①~103-⑮，
 *     唯一的区别是「三表循环」退化成「单表」，断言口径一字不改。
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const UP_PATH = join(ROOT, '102_inflight_def_version.sql');
const DOWN_PATH = join(ROOT, 'rollback', '102_inflight_def_version_down.sql');
const UP = readFileSync(UP_PATH, 'utf8');
const DOWN = readFileSync(DOWN_PATH, 'utf8');
/** 正向迁移的文件名 = 两条通道的记账 key（存文件名，不带路径）。 */
const UP_NAME = '102_inflight_def_version.sql';
const TABLES = ['inspection_task', 'transport_order', 'business_flow_tasks'] as const;
const COL = 'def_version';

/* ───────────── 103_inflight_def_version_workorder（T1-B 批 4：工单） ───────────── */
/** 103 只管 1 张表（102 管 3 张）—— 形状差异仅此一处，其余口径与 102 完全相同。 */
const TABLE103 = 'work_orders';
const UP103_PATH = join(ROOT, '103_inflight_def_version_workorder.sql');
const DOWN103_PATH = join(ROOT, 'rollback', '103_inflight_def_version_workorder_down.sql');
const UP103 = readFileSync(UP103_PATH, 'utf8');
const DOWN103 = readFileSync(DOWN103_PATH, 'utf8');
/** 103 的记账 key = 正向迁移的文件名（与 102 同款：两条通道存的都是文件名，不带路径）。 */
const UP103_NAME = '103_inflight_def_version_workorder.sql';

/** 取迁移文件里某张表的 CREATE TABLE 段（到 `\n);` 为止）：用真实建表口径，不自己另写一份。 */
function createTableBlock(file: string, table: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`迁移 ${file} 里找不到 ${table} 的建表语句（护栏已失效，请同步本测试）`);
  const end = text.indexOf('\n);', start);
  // 必须把收尾的 '\n);' 一起切进来 —— 只切到 end 会拿到没有右括号的 CREATE TABLE。
  return text.slice(start, end < 0 ? text.length : end + 3);
}

/**
 * 剥掉整行注释（`--` 开头），只留 SQL 语句本体。
 * 【为什么必须剥】down 文件的注释里为了讲清顺序，必然会提到这些关键词；
 * 若不剥离，"第 N 个字符"会被注释里的措辞带偏（本次实测踩到：注释里写了
 * `DROP COLUMN IF EXISTS`，导致顺序断言把注释位置当成了语句位置）。
 * ⇒ 断言要盯**语句本体**，注释措辞不该能左右断言结果。
 */
function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');
}

/**
 * _migrations 记账表建表原文（与 src/db/migrate.ts:31-34 同款）。
 * 【为什么抽成常量】103 的库也要同一张记账表；抽出来才不会有两份真源、
 * 也不会为了复用而改动 freshDb() 的既有行为。
 * 【为什么必须连记账表一起建】反向迁移要 `DELETE FROM _migrations ...`（擦账），
 * 没有这张表 ⇒ down 直接报 relation does not exist ⇒ 反向那几条假红。
 */
const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS _migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`;

/**
 * 真建三张业务表（011 inspection_task / 034 transport_order / 030 business_flow_tasks）
 * + 真建 _migrations 记账表。
 */
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('011_inspection.sql', 'inspection_task'));
  await db.exec(createTableBlock('034_emergency_transport.sql', 'transport_order'));
  await db.exec(createTableBlock('030_business_flow.sql', 'business_flow_tasks'));
  await db.exec(MIGRATIONS_TABLE);
  return db;
}

/**
 * 103 专用库：只建 work_orders（001 建表原文）+ _migrations 记账表。
 * 【为什么只建这一张表】103 迁移只碰 work_orders，多建表既无必要又会拖慢；
 * 建表用 001_init.sql 的原文（全仓 `CREATE TABLE IF NOT EXISTS work_orders` 只此一处）。
 */
async function freshDb103(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('001_init.sql', TABLE103));
  await db.exec(MIGRATIONS_TABLE);
  return db;
}

/** 记账表里有没有这条迁移（模拟"102 已被应用过"）。 */
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

/** 列的可空性 + 默认值：直接查 information_schema，不猜。 */
async function colShape(
  db: PGlite,
  table: string,
): Promise<{ isNullable: boolean; dataType: string; def: string | null }> {
  const r = await db.query<{ is_nullable: string; data_type: string; column_default: string | null }>(
    `SELECT is_nullable, data_type, column_default FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`,
    [table, COL],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`${table}.${COL} 不存在`);
  return { isNullable: row.is_nullable === 'YES', dataType: row.data_type, def: row.column_default };
}

describe('102_inflight_def_version 正向', () => {
  it('① 三张表都加上 def_version', async () => {
    const db = await freshDb();
    for (const t of TABLES) expect(await columnsOf(db, t)).not.toContain(COL);
    await db.exec(UP);
    for (const t of TABLES) expect(await columnsOf(db, t)).toContain(COL);
  });

  it('② 列形状：integer / NOT NULL / DEFAULT 0（三表一致）', async () => {
    const db = await freshDb();
    await db.exec(UP);
    for (const t of TABLES) {
      const s = await colShape(db, t);
      expect(s.dataType, `${t} 类型`).toBe('integer');
      expect(s.isNullable, `${t} 可空`).toBe(false);
      expect(s.def, `${t} 默认值`).toBe('0');
    }
  });

  it('③ 幂等：连续执行 3 次不报错，列仍然只有一份', async () => {
    const db = await freshDb();
    await db.exec(UP);
    await db.exec(UP);
    await db.exec(UP);
    for (const t of TABLES) {
      const cols = await columnsOf(db, t);
      expect(cols.filter((c) => c === COL).length).toBe(1);
    }
  });

  it('④ E4：迁移后新行与存量行的 def_version 都是 0，且不捏造建单版本', async () => {
    const db = await freshDb();
    // 迁移前先插一行（模拟存量）。id 是 uuid PRIMARY KEY DEFAULT gen_random_uuid()，
    // 不手工塞 id —— 塞了会被 PGlite 判类型错误，那是测试自己的 bug 不是迁移的。
    await db.exec(
      `INSERT INTO inspection_task (tenant_id, title, status)
       VALUES ('tenant-1', '存量单', 'draft')`,
    );
    await db.exec(UP);
    await db.exec(
      `INSERT INTO inspection_task (tenant_id, title, status)
       VALUES ('tenant-1', '新单', 'draft')`,
    );
    const r = await db.query<{ title: string; v: number }>(
      `SELECT title, ${COL} AS v FROM inspection_task`,
    );
    // 不依赖 ORDER BY（中文排序随 locale 变），按 title 取值断言。
    const m = new Map(r.rows.map((x) => [x.title, x.v]));
    expect(m.get('存量单'), '存量行').toBe(0);
    expect(m.get('新单'), '新行').toBe(0);
  });

  it('⑤ 🔴 E4 硬闸：迁移文件里不含任何 UPDATE 业务表 SET def_version', () => {
    // 「把存量填成当前 version」= 伪造数据（总则 E4）。本条是唯一能机器拦住它的断言。
    for (const t of TABLES) {
      const re = new RegExp(`UPDATE\\s+${t}\\s+SET\\s+${COL}`, 'i');
      expect(UP, `正向迁移里出现了 UPDATE ${t} SET ${COL}`).not.toMatch(re);
    }
    // 兜底：整个文件里一条 UPDATE 都不该有（本迁移只是加列）
    expect(UP.trim()).not.toMatch(/^\s*UPDATE\s/im);
  });
});

describe('102_inflight_def_version 反向', () => {
  it('⑥ 反向删掉 3 列，且其它列一行不动', async () => {
    const db = await freshDb();
    const before: Record<string, string[]> = {};
    for (const t of TABLES) before[t] = await columnsOf(db, t);
    await db.exec(UP);
    await db.exec(DOWN);
    for (const t of TABLES) {
      expect(await columnsOf(db, t), `${t} 反向后`).toEqual(before[t]);
    }
  });

  it('⑦ 反向幂等：连续执行 2 次不报错', async () => {
    const db = await freshDb();
    await db.exec(UP);
    await db.exec(DOWN);
    await db.exec(DOWN);
    for (const t of TABLES) expect(await columnsOf(db, t)).not.toContain(COL);
  });

  it('⑧ 正 → 反 → 正：3 列去而复返（退回去还能再上来）', async () => {
    const db = await freshDb();
    await db.exec(UP);
    for (const t of TABLES) expect(await columnsOf(db, t)).toContain(COL);
    await db.exec(DOWN);
    for (const t of TABLES) expect(await columnsOf(db, t)).not.toContain(COL);
    await db.exec(UP);
    for (const t of TABLES) expect(await columnsOf(db, t)).toContain(COL);
  });

  it('⑨ 记账往返：反向把 _migrations 里 102 的账也擦掉（只删列不擦账 = 假回退）', async () => {
    const db = await freshDb();
    await db.exec(UP);
    // 必须用 query 而不是 exec：PGlite 的 exec 不绑定参数，$1 会原样发给 PG ⇒ 报错。
    await db.query(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [UP_NAME]);
    expect(await ledgerHas(db, UP_NAME)).toBe(true);
    await db.exec(DOWN);
    expect(await ledgerHas(db, UP_NAME), '反向后记账仍在').toBe(false);
  });

  it('⑩ 反向后再正向 → 记账重新回来（模拟"回退 → 修 bug → 重新上线"）', async () => {
    const db = await freshDb();
    await db.exec(UP);
    await db.query(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [UP_NAME]);
    await db.exec(DOWN);
    await db.exec(UP);
    await db.query(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [UP_NAME]);
    expect(await ledgerHas(db, UP_NAME)).toBe(true);
    for (const t of TABLES) expect(await columnsOf(db, t)).toContain(COL);
  });
});

describe('102 文件位置与形态（静态断言）', () => {
  it('⑪ 正向在仓库根目录（两条自动通道扫得到）', () => {
    expect(existsSync(UP_PATH)).toBe(true);
    // 反向**绝不能**在根目录：两条通道都按「数字前缀 + .sql」扫根目录，
    // 放那里会被当成正向迁移紧跟着 102 执行 ⇒ 刚加的 3 列被同一次 migrate 删掉。
    for (const f of ['102_inflight_def_version_down.sql']) {
      expect(existsSync(join(ROOT, f)), `${f} 不该在根目录`).toBe(false);
    }
  });

  it('⑫ 反向在 rollback/ 子目录（两条通道都扫不到）', () => {
    expect(existsSync(DOWN_PATH)).toBe(true);
  });

  it('⑬ 顺序硬要求：down 文件里「擦账 DELETE」排在「DROP COLUMN」之前', () => {
    const body = stripSqlComments(DOWN); // 在语句本体上定位，不被注释措辞带偏
    const del = body.search(/DELETE\s+FROM\s+_migrations/i);
    const drop = body.search(/DROP\s+COLUMN/i);
    expect(del, 'down 文件里找不到擦账 DELETE').toBeGreaterThan(-1);
    expect(drop, 'down 文件里找不到 DROP COLUMN').toBeGreaterThan(-1);
    // 失败态必须落在「列还在 + 账已擦」那一侧（可自愈），不能落在「列已删 + 账还在」。
    expect(del, '擦账必须排在删列之前').toBeLessThan(drop);
  });

  it('⑭ down 文件自带显式事务（禁止叠加 --single-transaction）', () => {
    expect(DOWN).toMatch(/^\s*BEGIN\s*;/im);
    expect(DOWN).toMatch(/^\s*COMMIT\s*;/im);
  });

  it('⑮ 记账 key 写死文件名（两条通道存的都是文件名，不带路径）', () => {
    expect(DOWN).toContain(UP_NAME);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════
 * 103_inflight_def_version_workorder —— 与上面 ①~⑮ 一一对应，只是「三表」退化成「单表」。
 * 目的是补上「103 反向迁移此前从未实跑」这个洞（E1：写了没验过的反向迁移不算回退方案）。
 * ══════════════════════════════════════════════════════════════════════════════════ */

describe('103_inflight_def_version_workorder 正向', () => {
  it('103-① work_orders 加上 def_version', async () => {
    const db = await freshDb103();
    expect(await columnsOf(db, TABLE103), '迁移前不该有 def_version').not.toContain(COL);
    await db.exec(UP103);
    expect(await columnsOf(db, TABLE103), '迁移后必须有 def_version').toContain(COL);
  });

  it('103-② 列形状：integer / NOT NULL / DEFAULT 0', async () => {
    const db = await freshDb103();
    await db.exec(UP103);
    const s = await colShape(db, TABLE103);
    expect(s.dataType, '类型').toBe('integer');
    expect(s.isNullable, '可空').toBe(false);
    expect(s.def, '默认值').toBe('0');
  });

  it('103-③ 幂等：连续执行 3 次不报错，列仍然只有一份', async () => {
    const db = await freshDb103();
    await db.exec(UP103);
    await db.exec(UP103);
    await db.exec(UP103);
    const cols = await columnsOf(db, TABLE103);
    expect(cols.filter((c) => c === COL).length).toBe(1);
  });

  it('103-④ E4：迁移后新行与存量行的 def_version 都是 0，且不捏造建单版本', async () => {
    const db = await freshDb103();
    // 🔴 存量行必须在 exec UP103 **之前**插入，否则测不到「存量行迁移后是 0」。
    // id 是 text PRIMARY KEY（001:25），不依赖自增；status 取 CHECK 枚举内的 'draft'（001:34-35）。
    await db.exec(
      `INSERT INTO work_orders (id, tenant_id, business_type, title, status)
       VALUES ('wo-old-1', 'tenant-1', 'repair', '存量单', 'draft')`,
    );
    await db.exec(UP103);
    await db.exec(
      `INSERT INTO work_orders (id, tenant_id, business_type, title, status)
       VALUES ('wo-new-1', 'tenant-1', 'repair', '新单', 'draft')`,
    );
    const r = await db.query<{ title: string; v: number }>(`SELECT title, ${COL} AS v FROM work_orders`);
    // 不依赖 ORDER BY（中文排序随 locale 变），按 title 取值断言。
    const m = new Map(r.rows.map((x) => [x.title, x.v]));
    expect(m.get('存量单'), '存量行').toBe(0);
    expect(m.get('新单'), '新行').toBe(0);
  });

  it('103-⑤ 🔴 E4 硬闸：迁移文件里不含 UPDATE work_orders SET def_version', () => {
    // 「把存量填成当前 version」= 伪造数据（总则 E4）。本条是唯一能机器拦住它的断言。
    const re = new RegExp(`UPDATE\\s+${TABLE103}\\s+SET\\s+${COL}`, 'i');
    expect(UP103, `正向迁移里出现了 UPDATE ${TABLE103} SET ${COL}`).not.toMatch(re);
    // 兜底：整个文件里一条 UPDATE 都不该有（本迁移只是加列）
    expect(UP103.trim()).not.toMatch(/^\s*UPDATE\s/im);
  });
});

describe('103_inflight_def_version_workorder 反向', () => {
  it('103-⑥ 反向删掉 def_version，且其它列一行不动', async () => {
    const db = await freshDb103();
    const before = await columnsOf(db, TABLE103);
    await db.exec(UP103);
    await db.exec(DOWN103);
    expect(await columnsOf(db, TABLE103), '反向后').toEqual(before);
  });

  it('103-⑦ 反向幂等：连续执行 2 次不报错', async () => {
    const db = await freshDb103();
    await db.exec(UP103);
    await db.exec(DOWN103);
    await db.exec(DOWN103);
    expect(await columnsOf(db, TABLE103)).not.toContain(COL);
  });

  it('103-⑧ 正 → 反 → 正：列去而复返（退回去还能再上来）', async () => {
    const db = await freshDb103();
    await db.exec(UP103);
    expect(await columnsOf(db, TABLE103)).toContain(COL);
    await db.exec(DOWN103);
    expect(await columnsOf(db, TABLE103)).not.toContain(COL);
    await db.exec(UP103);
    expect(await columnsOf(db, TABLE103)).toContain(COL);
  });

  it('103-⑨ 记账往返：反向把 _migrations 里 103 的账也擦掉（只删列不擦账 = 假回退）', async () => {
    const db = await freshDb103();
    await db.exec(UP103);
    // 必须用 query 而不是 exec：PGlite 的 exec 不绑定参数，$1 会原样发给 PG ⇒ 报错。
    await db.query(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [UP103_NAME]);
    expect(await ledgerHas(db, UP103_NAME)).toBe(true);
    await db.exec(DOWN103);
    expect(await ledgerHas(db, UP103_NAME), '反向后记账仍在').toBe(false);
  });

  it('103-⑩ 反向后再正向 → 记账重新回来（模拟"回退 → 修 bug → 重新上线"）', async () => {
    const db = await freshDb103();
    await db.exec(UP103);
    await db.query(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [UP103_NAME]);
    await db.exec(DOWN103);
    await db.exec(UP103);
    await db.query(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [UP103_NAME]);
    expect(await ledgerHas(db, UP103_NAME)).toBe(true);
    expect(await columnsOf(db, TABLE103)).toContain(COL);
  });
});

describe('103 文件位置与形态（静态断言）', () => {
  it('103-⑪ 正向在仓库根目录（两条自动通道扫得到）', () => {
    expect(existsSync(UP103_PATH)).toBe(true);
    // 反向**绝不能**在根目录：两条通道都按「数字前缀 + .sql」扫根目录，
    // 放那里会被当成正向迁移紧跟着 103 执行 ⇒ 刚加的列被同一次 migrate 删掉。
    for (const f of ['103_inflight_def_version_workorder_down.sql']) {
      expect(existsSync(join(ROOT, f)), `${f} 不该在根目录`).toBe(false);
    }
  });

  it('103-⑫ 反向在 rollback/ 子目录（两条通道都扫不到）', () => {
    expect(existsSync(DOWN103_PATH)).toBe(true);
  });

  it('103-⑬ 顺序硬要求：down 文件里「擦账 DELETE」排在「DROP COLUMN」之前', () => {
    const body = stripSqlComments(DOWN103); // 在语句本体上定位，不被注释措辞带偏
    const del = body.search(/DELETE\s+FROM\s+_migrations/i);
    const drop = body.search(/DROP\s+COLUMN/i);
    expect(del, 'down 文件里找不到擦账 DELETE').toBeGreaterThan(-1);
    expect(drop, 'down 文件里找不到 DROP COLUMN').toBeGreaterThan(-1);
    // 失败态必须落在「列还在 + 账已擦」那一侧（可自愈），不能落在「列已删 + 账还在」。
    expect(del, '擦账必须排在删列之前').toBeLessThan(drop);
  });

  it('103-⑭ down 文件自带显式事务（禁止叠加 --single-transaction）', () => {
    expect(DOWN103).toMatch(/^\s*BEGIN\s*;/im);
    expect(DOWN103).toMatch(/^\s*COMMIT\s*;/im);
  });

  it('103-⑮ 记账 key 写死文件名（两条通道存的都是文件名，不带路径）', () => {
    // 🔴 必须在**剥掉注释的语句本体**上断言，不能拿原文 toContain：
    //    down 文件头第 2 行的注释「（与 103_inflight_def_version_workorder.sql 成对）」
    //    本身就含这个字符串 ⇒ 原文 toContain 会被**注释**满足。
    //    实测踩到：变异 M4（把 DELETE 的 key 改成去掉 .sql）只红了 103-⑨，
    //    ⑮ 仍绿 —— 那就是一条纸面断言，注释一改就没了。故本条盯语句本体。
    const body = stripSqlComments(DOWN103);
    expect(body, 'down 的语句本体里没有记账 key').toContain(UP103_NAME);
    // 且这个 key 必须就长在**那一条擦账 DELETE** 上，而不是散落在别处。
    const key = UP103_NAME.replace(/\./g, '\\.');
    expect(body).toMatch(new RegExp(`DELETE\\s+FROM\\s+_migrations\\s+WHERE\\s+name\\s*=\\s*'${key}'`, 'i'));
  });
});
