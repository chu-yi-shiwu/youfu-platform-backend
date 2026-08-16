// 角色鉴权中间件（批次 B 复用）：仅 admin/operator 可写管理类资源。
// 与批次 A 的 config.ts 内联实现保持一致，单独抽出以便多路由复用，且不动已验证的 config.ts。
import { AppError } from './error.js';

export function requireConfigRole(_req: unknown, res: any): void {
  const role = res.locals.auth.role;
  if (role !== 'admin' && role !== 'operator') {
    throw new AppError('FORBIDDEN', 'only admin/operator can manage', 403);
  }
}
