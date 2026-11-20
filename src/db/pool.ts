// 连接池 + 每请求独立连接注入 tenant_id（P1 多租户隔离落点）。
// 关键约束：
//  - 使用 pg.Pool（连接池），不在每请求新建连接。
//  - SET LOCAL app.tenant_id 必须在独立 client 的事务内执行，请求结束释放回池。
//  - SET LOCAL ROLE youfu_app 切换为受限角色，使 RLS policy(TO youfu_app) 生效（事务内有效，自动复位）。
import { Pool, types } from 'pg';
// DATE(OID=1082) 统一按 YYYY-MM-DD 字符串返回：日期字段无时区语义，
// 交给 JSON 序列化成 ISO 时间戳会导致前端/接口契约出现“日期+时区偏移”的假变更。
types.setTypeParser(1082, (v: string) => v);
import 'dotenv/config';
import { AppError } from '../middleware/error.js';
import { getAuthContext, type DataScope } from './authContext.js';

const pool = new Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'youfu',
  user: process.env.PGUSER ?? 'youfu_app',
  password: process.env.PGPASSWORD ?? 'change_me',
  // 审查修复（架构🔴4）：此前全默认（max=10、无超时护栏）——连接耗尽时请求无限排队，
  // 慢查询/长事务会静默拖垮整站。现显式设限：
  //   - max=20：单进程部署下足够，超出排队而非无限增长；
  //   - connectionTimeoutMillis=3000：拿不到连接 3s 快速失败（可观测的 5xx 优于雪崩式挂起）；
  //   - idleTimeoutMillis=30000：空闲 30s 回收，防连接长期占用。
  // 诚实边界：刻意**不加** statement_timeout（会影响既有慢查询语义，另行立项评估）。
  max: 20,
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 30000,
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
    throw new AppError('INVALID_TENANT_ID', `INVALID_TENANT_ID: 租户编码格式不正确（仅允许字母/数字/点/下划线/短横线，1-64 位；不是医院中文名）`, 400);
  }
  return tenantId;
}

export interface TenantClientOptions {
  /** 系统/公开任务：显式绕过本人范围，仍受租户隔离 */
  system?: boolean;
  /** 仅抢单大厅/认领事务：允许看到未分派单 */
  claimHall?: boolean;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isTestEnv(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

export async function withTenantClient<T>(
  tenantId: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
  opts: TenantClientOptions = {},
): Promise<T> {
  const safeTenant = assertSafeTenantId(tenantId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 会话级租户隔离：事务内有效，连接释放后失效（P1 规避并发泄漏核心）
    // SET LOCAL 不支持 $1 参数化，需用白名单校验后的 tenant_id 拼字符串
    await client.query(`SET LOCAL app.tenant_id = '${safeTenant.replace(/'/g, "''")}'`);
    // 切换受限角色，使 RLS policy 生效。审查修复（架构🔴4）：会话级 SET ROLE 在连接归还
    // 池后不复位（下个请求若不在事务内执行会沿用 youfu_app）。改 SET LOCAL ROLE：
    // 随事务结束自动复位，杜绝跨请求角色泄漏。本行已在 BEGIN 之后，语义安全。
    await client.query('SET LOCAL ROLE youfu_app');

    // 请求级数据范围：RLS 在数据库层消费，不靠路由自己写可见性 if。
    const ctx = getAuthContext();
    let scope: DataScope;
    if (opts.system) {
      scope = 'system';
    } else if (ctx?.scope) {
      scope = ctx.scope;
    } else if (isTestEnv()) {
      // 测试兼容：大量既有测试直接调 withTenantClient。生产/脚本不会落到这里。
      scope = 'system';
    } else {
      throw new AppError(
        'MISSING_AUTH_CONTEXT',
        'withTenantClient 缺少 auth context：系统/公开任务必须显式传入 { system: true }',
        500,
      );
    }

    let workerIds: string[] = [];
    if (scope === 'self') {
      if (ctx?.workerIds) {
        workerIds = ctx.workerIds;
      } else if (ctx?.userId) {
        // account_user.id → worker.id 双路匹配（与 workerIdentity.ts 同口径）
        const r = await client.query<{ id: string }>(
          'SELECT id FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1) LIMIT 10',
          [ctx.userId, safeTenant],
        );
        workerIds = r.rows.map((x) => x.id);
        if (ctx) ctx.workerIds = workerIds;
      }
    }

    await client.query(`SET LOCAL app.scope = '${scope}'`);
    await client.query(`SET LOCAL app.user_id = ${sqlLiteral(ctx?.userId ?? '')}`);
    await client.query(`SET LOCAL app.worker_ids = ${sqlLiteral(workerIds.join(','))}`);
    await client.query(`SET LOCAL app.claim_hall = '${opts.claimHall ? '1' : '0'}'`);

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
