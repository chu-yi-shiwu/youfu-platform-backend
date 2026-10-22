// metaLabelsAuthE2E.test.ts —— 租户译名字典「真鉴权」端到端（P0 回归防线）。
//
// 【这份测试为什么存在】
//   R1-B 上线后出过一个 P0：GET /meta/labels/me 生产恒 401。根因是它原在 meta.ts，
//   而 metaRouter 挂在 authMiddleware **之前**（server.ts:168 vs 175）⇒ res.locals.auth
//   恒 undefined ⇒ 恒 401。当时的生产冒烟只验了「未登录返回 401」这一个**负例**就当成
//   通过，没验「登录后能不能读到」——负例绿了 ≠ 功能活着。
//   已有的 metaTenantLabels / metaTenantLabelWrite 两个测试都**伪造** res.locals.auth
//   （?tenant=T1 注入），从来没有真过 authMiddleware，所以这个 bug 在测试里永远是绿的。
//
//   本文件补的就是这条断链：
//     真 JWT（signJwt 现签）→ 真 authMiddleware（prod 模式，含 assertTenantActive 热路径）
//     → 真 metaTenantLabelRouter → 真 withTenantClient（BEGIN / SET LOCAL app.tenant_id /
//       SET LOCAL ROLE youfu_app / COMMIT —— **不 mock 连接池**，只把 pool 实例换成 PGlite 后端）
//     → PGlite 真库（073 平台字典 + 098 覆盖表 + tenant_registry + role_permission，RLS 真生效）。
//
// 【为什么敢不 mock pool】pool.ts 的 `const pool = new Pool(...)` 惰性建连（构造不发请求），
//   把实例的 connect/query 换成 PGlite 适配器后，模块内 withTenantClient 与 auth.ts 的
//   assertTenantActive 走的都是同一个实例，拿到的是真事务语义。已探针验证 PGlite 完整支持
//   该事务链：事务内降权 youfu_app 后按 app.tenant_id 过滤行集，COMMIT 后角色自动复位，
//   第二个事务换租户不粘滞。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pool from '../db/pool.js';
import {
  authMiddleware,
  signJwt,
  __setAuthModeForTest,
  __clearTenantStatusCacheForTest,
} from '../middleware/auth.js';
import { apiGuardMiddleware } from '../middleware/apiGuard.js';
import { errorMiddleware } from '../middleware/error.js';
import metaRouter from '../routes/meta.js';
import metaTenantLabelRouter, { invalidateTenantLabelCache } from '../routes/metaTenantLabel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL098 = readFileSync(join(ROOT, '098_label_dict_tenant.sql'), 'utf8');
const SQL073 = readFileSync(join(ROOT, '073_label_dict.sql'), 'utf8');
const SECRET = 'meta-labels-e2e-secret';

/** 073 建表段（不含种子）：种子由 beforeEach 显式播，各用例看到的平台字典内容是确定的。 */
function ddl073(): string {
  const start = SQL073.indexOf('CREATE TABLE IF NOT EXISTS label_dict');
  const marker = 'CREATE UNIQUE INDEX IF NOT EXISTS ux_label_dict_scope_key';
  const end = SQL073.indexOf(';', SQL073.indexOf(marker));
  if (start < 0 || end < 0) throw new Error('073 迁移结构变了：截取 DDL 失败，请同步本测试');
  return SQL073.slice(start, end + 1);
}

type Q = { sql: string; params: unknown[] };
const queries: Q[] = [];

let db: PGlite;
let prodServer: Server;   // 生产真实挂载顺序：metaRouter 在 auth 前（免鉴权），metaTenantLabelRouter 在 auth 后
let swappedServer: Server; // RED 探针用：两个 router 都先于 authMiddleware（= P0 形态）
let prodBase = '';
let swappedBase = '';

/** PGlite 适配的 PoolClient：query/release 两个方法即 withTenantClient 用到的全部面。 */
const fakeClient = {
  query: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    const r = await db.query(sql, params as never);
    return { rows: r.rows as Array<Record<string, unknown>>, rowCount: r.rows.length };
  },
  release: () => undefined,
};

