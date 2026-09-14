// reviewFixesF8F9F15.test.ts —— 横切修复批次（F8/F9/F15）关键路径护栏。
//
//   F8 notifications/read 收口（横切⑦ B-1）：置已读必须限定本人收件身份集合
//     （auth.userId ∪ resolveWorkerIds 双路匹配），ids 路径与缺省路径均加
//     recipient = ANY(...) 条件；身份解析不出 → 422 IDENTITY_UNRESOLVED（已读不可逆，
//     绝不降级为全租户置已读）。
//   F9 transitionEntity 行锁（横切⑦ B-2）：SELECT * FOR UPDATE 落锁，
//     与 ticket.ts findOneForUpdate 同款模式（跨语句「读状态→校验→写回」竞态封口）。
//   F15 089 迁移静态守卫：放宽向覆盖行回填（operator×志愿者三点 + worker×intake.create）
//     ——只补已有覆盖行、ON CONFLICT DO NOTHING 幂等、🔴纯 DML 无 now()、无 DDL。
//
// 断言纪律：一律断言真实 HTTP 状态码 / SQL 落盘形态，禁止 try/catch 空过。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[reviewFixesF8F9F15] 单测禁用真实 pool'); } },
}));

import workOrderRouter from '../routes/workOrder.js';

interface Handler {
  match: (text: string) => boolean;
  reply: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[]) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  h.client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const hd of handlers) {
        if (hd.match(text)) return hd.reply(text, params ?? []);
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return calls;
}

const T = 't-f8-review';

let server: Server;
let baseUrl = '';
const auth = { tenantId: T, requestId: 'req-f8', userId: 'u-1', username: 'worker-a', role: 'worker', authMode: 'prod' as const };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = auth;
    next();
  });
  app.use('/api/v1', workOrderRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> => {
  const r = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};

// worker 双路匹配 handler：resolveWorkerIds（account_id=$1 OR id=$1）
const workerProfileHandler = (profiles: string[]): Handler => ({
  match: (t) => t.includes('FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1)'),
  reply: () => ({ rows: profiles.map((id) => ({ id })), rowCount: profiles.length }),
});

// ============ F8：notifications/read 收口 ============

describe('F8 notifications/read：置已读必须限定本人收件身份集合', () => {
  it('F8-1 缺省路径（全部已读）：SQL 必须带 recipient = ANY，身份集合 = userId ∪ worker.id', async () => {
    const calls = makeClient([
      workerProfileHandler(['W0001', 'W0009']), // 双档案全返回（E-8 QA P3-1 语义沿用）
      { match: (t) => t.startsWith('UPDATE notification SET read = true'), reply: () => ({ rows: [], rowCount: 3 }) },
    ]);
    const r = await post('/open/notifications/read', {});
    expect(r.status).toBe(200);
    expect(r.body.marked).toBe(3);
    const upd = calls.find((c) => c.text.startsWith('UPDATE notification SET read = true'));
    expect(upd).toBeTruthy();
    // 收口实锤：必须限定 recipient 集合，禁止全租户裸 UPDATE
    expect(upd!.text).toContain('recipient = ANY($2::text[])');
    expect(upd!.text).not.toMatch(/WHERE tenant_id = \$1 AND read = false/);
    // 身份集合深等：userId + 全部 worker 档案 id（双路身份覆盖 worker/account 两种 recipient_kind）
    expect(upd!.params).toContainEqual(['u-1', 'W0001', 'W0009']);
  });

  it('F8-2 ids 路径：id = ANY 之外必须叠加 recipient = ANY（防按 id 置他人通知已读）', async () => {
    const calls = makeClient([
      workerProfileHandler(['W0001']),
      { match: (t) => t.startsWith('UPDATE notification SET read = true'), reply: () => ({ rows: [{ id: 'n-1' }], rowCount: 1 }) },
    ]);
    const r = await post('/open/notifications/read', { ids: ['n-1', 'n-other'] });
    expect(r.status).toBe(200);
    const upd = calls.find((c) => c.text.startsWith('UPDATE notification SET read = true'));
    expect(upd).toBeTruthy();
    expect(upd!.text).toContain('id = ANY($2::text[])');
    expect(upd!.text).toContain('recipient = ANY($3::text[])');
    // 第 3 参必须是本人身份集合（含 userId 与 worker.id）
    expect(upd!.params).toContainEqual(['u-1', 'W0001']);
  });

  it('F8-3 身份解析不出（无 userId、无 worker 档案）→ 422 IDENTITY_UNRESOLVED，拒绝而非全租户放行', async () => {
    auth.userId = '';
    try {
      const calls = makeClient([
        workerProfileHandler([]),
        { match: (t) => t.startsWith('UPDATE notification SET read = true'), reply: () => ({ rows: [], rowCount: 99 }) },
      ]);
      const r = await post('/open/notifications/read', {});
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('IDENTITY_UNRESOLVED');
      // 422 前置拒绝：不得有任何 UPDATE notification 调用发生
      expect(calls.some((c) => c.text.startsWith('UPDATE notification SET read = true'))).toBe(false);
    } finally {
      auth.userId = 'u-1';
    }
  });
});

// ============ F9：transitionEntity 行锁 ============

describe('F9 transitionEntity：状态读取 SELECT 必须带 FOR UPDATE 行锁', () => {
  it('F9-1 首条 SELECT 含 FOR UPDATE（与 ticket.ts findOneForUpdate 同款模式）', async () => {
    const { transitionEntity } = await import('../engine/transition.js');
    const calls: Array<{ text: string; params?: unknown[] }> = [];
    const client = {
      query: async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        if (/^SELECT \* FROM business_flow_tasks/.test(text)) {
          return { rows: [{ id: 'e1', tenant_id: T, status: 'draft', data: {} }], rowCount: 1 };
        }
        if (text.includes('FROM workflow_def')) return { rows: [], rowCount: 0 }; // 回退默认 def
        if (text.startsWith('UPDATE business_flow_tasks')) return { rows: [{ id: 'e1', status: 'assigned' }], rowCount: 1 };
        return { rows: [], rowCount: 1 }; // emitDomainEvent 等
      },
    };
    const row = await transitionEntity(client as never, T, {
      table: 'business_flow_tasks',
      entityType: 'business_flow_task',
      id: 'e1',
      event: 'assign',
      actor: 'tester',
      fallbackDef: {
        initial: 'draft',
        states: ['draft', 'assigned', 'processing', 'completed'],
        transitions: [{ from: 'draft', to: 'assigned', event: 'assign' }],
        config: {},
      },
    } as never);
    expect(row.status).toBe('assigned');
    const sel = calls.find((c) => /^SELECT \* FROM business_flow_tasks/.test(c.text));
    expect(sel).toBeTruthy();
    expect(sel!.text).toContain('FOR UPDATE');
  });
});

