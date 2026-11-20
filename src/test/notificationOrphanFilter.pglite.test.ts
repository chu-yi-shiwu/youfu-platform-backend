// notificationOrphanFilter.pglite.test.ts —— P0-6 通知孤儿过滤（真 PGlite + 真 SQL）。
//
// 【修复前的真实洞】
//   notification.work_order_id 是 NOT NULL text 列且无外键。运送单通知按约定「借位」
//   存 transport_order.id，并用 payload.entity_type='transport_order' 标记真实实体。
//   旧过滤 `EXISTS (SELECT 1 FROM work_orders ...)` 把整类运送通知当成孤儿丢弃
//   ⇒ 工人收不到派单 / SLA 提醒，而数据库里通知明明还在。
//
// 本文件用真 SQL 钉死：
//   ① 正常工单通知仍可见（向后兼容）；
//   ② 已删工单通知被过滤；
//   ③ 运送通知只要 transport_order 还在就可见（修复的核心）；
//   ④ 已删运送单通知被过滤；
//   ⑤ 跨租户 id 碰撞不得让通知「复活」（两分支都对齐 tenant_id）；
//   ⑥ payload 缺省 / 非运送仍走 work_orders，行为与改造前一致；
//   ⑦ entity_type 标了运送就只查 transport_order，不得回落 work_orders。
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { notificationOrphanGuardSql } from '../repo/notificationVisibility.js';

const T1 = 't1';
const T2 = 't2';

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE work_orders (
      id text PRIMARY KEY,
      tenant_id text NOT NULL
    );
    CREATE TABLE transport_order (
      id uuid PRIMARY KEY,
      tenant_id text NOT NULL
    );
    CREATE TABLE volunteer_activity (
      id uuid PRIMARY KEY,
      tenant_id text NOT NULL
    );
    CREATE TABLE notification (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      recipient text NOT NULL,
      channel text NOT NULL DEFAULT 'in_app',
      work_order_id text NOT NULL,
      payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.exec(`
    INSERT INTO work_orders (id, tenant_id) VALUES
      ('wo-live', '${T1}'),
      ('wo-other-tenant', '${T2}');
    INSERT INTO transport_order (id, tenant_id) VALUES
      ('11111111-1111-4111-8111-111111111111', '${T1}'),
      ('22222222-2222-4222-8222-222222222222', '${T2}');
    INSERT INTO volunteer_activity (id, tenant_id) VALUES
      ('44444444-4444-4444-8444-444444444444', '${T1}');
    INSERT INTO notification (id, tenant_id, recipient, work_order_id, payload) VALUES
      ('n-wo-live',          '${T1}', 'W1', 'wo-live',           '{}'::jsonb),
      ('n-wo-dead',          '${T1}', 'W1', 'wo-dead',           '{}'::jsonb),
      ('n-wo-null-payload',  '${T1}', 'W1', 'wo-live',           NULL),
      ('n-tr-live',          '${T1}', 'W1', '11111111-1111-4111-8111-111111111111', '{"entity_type":"transport_order"}'::jsonb),
      ('n-tr-dead',          '${T1}', 'W1', '33333333-3333-4333-8333-333333333333', '{"entity_type":"transport_order"}'::jsonb),
      ('n-tr-cross-tenant',  '${T1}', 'W1', '22222222-2222-4222-8222-222222222222', '{"entity_type":"transport_order"}'::jsonb),
      ('n-wo-cross-tenant',  '${T1}', 'W1', 'wo-other-tenant',   '{}'::jsonb),
      ('n-other-entity',     '${T1}', 'W1', 'wo-live',           '{"entity_type":"inspection_task"}'::jsonb),
      ('n-tr-id-collides-wo','${T1}', 'W1', 'wo-live',           '{"entity_type":"transport_order"}'::jsonb),
      ('n-va-live',          '${T1}', 'W1', '44444444-4444-4444-8444-444444444444', '{"entity_type":"volunteer_activity"}'::jsonb),
      ('n-va-dead',          '${T1}', 'W1', '55555555-5555-4555-8555-555555555555', '{"entity_type":"volunteer_activity"}'::jsonb),
      ('n-tr-other-tenant',  '${T2}', 'W2', '22222222-2222-4222-8222-222222222222', '{"entity_type":"transport_order"}'::jsonb);
  `);
  return db;
}

async function visibleIds(db: PGlite, tenantId: string): Promise<string[]> {
  const r = await db.query<{ id: string }>(
    `SELECT n.id
       FROM notification n
      WHERE n.tenant_id = $1
        AND n.channel = 'in_app'
        AND ${notificationOrphanGuardSql()}
      ORDER BY n.id`,
    [tenantId],
  );
  return r.rows.map((x) => x.id);
}

describe('P0-6 · 通知列表孤儿过滤（work_orders / transport_order 分流）', () => {
  it('① 工单通知：单还在 → 可见；单已删 → 过滤', async () => {
    const db = await setup();
    const ids = await visibleIds(db, T1);
    expect(ids).toContain('n-wo-live');
    expect(ids).not.toContain('n-wo-dead');
  });

  it('③ 运送通知：transport_order 还在 → 可见（旧实现会整类丢弃）', async () => {
    const db = await setup();
    const ids = await visibleIds(db, T1);
    expect(ids).toContain('n-tr-live');
  });

  it('④ 运送通知：运送单已删 → 过滤', async () => {
    const db = await setup();
    const ids = await visibleIds(db, T1);
    expect(ids).not.toContain('n-tr-dead');
  });

  it('⑤ 跨租户 id 碰撞不得复活：t1 通知指向只存在于 t2 的单 → 过滤', async () => {
    const db = await setup();
    const ids = await visibleIds(db, T1);
    expect(ids).not.toContain('n-tr-cross-tenant');
    expect(ids).not.toContain('n-wo-cross-tenant');
    // 反证：t2 自己的同一运送单通知可见（不是把行本身弄没了）
    expect(await visibleIds(db, T2)).toContain('n-tr-other-tenant');
  });

  it('⑥ payload 缺省/null / 非运送 → 仍按 work_orders 判定（向后兼容）', async () => {
    const db = await setup();
    const ids = await visibleIds(db, T1);
    expect(ids).toContain('n-wo-null-payload');
    expect(ids).toContain('n-other-entity'); // entity_type=inspection_task 但 work_order_id 命中 wo-live
  });

  it('⑦ entity_type=transport_order 时只查 transport_order，不回落 work_orders', async () => {
    const db = await setup();
    const ids = await visibleIds(db, T1);
    // work_order_id 恰好等于存在的工单 id，但类型声称是运送 → 运送表没有该 id ⇒ 过滤
    expect(ids).not.toContain('n-tr-id-collides-wo');
  });

  it('⑧ 志愿活动通知：活动还在 → 可见；活动删了 → 过滤', async () => {
    const db = await setup();
    const ids = await visibleIds(db, T1);
    expect(ids).toContain('n-va-live');
    expect(ids).not.toContain('n-va-dead');
  });
});
