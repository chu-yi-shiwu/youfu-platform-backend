// healthReadiness.test.ts —— P0-8 存活/就绪分离 + 优雅停机静态护栏。
//
// 【为什么必须分离】
//   原 `/health` 不探 DB、永远 200。DB 挂掉后负载均衡仍认为实例健康，持续把业务流量
//   打进来，用户看到的是 500，而探针全绿 —— 无法自动摘流量，也无法自动重启恢复。
//
// 【为什么优雅停机】
//   systemd 每次部署都发 SIGTERM。此前 Node 默认直接杀进程：
//     - 在途请求被截断；
//     - scheduler 可能在退出过程中再开事务；
//     - 连接池不释放（DB 侧连接要等超时才回收）。
//
// 说明：server.ts 是进程入口（import 即 listen + 起 scheduler），不适合在 vitest 里
// 直接 import；本文件用源码静态断言锁定接线，运行时行为由 G1 的 staging 探针验收。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('P0-8 · /health 与 /health/ready 语义分离', () => {
  it('/health 仍是纯存活检查：不查 DB、永远 200', () => {
    const src = read('src/server.ts');
    const block = src.split("app.get('/health'")[1]?.split('});')[0] ?? '';
    expect(block).toContain("status: 'up'");
    expect(block).not.toContain('pool.query');
    expect(block).not.toContain('503');
  });

  it('/health/ready 真探 DB：成功 ready，失败 503', () => {
    const src = read('src/server.ts');
    const idx = src.indexOf("app.get('/health/ready'");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 900);
    expect(block).toContain("await pool.query('SELECT 1')");
    expect(block).toContain("status: 'ready'");
    expect(block).toContain('res.status(503)');
    expect(block).toContain("db: 'down'");
  });

  it('/health/ready 挂在 SPA 兜底/错误中间件之前（否则被吞成 404 或 HTML）', () => {
    const src = read('src/server.ts');
    expect(src.indexOf("app.get('/health/ready'")).toBeLessThan(src.indexOf("app.use('/api'"));
  });
});

describe('P0-8 · SIGTERM/SIGINT 优雅停机', () => {
  const src = read('src/server.ts');

  it('两个信号都接入同一个 gracefulShutdown', () => {
    expect(src).toContain("process.on('SIGTERM'");
    expect(src).toContain("process.on('SIGINT'");
    expect(src).toMatch(/SIGTERM[^\n]*gracefulShutdown\('SIGTERM'\)/);
    expect(src).toMatch(/SIGINT[^\n]*gracefulShutdown\('SIGINT'\)/);
  });

  it('停机顺序完整：四个 scheduler 全停 + server.close + pool.end', () => {
    expect(src).toContain('stopInspectionScheduler();');
    expect(src).toContain('stopSlaScheduler();');
    expect(src).toContain('stopTemplateEffectsScheduler();');
    expect(src).toContain('stopModelTrainScheduler();');
    expect(src).toContain('server.close(');
    expect(src).toContain('await pool.end()');
  });

  it('有 10s 兜底强退，避免 systemd 等 TimeoutStopSec 后 SIGKILL', () => {
    expect(src).toContain('10_000');
    expect(src).toContain('forcing exit');
  });

  it('template / model 两个 scheduler 真的导出 stop（不是只 import 不实现）', () => {
    for (const rel of ['src/scheduler/templateEffectScheduler.ts', 'src/scheduler/modelTrainScheduler.ts']) {
      const s = read(rel);
      expect(s, rel).toContain('export function stop');
      expect(s, rel).toContain('clearInterval(timer)');
      expect(s, rel).toContain('timer = null');
    }
  });
});
