// publicAiChat.http.test.ts —— 对话管家公开路由 HTTP 测试（#942 审查补缺）。
// 背景：POST /public/ai-chat 是免登录公网入口，此前 vitest 覆盖为 0；#942 真机暴露
// org 缺失时 zod 统一报"参数不完整"掩盖真实缺因 → 已加前置明示 422。
// 本文件覆盖：org 缺失前置 422（口径对齐 GET 分支）、机构白名单 404、message 缺失 422。
// 模式复用 publicReport.http.test.ts：vi.mock 池与重依赖，express 真 handler。
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const poolQuery = vi.fn(async (text: unknown, params?: unknown[]) => {
  const sql = String(text);
  if (sql.includes('tenant_registry')) {
    const org = params?.[0];
    if (org === 't-nope') return { rows: [], rowCount: 0 };
    return { rows: [{ tenant_id: org, name: '测试机构', category: 'other', quota: null }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
});

vi.mock('../db/pool.js', () => ({
  default: { query: (...a: unknown[]) => poolQuery(...(a as [unknown, unknown[]])) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }),
  assertSafeTenantId: (t: string) => t,
}));
vi.mock('../repo/aiConversation.js', () => ({
  createConversation: vi.fn(),
  getConversation: vi.fn(),
  listTurns: vi.fn(),
}));
vi.mock('../services/conversationAgent.js', () => ({
  runAgentTurn: vi.fn(),
  conversationAvailable: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../middleware/auth.js', () => ({
  loginRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import router from '../routes/publicAiChat.js';

async function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return new Promise<{ app: express.Express; server: Server; url: string }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ app, server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const post = (base: string, body: unknown) =>
  fetch(base + '/api/v1/public/ai-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /public/ai-chat —— org 前置明示（#942 教训）', () => {
  it('缺 org → 422 VALIDATION_ORG_REQUIRED，message 明示"缺少机构"（不再被 zod 统一话术掩盖）', async () => {
    const { server, url } = await makeApp();
    try {
      const r = await post(url, { message: '打印机坏了' });
      expect(r.status).toBe(422);
      const b = (await r.json()) as any;
      expect(b.code).toBe('VALIDATION_ORG_REQUIRED');
      expect(b.message).toContain('缺少机构');
    } finally {
      server.close();
    }
  });

  it('org 空串 → 同样 422 VALIDATION_ORG_REQUIRED', async () => {
    const { server, url } = await makeApp();
    try {
      const r = await post(url, { org: '', message: '打印机坏了' });
      expect(r.status).toBe(422);
      const b = (await r.json()) as any;
      expect(b.code).toBe('VALIDATION_ORG_REQUIRED');
    } finally {
      server.close();
    }
  });

  it('org 不在白名单 → 404 ORG_404 机构不存在或未启用', async () => {
    const { server, url } = await makeApp();
    try {
      const r = await post(url, { org: 't-nope', message: '打印机坏了' });
      expect(r.status).toBe(404);
      const b = (await r.json()) as any;
      expect(b.code).toBe('ORG_404');
    } finally {
      server.close();
    }
  });

  it('缺 message → 422（zod VALIDATION_001，org 已过前置）', async () => {
    const { server, url } = await makeApp();
    try {
      const r = await post(url, { org: 't-ok' });
      expect(r.status).toBe(422);
      const b = (await r.json()) as any;
      expect(b.code).toBe('VALIDATION_001');
    } finally {
      server.close();
    }
  });
});
