/**
 * T0 RED 探针 · 缺口②：配置写入**无条件更新**，并发改动被静默覆盖
 * ============================================================================
 * 【这是探针，不是修复】只加测试、不改源码；T0 修好前必须红。
 *
 * 【缺口②的目标行为】
 *   配置写入必须锚定"我这次写是基于哪个版本"。写入方带着自己读到的版本号（或旧值）来写，
 *   若期间已被别人推进 → 直接拒绝（409 / 抛 VERSION_CONFLICT），**绝不静默覆盖**。
 *   "静默覆盖"的代价：两个管理员同时改流程，后写的把先写的整份 def 吃掉，
 *   先写的人看到"保存成功"，实际改动人间蒸发，且无从察觉。
 *
 * 【测法纪律：确定性，不写真并发】
 *   真并发（Promise.all + 时序竞争）是 flaky 的，跑十次绿九次也算通过——那不是探针是噪音。
 *   本文件一律用**确定性测法**：先读版本号 → 中间插一次别人的写入 → 再用**旧版本号**写 → 断言被拒。
 *   这在语义上等价于"我读到的版本已经过期"，但不依赖任何时序。
 *
 * 【目标契约（架构师 2026-10-23 裁决）】并发锚 = **version 列**，不用值锚（expected_label）
 *   ① 一处心智：workflow_def.version / workflow_def_change.base_version 已是版本锚语义，字典跟着用 version；
 *   ② 值锚有三个真缺陷：同 label 可重复（语义歧义）、把"改文案"和"并发控制"耦合、无法表达"我改的是我读到的那行"；
 *   ③ 反正如 updated_by 那批迁移已在开，label_dict_tenant.version 塞进同批迁移几乎零额外成本。
 *   参数名统一用 **expectVersion**（引擎层）/ **expected_version**（HTTP body），与既有 base_version 风格一致。
 *
 * 【为什么探针的库要按"目标 schema"搭（现状迁移 + T0 要加的列）】
 *   若按现状 schema 搭，②B 连"旧版本号"都没地方读 ⇒ 红的原因是"没地方写"而不是"代码没写"，
 *   这是**假红**（修好迁移、代码没动也会转绿）。故本文件用 ALTER 显式补上 T0 要加的列；
 *   迁移那一半由 t0ProbeUpdatedBy.test.ts 的「①E 迁移段静态扫描」单独钉死，两边不重复、也不漏。
 *
 * 【预期】
 *   A（workflow_def 引擎层）红 —— saveWorkflowDef 无 expectVersion，旧版本写照样成功并自增
 *   B（租户字典 HTTP 层）红 —— PUT 端点无版本锚，旧版本号写照样 200 并覆盖
 *   C（静态：单语句条件更新计数）红 —— 全仓 0 处
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
import { saveWorkflowDef, getWorkflowDefVersion } from '../engine/workflowDef.js';
import type { SaveWorkflowDefOpts } from '../engine/workflowDef.js';
import type { WorkflowDef } from '../engine/stateMachine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL098 = readFileSync(join(ROOT, '098_label_dict_tenant.sql'), 'utf8');
const SQL073 = readFileSync(join(ROOT, '073_label_dict.sql'), 'utf8');

const box = vi.hoisted(() => ({
  db: null as any,
  sqls: [] as string[],
}));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        box.sqls.push(sql);
        if (/role_permission/i.test(sql)) return { rows: [], rowCount: 0 };
        const r = await box.db.query(sql, params);
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
    }),
  assertSafeTenantId: (t: string) => t,
  default: {
    query: async (sql: string, params: unknown[] = []) => {
      const r = await box.db.query(sql, params);
      return { rows: r.rows, rowCount: r.rows.length };
    },
  },
}));

import metaTenantLabelRouter from '../routes/metaTenantLabel.js';

function dsl098(): string {
  const start = SQL098.indexOf('CREATE TABLE IF NOT EXISTS label_dict_tenant');
  const marker = 'CREATE INDEX IF NOT EXISTS idx_label_dict_tenant_lookup';
  const end = SQL098.indexOf(';', SQL098.indexOf(marker));
  if (start < 0 || end < 0) throw new Error('098 迁移结构变了：截取 DDL 失败，请同步本测试');
  return SQL098.slice(start, end + 1);
}

function dsl073(): string {
  const start = SQL073.indexOf('CREATE TABLE IF NOT EXISTS label_dict');
  const marker = 'CREATE UNIQUE INDEX IF NOT EXISTS ux_label_dict_scope_key';
  const end = SQL073.indexOf(';', SQL073.indexOf(marker));
  if (start < 0 || end < 0) throw new Error('073 迁移结构变了：截取 DDL 失败，请同步本测试');
  return SQL073.slice(start, end + 1);
}

async function freshWorkflowDb(): Promise<PGlite> {
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
  await db.exec(dsl073());
  await db.exec(dsl098());
  // 目标 schema：022/098 现状 + T0 要加的列（理由见文件头，避免"没地方写 / 没锚可比"型假红）
  await db.exec(`
    ALTER TABLE workflow_def ADD COLUMN IF NOT EXISTS updated_by text;
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS updated_by text;
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
  `);
  box.db = db;
  return db;
}

function def(states: string[]): WorkflowDef {
  return {
    initial: states[0],
    states,
    transitions: states.slice(1).map((s, i) => ({ from: states[i], to: s, event: `e${i}` })),
  };
}

/** 读 live 行的 (version, states)，用于断言"被拒后一行都没动"。 */
async function liveRow(db: PGlite): Promise<{ version: number; states: string[] }> {
  const r = await db.query<{ version: number; def: unknown }>(
    `SELECT version, def FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2`,
    ['T1', 'work_order'],
  );
  const d = (typeof r.rows[0].def === 'string' ? JSON.parse(r.rows[0].def as string) : r.rows[0].def) as {
    states: string[];
  };
  return { version: Number(r.rows[0].version), states: [...d.states].sort() };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. workflow_def：用**过期版本号**再写一次，必须被拒（条件更新）
// ─────────────────────────────────────────────────────────────────────────────
describe('T0-探针②A：workflow_def 必须条件更新（旧版本号写入要被拒）', () => {
  it('A 读到 v1 → B 保存（推进到 v2）→ A 带着 v1 再写：必须拒绝，不得静默覆盖 B 的改动', async () => {
    const db = await freshWorkflowDb();

    // ① A 出场：保存第一版，并**记住自己看到的版本**
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'rated']), {
      operator: 'a',
      reason: 'probe:a-saves-v1',
    });
    const versionSeenByA = await getWorkflowDefVersion(db as never, 'T1', 'work_order');
    expect(versionSeenByA).toBe(1);

    // ② B 抢先保存（A 不知情）：版本推进到 2
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'rated', 'archived']), {
      operator: 'b',
      reason: 'probe:b-saves-v2',
    });
    expect(await getWorkflowDefVersion(db as never, 'T1', 'work_order')).toBe(2);

    // ③ A 带着**自己读到的旧版本号**再写 —— 目标行为：拒绝（409 冲突）
    //    参数名与架构师裁决一致：expectVersion（引擎层）/ expected_version（HTTP body）
    const staleOpts: SaveWorkflowDefOpts & { expectVersion: number } = {
      operator: 'a',
      reason: 'probe:a-stale-write',
      expectVersion: versionSeenByA, // ← 过期版本号（1），实际已是 2
    };
    let threw: unknown = null;
    try {
      await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'closed']), staleOpts);
    } catch (e) {
      threw = e;
    }

    const err = threw as (Error & { code?: string; status?: number }) | null;
    expect(threw, '过期版本号写入未被拒绝：条件更新缺失，B 的改动被静默覆盖').not.toBeNull();
    expect(err?.status ?? 'no-throw', '冲突必须回 409（不是 500，也不是 200 静默成功）').toBe(409);
    expect(
      err === null ? 'no-throw' : `${err.code ?? ''} ${err.message}`,
      '错误码沿用既有 DRAFT_STALE / 或语义等价的 VERSION_CONFLICT（别新造一套）',
    ).toMatch(/DRAFT_STALE|VERSION_CONFLICT|CONFLICT|STALE|version/i);
    expect(
      err === null ? 'no-throw' : String(err.message),
      '拒绝时错误信息应说明是版本冲突（要能直接告诉前端"版本已过期，请刷新重取"）',
    ).toMatch(/version|conflict|stale|过期|冲突/i);

    // ④ 被拒后 live 行必须**一行未动**：仍是 B 的 v2，不是 A 的 def
    const after = await liveRow(db);
    expect(after.version, '被拒后版本号不应继续自增').toBe(2);
    expect(after.states, '被拒后 live def 不应被改写成 A 的内容').toEqual(['archived', 'draft', 'rated']);
    await db.close();
  });

  it('当前现状快照（T0 完成后本条应被推翻）：不带版本锚的两次写都成功，后者静默吃掉前者', async () => {
    const db = await freshWorkflowDb();
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'rated']), {
      operator: 'a',
      reason: 'probe:now-1',
    });
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'rated', 'archived']), {
      operator: 'b',
      reason: 'probe:now-2',
    });
    // A 基于自己读到的 v1 再写：现在**不会**被拒，B 的 archived 状态直接人间蒸发
    await saveWorkflowDef(db as never, 'T1', 'work_order', def(['draft', 'closed']), {
      operator: 'a',
      reason: 'probe:now-3-stale',
    });
    const after = await liveRow(db);
    // 现状：version=3 且 B 的改动已被覆盖（'archived' 不在了）。T0 修好后这里必须变成"被拒 / 仍为 v2"
    expect(after.version).toBe(3);
    expect(after.states).toEqual(['closed', 'draft']);
    await db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 租户字典写端点：基于**旧值**的写入必须被拒（乐观并发）
