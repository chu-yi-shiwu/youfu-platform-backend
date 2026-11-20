// deployChain.test.ts —— P0-2 部署链一致性护栏（源码构建 / Docker / systemd 三条链同构）。
//
// 【修复前的三条链各走各的】
//   package.json  start = tsx src/server.ts（解释执行 TS）
//   Dockerfile    node:22 + tsx
//   systemd       /opt/node16/bin/node dist/server.js
//   ⇒ 本地/容器跑源码、ECS 跑编译产物；Node16 与 Node22 行为差异只在生产暴露。
//
// 本文件把「统一为 Node22 + dist」钉死在静态契约上；实际构建由 CI/发布前
// `npm ci && npm run build` 验证（G1 检查项）。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('P0-2 · package.json 启动链', () => {
  const pkg = JSON.parse(read('package.json'));

  it('提供 build 脚本（tsc -p tsconfig.build.json）', () => {
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.build.json');
  });

  it('start / start:pilot / start:prod 一律运行编译产物 dist/server.js', () => {
    for (const key of ['start', 'start:pilot', 'start:prod']) {
      expect(pkg.scripts[key], key).toBe('node dist/server.js');
    }
  });

  it('engines 要求 Node 22（与 Docker/systemd 对齐）', () => {
    expect(pkg.engines.node).toBe('>=22.0.0');
  });

  it('tsconfig.build 输出 dist 且排除测试文件', () => {
    const cfg = JSON.parse(read('tsconfig.build.json'));
    expect(cfg.compilerOptions.outDir).toBe('dist');
    expect(cfg.compilerOptions.noEmit).toBe(false);
    expect(cfg.exclude).toContain('src/test');
  });
});

describe('P0-2 · Dockerfile 多阶段构建', () => {
  const df = read('Dockerfile');

  it('有 builder/runtime 两个阶段，且都基于 Node22', () => {
    expect(df).toMatch(/FROM node:22-slim AS builder/);
    expect(df).toMatch(/FROM node:22-slim AS runtime/);
  });

  it('builder 执行真实构建，runtime 只带 dist + 生产依赖', () => {
    expect(df).toContain('npm run build');
    expect(df).toContain('npm ci --omit=dev');
    expect(df).toContain('COPY --from=builder /app/dist ./dist');
  });

  it('运行命令直接是 node dist/server.js（不再走 tsx/npm start）', () => {
    expect(df).toContain('CMD ["node", "dist/server.js"]');
    expect(df).not.toMatch(/CMD.*tsx/);
    expect(df).not.toMatch(/CMD.*npm.*start/);
  });

  it('迁移/种子/规则库/管理页资源都在运行镜像里', () => {
    expect(df).toContain('COPY *.sql ./');
    expect(df).toContain('COPY seeds ./seeds');
    expect(df).toContain('COPY pending-migrations ./pending-migrations');
    expect(df).toContain('COPY data ./data');
    expect(df).toContain('COPY public ./public');
  });
});

describe('P0-2 · systemd unit 与 Node22/dist 对齐', () => {
  const unit = read('deploy/youfu-backend.service');

  it('使用 Node22 路径与 dist/server.js', () => {
    expect(unit).toContain('/opt/node22/bin');
    expect(unit).toContain('ExecStart=/opt/node22/bin/node dist/server.js');
    // 只检查生效配置行：注释里保留「原 node16 路径」是历史说明，不能算违规。
    const active = unit.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');
    expect(active).not.toContain('node16');
  });

  it('配置优雅停机信号与超时（配合 server.ts 的 gracefulShutdown）', () => {
    expect(unit).toContain('KillSignal=SIGTERM');
    expect(unit).toContain('TimeoutStopSec=15');
  });

  it('生产环境变量显式固定（ENV_FILE / AUTH_MODE）', () => {
    expect(unit).toContain('Environment="NODE_ENV=production"');
    expect(unit).toContain('Environment="ENV_FILE=/opt/youfu/backend/.env"');
    expect(unit).toContain('Environment="AUTH_MODE=prod"');
  });
});

describe('P0-2 · .env.example 覆盖生产最小启动集合', () => {
  it('存在且不被 .gitignore / .dockerignore 排除', () => {
    expect(existsSync(join(ROOT, '.env.example'))).toBe(true);
    expect(read('.gitignore')).toContain('!.env.example');
  });

  it('包含必需键，但不含真实密钥占位以外的值', () => {
    const env = read('.env.example');
    for (const key of ['NODE_ENV', 'AUTH_MODE', 'JWT_SECRET', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'ENV_FILE', 'PORT']) {
      expect(env, key).toMatch(new RegExp(`^${key}=`, 'm'));
    }
    expect(env).not.toMatch(/JWT_SECRET=[0-9a-f]{64}/); // 防止有人把真密钥写进模板
  });
});
