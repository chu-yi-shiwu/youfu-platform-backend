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

describe('work_order 模块路由边界', () => {
  it('管理面 /admin/work-orders 统一挂 work_order 模块门禁', () => {
    expect(workOrder).toContain("router.use('/admin/work-orders', requireModule('work_order'))");
  });

  it('管理面 /admin/work-orders 统一挂管理角色门禁，worker 不能进入', () => {
    expect(workOrder).toContain("router.use('/admin/work-orders', requireManagementRole)");
    expect(workOrder).toContain("'management endpoint'");
  });

  it('共享执行路由必须带 requireWorkerExecution，不能靠角色分支绕过', () => {
    for (const route of [
      "router.post('/open/work_order', requireWorkerExecution",
      "router.get('/open/work_orders', requireWorkerExecution",
      "router.post('/open/work_order/:id/transition', requireWorkerExecution",
      "router.get('/open/work_order/:id', requireWorkerExecution",
      "router.post('/open/work_order/:id/claim', requireWorkerExecution",
      "router.post('/open/work_order/:id/urge', requireWorkerExecution",
      "router.get('/open/claim-hall', requireWorkerExecution",
      "router.patch('/open/work_order/:id/ext', requireWorkerExecution",
    ]) {
      expect(workOrder).toContain(route);
    }
  });

  it('管理面补照片/语音与执行面共用 handler，但注册在 /admin 契约下', () => {
    expect(workOrder).toContain("router.post('/admin/work-orders/:id/photos', handleWorkOrderPhotos)");
    expect(workOrder).toContain("router.post('/admin/work-orders/:id/voice', handleWorkOrderVoice)");
    expect(workOrder).toContain("router.post('/open/work_order/:id/photos', requireWorkerExecution, handleWorkOrderPhotos)");
    expect(workOrder).toContain("router.post('/open/work_order/:id/voice', requireWorkerExecution, handleWorkOrderVoice)");
  });

  it('管理端点不得继续注册在 /open 下', () => {
    for (const route of [
      "router.get('/open/work_order/available',",
      "router.get('/open/work_order/:id/events',",
      "router.post('/open/work_order/:id/change-department',",
      "router.get('/open/dispatch-recommend',",
    ]) {
      expect(workOrder).not.toContain(route);
    }
  });
});

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
