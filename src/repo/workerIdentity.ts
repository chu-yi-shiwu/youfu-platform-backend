// workerIdentity.ts —— 「登录账号 → worker 档案」反查的单一事实源。
//
// 生产实测事实（team-lead 2026-09-xx，务必按此实现，别按 uuid 猜）：
//   - worker.id = text、worker.account_id = text、work_orders.assignee_id = text；
//     只有 account_user.id 是 uuid → 参数一律按 text 传，**绝不加 ::uuid 强转**（PG 会报 operator 不存在）；
//   - 存量数据 account_id 有脏值：有的工人 account_id 存的是自己的 worker.id，有的存的是真实账号 id
//     → 双路匹配 (account_id=$1 OR id=$1)，缺一即出现"查不到档案"的假阴性。
// 返回空数组 = 查不到档案 → 调用方按各自场景降级/拒绝（工单列表按既定纪律降级放行；
// 巡检写侧归属守卫拒绝）。不可让降级路径本身变成 500。
import type { PoolClient } from 'pg';

export async function resolveWorkerIds(
  client: PoolClient,
  tenantId: string,
  authUserId: string | undefined,
): Promise<string[]> {
  const uid = authUserId ?? '';
  if (!uid) return [];
  // E-8 QA P3-1（双档案漏判）：LIMIT 2 → LIMIT 10 并返回【全部】命中行——同人挂多条
  // worker 档案（脏数据）时，只读 rows[0] 会漏掉第二条，导致可见性/归属判断漏匹配。
  // 调用方（列表 scopedAssignee / 详情归属校验 / SELF_ACCEPT 守卫）一律按集合判定。
  // 防御：rowCount 异常（undefined/null）或 rows 空时按"查不到"降级（空数组），
  // 绝不让降级路径本身变成 500（降级纪律：一线可用性优先）。
  const r = await client.query<{ id: string }>(
    'SELECT id FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1) LIMIT 10',
    [uid, tenantId],
  );
  if (r.rowCount === 0 || r.rows.length === 0) return [];
  if (r.rows.length > 1) {
    // 多命中：同一身份挂了多份档案（脏数据）。告警并全部返回（由调用方按集合判定），运维按日志清洗。
    console.warn('[workerIdentity] worker 档案多命中，全部返回按集合判定（account_id/id 重复关联，需清洗）', {
      tenantId, authUserId: uid, ids: r.rows.map((x) => x.id),
    });
  }
  return r.rows.map((x) => x.id);
}
