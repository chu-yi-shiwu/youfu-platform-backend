// metaTenantLabelWrite.http.test.ts —— 展示标签「租户覆盖」**写**端点
// PUT /api/v1/meta/labels/me/:scope/:key（R1-B 补全）。
//
// 为什么必须有这个端点：098 落覆盖行时 label 缺省 = key（ensureTenantStateLabels），
// 管理员没有任何入口把裸 key 改成中文名 ⇒ 租户自定义状态在界面上仍是英文裸 key。
// 本端点是「改译名」的唯一入口；红线是**绝不能写到平台字典 label_dict**（写穿 = 全平台事故）。
//
// 【验证口径】真 express + 真 HTTP + **PGlite 真库**（仿 labelDictTenant.test.ts）：
// 真建表（098 + 073 的 DDL 段，GRANT/RLS 段 PGlite 不认，治理段由那份测试真跑）、
// 真执行 UPSERT、真查行。只替换连接池外壳（withTenantClient），SQL 一行不 mock。
//
// 覆盖：① 未登录 → 401
//       ② 正常改 → 200，真库里该租户该 key 的 label 变成新值（UPSERT 生效）
//       ③ **平台字典不被写穿**（真库逐值比对 label_dict + src 静态护栏双重卡）
//       ④ 非法 scope / 空 label / 超长 label → 400
//       ⑤ 请求里带 tenant_id 无效：仍写 auth 的 tenantId（防越权改别人字典）
//       ⑥ 无 basicdata.edit 权限 → 403；operator 默认矩阵含它 → 200（锁权限点，防改回 workflow.edit）
//       ⑦ 写后读 /meta/labels/me 立刻是新值（缓存必须失效）
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

type Db = {
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; affectedRows?: number }>;
  close(): Promise<void>;
};

/** 098 建表段（PGlite 可执行）：CREATE TABLE + 两个 CREATE INDEX；GRANT/RLS 段不认，走静态+治理测试。 */
function ddl098(): string {
  const start = SQL098.indexOf('CREATE TABLE IF NOT EXISTS label_dict_tenant');
  const marker = 'CREATE INDEX IF NOT EXISTS idx_label_dict_tenant_lookup';
  const end = SQL098.indexOf(';', SQL098.indexOf(marker));
  if (start < 0 || end < 0) throw new Error('098 迁移结构变了：截取 DDL 失败，请同步本测试');
  return SQL098.slice(start, end + 1);
}

/** 073 建表段（**不含种子**）：写穿检测要拿它做真库比对，表不存在就谈不上"没被改"。 */
function ddl073(): string {
  const start = SQL073.indexOf('CREATE TABLE IF NOT EXISTS label_dict');
  const marker = 'CREATE UNIQUE INDEX IF NOT EXISTS ux_label_dict_scope_key';
  const end = SQL073.indexOf(';', SQL073.indexOf(marker));
  if (start < 0 || end < 0) throw new Error('073 迁移结构变了：截取 DDL 失败，请同步本测试');
  return SQL073.slice(start, end + 1);
}

const h = vi.hoisted(() => ({
  db: null as unknown,
  rolePerms: [] as string[],
  // 下发的每条 SQL + 参数：越权（tenant_id 取错）只有看 SQL 才抓得到——只看 HTTP 状态码是绿的。
  sqls: [] as string[],
  params: [] as unknown[][],
  tenants: [] as string[],
}));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (tenantId: string, fn: (c: unknown) => Promise<unknown>) => {
    h.tenants.push(tenantId);
    return fn({
      query: async (sql: string, params: unknown[] = []) => {
        h.sqls.push(sql);
        h.params.push(params);
        // role_permission 是权限点查询，与本端点的字典写无关，走桩（权限行为由 role.ts 保证）
        if (/role_permission/i.test(sql)) {
          return { rows: h.rolePerms.map((perm) => ({ perm })), rowCount: h.rolePerms.length };
        }
        const r = await (h.db as { query: Db['query'] }).query(sql, params); // 真库执行
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
      },
    });
  },
  assertSafeTenantId: (t: string) => t,
  default: {
    query: async (sql: string, params: unknown[] = []) => {
      const r = await (h.db as { query: Db['query'] }).query(sql, params);
      return { rows: r.rows, rowCount: r.rows.length };
    },
  },
}));

