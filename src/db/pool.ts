// 连接池 + 每请求独立连接注入 tenant_id（P1 多租户隔离落点）。
// 关键约束：
//  - 使用 pg.Pool（连接池），不在每请求新建连接。
//  - SET LOCAL app.tenant_id 必须在独立 client 的事务内执行，请求结束释放回池。
//  - SET ROLE youfu_app 切换为受限角色，使 RLS policy(TO youfu_app) 生效。
import { Pool } from 'pg';
import 'dotenv/config';
import { AppError } from '../middleware/error.js';

const pool = new Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'youfu',
  user: process.env.PGUSER ?? 'youfu_app',
  password: process.env.PGPASSWORD ?? 'change_me',
});

/**
 * 在独立连接 + 事务内执行 fn，连接层注入 tenant_id。
 * 完成后 COMMIT 并释放 client 回池（无论成功失败）。
 */
// tenant_id 来自请求头，不可信。仅允许安全标识符，防止 SET 语句注入。
// SET LOCAL 不支持预处理参数 $1，必须拼字符串，故此处严格白名单校验。
const TENANT_ID_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
export function assertSafeTenantId(tenantId: string): string {
  if (!tenantId || !TENANT_ID_RE.test(tenantId)) {
    // OBS-1（#922）：改抛 AppError(400) 走 errorMiddleware 正常 4xx 路径——
    // 原裸 Error 会被归类 [unhandled] 并返回 500，误导排障（fail-closed 语义不变，仅错误分类更准确）。
    // message 前缀保留 INVALID_TENANT_ID 文案，pool.test.ts 的 toThrow 子串断言保持兼容。
    throw new AppError('INVALID_TENANT_ID', `INVALID_TENANT_ID: tenant id must match ${TENANT_ID_RE.source}`, 400);
  }
  return tenantId;
}

export async function withTenantClient<T>(
  tenantId: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const safeTenant = assertSafeTenantId(tenantId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 会话级租户隔离：事务内有效，连接释放后失效（P1 规避并发泄漏核心）
    // SET LOCAL 不支持 $1 参数化，需用白名单校验后的 tenant_id 拼字符串
    await client.query(`SET LOCAL app.tenant_id = '${safeTenant.replace(/'/g, "''")}'`);
    // 切换受限角色，使 RLS policy 生效
    await client.query('SET ROLE youfu_app');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    // 请求结束即释放连接回池
    client.release();
  }
}

export default pool;
