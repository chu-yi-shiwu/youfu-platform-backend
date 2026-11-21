// 模块授权边界静态回归：analytics 只能有一个入口，且门禁在 router 自身。
//
// 背景：/stats 曾经同时注册在 workOrderRouter 和 statsRouter，共享路由先挂载，
// 导致 analytics 模块关闭时仍可访问管理统计。这个测试防止“又加回共享路由”。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const workOrder = readFileSync(join(ROOT, 'src', 'routes', 'workOrder.ts'), 'utf8');
const stats = readFileSync(join(ROOT, 'src', 'routes', 'stats.ts'), 'utf8');

describe('analytics 模块路由边界', () => {
  it('共享 workOrderRouter 不再注册 /stats', () => {
    expect(workOrder).not.toMatch(/router\.get\(\s*['"]\/stats['"]/);
  });

  it('statsRouter 自身挂 requireModule(analytics)', () => {
    const guard = stats.indexOf("router.use(requireModule('analytics'))");
    const firstRoute = stats.indexOf('router.get(');
    expect(guard).toBeGreaterThan(-1);
    expect(firstRoute).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstRoute);
  });

  it('statsRouter 保留 /stats 唯一实现', () => {
    expect(stats).toMatch(/router\.get\(\s*['"]\/stats['"]/);
  });
});