// ─────────────────────────────────────────────────────────────────────────────
let server: Server;
let baseUrl = '';
/** HTTP 用例专用库：与 describe A 各自 new 的库**分开持有**，否则 beforeEach 会拿到已 close 的实例。 */
let httpDb: PGlite;

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(dsl073());
  await db.exec(dsl098());
  // 目标 schema：098 现状 + T0 迁移要加的两列（version = 并发锚，updated_by = 变更人）。
  // 不补这两列的话，②B 连"旧版本号"都没地方读，红了也是假红（见文件头注释）。
  await db.exec(`
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS updated_by text;
  `);
  httpDb = db;
  box.db = db;
  const app = express();
  app.use((req, res, next) => {
    const t = (req.query.tenant as string) || '';
    const username = (req.query.user as string) || 'u-alice';
    if (t) {
      (res.locals as Record<string, unknown>).auth = {
        tenantId: t,
        role: 'admin',
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

async function putLabel(key: string, body: unknown, user: string) {
  const r = await fetch(`${baseUrl}/meta/labels/me/wo_status/${key}?tenant=T1&user=${user}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function labelOf(key: string): Promise<string | undefined> {
  const r = await httpDb.query<{ label: string }>(
    `SELECT label FROM label_dict_tenant WHERE tenant_id=$1 AND scope=$2 AND key=$3`,
    ['T1', 'wo_status', key],
  );
  return r.rows[0]?.label;
}

/** 读该行的版本号（并发锚本身）：目标行为是每次写入 version + 1。 */
async function versionOf(key: string): Promise<number | undefined> {
  const r = await httpDb.query<{ version: number }>(
    `SELECT version FROM label_dict_tenant WHERE tenant_id=$1 AND scope=$2 AND key=$3`,
    ['T1', 'wo_status', key],
  );
  return r.rows[0]?.version;
}

describe('T0-探针②B：租户字典写端点必须乐观并发（基于旧版本号的写入要被拒）', () => {
  beforeEach(async () => {
    box.db = httpDb; // describe A 的用例会把 box.db 换成自己的库并 close，这里必须切回来
    const db = httpDb;
    await db.exec('TRUNCATE label_dict_tenant;');
    await db.query(
      `INSERT INTO label_dict_tenant (tenant_id, scope, key, label) VALUES ('T1','wo_status','rated','已评价')`,
    );
    box.sqls = [];
  });

  it('A 读到 v1 → B 改成"B改"（推进到 v2）→ A 带 v1 再写：必须 409，且库里仍是 B 的值', async () => {
    const versionSeenByA = await versionOf('rated');
    expect(versionSeenByA).toBe(1); // A 读到的版本号

    const byB = await putLabel('rated', { label: 'B改' }, 'u-bob');
    expect(byB.status).toBe(200); // B 写成功
    expect(await labelOf('rated')).toBe('B改');
    expect(await versionOf('rated'), '写入必须把 version 推进（没有版本维护就没有并发锚）').toBe(2);

    // A 带着自己读到的**旧版本号**写 → 目标行为：409（我基于过期事实在写）
    const byA = await putLabel('rated', { label: 'A改', expected_version: versionSeenByA }, 'u-alice');
    expect(byA.status, '基于过期版本号的写入未被拒绝：字典写端点无版本锚，B 的改动被静默覆盖').toBe(409);
    expect(await labelOf('rated'), '被拒后库里不该变成 A 的值').toBe('B改');
    expect(await versionOf('rated'), '被拒后 version 不该继续自增').toBe(2);
  });

  it('（对照·现状绿）不带版本锚的普通写入照常成功 —— 保证上面这条不是"端点根本写不进去"造成的假红', async () => {
    const r = await putLabel('rated', { label: 'A改' }, 'u-alice');
    expect(r.status).toBe(200);
    expect(await labelOf('rated')).toBe('A改');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. 静态证据：全仓「单语句条件更新」到底有几处（骨架声称 0）
// ─────────────────────────────────────────────────────────────────────────────
describe('T0-探针②C：全仓单语句条件更新计数（结构性证据）', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
  }

  /**
   * 认定"条件更新" = UPDATE ... SET ... WHERE ... 里把版本号/rev 当作**条件**（出现 version = / rev = 之类）。
   * 只认 WHERE 子句：workflowDefChange.ts 的 `SET ... base_version = $4 WHERE tenant_id...`
   * 是**写** base_version、不是拿它当条件，天然不被计入（那不是防竞态，是状态机字段维护）。
   */
  function conditionalUpdates(): Array<{ file: string; snippet: string }> {
    const out: Array<{ file: string; snippet: string }> = [];
    for (const f of walk(join(ROOT, 'src'))) {
      const src = readFileSync(f, 'utf8');
      // 两种合法形态都要认：
      //   ① 经典 UPDATE <t> SET ... WHERE ... version = $n
      //   ② UPSERT 的条件更新：INSERT ... ON CONFLICT DO UPDATE SET ... WHERE ... version = $n
      //      （初版只认① ⇒ T0 落地后这里会漏判，护栏自己变瞎，故补②）
      const res: RegExp[] = [
        /UPDATE\s+[A-Za-z_][A-Za-z0-9_]*\s+SET[\s\S]{0,1500}?;/gi,
        /ON\s+CONFLICT[\s\S]{0,400}?DO\s+UPDATE\s+SET[\s\S]{0,1500}?;/gi,
      ];
      for (const re of res) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          const stmt = m[0];
          const whereAt = stmt.search(/\bWHERE\b/i);
          if (whereAt < 0) continue;
          const where = stmt.slice(whereAt);
          if (/\b(version|rev)\b\s*(=|>=|<=|<>|!=|IS)/i.test(where)) {
            out.push({ file: f.replace(ROOT, '').replace(/\\/g, '/'), snippet: stmt.replace(/\s+/g, ' ').slice(0, 120) });
          }
        }
      }
    }
    return out;
  }

  it('配置类写入至少有一处带版本锚的单语句条件更新（当前 0 处 = 骨架证据属实）', () => {
    const hits = conditionalUpdates();
    const list = hits.map((h) => `${h.file}: ${h.snippet}`).join('\n');
    // 防扫描器退化：至少要扫到足够多的文件，否则空集会让断言永远绿
    expect(walk(join(ROOT, 'src')).length).toBeGreaterThan(50);
    expect(hits.length, `全仓单语句条件更新命中 ${hits.length} 处（骨架声称 0）：\n${list}`).toBeGreaterThanOrEqual(1);
  });

  it('workflow_def 的写入语句要么带 version 锚、要么在写入前用同一事务/同一语句比对版本（当前两者皆无）', () => {
    const src = readFileSync(join(ROOT, 'src', 'engine', 'workflowDef.ts'), 'utf8');
    // 锚点必须带 '(tenant_id'：只写 'INSERT INTO workflow_def' 会先命中前面的
    // `INSERT INTO workflow_def_history`（它是前缀），护栏就变成在验一条历史插桩 ⇒ 假红。
    // 不带列清单（列名会随 T0 演进加了 updated_by），但带左括号以锁定 live 表那一条。
    // 必须锁定 **saveWorkflowDef 那条**（带 ON CONFLICT DO UPDATE），不能命中 ensureWorkflowDef 的
    // 纯 INSERT：后者同样以 'INSERT INTO workflow_def (' 开头且位置更靠前，初版就是被它骗红的。
    // 判定依据取该语句独有的 'DO UPDATE SET def = EXCLUDED.def'。
    let at = -1;
    for (let i = src.indexOf('INSERT INTO workflow_def (tenant_id'); i >= 0; i = src.indexOf('INSERT INTO workflow_def (tenant_id', i + 1)) {
      const end0 = src.indexOf('`', i);
      if (end0 > 0 && src.slice(i, end0).includes('DO UPDATE SET def = EXCLUDED.def')) { at = i; break; }
    }
    expect(at, '没定位到 saveWorkflowDef 的 live 写入语句（护栏已失效）').toBeGreaterThan(0);
    const saveStmt = src.slice(at);
    // 语句以模板字面量的**收尾反引号**结束（后面跟的是 `,`，不是 `;`）——
    // 初版按 '`;' 切 ⇒ 永远切不到 ⇒ 拿到空串 ⇒ 护栏恒红（T0 做完了也不会转绿）。
    const end = saveStmt.indexOf('`');
    expect(end, '没找到语句收尾反引号（护栏已失效）').toBeGreaterThan(0);
    const stmt = saveStmt.slice(0, end);
    expect(stmt.length, '没定位到 saveWorkflowDef 的写入语句，护栏已失效').toBeGreaterThan(50);
    // 单语句条件更新的两种合法形态：DO UPDATE ... WHERE version = X，或 SET version = version+1 且 WHERE 带锚
    const guarded = /\bWHERE\b[\s\S]*\bversion\b\s*=/i.test(stmt);
    expect(guarded, 'workflow_def 的 UPSERT 不带任何版本锚 ⇒ 任何人的旧版本写入都会成功并覆盖').toBe(true);
  });
});
