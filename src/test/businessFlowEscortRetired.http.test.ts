// 陪检双轨收口：/flow/escort 必须 410，指向标准工单入口。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import businessFlowRouter from '../routes/businessFlow.js';

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = { tenantId: 't-escort', role: 'admin', authMode: 'dev', userId: 'u-1', requestId: 'r-1' };
    next();
  });
  app.use('/api/v1/flow', businessFlowRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('陪检唯一主流程', () => {
  it('/flow/escort → 410 GONE，指向标准工单', async () => {
    const r = await fetch(`${base}/flow/escort`);
    expect(r.status).toBe(410);
    const j = (await r.json()) as any;
    expect(j.code).toBe('GONE');
    expect(j.message).toContain('/intake?template=escort');
    expect(j.message).toContain('/tickets');
  });
});
