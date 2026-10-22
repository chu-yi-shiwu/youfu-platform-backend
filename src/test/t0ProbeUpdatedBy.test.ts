/**
 * T0 RED 探针 · 缺口①：配置变更**不留变更人**（updated_by）
 * ============================================================================
 * 【这是探针，不是修复】
 *   本文件**只加测试、不改源码**。它存在的意义是把「应该有的行为现在没有」钉成可执行目标：
 *   T0 修好之前它必须红，修好之后应当转绿。任何让它变绿的捷径（改断言、删用例）都是作弊。
 *
 * 【缺口①的目标行为】
 *   任何配置类写入（租户字典 / 流程定义 / 平台配置 / 租户级 system_config）之后，
 *   都能从**该行自身**读出「谁改的」（updated_by = 操作人），而不是只能去翻历史表。
 *
 * 【为什么必须是"行上的 updated_by"，历史表不算】
 *   运维/管理员在界面上看到的是**当前生效值**。追问"这行现在是谁改的"时，
 *   历史表只能间接回答（且要 join + 排序 + 去重）；行上没有变更人 ⇒
 *   ① 界面无法直接展示"最近修改人"；② 越权改配置后无法第一时间定位到人。
 *
 * 【探针口径】一律 PGlite 真库（照 labelDictTenantSave.test.ts / migration097.pglite.test.ts
 *   的 setUp 写法）：真建表 → 真调用生产函数 → 真查列/值。SQL 一行不 mock。
 *
 * 【关于"目标 schema"】
 *   本文件的库 = **现状迁移 + T0 要加的 updated_by 列**（用 ALTER IF NOT EXISTS 显式补上）。
 *   为什么：若按现状 schema 搭库，A/B 组红的原因是"表里没这列、没地方写"，
 *   这是**假红**——T0 只加个迁移、代码一行不动，测试就转绿了，什么都证明不了。
 *   补上列之后，红的唯一可能原因就是**写入语句没写 updated_by**。
 *   迁移那一半（"列到底加没加"）由 ①E 单独静态钉死，两边不重复、也不漏。
 *
 * 【预期】
 *   A（租户字典）红 —— 列已由探针补上，但 PUT / ensureTenantStateLabels 都不写它
 *   B（流程定义）红 —— 列已由探针补上，但 saveWorkflowDef 不写它
 *   C（平台配置）绿 —— 097 有列且 repo 真写（骨架声称的"唯一一处"属实）
 *   D（代码侧静态扫描）红 —— 8 处配置写语句里 7 处不带 updated_by
 *   E（迁移侧静态扫描）红 —— 022/010/098 三张表的建表段都没有 updated_by
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { errorMiddleware } from '../middleware/error.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL098 = readFileSync(join(ROOT, '098_label_dict_tenant.sql'), 'utf8');
const SQL073 = readFileSync(join(ROOT, '073_label_dict.sql'), 'utf8');
const SQL097 = readFileSync(join(ROOT, '097_platform_config.sql'), 'utf8');

const box = vi.hoisted(() => ({
  db: null as any,
  tenants: [] as string[],
  sqls: [] as string[],
  params: [] as unknown[][],
}));

// pool 只替换外壳，SQL 一行不改、全部下发真库执行。
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (tenantId: string, fn: (c: unknown) => Promise<unknown>) => {
    box.tenants.push(tenantId);
    return fn({
      query: async (sql: string, params: unknown[] = []) => {
        box.sqls.push(sql);
        box.params.push(params);
        if (/role_permission/i.test(sql)) return { rows: [], rowCount: 0 }; // 权限由 role.ts 保证，与本探针无关
        const r = await box.db.query(sql, params);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
    });
  },
  assertSafeTenantId: (t: string) => t,
  default: {
    query: async (sql: string, params: unknown[] = []) => {
      const r = await box.db.query(sql, params);
      return { rows: r.rows, rowCount: r.rows.length };
    },
  },
}));

import metaTenantLabelRouter from '../routes/metaTenantLabel.js';
import { saveWorkflowDef } from '../engine/workflowDef.js';
import type { WorkflowDef } from '../engine/stateMachine.js';
import { setPlatformConfig, setWorkflowConfigOwner } from '../repo/platformConfig.js';

/** 098 建表段（PGlite 可执行；GRANT/RLS 段 PGlite 不认，治理由 labelDictTenant.test.ts 真跑）。 */
function ddl098(): string {
  const start = SQL098.indexOf('CREATE TABLE IF NOT EXISTS label_dict_tenant');
  const marker = 'CREATE INDEX IF NOT EXISTS idx_label_dict_tenant_lookup';
  const end = SQL098.indexOf(';', SQL098.indexOf(marker));
  if (start < 0 || end < 0) throw new Error('098 迁移结构变了：截取 DDL 失败，请同步本测试');
  return SQL098.slice(start, end + 1);
}

