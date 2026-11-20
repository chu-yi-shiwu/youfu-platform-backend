// 请求形状守卫（2026-11-14 深度探针 D-新1/D-新2 负控制）
//
// 修复前实测：
//   GET /open/work_orders?status=done&status=pending  → 500（数组直达 SQL）
//   POST /accounts {username:"a\u0000b"}               → 500（NUL 直达 PG → 22021 未映射）
//   POST /basic-data/dept {name:"a\u0000b"}            → 500
// 修复：边界层统一拒绝（400），不允许用户输入制造 5xx。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestShapeMiddleware } from '../middleware/requestShape.js';
import { errorMiddleware } from '../middleware/error.js';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', requestShapeMiddleware);
  app.get('/api/echo', (req, res) => res.json({ ok: true, q: req.query }));
  app.post('/api/echo', (req, res) => res.json({ ok: true, body: req.body }));
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('重复/嵌套查询参数 → 400（不再 500）', () => {
  it('重复 status 参数被拒绝', async () => {
    const r = await fetch(base + '/echo?status=done&status=pending');
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe('BAD_QUERY');
  });

  it('嵌套 a[b]=c 被拒绝', async () => {
    const r = await fetch(base + '/echo?a[b]=c');
    expect(r.status).toBe(400);
  });

  it('单值查询正常放行', async () => {
    const r = await fetch(base + '/echo?status=done');
    expect(r.status).toBe(200);
  });
});

describe('NUL 字节 → 400（不再 500）', () => {
  it('body 字符串含 NUL 被拒绝', async () => {
    const r = await post('/echo', { title: 'a\u0000b' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe('BAD_PARAM');
  });

  it('深层嵌套 body 含 NUL 被拒绝', async () => {
    const r = await post('/echo', { ext: { nested: ['ok', { x: '\u0000' }] } });
    expect(r.status).toBe(400);
  });

  it('查询串 %00 被拒绝', async () => {
    const r = await fetch(base + '/echo?q=a%00b');
    expect(r.status).toBe(400);
  });

  it('正常 body 放行', async () => {
    const r = await post('/echo', { title: '正常标题' });
    expect(r.status).toBe(200);
  });
});
