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
 * 【103（work_orders）在本文件里的覆盖范围 —— 改之前必读，别补错地方】
 *   T1-B 批 4 给 work_orders 加同名列 def_version，口径与 102 逐条相同。
 *   当时受「不许新增任何护栏/探针/自检项，验收一律扩在既有测试文件里」约束，
 *   103 就长在本文件里（编号 103-① ~ 103-⑮）。
 *
 *   ⚠️ 现已**拆分**：103 的**反向闭环 + 文件形态**迁到了独立文件
 *   `src/test/migration103.pglite.test.ts`（反向迁移文件末尾点名要这一份，
 *   且 down 文件「尚未实跑验证」的洞只有它有牙 —— 见下）。
 *
 *   【为什么必须拆出去】本文件旧版 103-⑧ 第 3 步写的是 `await db.exec(UP103)`
 *   —— **无条件**执行。而真实迁移通道是 `migrate.ts:61 if (applied.has(file)) continue`。
 *   实测：把 down 里的擦账 DELETE 注释掉后，103-⑧ **仍然绿**（SQL 被硬跑一遍，列当然回来），
 *   即「只删列不擦账」这个假回退在它下面**测不出来** ⇒ 纸面断言。
 *   新文件把第 3 步建模成真实通道（已记账就 skip），同一变异下**真红**。
 *
 *   【分工（逐条对照，避免双重真源）】
 *     · 保留在本文件 → 103-② 列形状 / 103-③ 正向幂等 / 103-④ E4 存量行 / 103-⑤ E4 硬闸
 *     · 已迁到新文件 → 103-① ⑥ ⑦ ⑧ ⑨ ⑩ ⑪ ⑫ ⑬ ⑭ ⑮（逐条被那边覆盖，此处不重复）
 *   ⇒ **改 103 的反向迁移或 down 文件时，改 migration103.pglite.test.ts**，别在这里补。
 *
 * 【103 与 102 的形状差异（其余口径完全相同）】
 *   · 102 管 **3 张表**（inspection_task / transport_order / business_flow_tasks）；
 *   · 103 只管 **1 张表**（work_orders）—— 工单单独成一份迁移，为的是这一列能
 *     **独立回退**、不牵连已上线的那三张表（理由见 103 迁移文件头注释 :33-40）。
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
/**
 * 103 只管 1 张表（102 管 3 张）—— 形状差异仅此一处，其余口径与 102 完全相同。
 *
 * ⚠️ 103 的**反向闭环 + 文件形态**已迁到 `src/test/migration103.pglite.test.ts`
 * （down 文件末尾点名要那一；且只有它把第 3 步建模成真实迁移通道，变异下真红）。
 * 故此处**只留正向侧的 4 条孤儿断言**（② ③ ④ ⑤，新文件未覆盖），
 * 反向所需的 DOWN103 / UP103_NAME 一并移除 —— 留着就是第二处真源。
 * 分工对照表见文件头「103（work_orders）在本文件里的覆盖范围」。
 */
const TABLE103 = 'work_orders';
const UP103_PATH = join(ROOT, '103_inflight_def_version_workorder.sql');
const UP103 = readFileSync(UP103_PATH, 'utf8');

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
 * 把一个单元格压成可逐字节比较的字符串（供用例 ⑯ 的行级比对用）。
 * 【为什么不能直接 toEqual(raw)】
 *   ① Date / jsonb 对象用 toEqual 比较依赖引用语义与键序，换个驱动就飘；
 *   ② '1'（string）与 1（number）在 JS 的 == 下相等，会把「迁移把列换了类型」洗绿。
 * ⇒ 带上 typeof 前缀 + 确定性序列化：Date → ISO 串，对象 → JSON 串，null/undefined → 固定记号。
 */
function normalizeCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `date:${v.toISOString()}`;
  if (Array.isArray(v)) return `array:${JSON.stringify(v)}`;
  if (typeof v === 'object') return `json:${JSON.stringify(v)}`;
  return `${typeof v}:${String(v)}`;
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

