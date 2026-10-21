/**
 * slaPolicy.ts —— SLA 时限的可配置来源（租户级）
 *
 * 背景（回码实证）：
 * `sla_policy` 表由 047_basic_data_consolidate.sql:69 建成，带 RLS（:81-86），
 * basicData.ts:174 已登记为运营可维护的基础数据（界面能增删改）。
 * 但全仓**零消费**——sla.ts 用的是写死的常量表 SLA_MINUTES，其文件头第 5 行
 * 自承"真实化后可下沉为租户可配 sla_policy 表"。
 * 即：运营在界面配的响应/完成时限，对建单算 SLA **完全不起作用**。
 *
 * 本模块把这条路接上，并遵守三条边界：
 *
 * ① **空配置 = 零行为变化**。租户没配任何策略（现状：生产该表大概率为空，
 *    因为配了也没人消费）⇒ 完全回退 sla.ts 既有常量逻辑，分钟数逐字不变。
 *    不得因为"接了可配置"就让存量单的 SLA 悄悄变宽松/收紧。
 *
 * ② **配了才生效，且只认 enabled=true**。故障降级：查表报错 → 返回 null →
 *    回退常量，并 warn（不静默）。SLA 配置不是建单链路的单点故障源。
 *
 * ③ **取 complete_hours（完成时限）**，与 sla_due_at 的既有语义一致
 *    （004_sla.sql / 064_sla_scheduler.sql 均以 sla_due_at < now() 判超时，
 *    即"应付截止时刻"）。response_hours 一并返回供将来扩展，当前不作为截止口径。
 *    —— 这是对本仓既有语义的判断，若产品口径不同应改这一处，而不是各调用点各写一套。
 *
 * 与 needResolver.ts 同一套路：**来源可插拔，字段名不改**。
 */

import { resolveSlaMinutes } from './sla.js';

/** 策略行（DB 形态；numeric 在部分驱动下返回 string，故按 unknown 收敛） */
export interface SlaPolicyRow {
  entity_type: string;
  priority: string | null;
  response_hours: number | string;
  complete_hours: number | string;
  enabled: boolean;
}

/** 匹配结果（统一折算为分钟） */
export interface SlaPolicyMatch {
  responseMinutes: number;
  completeMinutes: number;
}

export interface SlaPolicyContext {
  entityType: string;
  priority?: string | null;
}

function toMinutes(v: number | string): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 60) : 0;
}

/**
 * 从策略行里挑最匹配的一条。纯函数，便于单测与复用。
 *
 * 匹配规则（定死，顺序即优先级）：
 *   1. 只认 enabled=true；
 *   2. entity_type 必须**精确相等**——不跨实体兜底，避免运送策略误配到工单；
 *   3. priority 精确匹配 > priority 为空（"全适用"）；
 *   4. 同具体度多条 ⇒ 取第一条（SQL 已 ORDER BY 保证确定性）。
 *
 * @returns 命中返回折算后的分钟；无命中返回 null（调用方回退常量）
 */
export function pickSlaPolicy(
  rows: SlaPolicyRow[] | null | undefined,
  ctx: SlaPolicyContext,
): SlaPolicyMatch | null {
  const candidates = (rows ?? []).filter(
    (r) => r && r.enabled === true && r.entity_type === ctx.entityType,
  );
  if (candidates.length === 0) return null;

  const exact = candidates.filter((r) => r.priority != null && r.priority === ctx.priority);
  const pool = exact.length > 0 ? exact : candidates.filter((r) => r.priority == null);
  if (pool.length === 0) return null;

  const row = pool[0];
  return {
    responseMinutes: toMinutes(row.response_hours),
    completeMinutes: toMinutes(row.complete_hours),
  };
}

/**
 * 读本租户启用的策略行。
 *
 * 降级契约：任何异常 ⇒ 返回 null（调用方回退常量），并 warn 留痕。
 * SQL 必带 tenant_id（RLS 之外的第二道）与 enabled 过滤。
 */
export async function loadSlaPolicy(
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> },
  tenantId: string,
): Promise<SlaPolicyRow[] | null> {
  // ⚠️ 为什么用 SAVEPOINT（实测教训，不是理论推演）：
  // 本函数在**建单事务内**被调用（autoDispatchAfterCreate 跑在 createWithIdem 的 client 上）。
  // PostgreSQL 的语义是：事务内任何一条语句报错 ⇒ 整个事务进入 aborted 状态，
  // 此后**所有**语句都会被拒（"current transaction is aborted"）——
  // 外层 try/catch 接住异常也救不回来，因为事务已经废了。
  // 实测复现：测试库缺 sla_policy 表时，本查询一错，同事务后续的
  // UPDATE work_orders SET sla_minutes... 全部失败 ⇒ 建单直接崩（9 条存量测试转红）。
  //
  // 故用 SAVEPOINT 把"读配置"这一段隔离成可回滚的子单元：
  //   读失败 ⇒ ROLLBACK TO SAVEPOINT ⇒ 事务回到可用状态 ⇒ 回退内置常量，建单照常完成。
  // 这条是"可配置不能变成新的故障源"的兑现，不是可选的优雅写法。
  const SP = 'sla_policy_probe';
  // 注意（实测）：PG 规定 SAVEPOINT 只能在事务块内使用，事务外调用会报
  // "SAVEPOINT can only be used in transaction block"。本函数两种调用形态都有：
  //   · 建单事务内（autoDispatchAfterCreate / createLinkedWorkOrder）⇒ 需要保护；
  //   · 事务外的只读调用 ⇒ 建不了保存点，但那种情况下查询失败也污染不到别人的事务。
  // 故：建不了保存点**不是错误**，按"无保护"继续即可，不得直接放弃读策略。
  let inSavepoint = false;
  try {
    await client.query(`SAVEPOINT ${SP}`);
    inSavepoint = true;
  } catch {
    inSavepoint = false;
  }

  try {
    const r = await client.query(
      `SELECT entity_type, priority, response_hours, complete_hours, enabled
         FROM sla_policy
        WHERE tenant_id = $1 AND enabled = true
        ORDER BY (priority IS NULL) ASC, created_at ASC`,
      [tenantId],
    );
    if (inSavepoint) {
      try {
        await client.query(`RELEASE SAVEPOINT ${SP}`);
      } catch {
        /* 释放失败无害：保存点会在事务结束时自动清理 */
      }
    }
    return (r?.rows ?? []) as SlaPolicyRow[];
  } catch (e) {
    // 表缺失 / 权限不足 / 迁移未跑 ⇒ 回滚保存点，让外层事务继续可用
    if (inSavepoint) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${SP}`);
      } catch {
        /* 回滚也失败则事务已不可救，交给上层处理 */
      }
    }
    console.warn('[slaPolicy] 读取 sla_policy 失败（已回滚保存点，回退内置时限常量）：', (e as Error)?.message);
    return null;
  }
}

/**
 * 统一的 SLA 分钟数入口：策略优先，无策略回退既有常量。
 *
 * 这是"可配置"真正兑现的那一行——调用方只认这个函数，不再自己拼 if。
 */
export function resolveSlaMinutesWithPolicy(opts: {
  policy?: SlaPolicyMatch | null;
  catalog?: string | null;
  priority?: string | null;
}): number {
  const p = opts.policy;
  if (p && Number.isFinite(p.completeMinutes) && p.completeMinutes > 0) {
    return p.completeMinutes;
  }
  return resolveSlaMinutes(
    opts.catalog ?? undefined,
    opts.priority === 'urgent' ? 'urgent' : 'normal',
  );
}
