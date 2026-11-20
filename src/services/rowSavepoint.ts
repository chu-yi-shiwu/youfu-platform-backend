// CSV 逐行写入的 SAVEPOINT 隔离（2026-11-17）
// 根因：导入在单个事务中逐行 try/catch；某行唯一键冲突后 PostgreSQL 事务进入 aborted 状态，
//       后续 COMMIT 实际执行 ROLLBACK，接口却返回 inserted>0 —— 回执与落库不一致。
// 口径：每行一个 SAVEPOINT，失败只回滚该行，成功行照常提交。
import type { PoolClient } from 'pg';

export async function withRowSavepoint<T>(
  client: PoolClient,
  fn: () => Promise<T>,
  name = 'csv_row',
): Promise<T> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const value = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return value;
  } catch (e) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw e;
  }
}
