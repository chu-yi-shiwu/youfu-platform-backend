/**
 * 101_config_actor_and_version.sql —— PGlite 真跑验证（正向 + **反向**）
 *
 * 【为什么必须有这份】
 *   T0 的回退 = ① git revert 代码提交 + ② 反向迁移 DROP COLUMN。
 *   **git revert 掉不掉加列**：迁移由 _migrations 按文件名追踪（src/db/migrate.ts），
 *   回滚代码不会撤销已执行的 ALTER TABLE，重跑 migrate 也不会自动撤。
 *   ⇒ 只 revert 不跑反向迁移 = 代码回退了、库里多 4 列，属于"回退不彻底"。
 *   而**写了没跑过的反向迁移不算回退方案**（总则 E1 的镜像：事前写了但没验过，同样不算）。
 *   所以本文件把正向和反向都真跑一遍——与 093/094/095/096/097 同款口径：真建库 → 真执行 → 查真列。
 *
 * 【验证口径】
 *   ① 正向：4 列都在，且**可空 / 有默认值**（这是 DROP COLUMN 安全的前提，不是随手写的）
 *   ② 幂等：重复执行不报错
 *   ③ 反向：4 列全没了，且**表的其它列一行不动**（DROP COLUMN 不能顺手带走既有列）
 *   ④ version 列的存量/新行默认值 = 1（并发锚读到 NULL 就没法比）
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const UP = readFileSync(join(ROOT, '101_config_actor_and_version.sql'), 'utf8');
// 反向迁移**故意不放根目录**：根目录是两条自动迁移通道的扫描范围，
// 放在那里会被当成正向迁移紧跟着 101 执行（详见 rollback/ 下该文件的头部注释）。
const DOWN = readFileSync(join(ROOT, 'rollback', '101_config_actor_and_version_down.sql'), 'utf8');
/** 正向迁移的文件名 = 两条通道的记账 key（存文件名，不带路径）。 */
const UP_NAME = '101_config_actor_and_version.sql';

/** 取迁移文件里某张表的 CREATE TABLE 段（到 `\n);` 为止）：用真实建表口径，不自己另写一份。 */
function createTableBlock(file: string, table: string): string {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const start = text.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`迁移 ${file} 里找不到 ${table} 的建表语句（护栏已失效，请同步本测试）`);
  const end = text.indexOf('\n);', start);
  // 必须把收尾的 '\n);' 一起切进来（end 指向 '\n'，共 3 个字符）——
  // 只切到 end 会拿到一条没有右括号的 CREATE TABLE ⇒ "syntax error at end of input"。
  return text.slice(start, end < 0 ? text.length : end + 3);
}

/**
 * 真建三张表（022 workflow_def / 010 system_config / 098 label_dict_tenant）
 * + 真建 _migrations 记账表（与 src/db/migrate.ts:31-34 同款）。
 *
 * 【为什么必须连记账表一起建】反向迁移要 `DELETE FROM _migrations ...`（擦账），
 * 没有这张表 ⇒ 执行 down 直接报 relation does not exist ⇒ ⑤⑥⑦⑧ 四条假红。
 * 生产上这张表必然存在（migrate.ts / migrate-as-owner.sh 都会先建），所以它是真实口径的一部分。
 */
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(createTableBlock('022_workflow_def.sql', 'workflow_def'));
  await db.exec(createTableBlock('010_system_config.sql', 'system_config'));
  await db.exec(createTableBlock('098_label_dict_tenant.sql', 'label_dict_tenant'));
  await db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  return db;
}

/** 记账表里有没有这条迁移（模拟"101 已被应用过"）。 */
async function ledgerHas(db: PGlite, name: string): Promise<boolean> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM _migrations WHERE name = $1`,
    [name],
  );
  return Number(r.rows[0]?.n ?? 0) > 0;
}

async function columnsOf(db: PGlite, table: string): Promise<string[]> {
  const r = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name`,
    [table],
  );
  return r.rows.map((x) => x.column_name);
}

const NEW_COLS: Array<[string, string]> = [
  ['workflow_def', 'updated_by'],
  ['system_config', 'updated_by'],
  ['label_dict_tenant', 'updated_by'],
  ['label_dict_tenant', 'version'],
];

