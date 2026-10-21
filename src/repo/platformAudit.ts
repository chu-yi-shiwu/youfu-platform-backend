/**
 * platformAudit.ts —— 平台审计写入的单一事实源
 *
 * 背景（回码实证，非线上故障）：
 * `INSERT INTO platform_audit (...) VALUES ($1..$5)` 此前在 7 个路由文件里**逐字重复 8 次**
 * （accounts.ts:51 / invite.ts:60 / platform.ts:40 / platformWorkflow.ts:41 /
 *   templateContributions.ts:56 / templateMarket.ts:22 / workflowDef.ts:46,328），
 * 每个文件各自包一份同名 `audit()` 函数——实现完全相同，只有 console.warn 的前缀不同。
 *
 * 为什么必须收敛（不是"代码整洁"问题）：
 *   平台审计是 **append-only 的证据链**（表只 GRANT SELECT/INSERT，无 UPDATE/DELETE）。
 *   证据链的价值建立在"每条记录形态一致、失败可观测"上。8 处各自实现意味着：
 *     · 任一处漏字段 / 序列化方式不同 ⇒ 该条记录与其余不可比，事后追账断链；
 *     · 任一处 catch 写成静默吞 ⇒ 审计丢失**无人知晓**（platform.ts 曾 `catch {}`，
 *       是审查修复 QA🟡6 才补的 warn；其余 6 处是否都已补，此前无机器看守）。
 *   收敛后，"失败是否留痕"这件事只有一处代码能决定，测试可以锁死它。
 *
 * 契约（与原有 7 处实现逐字等价，本次不改行为）：
 *   ① 失败绝不向外抛——审计是旁路，不能拖垮主流程；
 *   ② 失败必须 warn 留痕——证据链不能静默缺失；
 *   ③ payload 对象 → JSON.stringify；未传/显式 null → NULL；0/false/'' 如实写入。
 */

export interface PlatformAuditEntry {
  actor: string;
  action: string;
  resource?: string | null;
  targetTenant?: string | null;
  payload?: unknown;
  /** 调用方标识，仅用于日志定位（如 'accounts' / 'workflowDef'） */
  scope?: string;
}

/**
 * 写一条平台审计。
 *
 * @param client 只需实现 query(sql, params)——Pool 或事务内 PoolClient 均可。
 *               注意：本函数**不**自己建 SAVEPOINT。若调用方处在事务内且担心表缺失，
 *               应参照 slaPolicy.loadSlaPolicy 的做法自行包裹保存点。
 */
export async function recordPlatformAudit(
  client: { query(sql: string, params?: unknown[]): Promise<unknown> },
  e: PlatformAuditEntry,
): Promise<void> {
  const tag = e.scope ? `[${e.scope}]` : '[audit]';
  try {
    // payload：undefined 与 null 都写 NULL；其余（含 0/false/''）如实序列化
    const payloadSql = e.payload === undefined || e.payload === null
      ? null
      : JSON.stringify(e.payload);
    await client.query(
      `INSERT INTO platform_audit (actor, action, resource, target_tenant, payload) VALUES ($1,$2,$3,$4,$5)`,
      [e.actor, e.action, e.resource ?? null, e.targetTenant ?? null, payloadSql],
    );
  } catch (err) {
    // 审计属旁路：失败绝不阻断主流程，但必须留痕以便事后追账（不得静默吞）
    console.warn(`${tag} platform_audit 写入失败（不阻断主流程）`, {
      actor: e.actor,
      action: e.action,
      resource: e.resource ?? null,
      targetTenant: e.targetTenant ?? null,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
