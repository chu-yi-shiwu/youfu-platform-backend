// accessLog.test.ts —— P0-12 最小可观测性：结构化访问日志 + request_id 贯穿。
//
// 钉死四件事：
//   1. 一条请求 = 一行 JSON，字段足够定位（request_id/method/path/status/duration/tenant/user/role）；
//   2. X-Request-Id 客户端给定则沿用，未给定则生成并通过响应头回传；
//   3. query string 不进日志（防手机号/令牌/搜索词落盘）；
//   4. 健康探针不记日志；500 的 errorMiddleware 日志带同一个 request_id。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { accessLogMiddleware, buildAccessLogEntry } from '../middleware/accessLog.js';
import { errorMiddleware } from '../middleware/error.js';

let server: Server;
let base = '';
let logs: string[] = [];
let errors: unknown[][] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const app = express();
  app.use(accessLogMiddleware);
  app.get('/ok', (_req, res) => {
    res.locals.auth = { tenantId: 't-1', userId: 'u-1', role: 'worker', requestId: 'rid-test', authMode: 'prod' };
    res.json({ ok: true });
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/unauth', (_req, res) => res.status(401).json({ ok: false }));
  app.get('/boom', () => {
    throw new Error('boom');
  });
  // 模拟真实 server.ts 的挂载形态：验证访问日志记完整路径，而不是 Express 截断后的相对路径。
  const sub = express.Router();
  sub.get('/nope', (_req, res) => res.status(404).json({ ok: false }));
  app.use('/api/v1', sub);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  logs = [];
  errors = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(' '));
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

function lastAccessLog(): Record<string, unknown> {
  expect(logs.length, '应恰好产生一条访问日志').toBe(1);
  return JSON.parse(logs[0]) as Record<string, unknown>;
}

describe('P0-12 · 结构化访问日志', () => {
  it('① buildAccessLogEntry 输出稳定字段与毫秒级耗时', () => {
    const entry = buildAccessLogEntry({
      requestId: 'rid-1',
      method: 'POST',
      path: '/api/v1/work_orders',
      status: 201,
      durationMs: 12.3456,
      tenantId: 't-1',
      userId: 'u-1',
      role: 'operator',
      at: new Date('2026-11-07T12:00:00.000Z'),
    });
    expect(entry).toEqual({
      ts: '2026-11-07T12:00:00.000Z',
      level: 'info',
      type: 'access',
      request_id: 'rid-1',
      method: 'POST',
      path: '/api/v1/work_orders',
      status: 201,
      duration_ms: 12.346,
      tenant_id: 't-1',
      user_id: 'u-1',
      role: 'operator',
    });
  });

  it('② 客户端给定 X-Request-Id → 原样沿用并回传响应头，日志含身份字段', async () => {
    const r = await fetch(`${base}/ok`, { headers: { 'X-Request-Id': 'rid-client-1' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-request-id')).toBe('rid-client-1');

    const entry = lastAccessLog();
    expect(entry.request_id).toBe('rid-client-1');
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/ok');
    expect(entry.status).toBe(200);
    expect(typeof entry.duration_ms).toBe('number');
    expect(entry.tenant_id).toBe('t-1');
    expect(entry.user_id).toBe('u-1');
    expect(entry.role).toBe('worker');
  });

  it('③ 未给定 X-Request-Id → 服务端生成 UUID，响应头与日志一致', async () => {
    const r = await fetch(`${base}/ok`);
    const header = r.headers.get('x-request-id');
    expect(header).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(lastAccessLog().request_id).toBe(header);
  });

  it('④ query string 不落日志：手机号等敏感参数不扩散', async () => {
    const r = await fetch(`${base}/ok?phone=13800000000&token=secret`);
    expect(r.status).toBe(200);
    const entry = lastAccessLog();
    expect(entry.path).toBe('/ok');
    expect(logs[0]).not.toContain('13800000000');
    expect(logs[0]).not.toContain('secret');
  });

  it('⑤ /health 探针不记访问日志，但仍回传 request_id', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-request-id')).toBeTruthy();
    expect(logs.length).toBe(0);
  });

  it('⑥ 未认证请求（401）也记日志，身份字段为 null', async () => {
    const r = await fetch(`${base}/unauth`, { headers: { 'X-Request-Id': 'rid-401' } });
    expect(r.status).toBe(401);
    const entry = lastAccessLog();
    expect(entry.request_id).toBe('rid-401');
    expect(entry.status).toBe(401);
    expect(entry.tenant_id).toBeNull();
    expect(entry.user_id).toBeNull();
    expect(entry.role).toBeNull();
  });

  it('⑦ 挂载子路由时记录完整 originalUrl（不丢 /api 前缀）', async () => {
    const r = await fetch(`${base}/api/v1/nope`, { headers: { 'X-Request-Id': 'rid-mount' } });
    expect(r.status).toBe(404);
    const entry = lastAccessLog();
    expect(entry.path).toBe('/api/v1/nope');
    expect(entry.request_id).toBe('rid-mount');
  });

  it('⑧ 500 的 [unhandled] 日志与访问日志使用同一个 request_id', async () => {
    const r = await fetch(`${base}/boom`, { headers: { 'X-Request-Id': 'rid-500' } });
    expect(r.status).toBe(500);
    expect(lastAccessLog().status).toBe(500);
    expect(errors.length).toBe(1);
    expect(errors[0][0]).toBe('[unhandled]');
    expect(errors[0]).toContain('request_id=rid-500');
    expect(errors[0]).toContain('GET /boom');
  });
});
