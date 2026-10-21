/**
 * slaPolicy.test.ts —— SLA 策略可配置化
 *
 * 背景（回码实证，非线上故障）：
 * `sla_policy` 表由 047_basic_data_consolidate.sql:69 创建，带 RLS 租户隔离（:81-86），
 * 且 basicData.ts:174-190 已把它登记为运营可维护的基础数据（前端能增删改）。
 * 但全仓**零消费**：`src/engine/sla.ts:9-18` 用的是写死的 `SLA_MINUTES` 常量表，
 * 该文件第 5 行注释自承"真实化后可下沉为租户可配 sla_policy 表"——即承认未完成。
 *
 * 这不是"少个功能"，是**运营配了没反应**：
 *   界面能配 → 库里有行 → 建单算 SLA 时完全不看 → 恒用常量。
 * 与 match.skill_tags 那次同类：配置入口存在，消费端没接。
 *
 * 附带实证（本审查发现，见审查报告）：
 *   SLA_MINUTES 的 key 是 electrician/plumber/specimen/patient_escort，
 *   而建单传入的 catalog 来自 `fault_category.code`（intakeOptions.ts:31 实测），
 *   该 code 由租户在分类维护页自定义 ⇒ 两者对不上时**恒落 DEFAULT_SLA{urgent:30,normal:240}**，
 *   即"运送类 15min"这条口径在生产上从未生效过。
 *
 * 本测试锁四件事：
 *   A 匹配规则：entity_type 精确 > 不适用；priority 精确 > priority 空（全适用）；
 *   B 降级：空表/未配/报错 ⇒ 完全回退既有常量逻辑（零行为变化）；
 *   C 隔离：只认 enabled=true，且租户隔离（SQL 带 tenant_id）；
 *   D 接入：两个建单调用点真的用上了策略（不是只写了个没人调的函数）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const ROOT = join(process.cwd(), 'src');

// ---------------------------------------------------------------------------
// 测试替身：最小 PoolClient 适配器（只实现被消费的 query 签名）
// ---------------------------------------------------------------------------

function makeFakeClient(rows: unknown[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  } as any;
}

// ---------------------------------------------------------------------------
// A. 纯函数匹配规则（不依赖 DB）
// ---------------------------------------------------------------------------

describe('A. 匹配规则：谁说了算', () => {
  type Row = {
    entity_type: string;
    priority: string | null;
    response_hours: number | string;
    complete_hours: number | string;
    enabled: boolean;
  };

  // 延迟 import：RED 阶段模块还不存在
  const load = () => import('../engine/slaPolicy.js');

  it('A1 命中：entity_type + priority 都精确匹配 ⇒ 取该行的 complete_hours', async () => {
    const { pickSlaPolicy } = await load();
    const rows: Row[] = [
      { entity_type: 'work_order', priority: 'urgent', response_hours: 1, complete_hours: 4, enabled: true },
      { entity_type: 'work_order', priority: null, response_hours: 2, complete_hours: 24, enabled: true },
    ];
    const hit = pickSlaPolicy(rows as any, { entityType: 'work_order', priority: 'urgent' });
    expect(hit).not.toBeNull();
    expect(hit!.completeMinutes).toBe(240); // 4h × 60
  });

  it('A2 具体优先：priority 精确的行压过 priority 为空的「全适用」行', async () => {
    const { pickSlaPolicy } = await load();
    const rows: Row[] = [
      { entity_type: 'work_order', priority: null, response_hours: 2, complete_hours: 24, enabled: true },
      { entity_type: 'work_order', priority: 'normal', response_hours: 8, complete_hours: 48, enabled: true },
    ];
    const hit = pickSlaPolicy(rows as any, { entityType: 'work_order', priority: 'normal' });
    expect(hit!.completeMinutes).toBe(48 * 60);
  });

  it('A3 回退：没有精确 priority 时，用 priority 为空的「全适用」行', async () => {
    const { pickSlaPolicy } = await load();
    const rows: Row[] = [
      { entity_type: 'work_order', priority: null, response_hours: 2, complete_hours: 24, enabled: true },
      { entity_type: 'work_order', priority: 'urgent', response_hours: 1, complete_hours: 4, enabled: true },
    ];
    const hit = pickSlaPolicy(rows as any, { entityType: 'work_order', priority: 'low' });
    expect(hit!.completeMinutes).toBe(24 * 60); // 落到全适用行
  });

  it('A4 实体隔离：别的 entity_type 的策略不串味', async () => {
    const { pickSlaPolicy } = await load();
    const rows: Row[] = [
      { entity_type: 'transport_order', priority: null, response_hours: 1, complete_hours: 2, enabled: true },
    ];
    const hit = pickSlaPolicy(rows as any, { entityType: 'work_order', priority: 'normal' });
    expect(hit).toBeNull();
  });

  it('A5 停用不生效：enabled=false 的行一律跳过', async () => {
    const { pickSlaPolicy } = await load();
    const rows: Row[] = [
      { entity_type: 'work_order', priority: 'urgent', response_hours: 1, complete_hours: 4, enabled: false },
    ];
    const hit = pickSlaPolicy(rows as any, { entityType: 'work_order', priority: 'urgent' });
    expect(hit).toBeNull();
  });

  it('A6 空集：没有策略行 ⇒ 返回 null（调用方回退常量，零行为变化）', async () => {
    const { pickSlaPolicy } = await load();
    expect(pickSlaPolicy([], { entityType: 'work_order', priority: 'normal' })).toBeNull();
  });

  it('A7 小时转分钟：numeric 可能是字符串（PG numeric 驱动返回 string），必须能算对', async () => {
    const { pickSlaPolicy } = await load();
    const rows: Row[] = [
      { entity_type: 'work_order', priority: null, response_hours: '2', complete_hours: '24', enabled: true },
    ];
    const hit = pickSlaPolicy(rows as any, { entityType: 'work_order', priority: 'normal' });
    expect(hit!.completeMinutes).toBe(1440);
    expect(hit!.responseMinutes).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// B. 降级：查不到 / 报错 ⇒ 完全回退既有行为
// ---------------------------------------------------------------------------

describe('B. 降级：可配置不能变成新的故障源', () => {
  const load = () => import('../engine/slaPolicy.js');

  it('B1 查询报错 ⇒ 返回 null 而不是抛（建单链路不能被 SLA 配置拖垮）', async () => {
    const { loadSlaPolicy } = await load();
    const bad = {
      async query() {
        throw new Error('boom');
      },
    } as any;
    await expect(loadSlaPolicy(bad, 't-1')).resolves.toBeNull();
  });

  it('B2 未配策略（空表）⇒ 回退到既有常量逻辑，结果与今天逐字一致', async () => {
    const { resolveSlaMinutesWithPolicy } = await load();
    // 空策略 + catalog 未命中常量表 ⇒ 必须落 DEFAULT_SLA.normal = 240
    expect(resolveSlaMinutesWithPolicy({ policy: null, catalog: 'whatever', priority: 'normal' })).toBe(240);
    // 空策略 + catalog 命中常量表 ⇒ 必须与既有 resolveSlaMinutes 一致（30）
    expect(resolveSlaMinutesWithPolicy({ policy: null, catalog: 'electrician', priority: 'urgent' })).toBe(30);
  });

  it('B3 有策略 ⇒ 策略说了算（这才是"可配置"的兑现）', async () => {
    const { resolveSlaMinutesWithPolicy } = await load();
    const minutes = resolveSlaMinutesWithPolicy({
      policy: { responseMinutes: 120, completeMinutes: 480 },
      catalog: 'electrician',
      priority: 'urgent',
    });
    expect(minutes).toBe(480); // 策略压过常量表的 30
  });
});

// ---------------------------------------------------------------------------
// C. 真库：RLS 与 SQL 形态
// ---------------------------------------------------------------------------

describe('C. 真库（PGlite）：SQL 必须带租户隔离', () => {
  const load = () => import('../engine/slaPolicy.js');

  async function setup() {
    const db = new PGlite();
    await db.query(`
      CREATE TABLE sla_policy (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      text NOT NULL,
        name           text NOT NULL,
        entity_type    text NOT NULL DEFAULT 'work_order',
        priority       text,
        response_hours numeric NOT NULL DEFAULT 2,
        complete_hours numeric NOT NULL DEFAULT 24,
        enabled        boolean NOT NULL DEFAULT true,
        created_at     timestamptz NOT NULL DEFAULT now()
      );
    `);
    return db;
  }

  function wrap(db: PGlite) {
    return {
      async query(sql: string, params: unknown[] = []) {
        const r = await db.query(sql, params as any[]);
        return { rows: r.rows, rowCount: r.rows.length };
      },
    } as any;
  }

  it('C1 租户隔离：只查本租户的行', async () => {
    const db = await setup();
    await db.query(
      `INSERT INTO sla_policy (tenant_id, name, entity_type, priority, response_hours, complete_hours, enabled) VALUES
       ('t-a','A单','work_order',NULL,2,8,true),
       ('t-b','B单','work_order',NULL,2,99,true)`,
    );
    const { loadSlaPolicy, pickSlaPolicy } = await load();
    const rows = await loadSlaPolicy(wrap(db), 't-a');
    const hit = pickSlaPolicy(rows as any, { entityType: 'work_order', priority: 'normal' });
    expect(hit!.completeMinutes).toBe(8 * 60); // 读到的是 t-a 的 8h，不是 t-b 的 99h
    await db.close();
  });

  it('C1b 停用不读出：enabled=false 的行不出现在结果里（真库路径，补 A5 覆盖盲区）', async () => {
    const db = await setup();
    await db.query(
      `INSERT INTO sla_policy (tenant_id, name, entity_type, priority, response_hours, complete_hours, enabled) VALUES
       ('t-a','停用策略','work_order',NULL,1,999,false),
       ('t-a','生效策略','work_order',NULL,2,8,true)`,
    );
    const { loadSlaPolicy, pickSlaPolicy } = await load();
    const rows = await loadSlaPolicy(wrap(db), 't-a');
    // 直接验 SQL 层：读出来的行里不许有 enabled=false 的。
    // （不能只验 pickSlaPolicy 的结果——纯函数层还有第二道过滤，会把 SQL 层的漏网兜住，
    //   那样即使 SQL 漏了测试也绿，等于没在看 SQL。）
    expect((rows as any[]).some((r: any) => r.enabled === false)).toBe(false);
    expect((rows as any[]).length).toBe(1);
    const hit = pickSlaPolicy(rows as any, { entityType: 'work_order', priority: 'normal' });
    expect(hit!.completeMinutes).toBe(8 * 60); // 不是 999h
    await db.close();
  });

  it('C2 SQL 形态：必须带 tenant_id 参数与 enabled 过滤（防越权/停用生效）', async () => {
    const db = await setup();
    const client = makeFakeClient([]);
    const { loadSlaPolicy } = await load();
    await loadSlaPolicy(client, 't-x');
    // 事务安全改造后第一条会是 SAVEPOINT，故按内容定位真正的查询，而不是按位置
    const q = client.calls.find((c: { sql: string }) => c.sql.includes('FROM sla_policy'));
    expect(q, '未找到查 sla_policy 的语句').toBeTruthy();
    expect(q!.sql).toMatch(/tenant_id/);
    expect(q!.sql).toMatch(/enabled/);
    expect(q!.params[0]).toBe('t-x');
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// C2. 事务安全：读配置不得污染建单事务（实测教训，见实现里的 SAVEPOINT 注释）
// ---------------------------------------------------------------------------

describe('C2. 事务安全：表缺失时不得拖垮整个建单事务', () => {
  const load = () => import('../engine/slaPolicy.js');

  it('C2-1 事务内查不存在的表 ⇒ 同一个 client 后续语句仍能正常执行', async () => {
    const db = new PGlite();
    await db.query(`CREATE TABLE work_orders (id text PRIMARY KEY, sla_minutes int);`);
    await db.query(`INSERT INTO work_orders (id) VALUES ('w1')`);

    // 模拟真实调用形态：建单事务内先读策略、再 UPDATE
    await db.query('BEGIN');
    const { loadSlaPolicy } = await load();
    const rows = await loadSlaPolicy(
      {
        async query(sql: string, params: unknown[] = []) {
          const r = await db.query(sql, params as any[]);
          return { rows: r.rows, rowCount: r.rows.length };
        },
      } as any,
      't-1',
    );
    expect(rows).toBeNull(); // 表不存在 ⇒ 降级

    // 关键：事务必须还活着。没有 SAVEPOINT 时这一步会抛
    // "current transaction is aborted, commands ignored until end of transaction block"
    await db.query(`UPDATE work_orders SET sla_minutes = 240 WHERE id = 'w1'`);
    await db.query('COMMIT');

    const after = await db.query(`SELECT sla_minutes FROM work_orders WHERE id = 'w1'`);
    expect((after.rows[0] as any).sla_minutes).toBe(240);
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// D. 契约守卫：两个建单调用点必须真的用上（防止写了个没人调的函数）
// ---------------------------------------------------------------------------

describe('D. 接入守卫：不是"写了个函数"就算可配置', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

  it('D1 workOrder.ts 建单处走策略版（不再只吃常量）', () => {
    const src = read('routes/workOrder.ts');
    expect(src).toMatch(/resolveSlaMinutesWithPolicy|loadSlaPolicy/);
  });

  it('D2 linkedWorkOrder.ts 转单处同样走策略版', () => {
    const src = read('services/linkedWorkOrder.ts');
    expect(src).toMatch(/resolveSlaMinutesWithPolicy|loadSlaPolicy/);
  });

  it('D3 常量表保留为兜底，且注释如实写明它与租户 catalog 未必对得上', () => {
    const src = read('engine/sla.ts');
    expect(src).toMatch(/DEFAULT_SLA/);
    expect(src).toMatch(/兜底|回退|降级/);
  });
});