function buildApp(order: 'prod' | 'swapped') {
  const app = express();
  app.use(express.json());
  if (order === 'prod') {
    // 与 server.ts 逐行同序：metaRouter（:168，免鉴权）→ apiGuard（:174）→ authMiddleware（:175）
    //   → metaTenantLabelRouter（:212）。顺序本身就是被测对象的一部分，不许"图顺"改排。
    app.use('/api/v1', metaRouter);
    app.use('/api', apiGuardMiddleware);
    app.use('/api', authMiddleware);
    app.use('/api/v1', metaTenantLabelRouter);
  } else {
    // P0 形态复刻：读端点所在的 router 先于 authMiddleware 挂载
    app.use('/api/v1', metaTenantLabelRouter);
    app.use('/api', apiGuardMiddleware);
    app.use('/api', authMiddleware);
    app.use('/api/v1', metaRouter);
  }
  app.use(errorMiddleware);
  return app;
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}/api/v1` };
}

/** 现签 JWT：tenant 缺省表示 token 里不带 tid/tenantId（用于 TENANT_001 用例）。 */
function jwt(tenant?: string, role = 'admin', extra: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = { sub: 'u-e2e', username: 'e2e', role, ...extra };
  if (tenant) payload.tid = tenant;
  return signJwt(payload, SECRET);
}

async function getMe(token?: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${prodBase}/meta/labels/me`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });
  return { status: r.status, headers: r.headers, body: (await r.json()) as Record<string, never> };
}