/**
 * 🔴 **按真实迁移通道的口径**应用 102：已记账 ⇒ skip（src/db/migrate.ts:61 `continue`）。
 *
 * 【为什么不能直接 db.exec(UP)】那是"无条件执行"，而真实通道不是这样 ——
 * 本文件旧版 ⑧ 正因为无条件 exec 上游 SQL，在「只删列不擦账」变异下**仍然绿**
 * （SQL 被硬跑一遍，列当然回来了），是纸面断言。本函数是那条 paper assertion 的替身。
 *
 * @returns 是否真的执行了（false = 被记账 skip 掉）
 */
async function apply102ViaMigrate(db: PGlite): Promise<boolean> {
  if (await ledgerHas(db, UP_NAME)) return false; // migrate.ts:61 —— 已记账就 skip
  await db.exec(UP);
  // migrate.ts:87 —— 跑完才记账，口径一致（ON CONFLICT DO NOTHING，只增不删）
  await db.query(`INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`, [UP_NAME]);
  return true;
}

/**
 * 反向迁移的真实执行方式：人手工 `psql -v ON_ERROR_STOP=1 -f rollback/xxx_down.sql`
 * （自带 BEGIN/COMMIT，禁止叠加 --single-transaction —— 见 down 文件头）。
 * @param sql 默认用仓库里的 down 原文；传变体时只改内存里的字符串，**不动仓库文件**。
 */
async function applyDownViaPsql(db: PGlite, sql: string = DOWN): Promise<void> {
  await db.exec(sql);
}

/**
 * 造「只删列不擦账」的变体：把 down 里擦账那一条 DELETE 去掉（其余一字不改，剥注释后过滤）。
 * 【为什么自己造而不用上面那种 —— 因为留痕迹的仓库文件不能动】本函数只在内存里改。
 */