/** 073 建表段（不含种子）：写路径判重要查平台字典。 */
function ddl073(): string {
  const start = SQL073.indexOf('CREATE TABLE IF NOT EXISTS label_dict');
  const marker = 'CREATE UNIQUE INDEX IF NOT EXISTS ux_label_dict_scope_key';
  const end = SQL073.indexOf(';', SQL073.indexOf(marker));
  if (start < 0 || end < 0) throw new Error('073 迁移结构变了：截取 DDL 失败，请同步本测试');
  return SQL073.slice(start, end + 1);
}

/** 097 迁移（剥掉 psql 元命令，PGlite 不认反斜杠命令）。 */
function ddl097(): string {
  return SQL097.split('\n').filter((l) => !/^\s*\\/.test(l)).join('\n');
}

/** 真库：workflow_def + history + label_dict(_tenant) + platform_config，全部取自真实迁移口径。 */
async function freshDb(): Promise<PGlite> {
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
    CREATE TABLE IF NOT EXISTS work_orders (
      id bigserial PRIMARY KEY, tenant_id text NOT NULL, status text NOT NULL DEFAULT 'draft'
    );
    CREATE TABLE IF NOT EXISTS role_def (tenant_id text NOT NULL, code text NOT NULL, UNIQUE (tenant_id, code));
  `);
  // 目标 schema：022 现状 + T0 要加的 updated_by 列（理由见文件头，避免"没地方写"型假红）
  await db.exec(`ALTER TABLE workflow_def ADD COLUMN IF NOT EXISTS updated_by text;`);
  await db.exec(ddl073());
  await db.exec(ddl098());
  // 目标 schema：098 现状 + T0 要加的 updated_by + version（同上，避免"没地方写"型假红）
  await db.exec(`
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS updated_by text;
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
  `);
  await db.exec(ddl097());
  box.db = db;
  return db;
}

async function hasColumn(db: PGlite, table: string, column: string): Promise<boolean> {
  const r = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return Number(r.rows[0]?.c ?? 0) > 0;
}

/**
 * 读某行的 updated_by。列不存在时返回 exists:false（**不抛**）——
 * 探针要的是"缺口存在"这一事实，抛异常会把用例变成 error 而非可控的红。
 */
async function updatedByOf(
  db: PGlite,
  table: string,
  where: string,
  params: unknown[],
): Promise<{ exists: boolean; value: string | null }> {
  if (!(await hasColumn(db, table, 'updated_by'))) return { exists: false, value: null };
  const r = await db.query<{ updated_by: string | null }>(`SELECT updated_by FROM ${table} ${where}`, params);
  return { exists: true, value: r.rows[0]?.updated_by ?? null };
}

function def(states: string[]): WorkflowDef {
  return {
    initial: states[0],
    states,
    transitions: states.slice(1).map((s, i) => ({ from: states[i], to: s, event: `e${i}` })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 租户字典（label_dict_tenant）写端点：PUT /api/v1/meta/labels/me/:scope/:key
// ─────────────────────────────────────────────────────────────────────────────
let server: Server;
let baseUrl = '';
/** HTTP 用例专用库：与 B/C 组各自 new 的库**分开持有**（后者用完即 close，不能拿来收尾）。 */
let httpDb: PGlite;

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(ddl073());
  await db.exec(ddl098());
  // 目标 schema：098 现状 + T0 要加的 updated_by + version（理由见文件头，避免"没地方写"型假红）
  await db.exec(`
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS updated_by text;
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
  `);
  httpDb = db;
  box.db = db;
  const app = express();
  // 伪造鉴权：?tenant=T1&user=u-alice —— username 就是本探针认定的"操作人"
  app.use((req, res, next) => {
    const t = (req.query.tenant as string) || '';
    const username = (req.query.user as string) || 'u-alice';
    if (t) {
      (res.locals as Record<string, unknown>).auth = {
        tenantId: t,
        role: 'admin', // admin 恒放行权限点（role.ts:268 requirePermission）
        userId: `uid-${username}`,
        username,
        requestId: 'r1',
        authMode: 'prod',
      };
    }
    next();
  });
  app.use(express.json());
  app.use('/api/v1', metaTenantLabelRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await httpDb.close();
});

describe('T0-探针①A：租户字典写入必须留变更人（updated_by）', () => {
  beforeEach(async () => {
    box.db = httpDb; // B/C 组用例会把 box.db 换成自己的库并 close，这里必须切回 HTTP 库
    const db = httpDb;
    await db.exec('TRUNCATE label_dict_tenant; TRUNCATE label_dict;');
    await db.query(`INSERT INTO label_dict (scope, key, label) VALUES ('wo_status','draft','草稿')`);
    await db.query(
      `INSERT INTO label_dict_tenant (tenant_id, scope, key, label) VALUES ('T1','wo_status','rated','rated')`,
    );
    box.sqls = [];
    box.params = [];
    box.tenants = [];
  });

  it('PUT 改译名后，该行 updated_by = 操作人（行上直接可读，无需翻历史）', async () => {
    const r = await fetch(`${baseUrl}/meta/labels/me/wo_status/rated?tenant=T1&user=u-alice`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: '已评价' }),
    });
    expect(r.status).toBe(200); // 写本身成功（不是因为报错才没留痕）

    const probe = await updatedByOf(
      box.db as PGlite,
      'label_dict_tenant',
      `WHERE tenant_id = $1 AND scope = $2 AND key = $3`,
      ['T1', 'wo_status', 'rated'],
    );
    expect(probe.exists, 'label_dict_tenant 表缺少 updated_by 列（098 建表就没这列）= 缺口①').toBe(true);
    expect(probe.value, '租户字典写入未记录变更人').toBe('u-alice');
  });

  it('换一个操作人改同一行：updated_by 必须跟着变成新操作人（不是第一次写入后就冻住）', async () => {
    await fetch(`${baseUrl}/meta/labels/me/wo_status/rated?tenant=T1&user=u-alice`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: '已评价' }),
    });
    const r2 = await fetch(`${baseUrl}/meta/labels/me/wo_status/rated?tenant=T1&user=u-bob`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: '已评价(B改)' }),
    });
    expect(r2.status).toBe(200);

    const probe = await updatedByOf(
      box.db as PGlite,
      'label_dict_tenant',
      `WHERE tenant_id = $1 AND scope = $2 AND key = $3`,
      ['T1', 'wo_status', 'rated'],
    );
    expect(probe.exists, 'label_dict_tenant 表缺少 updated_by 列 = 缺口①').toBe(true);
    expect(probe.value, '第二次写入后变更人仍是旧值（覆盖写未更新 updated_by）').toBe('u-bob');
  });

  it('流程生效时落租户字典（ensureTenantStateLabels）也必须留变更人', async () => {
    // 必须用 freshDb（全套 workflow_def + label_dict*），HTTP 那个库里没有 workflow_def，
    // 用它会因为"表不存在"而红 —— 那是假红，证明不了缺口。
    const db = await freshDb();
    await db.exec('TRUNCATE label_dict_tenant;');
    // 走真实保存链路：saveWorkflowDef → ensureTenantStateLabels（只补不覆盖）
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'rated']), {
      operator: 'u-carol',
      reason: 'probe:label-with-actor',
    });
    const probe = await updatedByOf(db, 'label_dict_tenant', `WHERE tenant_id = $1 AND key = $2`, ['T1', 'rated']);
    expect(probe.exists, 'label_dict_tenant 表缺少 updated_by 列 = 缺口①').toBe(true);
    expect(probe.value, '流程生效落字典时未记录变更人').toBe('u-carol');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 流程定义（workflow_def）live 行
// ─────────────────────────────────────────────────────────────────────────────
describe('T0-探针①B：流程定义 live 行必须留变更人（updated_by）', () => {
  it('saveWorkflowDef 之后，workflow_def 行上 updated_by = operator', async () => {
    const db = await freshDb();
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'assigned', 'rated']), {
      operator: 'u-dave',
      reason: 'probe:wf-actor',
    });
    const probe = await updatedByOf(db, 'workflow_def', `WHERE tenant_id = $1 AND entity_type = $2`, [
      'T1',
      'work_order',
    ]);
    expect(probe.exists, 'workflow_def 表缺少 updated_by 列（022 建表就没这列）= 缺口①').toBe(true);
    expect(probe.value, '流程定义写入未记录变更人').toBe('u-dave');
    await db.close();
  });

  it('第二次保存后 updated_by 必须更新为最新操作人（审批/回滚/模板应用都会改这一行）', async () => {
    const db = await freshDb();
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'rated']), {
      operator: 'u-dave',
      reason: 'probe:first',
    });
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'rated', 'archived']), {
      operator: 'u-erin',
      reason: 'probe:second',
    });
    const probe = await updatedByOf(db, 'workflow_def', `WHERE tenant_id = $1 AND entity_type = $2`, [
      'T1',
      'work_order',
    ]);
    expect(probe.exists, 'workflow_def 表缺少 updated_by 列 = 缺口①').toBe(true);
    expect(probe.value, '第二次保存后变更人未更新').toBe('u-erin');
    await db.close();
  });

  /**
   * 【对照锚 · 现状实拍，是绿的】历史表 workflow_def_history.operator **确实留了人**，
   * 但留的是**覆盖者**而不是作者：saveWorkflowDef 落的是「被顶掉的那一版快照 + 本次操作人」
   * （engine/workflowDef.ts:290-304）。
   *
   * 实拍结果：两次保存后 history 只有 1 行 —— version=1，operator='u-erin'。
   * 也就是说：
   *   · 当前生效的 v2 在 history 里**根本没有记录**；
   *   · 唯一那行 v1 的 operator 写的是 u-erin（把 v1 干掉的人），不是写 v1 的 u-dave。
   * ⇒ "当前生效版本是谁改的"只能靠推理（谁干掉了上一版 ≈ 谁写的这一版），没有直接证据。
   * 这条存在的意义：既不把缺口夸大成"零留痕"，也说明**历史表补不上 live 行的洞**。
   */
  it('对照（现状实拍·绿）：历史表只记「被覆盖的版本 + 覆盖者」，当前生效版本的作者查不到', async () => {
    const db = await freshDb();
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'rated']), {
      operator: 'u-dave',
      reason: 'probe:h1',
    });
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'rated', 'archived']), {
      operator: 'u-erin',
      reason: 'probe:h2',
    });
    const r = await db.query<{ version: number; operator: string }>(
      `SELECT version, operator FROM workflow_def_history WHERE tenant_id = 'T1' ORDER BY version`,
    );
    expect(r.rows.map((x) => [x.version, x.operator])).toEqual([[1, 'u-erin']]);
    await db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. 平台配置（platform_config）：骨架声称"唯一有 updated_by 的地方"，验它是不是真写
// ─────────────────────────────────────────────────────────────────────────────
describe('T0-探针③：platform_config 的 updated_by 到底写没写（骨架声称唯一一处）', () => {
  it('setPlatformConfig 写入后 updated_by = 传入的 actor（预期绿：097 有列且 repo 真写）', async () => {
    const db = await freshDb();
    await setPlatformConfig('probe_switch', 'on', 'ops:alice');
    const probe = await updatedByOf(db, 'platform_config', `WHERE key = $1`, ['probe_switch']);
    expect(probe.exists, 'platform_config 缺 updated_by 列（097 建表有这列，不该缺）').toBe(true);
    expect(probe.value).toBe('ops:alice');
    await db.close();
  });

  it('setWorkflowConfigOwner 重复写：updated_by 更新为最新操作人（预期绿）', async () => {
    const db = await freshDb();
    await setWorkflowConfigOwner('tenant', 'ops:alice');
    await setWorkflowConfigOwner('tenant', 'ops:bob');
    const probe = await updatedByOf(db, 'platform_config', `WHERE key = $1`, ['workflow_config_owner']);
    expect(probe.exists).toBe(true);
    expect(probe.value).toBe('ops:bob');
    await db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. 静态扫描：所有配置类写语句是否都带 updated_by（把 A/B 的点状缺口扩成面状证据）
// ─────────────────────────────────────────────────────────────────────────────
describe('T0-探针①D：全仓配置类写语句必须带 updated_by（静态扫描）', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
  }

  // 配置类表：平台配置 / 租户级配置 / 租户字典 / 流程定义（live）。
  // 注意 \b 使 workflow_def_history / workflow_def_change 天然不被命中（下划线是词字符）。
  const CONFIG_TABLES = 'platform_config|system_config|label_dict_tenant|workflow_def';

  it('每条配置写语句都要带 updated_by（缺一条 = 有一类配置改了查不到人）', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const f of walk(join(ROOT, 'src'))) {
      const src = readFileSync(f, 'utf8');
      const re = new RegExp(`(?:INSERT\\s+INTO|UPDATE)\\s+(?:${CONFIG_TABLES})\\b`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        scanned += 1;
        // 取语句窗口：到下一个反引号/分号为止（SQL 都写在模板字面量里）
        const rest = src.slice(m.index, m.index + 1200);
        const cut = rest.search(/[`;]\s*(?:,|\)|\]|\)|;|\n\s*[a-zA-Z_$])/);
        const stmt = (cut > 0 ? rest.slice(0, cut) : rest).replace(/\s+/g, ' ');
        if (!/updated_by/i.test(stmt)) {
          offenders.push(`${f.replace(ROOT, '').replace(/\\/g, '/')} → ${stmt.slice(0, 110)}`);
        }
      }
    }
    // 防扫描器退化成空集（空集会让断言永远绿）
    expect(scanned, '扫描器没扫到任何配置写语句，护栏已失效').toBeGreaterThanOrEqual(5);
    expect(offenders, `以下 ${offenders.length} 处配置写入不留变更人：\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * 【为什么还要①E】A/B 组的库是**目标 schema**（列由探针自己 ALTER 补上），
 * 所以它证明不了"迁移里到底加没加列"。①E 把这一半补上：
 * ①D 钉"代码写不写"，①E 钉"迁移加没加"，合起来才是完整的 T0 目标。
 */
describe('T0-探针①E：三张配置表的**迁移**必须建立 updated_by / version（迁移那一半）', () => {
  /**
   * 【口径修正（第 2 轮）】初版只查 022/010/098 的 **CREATE TABLE 段**，那是错的：
   *   已部署迁移由 _migrations **按文件名**追踪（src/db/migrate.ts），回去改已应用过的迁移内容
   *   在部署库上就是 no-op —— 库里不会有这个列，代码却以为有。
   *   所以正确口径是：**任意一份迁移**（CREATE TABLE 段里，或 ALTER TABLE ADD COLUMN）建立了该列即可。
   *   反向迁移（DROP COLUMN）不算建立，故只认 CREATE/ADD 两种形态。
   */
  const MIGRATIONS = readdirSync(ROOT)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .map((f) => ({ name: f, text: readFileSync(join(ROOT, f), 'utf8') }));

  /** 某张表的列是否在**任一迁移**里被建立（CREATE TABLE 段含该列，或 ALTER TABLE ADD COLUMN 该列）。 */
  function columnEstablished(table: string, column: string): string[] {
    const hits: string[] = [];
    for (const { name, text } of MIGRATIONS) {
      const start = text.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
      if (start >= 0) {
        const end = text.indexOf('\n);', start);
        const block = text.slice(start, end < 0 ? text.length : end);
        if (new RegExp(`^\\s*${column}\\s`, 'im').test(block)) hits.push(`${name}（建表段）`);
      }
      const addRe = new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ADD\\s+COLUMN\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${column}\\b`, 'i');
      if (addRe.test(text)) hits.push(`${name}（ALTER ADD COLUMN）`);
    }
    return hits;
  }

  const TARGETS: Array<[string, string]> = [
    ['workflow_def', 'updated_by'],
    ['system_config', 'updated_by'],
    ['label_dict_tenant', 'updated_by'],
    ['label_dict_tenant', 'version'],
  ];

  it('4 列（3 表 updated_by + label_dict_tenant.version）都必须有迁移建立', () => {
    const missing: string[] = [];
    for (const [table, column] of TARGETS) {
      if (columnEstablished(table, column).length === 0) missing.push(`${table}.${column} 没有任何迁移建立`);
    }
    expect(missing, `以下列没有迁移建立：\n${missing.join('\n')}`).toEqual([]);
  });

  it('反向迁移必须与正向迁移成对存在（加列的回退 = DROP COLUMN，只 revert 代码不算回退）', () => {
    // 【反向迁移放在 rollback/ 子目录，不扫根目录】两条自动迁移通道都只扫根目录、
    // 且都以"数字前缀 + .sql"为筛选条件；反向迁移若躺根目录会被紧跟着正向迁移执行
    // （详见 rollback/101_config_actor_and_version_down.sql 头部注释、
    //  src/test/migration101.pglite.test.ts 用例⑨⑩）。
    // 所以这里也只认 rollback/ 下的 *_down.sql ——与放置约定保持一致。
    const rollbackDir = join(ROOT, 'rollback');
    const down = readdirSync(rollbackDir).filter((f) => /^\d{3}_.*_down\.sql$/.test(f));
    const establishedBy = new Set<string>();
    for (const [table, column] of TARGETS) {
      for (const hit of columnEstablished(table, column)) establishedBy.add(hit.split('（')[0]);
    }
    // 每一份建立了这些列的正向迁移，都要有同序号的 _down
    const missingDown: string[] = [];
    for (const name of establishedBy) {
      const num = /^(\d{3})_/.exec(name)?.[1];
      if (!num) continue;
      if (!down.some((d) => d.startsWith(`${num}_`) )) missingDown.push(`${name} 缺同序号反向迁移`);
    }
    expect(down.length, '没有任何反向迁移文件').toBeGreaterThan(0);
    expect(missingDown, `以下正向迁移缺反向迁移：\n${missingDown.join('\n')}`).toEqual([]);
  });

  it('护栏自检：迁移清单扫得到（扫不到 = 本护栏已失效，不算通过）', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(100);
  });
});
