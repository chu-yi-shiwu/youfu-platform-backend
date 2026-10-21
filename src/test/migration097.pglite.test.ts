/**
 * 097_platform_config.sql —— PGlite 真跑验证
 *
 * 【为什么补这份】
 *   093/094/095/096 四个迁移都有 PGlite 真执行测试，097 是唯一没有的——
 *   而它建的表正好是「谁能改流程」这道治理闸的**唯一数据源**：
 *     · 表没建出来 → getWorkflowConfigOwner 回退 'platform'（还好，fail-closed）；
 *     · 表建出来但**误带 RLS** → 平台侧 pool 直连不设 app.tenant_id，查询恒返回空行
 *       ⇒ 永远读不到 'tenant'，运维在后台拨开关也拨不动 ⇒ 客户改不了 + 运维也改不了 = 死锁；
 *     · 种子写成 ON CONFLICT DO UPDATE → 每次部署都会把运维已拨开的开关**悄悄拨回去**。
 *   这三条没有一条能被「读代码」发现，只有真跑才验得出来。
 *
 * 【验证口径】与 094/095/096 同款：真建库 → 真执行迁移 → 查真实系统表/真实行。
 */
import { describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 写入侧（setPlatformConfig / setWorkflowConfigOwner）是 pool 直连、不接受 client 注入，
// 要真验它的 UPSERT 行为只能把 pool 指向真库。box.db 由每个用例置为当前 PGlite 实例。
const box = vi.hoisted(() => ({ db: null as any }));
vi.mock('../db/pool.js', () => ({
  default: {
    query: async (sql: string, params: unknown[] = []) => {
      if (!box.db) throw new Error('test harness: PGlite 实例未初始化');
      return box.db.query(sql, params);
    },
  },
  withTenantClient: async (_t: string, fn: (c: unknown) => unknown) => fn(box.db),
  assertSafeTenantId: (t: string) => t,
}));

import { getWorkflowConfigOwner, setWorkflowConfigOwner, setPlatformConfig } from '../repo/platformConfig.js';

const ROOT = join(__dirname, '..', '..');

function readMigration(): string {
  // 与 096 harness 同款：剥掉 psql 元命令（PGlite 走 pg 协议，不认反斜杠命令）
  return readFileSync(join(ROOT, '097_platform_config.sql'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l))
    .join('\n');
}

const SQL = readMigration();

/** 建库 + 跑迁移，并把它设为 pool 指向的真库（写入侧用例需要）。 */
async function freshDb() {
  const db = new PGlite();
  await db.exec(SQL);
  box.db = db;
  return db;
}

describe('097_platform_config.sql（PGlite 真跑）', () => {
  it('① 表建出来，且种子行 = platform（缺省取最严侧）', async () => {
    const db = await freshDb();
    const r = await db.query<{ value: string; updated_by: string | null }>(
      `SELECT value, updated_by FROM platform_config WHERE key = 'workflow_config_owner'`,
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].value).toBe('platform');
    expect(r.rows[0].updated_by).toBe('097_migration');
    await db.close();
  });

  it('② 幂等：二次执行不报错，种子仍只有 1 行（ON CONFLICT DO NOTHING）', async () => {
    const db = new PGlite();
    await db.exec(SQL);
    await db.exec(SQL); // 重复部署
    await db.exec(SQL);
    const r = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM platform_config`);
    expect(r.rows[0].c).toBe(1);
    await db.close();
  });

  it('③ 表不得带 tenant_id 列（平台级表；带租户列 = 客户能自己改开关，等于没锁）', async () => {
    const db = await freshDb();
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'platform_config'`,
    );
    const cols = r.rows.map((x) => x.column_name);
    expect(cols).not.toContain('tenant_id');
    expect(cols.sort()).toEqual(['key', 'updated_at', 'updated_by', 'value']);
    await db.close();
  });

  it('④ 表不得挂 RLS（误挂 ⇒ 平台侧直连恒空行 ⇒ 开关永远拨不动，运维也被锁死）', async () => {
    const db = await freshDb();
    const r = await db.query<{ rowsecurity: boolean }>(
      `SELECT rowsecurity FROM pg_tables WHERE tablename = 'platform_config'`,
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].rowsecurity).toBe(false);
    await db.close();
  });

  it('⑤ 运维已拨成 tenant 后重跑迁移，不得被覆盖回 platform（否则每次部署都偷偷收回授权）', async () => {
    const db = await freshDb();
    await db.query(
      `UPDATE platform_config SET value = 'tenant', updated_by = 'ops:alice'
       WHERE key = 'workflow_config_owner'`,
    );
    await db.exec(SQL); // 重新部署
    const r = await db.query<{ value: string; updated_by: string }>(
      `SELECT value, updated_by FROM platform_config WHERE key = 'workflow_config_owner'`,
    );
    expect(r.rows[0].value).toBe('tenant');
    expect(r.rows[0].updated_by).toBe('ops:alice'); // 留痕也未被覆盖
    await db.close();
  });

  it('⑥ key 是主键：同一 key 只可能存在一行（防并发部署写出两行互相打架）', async () => {
    const db = await freshDb();
    await expect(
      db.query(`INSERT INTO platform_config (key, value) VALUES ('workflow_config_owner', 'tenant')`),
    ).rejects.toThrow();
    await db.close();
  });

  // 诚实边界：⑦ 不试图证明「RLS 会不会拦住查询」——PGlite 连接是 superuser，
  // superuser 恒绕过 RLS（连 FORCE 也无效），写那种断言只会得到一条**永远绿**的假锚。
  // ④ 的 rowsecurity=false 才是防误挂 RLS 的真断言。
  // 注意：这里**不能**只断言 owner === 'platform' —— 读取失败时回退值恰好也是 'platform'，
  // 那样即使表名/key 名全写错也会绿，是一条不可证伪的假锚（E2 可验证）。
  // 真正要锚的是「没有走静默回退」：repo 读失败会 console.warn，故断言 warn 未被调用。
  it('⑦ repo 读取函数对着真库跑得通：既不报错也不静默回退（表名/key 名/SQL 三者对齐）', async () => {
    const db = await freshDb();
    const saved = process.env.WORKFLOW_CONFIG_OWNER;
    delete process.env.WORKFLOW_CONFIG_OWNER; // 排除 env 熔断层干扰，只验 DB 链路
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 直接把 PGlite 当 client 注入 repo 函数：跑的是 src/repo/platformConfig.ts 里那条真实 SQL
      const owner = await getWorkflowConfigOwner(db as never);
      expect(owner).toBe('platform');
      expect(warn).not.toHaveBeenCalled(); // ← 关键：真读到了，不是读崩了回退来的
    } finally {
      warn.mockRestore();
      if (saved === undefined) delete process.env.WORKFLOW_CONFIG_OWNER;
      else process.env.WORKFLOW_CONFIG_OWNER = saved;
      await db.close();
    }
  });

  it('⑧ 运维在库里拨成 tenant 后，repo 读取函数立即读到 tenant（后台改库即生效，无需发版）', async () => {
    const db = await freshDb();
    await db.query(`UPDATE platform_config SET value = 'tenant' WHERE key = 'workflow_config_owner'`);
    const saved = process.env.WORKFLOW_CONFIG_OWNER;
    delete process.env.WORKFLOW_CONFIG_OWNER;
    try {
      expect(await getWorkflowConfigOwner(db as never)).toBe('tenant');
    } finally {
      if (saved === undefined) delete process.env.WORKFLOW_CONFIG_OWNER;
      else process.env.WORKFLOW_CONFIG_OWNER = saved;
      await db.close();
    }
  });
});