import metaRouter from '../routes/meta.js';
import metaTenantLabelRouter from '../routes/metaTenantLabel.js';

const PLATFORM: Array<[string, string, string]> = [
  ['wo_status', 'draft', '草稿'],
  ['wo_status', 'assigned', '已派单'],
  ['priority', 'urgent', '加急'],
];

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  // PGlite 实例**整个文件只建一次**：每个用例 new 一个是 12 次 WASM 实例化的开销
  // （全量跑时还会在并发下偶发 ECONNRESET），用例间用 TRUNCATE + 重播种隔离即可。
  const db = new PGlite();
  await db.exec(ddl098());
  await db.exec(ddl073());
  // T0（101 迁移）：覆盖表新增 updated_by + version，库形状须与生产迁移一致（否则写语句假红）
  await db.exec(`
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS updated_by text;
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
  `);
  h.db = db;
  const app = express();
  // 伪造鉴权：?tenant=T1 时注入 res.locals.auth（role 默认 admin），不传即未登录
  app.use((req, res, next) => {
    const t = (req.query.tenant as string) || '';
    const role = (req.query.role as string) || 'admin';
    if (t) (res.locals as Record<string, unknown>).auth = { tenantId: t, role, requestId: 'r1', authMode: 'prod' };
    next();
  });
  app.use(express.json());
  app.use('/api/v1', metaRouter); // 平台字典读端点（验证写端点不污染它）
  app.use('/api/v1', metaTenantLabelRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await (h.db as Db).close();
});

beforeEach(async () => {
  const db = h.db as unknown as Db;
  // 真库重置：清空两张表再按固定基线播种（用例之间零串扰，且不重建 WASM 实例）
  await db.exec('TRUNCATE label_dict_tenant; TRUNCATE label_dict;');
  for (const [scope, key, label] of PLATFORM) {
    await db.query('INSERT INTO label_dict (scope, key, label) VALUES ($1, $2, $3)', [scope, key, label]);
  }
  // 模拟流程生效落下的裸 key（098 ensureTenantStateLabels 的行为）
  await db.query(
    `INSERT INTO label_dict_tenant (tenant_id, scope, key, label) VALUES ('T1','wo_status','rated','rated')`,
  );
  h.rolePerms = [];
  h.sqls = [];
  h.params = [];
  h.tenants = [];
});