// ============ F15：089 迁移静态守卫 ============

describe('F15 089 迁移静态守卫：放宽向覆盖行回填红线', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 仓库根 = src/test 上两级
  const sqlPath = path.resolve(here, '..', '..', '089_volunteer_intake_perm_backfill.sql');
  const sql = fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf8') : '';

  it('F15-1 文件存在于仓库根（编号 089 只增）', () => {
    expect(fs.existsSync(sqlPath)).toBe(true);
  });

  it('F15-2 目标点齐备：operator×志愿者三点 + worker×intake.create，且角色限定 operator/worker', () => {
    expect(sql).toContain("'operator', 'volunteer.view'");
    expect(sql).toContain("'operator', 'volunteer.manage'");
    expect(sql).toContain("'operator', 'volunteer.audit'");
    expect(sql).toContain("'worker', 'intake.create'");
    expect(sql).toContain("rp.role IN ('operator', 'worker')");
    // 回填只给已有覆盖行的租户：EXISTS 自证子句在场
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM role_permission/);
  });

  it('F15-3 幂等：ON CONFLICT (tenant_id, role, perm) DO NOTHING 在场', () => {
    expect(sql).toContain('ON CONFLICT (tenant_id, role, perm) DO NOTHING');
  });

  it('F15-4 🔴 红线：纯 DML——无 now()、无 DDL（CREATE/ALTER/DROP/TABLE）', () => {
    // 红线针对真实 SQL 语句：剥离 -- 注释行与 \echo 提示行后检查（注释里提到 now() 不违规）
    const code = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('\\echo'))
      .join('\n');
    expect(code).not.toMatch(/now\(\)/i);
    expect(code).not.toMatch(/\bCREATE\s+(TABLE|INDEX)\b/i);
    expect(code).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(code).not.toMatch(/\bDROP\s+(TABLE|INDEX)\b/i);
  });

  it('F15-5 附盘点 SQL：回填后仍 403 的 (tenant, role) 复核段（③ 复核）在场', () => {
    expect(sql).toContain('089③');
    expect(sql).toMatch(/still_missing/);
  });
});
