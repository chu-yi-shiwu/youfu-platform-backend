// 事务内临时切换 app.scope 的窄工具。
//
// 为什么单独放这里：
//   - 很多 HTTP 测试会 mock ../db/pool.js；把该工具放 pool 会迫使几十个 mock 同步新增导出；
//   - 它只操作调用方传入的 client，不碰连接池，独立文件不会形成依赖环。
import type { PoolClient } from 'pg';
import type { DataScope } from './authContext.js';

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 在已开启的事务内临时切换数据范围，结束后恢复原值。
 * 只用于受信系统动作（自动派单/退回重派）——这些动作必须把 assignee 改成别人，
 * PostgreSQL UPDATE 的新行还要过 SELECT 策略，因此只能在赋值语句期间切 system。
 * 不用于人类操作端点，也不从请求体读取。
 */
export async function withTenantScope<T>(
  client: PoolClient,
  scope: DataScope,
  fn: () => Promise<T>,
): Promise<T> {
  const cur = await client.query<{ v: string | null }>(
    `SELECT current_setting('app.scope', true) AS v`,
  );
  const prev = cur.rows[0]?.v ?? 'self';
  await client.query(`SET LOCAL app.scope = '${scope}'`);
  try {
    return await fn();
  } finally {
    await client.query(`SET LOCAL app.scope = ${sqlLiteral(prev)}`);
  }
}