/** 每列的"可空 / 有默认值"信息——回退安全性的判据。 */
async function colMeta(
  db: PGlite,
  table: string,
  column: string,
): Promise<{ isNullable: boolean; hasDefault: boolean } | null> {
  const r = await db.query<{ is_nullable: string; column_default: string | null }>(
    `SELECT is_nullable, column_default FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  if (!r.rows[0]) return null;
  return {
    isNullable: r.rows[0].is_nullable === 'YES',
    hasDefault: r.rows[0].column_default !== null,
  };
}

describe('101_config_actor_and_version.sql（PGlite 真跑 · 正向）', () => {
  it('① 4 列全部建立：workflow_def.updated_by / system_config.updated_by / label_dict_tenant.(updated_by, version)', async () => {
    const db = await freshDb();
    await db.exec(UP);
    for (const [table, column] of NEW_COLS) {
      expect(await columnsOf(db, table), `${table} 缺列`).toContain(column);
    }
    await db.close();
  });

  it('② 每一列都可空或有默认值 —— 这是"反向迁移 DROP COLUMN 安全"的前提，不是随手写的', async () => {
    const db = await freshDb();
    await db.exec(UP);
    for (const [table, column] of NEW_COLS) {
      const meta = await colMeta(db, table, column);
      expect(meta, `${table}.${column} 不存在`).not.toBeNull();
      const safe = meta!.isNullable || meta!.hasDefault;
      expect(
        safe,
        `${table}.${column} 既 NOT NULL 又无默认值 ⇒ DROP COLUMN 后无法原样加回，反向迁移会变成有损操作`,
      ).toBe(true);
    }
    await db.close();
  });

  it('③ 幂等：连续执行三次不报错（重复部署安全）', async () => {
    const db = await freshDb();
    await db.exec(UP);
    await db.exec(UP);
    await db.exec(UP);
    expect(await columnsOf(db, 'label_dict_tenant')).toContain('version');
    await db.close();
  });

  it('④ version 列新行默认值 = 1（并发锚读到 NULL 就无法比对）', async () => {
    const db = await freshDb();
    await db.exec(UP);
    await db.query(
      `INSERT INTO label_dict_tenant (tenant_id, scope, key, label) VALUES ('T1','wo_status','rated','已评价')`,
    );
    const r = await db.query<{ version: number }>(
      `SELECT version FROM label_dict_tenant WHERE tenant_id = 'T1'`,
    );
    expect(r.rows[0].version).toBe(1);
    await db.close();
  });
});

describe('101_config_actor_and_version_down.sql（PGlite 真跑 · 反向）', () => {
  it('⑤ 反向迁移把 4 列全部删掉（回退到 T0 之前的形状）', async () => {
    const db = await freshDb();
    await db.exec(UP);
    await db.exec(DOWN);
    for (const [table, column] of NEW_COLS) {
      expect(await columnsOf(db, table), `${table}.${column} 反向迁移后仍存在`).not.toContain(column);
    }
    await db.close();
  });

  it('⑥ 反向迁移只删本次新增的列：表的既有列一行不动（不能顺手带走业务列）', async () => {
    const db = await freshDb();
    const before: Array<[string, string[]]> = [
      ['workflow_def', await columnsOf(db, 'workflow_def')],
      ['system_config', await columnsOf(db, 'system_config')],
      ['label_dict_tenant', await columnsOf(db, 'label_dict_tenant')],
    ];
    await db.exec(UP);
    await db.exec(DOWN);
    for (const [table, cols] of before) {
      expect(await columnsOf(db, table), `${table} 的既有列被反向迁移误删`).toEqual(cols);
    }
    await db.close();
  });

  it('⑦ 反向迁移幂等：没跑过正向也能执行（DROP IF EXISTS，重复执行不报错）', async () => {
    const db = await freshDb();
    await db.exec(DOWN);
    await db.exec(DOWN);
    expect(await columnsOf(db, 'label_dict_tenant')).not.toContain('version');
    await db.close();
  });

  it('⑧ 正→反→正：列能原样加回来（证明 DROP 是可逆的、不是一次性破坏）', async () => {
    const db = await freshDb();
    await db.exec(UP);
    const afterUp = await columnsOf(db, 'label_dict_tenant');
    await db.exec(DOWN);
    await db.exec(UP);
    expect(await columnsOf(db, 'label_dict_tenant')).toEqual(afterUp);
    await db.close();
  });

  // ⑪ 是本文件最关键的一条：反向迁移**只删列不擦账** = 假回退。
  //   两条自动通道都只记账从不擦账（migrate.ts:61/:87、migrate-as-owner.sh:22-25/:40），
  //   ⇒ 若不擦账：跑完 down 后重新上线时 101 被 skip ⇒ 4 列加不回来 ⇒ 新代码 42703 ⇒ 500。
  //   **回退每一步都做对了、重新上线反而炸**。所以必须走完整往返，只测到"列没了"这道口子照样漏。
  it('⑪ 完整往返（含记账）：101 → down（列没了 **且账也擦了**）→ 再 101（列能回来）', async () => {
    const db = await freshDb();

    // 起手：模拟"101 已应用过"（两条通道记账口径：存文件名，不带路径）
    await db.query(`INSERT INTO _migrations(name) VALUES ($1)`, [UP_NAME]);
    expect(await ledgerHas(db, UP_NAME), '前置：101 应先被记为已应用').toBe(true);

    await db.exec(UP);
    for (const [table, column] of NEW_COLS) {
      expect(await columnsOf(db, table), `正迁后 ${table} 缺列`).toContain(column);
    }

    await db.exec(DOWN);
    for (const [table, column] of NEW_COLS) {
      expect(await columnsOf(db, table), `反迁后 ${table}.${column} 仍在`).not.toContain(column);
    }
    expect(
      await ledgerHas(db, UP_NAME),
      '反迁后 _migrations 里 101 仍在 ⇒ 重新上线时正向会被 skip ⇒ 列永远回不来 ⇒ 假回退',
    ).toBe(false);

    // 最后一步才真正证明"退回去还能再上来"
    await db.exec(UP);
    for (const [table, column] of NEW_COLS) {
      expect(await columnsOf(db, table), `再次正迁后 ${table} 缺列`).toContain(column);
    }
    await db.close();
  });
});

describe('101 反向迁移的**放置位置**（回退方案的生死线）', () => {
  // 【为什么这条也要钉死】两条自动迁移通道都只扫仓库根目录、且都以"数字前缀 + .sql"为筛选条件：
  //   · src/db/migrate.ts           → readdirSync(根).filter(f => /^\d+_.*\.sql$/.test(f))
  //   · scripts/migrate-as-owner.sh → ls [0-9][0-9][0-9]_*.sql
  // 反向迁移若以 101_xxx_down.sql 躺在根目录：排序上 '.'(46) < '_'(95) ⇒ 正向先跑、反向紧跟着跑，
  // 刚加的 4 列在同一次 migrate 里被立刻删掉，且 _migrations 把它记成"已应用" ⇒ 下次重跑不再补回来
  // ——静默失效。放 rollback/ 子目录 ⇒ 目录名不匹配数字前缀 ⇒ 两条通道都看不见它。
  it('⑨ 根目录里不存在任何会被自动通道拾取的反向迁移文件（*_down.sql）', () => {
    const autoApplied = readdirSync(ROOT).filter((f) => /^\d+_.*\.sql$/.test(f));
    const downAtRoot = autoApplied.filter((f) => f.endsWith('_down.sql'));
    expect(
      downAtRoot,
      '反向迁移掉到根目录了 ⇒ 会被自动迁移通道紧跟着正向迁移执行，4 列刚加就被删且被记账为已应用（静默失效）',
    ).toEqual([]);
  });

  it('⑩ 正向迁移确实在根目录（否则上一条会因为"根本没有正向迁移"而空过）', () => {
    const autoApplied = readdirSync(ROOT).filter((f) => /^\d+_.*\.sql$/.test(f));
    expect(autoApplied, '101 正向迁移必须在根目录才会被自动应用').toContain(UP_NAME);
  });

  // ⑫ 把"顺序"这个硬要求钉死：down 文件是**手工 psql -f 执行、不带 --single-transaction**
  //   ⇒ 非原子，中途失败会留半截。两种排法正常路径等价，**只在失败路径分生死**：
  //     ✅ 先擦账后删列 ⇒ 失败态「列还在 + 账已擦」⇒ 正向幂等重跑即自愈
  //     ❌ 先删列后擦账 ⇒ 失败态「列已删 + 账还在」⇒ 正向被永久 skip ⇒ 列永远回不来 ⇒ 42703
  //   注释写了会被后人改掉，断言不会。
  it('⑫ 擦账语句必须排在删列语句之前（顺序是硬要求，不是风格）', () => {
    // 必须**先剥掉注释行**再定位：本文件头部注释里就写着 "DROP COLUMN" / "DELETE FROM _migrations"
    // 这些字眼，直接在原文上 indexOf 会先命中注释 ⇒ 假红（且是"看起来像顺序错了"的那种最误导的假红）。
    const downBody = DOWN.split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    const eraseAt = downBody.indexOf('DELETE FROM _migrations');
    const firstDropAt = downBody.indexOf('DROP COLUMN');
    expect(eraseAt, 'down 文件里找不到擦账语句 ⇒ 假回退（回退后重新上线会 42703）').toBeGreaterThan(-1);
    expect(firstDropAt, 'down 文件里找不到删列语句').toBeGreaterThan(-1);
    expect(
      eraseAt,
      `擦账排到了删列之后（擦账@${eraseAt} / 首条删列@${firstDropAt}）：中途失败会留下「列已删 + 账还在」，` +
        `正向被永久 skip ⇒ 列永远回不来 ⇒ 42703`,
    ).toBeLessThan(firstDropAt);
  });

  // ⑬ 显式事务是"不可选项"（不是风格）：本文件手工 `psql -v ON_ERROR_STOP=1 -f` 执行，
  //   不带事务就非原子，中途失败会留下"擦了账但列还在"这类半截状态。
  //   ⚠️ 同时它**不能替代** ⑫ 的顺序要求：文件被人拆开逐条手敲时，事务这层防线不存在。
  it('⑬ down 文件必须自带显式事务（BEGIN 在最前、COMMIT 在最后）', () => {
    const downBody = DOWN.split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    const stmts = downBody
      .split(';')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    expect(stmts[0], 'down 文件首条语句必须是 BEGIN（不带事务 ⇒ 非原子，中途失败留半截）').toBe('BEGIN');
    expect(
      stmts[stmts.length - 1],
      'down 文件末条语句必须是 COMMIT（事务没闭合 ⇒ 整段不生效或挂住连接）',
    ).toBe('COMMIT');
    expect(stmts.filter((s) => s === 'BEGIN').length, '只能有一个 BEGIN').toBe(1);
    expect(stmts.filter((s) => s === 'COMMIT').length, '只能有一个 COMMIT').toBe(1);
  });
});