function withoutLedgerWipe(sql: string): string {
  const stripped = stripSqlComments(sql);
  const out = stripped
    .split('\n')
    .filter((l) => !/DELETE\s+FROM\s+_migrations/i.test(l))
    .join('\n');
  if (out === stripped) {
    throw new Error('变体构造失败：down 文件里没找到擦账 DELETE（本测试已失效，请检查 down 文件）');
  }
  return out;
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

  it('⑯ 🔴 A5 行级字节比对：迁移前后抽 3 行，除 def_version 外每字段逐项不变', async () => {
    // 【这条补的是什么】设计 §8 A5 原文要求「迁移前后**抽 N 行**，def_version 全为 0，
    // 且**除该列外其它字段字节不变**」。既有的 ④ 只验了「def_version 全为 0」且样本只有 1 行，
    // 完全没法发现「迁移顺手改写了业务数据」（如夹一句 UPDATE ... SET status='x'）。
    // 本条用 3 行有区分度的数据 + 整行 SELECT * 快照，按**字段名逐个**比对。
    //
    // 【为什么是 3 行】1 行只能证明"这一行没被改"，证明不了"没有按条件改写某一类行"；
    // 3 行覆盖 pending / in_progress / done 三种 status，夹带 UPDATE 时至少命中一类。
    const db = await freshDb();
    // id 是 uuid DEFAULT gen_random_uuid()，不手工塞（PGlite 会判类型错误 —— 见 ④ 注释）；
    // 用 tenant_id + title 做稳定主键，避免依赖 ORDER BY（中文排序随 locale 变）。
    // 字段刻意覆盖 uuid/nullable/text/double/jsonb/timestamptz 各种形态，
    // 其中 status / note / photos 是最容易被"顺手改写"的目标。
    const ROWS: Array<[string, string, string, string]> = [
      ['tenant-甲', '存量-待处理', 'pending', '甲备注 / 含斜杠与空格'],
      ['tenant-乙', '存量-进行中', 'in_progress', '乙备注\n含换行\n第二行'],
      ['tenant-丙', '存量-已完成', 'done', '丙备注 <含尖括号&符号>'],
    ];
    for (const [tenant, title, status, note] of ROWS) {
      await db.exec(
        `INSERT INTO inspection_task
           (tenant_id, type, title, assignee, status, geo_lat, geo_lng, note, photos,
            scheduled_at, done_at, created_by, created_at)
         VALUES ('${tenant}', 'plan', '${title}', '巡检员-${title}', '${status}',
                 31.2304, 121.4737, '${note}', '[{"u":"${title}.png"}]'::jsonb,
                 '2025-01-02T03:04:05Z', NULL, 'u-1', '2024-12-01T00:00:00Z')`,
      );
    }

    // 迁移前整行快照（SELECT * ⇒ 不预设任何字段清单，迁移改了 schema 也算变化被测到）
    type Row = Record<string, unknown>;
    const snapBefore = await db.query<Row>(`SELECT * FROM inspection_task`);
    expect(snapBefore.rows.length, '迁移前应有 3 行样本').toBe(ROWS.length);

    await db.exec(UP);

    const snapAfter = await db.query<Row>(`SELECT * FROM inspection_task`);
    expect(snapAfter.rows.length, '迁移后行数必须不变（不许增删行）').toBe(snapBefore.rows.length);

    const beforeByTitle = new Map(snapBefore.rows.map((r) => [String(r.title), r]));
    const seen = new Set<string>();
    for (const after of snapAfter.rows) {
      const key = String(after.title);
      const before = beforeByTitle.get(key);
      expect(before, `迁移后出现了迁移前没有的行：${key}`).toBeDefined();
      seen.add(key);

      // ① 除 def_version 外的每个字段逐个比字节（uniq 前缀带上 typeof，防 '1' 与 1 蒙混过关）
      const fields = Object.keys(before as Row);
      expect(fields.length, '快照字段太少 ⇒ 比对形同虚设').toBeGreaterThanOrEqual(10);
      for (const f of fields) {
        expect(normalizeCell((after as Row)[f]), `${key}.${f} 迁移前后必须字节不变`).toBe(
          normalizeCell((before as Row)[f]),
        );
      }
      // ② def_version 必须是 E4 哨兵 0
      expect(after[COL], `${key}.${COL} 必须全为 0（E4：不伪造建单版本）`).toBe(0);
      // ③ 迁移后不许凭空多出 def_version 之外的字段
      const extra = Object.keys(after).filter((k) => !(k in (before as Row)));
      expect(extra.filter((k) => k !== COL), `${key} 多出了 ${COL} 之外的字段`).toEqual([]);
    }
    // ④ 迁移前的每一行都被比过（漏比 = 假绿）
    expect([...seen].sort(), '必须逐行比对到全部 3 行').toEqual([...beforeByTitle.keys()].sort());
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

  it('⑰ 🔴 正 → 反 → 正（**走真实迁移通道**）：列去而复返，且第三步不许被 skip', async () => {
    // 【为什么还要再写一条】既有的 ⑧ 是无条件 `db.exec(UP)`，直接绕过
    // src/db/migrate.ts:61 的 skip 逻辑。实测（见下）：把 down 里「擦账 DELETE」注释掉，
    // ⑧ **仍然全绿** —— 它证明不了任何事。本条第 3 步走 apply102ViaMigrate（真实 skip 语义），
    // 同一变异下**必红**。这是本条相对 ⑧ 唯一的、也是关键的增量。
    //
    // 【为什么这条红很重要】「只删列不擦账」这个假回退，症状发生在**已经成功回退之后**：
    // 回退 → 修 bug → 重新上线，此时 102 被记账 skip ⇒ 列永远回不来 ⇒ 42703 ⇒ 500。
    const db = await freshDb();

    // ① 正向（真实通道）：真的跑了 + 列在 + 记账在
    const ran1 = await apply102ViaMigrate(db);
    expect(ran1, '首次上线 102 应真的被执行（不该被 skip）').toBe(true);
    for (const t of TABLES) expect(await columnsOf(db, t), `${t} 迁移后`).toContain(COL);
    expect(await ledgerHas(db, UP_NAME), '迁移后必须有记账').toBe(true);

    // ② 反向（人工 psql -f）：列没了 **且账也没了**
    await applyDownViaPsql(db);
    for (const t of TABLES) expect(await columnsOf(db, t), `${t} 反向后`).not.toContain(COL);
    expect(await ledgerHas(db, UP_NAME), '反向必须同时擦账（只删列不擦账 = 假回退）').toBe(false);

    // ③ 再次正向（真实通道）：不该被 skip，列必须加得回来
    const ran2 = await apply102ViaMigrate(db);
    expect(ran2, '重新上线时 102 不该被记账 skip 掉').toBe(true);
    for (const t of TABLES) expect(await columnsOf(db, t), `${t} 再上线后列必须加回来`).toContain(COL);
    expect(await ledgerHas(db, UP_NAME), '重新记账').toBe(true);
  });

  it('⑱ 🔴 假回退钉死：只删列不擦账 ⇒ 再上线被 skip ⇒ 读 def_version 报 42703', async () => {
    // 与 ⑰ 互补：⑰ 变异的是**仓库里的 down 文件**，本条把变体造在**内存**里
    // （withoutLedgerWipe），不碰仓库任何文件 ⇒ 日常回归也能钉住这个洞。
    const db = await freshDb();
    await apply102ViaMigrate(db);
    // 先插一行真实业务数据，好让 42703 真的炸在查询上（空表 SELECT 未必触发）。
    await db.exec(
      `INSERT INTO inspection_task (tenant_id, title, status)
       VALUES ('tenant-1', '在途单', 'pending')`,
    );

    // 变体：把擦账那一条 DELETE 去掉（只改内存里的 SQL，**不动仓库里的 down 文件**）
    await applyDownViaPsql(db, withoutLedgerWipe(DOWN));

    // 假回退的表象：列确实没了……
    expect(await columnsOf(db, 'inspection_task'), '变体下列应被删掉').not.toContain(COL);
    // ……但账还在 ⇒ 真实通道会 skip ⇒ 列永远回不来
    expect(await ledgerHas(db, UP_NAME), '变体下记账应残留（这正是假回退的特征）').toBe(true);
    const ran = await apply102ViaMigrate(db);
    expect(ran, '假回退后重新上线，102 被 skip（列回不来）').toBe(false);
    expect(await columnsOf(db, 'inspection_task'), '列没被加回来').not.toContain(COL);

    // 落到生产症状：读 def_version ⇒ 42703 ⇒ 500
    let err: unknown = null;
    try {
      await db.query(`SELECT ${COL} FROM inspection_task WHERE tenant_id = 'tenant-1'`);
    } catch (e) {
      err = e;
    }
    expect(err, '列不在却没报错 ⇒ 洞没被钉住').not.toBeNull();
    expect(String((err as { message?: string } | null)?.message ?? '')).toMatch(/def_version/i);
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
 *
 * ⚠️ 103 的**反向闭环 + 文件形态**（原 ⑥~⑮ 与 ①）已迁到 `migration103.pglite.test.ts`：
 *    那边的第 3 步走真实迁移通道（migrate.ts:61 已记账就 skip），变异下真红；
 *    本文件原先的无条件 `db.exec(UP103)` 版 103-⑧ 在「只删列不擦账」下是绿的（纸面断言）。
 *    ⇒ 此处只留新文件未覆盖的 4 条孤儿断言：② 列形状 / ③ 正向幂等 / ④ E4 存量行 / ⑤ E4 硬闸。
 * ══════════════════════════════════════════════════════════════════════════════════ */

describe('103_inflight_def_version_workorder 正向', () => {
  // 103-①（迁移前不含 / 迁移后含 def_version）已迁到 migration103.pglite.test.ts ①：
  // 那边在断言列的同时还断言了记账，是 103-① 的超集 ⇒ 此处不重复。
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

// 103 的反向闭环（原 ⑥~⑩）与文件形态静态断言（原 ⑪~⑮）已迁到
// src/test/migration103.pglite.test.ts —— 那边第 3 步走真实迁移通道
// （migrate.ts:61 已记账就 skip），「只删列不擦账」变异下真红；
// 本文件原 103-⑧ 是无条件 db.exec(UP103)，同一变异下仍绿（纸面断言）。
// 分工对照表见文件头注释。改 down 文件请改那边，别在这里补。