// 深化（第 2 轮）：写入侧真库行为。开关的**读**已有 mock 层锚，但 UPSERT 只在 mock 里
// 「看起来对」是不够的——updated_by 到底有没有覆盖、重复写会不会分裂出行，只有真库能验。
describe('097 写入侧：setWorkflowConfigOwner 对着真库的 UPSERT 行为', () => {
  it('⑨ 拨成 tenant → 库里 value=tenant 且 updated_by 记为操作人', async () => {
    const db = await freshDb();
    await setWorkflowConfigOwner('tenant', 'platform:alice');
    const r = await db.query<{ value: string; updated_by: string }>(
      `SELECT value, updated_by FROM platform_config WHERE key = 'workflow_config_owner'`,
    );
    expect(r.rows[0].value).toBe('tenant');
    expect(r.rows[0].updated_by).toBe('platform:alice');
    await db.close();
  });

  it('⑩ 重复写同一值：不分裂出新行（仍是 1 行），且 updated_by 更新为最新操作人', async () => {
    const db = await freshDb();
    await setWorkflowConfigOwner('tenant', 'platform:alice');
    await setWorkflowConfigOwner('tenant', 'platform:bob');
    const r = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM platform_config`);
    expect(r.rows[0].c).toBe(1);
    const u = await db.query<{ updated_by: string }>(
      `SELECT updated_by FROM platform_config WHERE key = 'workflow_config_owner'`,
    );
    expect(u.rows[0].updated_by).toBe('platform:bob');
    await db.close();
  });

  it('⑪ 拨开再拨回：同一行来回改，repo 读取跟着变（后台可逆，不用发版）', async () => {
    const db = await freshDb();
    const saved = process.env.WORKFLOW_CONFIG_OWNER;
    delete process.env.WORKFLOW_CONFIG_OWNER;
    try {
      expect(await getWorkflowConfigOwner()).toBe('platform'); // 种子
      await setWorkflowConfigOwner('tenant', 'platform:alice');
      expect(await getWorkflowConfigOwner()).toBe('tenant');
      await setWorkflowConfigOwner('platform', 'platform:alice');
      expect(await getWorkflowConfigOwner()).toBe('platform');
    } finally {
      if (saved === undefined) delete process.env.WORKFLOW_CONFIG_OWNER;
      else process.env.WORKFLOW_CONFIG_OWNER = saved;
      await db.close();
    }
  });

  it('⑫ 别的 key 写入不得影响 workflow_config_owner（同一张表放多个平台开关时不互相踩）', async () => {
    const db = await freshDb();
    await setPlatformConfig('some_other_switch', 'on', 'platform:alice');
    const r = await db.query<{ value: string }>(
      `SELECT value FROM platform_config WHERE key = 'workflow_config_owner'`,
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].value).toBe('platform');
    const all = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM platform_config`);
    expect(all.rows[0].c).toBe(2);
    await db.close();
  });
});