async function putLabel(scope: string, key: string, body: unknown, qs = 'tenant=T1') {
  const r = await fetch(`${baseUrl}/meta/labels/me/${scope}/${key}?${qs}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, body: json };
}

/** 真库读覆盖表某租户某 key 的 label。 */
async function overrideOf(tenant: string, scope: string, key: string): Promise<string | undefined> {
  const r = await (h.db as { query: Db['query'] }).query(
    `SELECT label FROM label_dict_tenant WHERE tenant_id=$1 AND scope=$2 AND key=$3`,
    [tenant, scope, key],
  );
  return r.rows[0]?.label as string | undefined;
}

async function platformRows(): Promise<Array<{ scope: string; key: string; label: string }>> {
  const r = await (h.db as { query: Db['query'] }).query(`SELECT scope, key, label FROM label_dict ORDER BY key`);
  return r.rows as unknown as Array<{ scope: string; key: string; label: string }>;
}

describe('PUT /api/v1/meta/labels/me/:scope/:key（租户覆盖字典写，PGlite 真库）', () => {
  it('未登录 → 401（写端点必须鉴权，且不得接受任何请求侧身份）', async () => {
    const r = await putLabel('wo_status', 'rated', { label: '已评价' }, '');
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('UNAUTHENTICATED');
    expect(h.sqls).toEqual([]); // 未登录不得下发任何 SQL
  });

  it('正常改 → 200 且真库里该租户该 key 的 label 变成新值', async () => {
    expect(await overrideOf('T1', 'wo_status', 'rated')).toBe('rated'); // 改前是裸 key
    const r = await putLabel('wo_status', 'rated', { label: '已评价' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, scope: 'wo_status', key: 'rated', label: '已评价' });
    expect(await overrideOf('T1', 'wo_status', 'rated')).toBe('已评价'); // 真库里真的改了
  });

  it('UPSERT：覆盖表里原本没有的行直接插入（不用先建后改）', async () => {
    const r = await putLabel('wo_status', 'brand_new_state', { label: '全新状态' });
    expect(r.status).toBe(200);
    expect(await overrideOf('T1', 'wo_status', 'brand_new_state')).toBe('全新状态');
    // 必须是同一条 UPSERT 语句，不能是「先 SELECT 再 INSERT/UPDATE」的两步（有竞态）
    expect(h.sqls.filter((s) => /INSERT INTO label_dict_tenant/i.test(s)).length).toBe(1);
    expect(h.sqls.some((s) => /ON CONFLICT/i.test(s))).toBe(true);
  });

  it('平台字典绝对不被写穿（真库逐值比对 label_dict 一字不动）', async () => {
    const before = await platformRows();
    const r = await putLabel('wo_status', 'draft', { label: '待提交' });
    expect(r.status).toBe(200);
    // 真库：平台字典内容零改动（逐值）
    expect(await platformRows()).toEqual(before);
    // 租户覆盖真的落在 _tenant 表上，平台表没多出任何行
    expect((await platformRows()).map((x) => x.key)).toEqual(['assigned', 'draft', 'urgent']);
    // 下发的所有写语句只碰 label_dict_tenant
    for (const sql of h.sqls) {
      expect(sql).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+label_dict\b/i);
    }
    // 平台字典读端点仍返回平台值，未被租户覆盖污染
    const pub = await fetch(`${baseUrl}/meta/labels`);
    const labels = ((await pub.json()) as { labels: Record<string, Record<string, string>> }).labels;
    expect(labels.wo_status.draft).toBe('草稿');
  });

  it('非法 scope → 400（白名单外一律拒，防把垃圾塞进字典表）', async () => {
    const r = await putLabel('evil_scope', 'x', { label: 'x' });
    expect(r.status).toBe(400);
    expect(h.sqls).toEqual([]); // 校验不过不得落库
  });

  it('空 label / 全空白 label / 超长 label / 缺 label → 400', async () => {
    expect((await putLabel('wo_status', 'rated', { label: '' })).status).toBe(400);
    expect((await putLabel('wo_status', 'rated', { label: '   ' })).status).toBe(400);
    expect((await putLabel('wo_status', 'rated', {})).status).toBe(400);
    expect((await putLabel('wo_status', 'rated', { label: '好'.repeat(64) })).status).toBe(200); // 64 是上限，可过
    expect((await putLabel('wo_status', 'rated', { label: '好'.repeat(65) })).status).toBe(400);
  });

  it('label 去空白后落库（前后空格不进字典）', async () => {
    const r = await putLabel('wo_status', 'rated', { label: '  已评价  ' });
    expect(r.status).toBe(200);
    expect(await overrideOf('T1', 'wo_status', 'rated')).toBe('已评价');
  });

  it('请求里的 tenant_id 无效：仍写 auth 的 tenantId（防越权改别人的字典）', async () => {
    const r = await putLabel('wo_status', 'rated', { label: '已评价', tenant_id: 'T9' }, 'tenant=T1&tenant_id=T9');
    expect(r.status).toBe(200);
    expect(h.tenants).toEqual(['T1']); // 连接上下文只可能是 auth 的租户
    const writeParams = h.params[h.sqls.findIndex((s) => /INSERT INTO label_dict_tenant/i.test(s))];
    expect(writeParams[0]).toBe('T1'); // SQL 第一个参数 = 服务端取的租户，不是请求参数
    expect(await overrideOf('T9', 'wo_status', 'rated')).toBeUndefined(); // 别人家字典没被改
    expect(await overrideOf('T1', 'wo_status', 'rated')).toBe('已评价');
  });

  it('无 basicdata.edit 权限（worker 默认矩阵不含）→ 403', async () => {
    const r = await putLabel('wo_status', 'rated', { label: '已评价' }, 'tenant=T1&role=worker');
    expect(r.status).toBe(403);
    expect(await overrideOf('T1', 'wo_status', 'rated')).toBe('rated'); // 未落库
  });

  it('operator 默认矩阵含 basicdata.edit → 200（权限点若被改回 workflow.edit 这条红）', async () => {
    const r = await putLabel('wo_status', 'rated', { label: '已评价' }, 'tenant=T1&role=operator');
    expect(r.status).toBe(200);
    expect(await overrideOf('T1', 'wo_status', 'rated')).toBe('已评价');
  });

  it('改完再读 /meta/labels/me 立刻是新值（写侧必须失效租户缓存，不然改了不生效）', async () => {
    const before = await fetch(`${baseUrl}/meta/labels/me?tenant=T1`);
    const beforeLabels = ((await before.json()) as { labels: Record<string, Record<string, string>> }).labels;
    expect(beforeLabels.wo_status.rated).toBe('rated'); // 先把缓存预热成旧值

    const r = await putLabel('wo_status', 'rated', { label: '已评价' });
    expect(r.status).toBe(200);

    const after = await fetch(`${baseUrl}/meta/labels/me?tenant=T1`);
    const afterLabels = ((await after.json()) as { labels: Record<string, Record<string, string>> }).labels;
    expect(afterLabels.wo_status.rated).toBe('已评价'); // 串了旧缓存会在这里红
    expect(afterLabels.wo_status.draft).toBe('草稿'); // 平台值仍在
  });
});

/**
 * 【结构性护栏】src/ 下的**生产代码**不得有任何写平台字典 label_dict 的语句。
 * 为什么单独一道静态门：上面那条真库比对只能证明"这次调用没写穿"，证明不了"代码里没有这条路径"
 * （换个分支、换个 scope 就可能走到）。正则护栏把整条路径都封死。
 * 只扫 src/ 非 test 目录：测试文件为了造平台字典种子本来就会 INSERT label_dict（见 labelDictTenant.test.ts）。
 */
describe('结构性护栏：生产代码零写平台字典', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
  }

  it('src/**/*.ts（非测试）不含 INSERT/UPDATE/DELETE 到 label_dict（非 _tenant）的语句', () => {
    const files = walk(join(ROOT, 'src'));
    expect(files.length).toBeGreaterThan(20); // 防扫描器退化成空集（空集会让断言永远绿）
    const offenders: string[] = [];
    for (const f of files) {
      // 先剥注释：meta.ts 的文件头注释里写着「改标签零代码（UPDATE label_dict 即生效）」，
      // 不剥会把一句设计说明误判成写穿语句（护栏自己变成噪音就没人信它了）。
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
      if (/(INSERT INTO|UPDATE|DELETE FROM)\s+label_dict(?!_tenant)\b/i.test(src)) {
        offenders.push(f.replace(ROOT, ''));
      }
    }
    expect(offenders, `以下文件写穿平台字典 label_dict（全局事故面）:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('本端点的 UPSERT 落点必须是 label_dict_tenant 且带 tenant_id（护栏自身不被改空）', () => {
    const src = readFileSync(join(ROOT, 'src', 'routes', 'metaTenantLabel.ts'), 'utf8');
    expect(src).toMatch(/INSERT INTO label_dict_tenant/);
    expect(src).toMatch(/ON CONFLICT \(tenant_id, scope, key\) DO UPDATE/);
    expect(src).not.toMatch(/INSERT INTO label_dict(?!_tenant)/);
  });
});