async function putLabel(
  token: string | undefined,
  scope: string,
  key: string,
  label: unknown,
  qs = '',
) {
  const r = await fetch(`${prodBase}/meta/labels/me/${scope}/${key}${qs}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ label }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, never> };
}

const PLATFORM: Array<[string, string, string]> = [
  ['wo_status', 'draft', '草稿'],
  ['wo_status', 'assigned', '已派单'],
  ['wo_status', 'processing', '处理中'],
  ['priority', 'urgent', '加急'],
];

beforeAll(async () => {
  __setAuthModeForTest('prod'); // 强制 prod 鉴权分支（JWT 必验），与生产同一条代码路径
  process.env.JWT_SECRET = SECRET;

  db = new PGlite();
  // 098 全文真执行（含 RLS / GRANT / 唯一索引）——labelDictTenant.test.ts 已验证 PGlite 吃得下
  await db.exec(`CREATE ROLE youfu_app NOLOGIN;`);
  await db.exec(`
    CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS text
      LANGUAGE sql STABLE AS $$
        SELECT COALESCE(current_setting('app.tenant_id', true), '')::text;
      $$;
  `);
  await db.exec(SQL098);
  await db.exec(ddl073());
  // T0（101 迁移）：覆盖表新增 updated_by + version，库形状须与生产迁移一致（否则写语句假红）
  await db.exec(`
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS updated_by text;
    ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;
  `);
  // assertTenantActive（authMiddleware 热路径）与 hasPerm（权限门）要查的两张表：
  // 形状取最小可用集，GRANT 与 046/079 生产迁移同口径（youfu_app 可读、role_permission 可读写）。
  await db.exec(`
    CREATE TABLE tenant_registry (tenant_id text PRIMARY KEY, status text NOT NULL);
    CREATE TABLE role_permission (
      tenant_id text NOT NULL, role text NOT NULL, perm text NOT NULL,
      PRIMARY KEY (tenant_id, role, perm)
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON role_permission TO youfu_app;
    GRANT SELECT ON tenant_registry TO youfu_app;
  `);

  // 只换 pool 实例的 connect/query，**不动 withTenantClient 本体**（真事务语义）
  (pool as unknown as { connect: () => Promise<typeof fakeClient> }).connect = async () => fakeClient;
  (pool as unknown as { query: typeof fakeClient.query }).query = fakeClient.query;

  const a = await listen(buildApp('prod'));
  prodServer = a.server;
  prodBase = a.base;
  const b = await listen(buildApp('swapped'));
  swappedServer = b.server;
  swappedBase = b.base;
});

afterAll(async () => {
  await new Promise<void>((resolve) => prodServer.close(() => resolve()));
  await new Promise<void>((resolve) => swappedServer.close(() => resolve()));
  await db.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE label_dict_tenant; TRUNCATE label_dict; TRUNCATE tenant_registry; TRUNCATE role_permission;');
  for (const [scope, key, label] of PLATFORM) {
    await db.query('INSERT INTO label_dict (scope, key, label) VALUES ($1, $2, $3)', [scope, key, label]);
  }
  // T1：管理员把平台状态 draft 改叫「待提交」，自定义状态 rated 改成「已评价」（覆盖优先的两个方向都要验）
  await db.query(
    `INSERT INTO label_dict_tenant (tenant_id, scope, key, label) VALUES
      ('T1','wo_status','draft','待提交'), ('T1','wo_status','rated','已评价')`,
  );
  await db.query(`INSERT INTO tenant_registry (tenant_id, status) VALUES ('T1','active'),('T2','active'),('T3','suspended')`);
  // T2 的 worker 被租户显式授予 basicdata.edit（租户覆盖优先于默认矩阵的用例）
  await db.query(`INSERT INTO role_permission (tenant_id, role, perm) VALUES ('T2','worker','basicdata.edit')`);
  invalidateTenantLabelCache();
  __clearTenantStatusCacheForTest();
  queries.length = 0;
});

describe('R1-B 租户译名字典：真鉴权端到端（P0 回归防线）', () => {
  it('正例：有效 JWT 登录后 GET /meta/labels/me → 200，平台字典 ∪ 租户覆盖且覆盖优先', async () => {
    const r = await getMe(jwt('T1'));
    expect(r.status).toBe(200);
    const labels = r.body.labels as unknown as Record<string, Record<string, string>>;
    expect(labels.wo_status.draft).toBe('待提交'); // 租户覆盖赢平台值
    expect(labels.wo_status.rated).toBe('已评价'); // 平台没有的自定义状态也有中文名
    expect(labels.wo_status.assigned).toBe('已派单'); // 平台值原样保留
    expect(labels.priority.urgent).toBe('加急');
    // 覆盖查询必须带服务端租户身份（RLS + 显式 WHERE 双保险，缺一不可）
    const sel = queries.filter((q) => /FROM label_dict_tenant/i.test(q.sql));
    expect(sel.length).toBeGreaterThan(0);
    expect(sel[0].params).toEqual(['T1']);
  });

  it('无 Authorization 头 → 401', async () => {
    const r = await getMe();
    expect(r.status).toBe(401);
    expect(queries.filter((q) => /label_dict/i.test(q.sql))).toEqual([]); // 未登录不得碰字典
  });

  it('垃圾 token / 错密钥签名 / 过期 token → 401（三种失效都拒，不放行）', async () => {
    expect((await getMe('not-a-jwt')).status).toBe(401);
    expect((await getMe(signJwt({ tid: 'T1' }, 'another-secret'))).status).toBe(401);
    expect((await getMe(jwt('T1', 'admin', { exp: Math.floor(Date.now() / 1000) - 60 }))).status).toBe(401);
  });

  it('token 里没有 tid/tenantId → 401（TENANT_001，无租户身份不得进租户数据）', async () => {
    const r = await getMe(jwt(undefined));
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('TENANT_001');
  });

  it('请求头 X-Tenant-Id 伪造无效：T1 的 token + X-Tenant-Id: T2 → 仍只拿到 T1 的译名', async () => {
    // prod 语义锁定（#735 修复的回归防线）：租户只取自签名 JWT，不信任何客户端头
    const r = await getMe(jwt('T1'), { 'X-Tenant-Id': 'T2' });
    expect(r.status).toBe(200);
    const labels = r.body.labels as unknown as Record<string, Record<string, string>>;
    expect(labels.wo_status.draft).toBe('待提交'); // T1 的覆盖；若退化成读头，这里会是平台值「草稿」
  });

  it('被停用租户的在途 token → 403（assertTenantActive 热路径真在拦）', async () => {
    const r = await getMe(jwt('T3'));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('TENANT_SUSPENDED');
  });

  it('registry 无记录的租户放行（过渡窗口兼容，不误伤 registry 落库前的存量租户）', async () => {
    const r = await getMe(jwt('T4'));
    expect(r.status).toBe(200);
  });

  it('PUT 作为 operator → 200（basicdata.edit 在 operator 默认矩阵；权限点被改回 workflow.edit 这条红）', async () => {
    const r = await putLabel(jwt('T2', 'operator'), 'wo_status', 'rated', '已评价');
    expect(r.status).toBe(200);
    const row = await db.query<{ label: string }>(`SELECT label FROM label_dict_tenant WHERE tenant_id='T2' AND key='rated'`);
    expect(row.rows[0]?.label).toBe('已评价');
  });

  it('PUT 作为 worker → 403（权限门真的在挡，不是摆设）', async () => {
    const r = await putLabel(jwt('T1', 'worker'), 'wo_status', 'rated', '已评价');
    expect(r.status).toBe(403);
    const row = await db.query<{ label: string }>(`SELECT label FROM label_dict_tenant WHERE tenant_id='T1' AND key='rated'`);
    expect(row.rows[0]?.label).toBe('已评价'); // 保持原值，未被写坏
  });

  it('PUT 作为 worker + 租户 role_permission 显式授权 → 200（租户覆盖优先于默认矩阵）', async () => {
    const r = await putLabel(jwt('T2', 'worker'), 'wo_status', 'rated', '工人也可改');
    expect(r.status).toBe(200);
    const row = await db.query<{ label: string }>(`SELECT label FROM label_dict_tenant WHERE tenant_id='T2' AND key='rated'`);
    expect(row.rows[0]?.label).toBe('工人也可改');
  });

  it('PUT → GET 立刻是新值（写侧必须失效读缓存，走真实 invalidateTenantLabelCache）', async () => {
    // 用 T1：beforeEach 已给它播种 rated→已评价，缓存预热有确定的旧值可验
    const warm = await getMe(jwt('T1'));
    const warmLabels = warm.body.labels as unknown as Record<string, Record<string, string>>;
    expect(warmLabels.wo_status.rated).toBe('已评价'); // 先把缓存预热成旧值

    const put = await putLabel(jwt('T1'), 'wo_status', 'rated', '已评价Plus');
    expect(put.status).toBe(200);

    const after = await getMe(jwt('T1'));
    const afterLabels = after.body.labels as unknown as Record<string, Record<string, string>>;
    expect(afterLabels.wo_status.rated).toBe('已评价Plus'); // 串了旧缓存会在这里红
    // 且第二次 GET 真的重新查了库（不是从内存缓存里吐的旧值）
    const selsAfterPut = queries.slice(queries.findIndex((q) => /INSERT INTO label_dict_tenant/i.test(q.sql)))
      .filter((q) => /FROM label_dict_tenant/i.test(q.sql));
    expect(selsAfterPut.length).toBeGreaterThan(0);
  });

  it('写路径只碰 label_dict_tenant：平台字典逐值不动（真库比对）', async () => {
    const before = await db.query(`SELECT scope, key, label FROM label_dict ORDER BY scope, key`);
    const r = await putLabel(jwt('T1'), 'wo_status', 'draft', '待提交改');
    expect(r.status).toBe(200);
    const after = await db.query(`SELECT scope, key, label FROM label_dict ORDER BY scope, key`);
    expect(after.rows).toEqual(before.rows); // 平台字典一字不动
    for (const q of queries) {
      expect(q.sql).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+label_dict(?!_tenant)\b/i);
    }
  });

  it('事务链完整：withTenantClient 真序 BEGIN → SET LOCAL app.tenant_id → SET LOCAL ROLE youfu_app → COMMIT', async () => {
    await getMe(jwt('T1'));
    const idx = (re: RegExp) => queries.findIndex((q) => re.test(q.sql));
    const begin = idx(/^BEGIN/i);
    const setTenant = idx(/SET LOCAL app\.tenant_id/i);
    const setRole = idx(/SET LOCAL ROLE youfu_app/i);
    const commit = idx(/^COMMIT/i);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(setTenant).toBeGreaterThan(begin);
    expect(setRole).toBeGreaterThan(setTenant);
    expect(commit).toBeGreaterThan(setRole);
    // 注入的租户必须来自服务端（= token 的 tid），不是请求侧任何输入
    expect(queries[setTenant].sql).toContain("'T1'");
    // SET LOCAL ROLE 是 RLS 的开关：被"优化"掉后 superuser 恒绕过策略，隔离静默失效
    expect(setRole).toBeGreaterThan(0);
  });

  it('零回归：/meta/labels 免鉴权 200 且是纯平台字典 + public 头；/me 是 private 头', async () => {
    const pub = await fetch(`${prodBase}/meta/labels`);
    expect(pub.status).toBe(200); // 无 token 也 200（FE/mp 启动即拉，不能被挡）
    const labels = ((await pub.json()) as { labels: Record<string, Record<string, string>> }).labels;
    expect(labels.wo_status.draft).toBe('草稿'); // 未被 T1 的覆盖污染
    expect(labels.wo_status.rated).toBeUndefined();
    expect(pub.headers.get('cache-control')).toBe('public, max-age=300');
    const me = await getMe(jwt('T1'));
    expect(me.headers.get('cache-control')).toMatch(/private/);
  });
});

describe('RED 探针：挂载顺序对调后正例必须红（证明上面的正例抓得住 P0 回归）', () => {
  it('router 先于 authMiddleware（= P0 形态）时，有效 JWT 也 401；公开端点同样被挡', async () => {
    // 这正是生产事故的形态：GET /meta/labels/me 原在 meta.ts，metaRouter 挂 auth 之前
    const me = await fetch(`${swappedBase}/meta/labels/me`, {
      headers: { Authorization: `Bearer ${jwt('T1')}` },
    });
    expect(me.status).toBe(401); // 生产顺序下同一请求是 200（见上面正例）
    const pub = await fetch(`${swappedBase}/meta/labels`);
    expect(pub.status).toBe(401); // 生产顺序下是 200（免鉴权公开端点）
  });
});
