// 请求级认证上下文（AsyncLocalStorage）。
//
// 为什么需要它：
//   - RLS 需要知道“当前请求是谁、什么数据范围、哪些 worker 档案”；
//   - 如果每个 withTenantClient 调用点都手传 auth，会漏、会漂移；
//   - 用 AsyncLocalStorage 在 authMiddleware 注入一次，连接层自动读取。
//
// 安全契约：
//   - 只有 authMiddleware / 测试 helper 可以写入；
//   - withTenantClient 没有 auth context 时必须显式 { system: true }，
//     否则 fail-closed 抛 MISSING_AUTH_CONTEXT；
//   - workerIds 由连接层按 userId 查 worker 档案后回填，避免每个请求重复查。
import { AsyncLocalStorage } from 'node:async_hooks';

export type DataScope = 'tenant' | 'self' | 'system';

export interface RequestAuthContext {
  /** account_user.id（JWT sub）；dev/system 可为空 */
  userId?: string;
  /** 角色 code（JWT role）；用于解释和审计，不直接做 SQL 拼接 */
  role?: string;
  /** tenant=全租户；self=本人；system=系统任务 */
  scope: DataScope;
  /** self 范围的 worker 档案 id 集合；连接层解析后回填 */
  workerIds?: string[];
}

const ALSCtx = new AsyncLocalStorage<RequestAuthContext>();

export function runWithAuthContext<T>(ctx: RequestAuthContext, fn: () => T): T {
  return ALSCtx.run(ctx, fn);
}

export function getAuthContext(): RequestAuthContext | undefined {
  return ALSCtx.getStore();
}

/** 仅供测试/脚本显式进入 system 上下文；生产请求由 authMiddleware 注入。 */
export function runWithSystemContext<T>(tenantId: string, fn: () => T): T {
  void tenantId;
  return ALSCtx.run({ scope: 'system' }, fn);
}
