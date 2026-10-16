/**
 * 自动审核规则仓储（地基④）——094 workflow_auto_rule 表的读写。
 *
 * 【边界】
 *   - 所有查询经 withTenantClient 的连接（已 SET LOCAL app.tenant_id），RLS 自动生效；
 *   - 表不存在（094 未应用的库）→ 读降级为空、写明确报错，**不得静默假装成功**
 *     （静默成功会让租户以为配好了，实际永不生效——比报错更难排查）；
 *   - 只做数据读写，红线判定在 engine/autoRules.ts（纯函数，可穷举单测）。
 */
import type { PoolClient } from 'pg';
import type { AutoRule, AutoRuleConditions } from '../engine/autoRules.js';

export interface AutoRuleRow {
  id: string;
  entity_type: string;
  from_state: string;
  event: string;
  conditions: AutoRuleConditions;
  enabled: boolean;
  note: string | null;
  updated_at: string;
}

const toRule = (tenantId: string, r: AutoRuleRow): AutoRule => ({
  id: r.id,
  tenantId,
  entityType: r.entity_type,
  fromState: r.from_state,
  event: r.event,
  conditions: r.conditions ?? {},
  enabled: !!r.enabled,
  note: r.note,
});

/** 列出本租户某实体类型的全部规则（含未启用的，配置台要能看见并编辑）。 */
export async function listAutoRules(
  client: PoolClient,
  tenantId: string,
  entityType: string,
): Promise<AutoRule[]> {
  try {
    const r = await client.query(
      `SELECT id, entity_type, from_state, event, conditions, enabled, note, updated_at::text AS updated_at
         FROM workflow_auto_rule
        WHERE tenant_id = $1 AND entity_type = $2
        ORDER BY from_state, event`,
      [tenantId, entityType],
    );
    return (r.rows as AutoRuleRow[]).map((x) => toRule(tenantId, x));
  } catch {
    // 094 未应用 → 无规则（执行器因此零自动行为，与改造前逐字等价）
    return [];
  }
}

/** 只取启用中的规则（执行器热路径用）。 */
export async function listEnabledAutoRules(
  client: PoolClient,
  tenantId: string,
  entityType: string,
): Promise<AutoRule[]> {
  return (await listAutoRules(client, tenantId, entityType)).filter((r) => r.enabled);
}

/**
 * 新建或更新一条规则（按 tenant+entity+from+event 唯一键 upsert）。
 * enabled 必须显式传入——不允许"不传就默认启用"（默认启用 = 配了就自动跑，属误伤风险）。
 */
export async function upsertAutoRule(
  client: PoolClient,
  tenantId: string,
  input: {
    entityType: string;
    fromState: string;
    event: string;
    conditions: AutoRuleConditions;
    enabled: boolean;
    note?: string | null;
  },
): Promise<AutoRule> {
  const r = await client.query(
    `INSERT INTO workflow_auto_rule (tenant_id, entity_type, from_state, event, conditions, enabled, note)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
     ON CONFLICT (tenant_id, entity_type, from_state, event)
     DO UPDATE SET conditions = EXCLUDED.conditions,
                   enabled    = EXCLUDED.enabled,
                   note       = EXCLUDED.note,
                   updated_at = now()
     RETURNING id, entity_type, from_state, event, conditions, enabled, note, updated_at::text AS updated_at`,
    [
      tenantId,
      input.entityType,
      input.fromState,
      input.event,
      JSON.stringify(input.conditions ?? {}),
      input.enabled,
      input.note ?? null,
    ],
  );
  return toRule(tenantId, r.rows[0] as AutoRuleRow);
}

/** 删除一条规则；不存在返回 false（路由层据此给 404）。 */
export async function deleteAutoRule(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  fromState: string,
  event: string,
): Promise<boolean> {
  const r = await client.query(
    `DELETE FROM workflow_auto_rule
      WHERE tenant_id=$1 AND entity_type=$2 AND from_state=$3 AND event=$4`,
    [tenantId, entityType, fromState, event],
  );
  return (r.rowCount ?? 0) > 0;
}
