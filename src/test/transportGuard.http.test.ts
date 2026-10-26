// transportGuard.http.test.ts —— P1（B2 接 allowedRoles + 补 SLA 字段）。
// 真·express + 真 HTTP（对齐 volunteerGuard.http.test.ts 范式），mock 掉 DB 连接池（脚本化 client）。
// 覆盖（审查报告 20260908 🟡"运送线声明式角色门禁未强制"）：
//   ① 在身承运人 worker receive（allowedRoles 含 worker）→ 200
//   ② 在身承运人 worker cancel（allowedRoles 仅 admin/operator）→ 403（P1 缺口锁定回归）
//   ③ admin cancel → 200（放行口径不变）
//   ④ 建单带 sla_due_at → INSERT 落参（B2 补 SLA：期望完成时间入列，供 SLA cron 扫描）
//   ⑤ 建单不带 sla_due_at → INSERT 落 null（诚实：不替租户估时）
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock 掉 DB 连接池：脚本化 SQL 响应 + 调用日志 ----
const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  scripted: [] as Array<{ match: RegExp; rows: any[]; rowCount?: number }>,
}));
vi.mock('../db/pool.js', () => ({
  default: {},
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        h.calls.push({ sql, params });
        for (const s of h.scripted) {
          if (s.match.test(sql)) return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return fn(client);
  },
}));

import transportRouter from '../routes/transport.js';

const T = 't-transport-guard';
let server: Server;
let base = '';

// 注入指定角色 + prod 模式（requireAssigneeOrConfig 真校验归属，allowedRoles 门禁真生效）
function injectAuth(role: string) {
  return (_req: any, res: any, next: any) => {
    res.locals.auth = { tenantId: T, role, authMode: 'prod', userId: 'w-1', requestId: 'test' };
    next();
  };
}

function scriptTransportOrder(status: string) {
  h.scripted.length = 0;
  h.calls.length = 0;
  // workflow_def 查不到 → 走 TRANSPORT_DEF 内置默认（门禁口径即内置声明）
  h.scripted.push({ match: /FROM workflow_def/, rows: [] });
  // 归属守卫探测（SELECT id, carrier）与 transitionOrder 全量读（SELECT *）都命中
  h.scripted.push({
    match: /FROM transport_order WHERE id/,
    rows: [{ id: 'to-1', tenant_id: T, status, carrier: 'w-1', item_name: '标本' }],
  });
  h.scripted.push({ match: /FROM worker WHERE tenant_id/, rows: [{ id: 'w-1' }] });
  h.scripted.push({ match: /UPDATE transport_order/, rows: [{ id: 'to-1', status: 'next' }] });
  h.scripted.push({ match: /INSERT INTO transport_track_point/, rows: [] });
  h.scripted.push({ match: /INSERT INTO domain_event/, rows: [] });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transport', injectAuth('worker'), transportRouter);
  app.use('/api/v1/admin-sim', injectAuth('admin'), transportRouter);
  app.use(errorMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('transport transition allowedRoles 门禁（P1）', () => {
  it('① 在身承运人 worker receive → 200（allowedRoles 含 worker）', async () => {
    scriptTransportOrder('assigned');
    const r = await fetch(`${base}/api/v1/transport/orders/to-1/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'receive' }),
    });
    expect(r.status).toBe(200);
  });

  it('② 在身承运人 worker cancel → 403（P1 缺口锁定：此前可越权取消）', async () => {
    scriptTransportOrder('transporting');
    const r = await fetch(`${base}/api/v1/transport/orders/to-1/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'cancel' }),
    });
    expect(r.status).toBe(403);
  });

  it('③ admin cancel → 200（放行口径不变）', async () => {
    scriptTransportOrder('transporting');
    const r = await fetch(`${base}/api/v1/admin-sim/orders/to-1/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'cancel' }),
    });
    expect(r.status).toBe(200);
  });
});

describe('transport 建单 sla_due_at 落参（P1 B2 补 SLA）', () => {
  function scriptCreate() {
    h.scripted.length = 0;
    h.calls.length = 0;
    h.scripted.push({ match: /INSERT INTO transport_order/, rows: [{ id: 'to-new' }] });
    h.scripted.push({ match: /INSERT INTO domain_event/, rows: [] });
  }

  it('④ 带 sla_due_at → INSERT 参数含该值', async () => {
    scriptCreate();
    const r = await fetch(`${base}/api/v1/admin-sim/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item_name: '标本', sla_due_at: '2026-09-09T18:00:00+08:00' }),
    });
    expect(r.status).toBe(201);
    const ins = h.calls.find((c) => /INSERT INTO transport_order/.test(c.sql));
    expect(ins?.sql).toContain('sla_due_at');
    expect(ins?.params).toContain('2026-09-09T18:00:00+08:00');
  });

  it('⑤ 不带 sla_due_at → INSERT 落 null（不纳入 SLA 扫描）', async () => {
    scriptCreate();
    const r = await fetch(`${base}/api/v1/admin-sim/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item_name: '文件' }),
    });
    expect(r.status).toBe(201);
    const ins = h.calls.find((c) => /INSERT INTO transport_order/.test(c.sql));
    expect(ins?.sql).toContain('sla_due_at');
    // sla_due_at 是第 12 个参数（$12），插值位置落 null
    expect(ins?.params[11]).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T1-B 批 2 · transport_order 在途单锁版本
//
// 【与 adapter 那份的分工】src/test/transportAdapter.map.test.ts 验 /flow 代理侧
//   （真 adapter + 假 client，断言"查了几次、哪个版本"）；本文件验原生路由侧：
//   盖章值对不对、读写两侧是不是同一条路径。两侧都要有，只验一侧会留缝。
// ═══════════════════════════════════════════════════════════════════════════
const TRANSPORT_SRC = readFileSync(join(__dirname, '..', 'routes', 'transport.ts'), 'utf8');

describe('T1-B 批2 · transport_order 在途单锁版本', () => {
  it('A4：建单 INSERT 带上 def_version，且值 = 建单时查到的 live version', async () => {
    h.scripted.length = 0;
    h.calls.length = 0;
    // 🔴 刻意让 workflow_def 返回一个**非 0** 的版本号。若让它返回 0（无定义），
    //    实现把版本号写死 0（= 永不上锁，最严重那种错）时本断言照样绿 ——
    //    批 1 在 http 桩上刚踩过这个坑：桩值恰好等于"错误实现的默认值"就是假绿的温床。
    h.scripted.push({ match: /SELECT version FROM workflow_def/, rows: [{ version: 5 }] });
    h.scripted.push({ match: /INSERT INTO transport_order/, rows: [{ id: 'to-new' }] });
    h.scripted.push({ match: /INSERT INTO domain_event/, rows: [] });

    const r = await fetch(`${base}/api/v1/admin-sim/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item_name: '标本' }),
    });
    expect(r.status).toBe(201);
    const ins = h.calls.find((c) => /INSERT INTO transport_order/.test(c.sql));
    expect(ins, '没发建单 SQL').toBeTruthy();
    expect(ins!.sql, 'INSERT 列清单缺 def_version ⇒ 新单不入版本锁').toContain('def_version');
    expect(ins!.params.length, '参数数应为 13（原 12 + def_version）').toBe(13);
    // 漏传 ⇒ length 是 12；写死 0 或别的常量 ⇒ 不等于 5。三种错都能抓住。
    expect(ins!.params[12], 'def_version 参数必须取 getWorkflowDefVersion 的返回值').toBe(5);
  });

  it('A3-静态：读写两侧走同一条 versioned read 路径（漏改任一侧都被这条抓住）', () => {
    const re = /getWorkflowDefAtVersion\(client, tenantId, 'transport_task', [to]\.def_version, TRANSPORT_DEF\)/g;
    expect(TRANSPORT_SRC.match(re)?.length, '写侧 + 读侧 = 2 处，少一处即 R-1').toBe(2);
    // 文件内不得残留裸调用：那条残留路径读的就是 live，等于锁了个寂寞。
    expect(TRANSPORT_SRC).not.toMatch(/getWorkflowDefOrDefault\s*\(/);
  });

  it('A4-实体名：取版本号必须传 transport_task，不是表名 transport_order', () => {
    // 🔴 D1 永久双名：表名 transport_order，def 口径却是 transport_task。
    //    传错会永远返回 0 而一声不响 ⇒ 最典型的静默失败（E3 反面）。这条把实体名钉死。
    const m = TRANSPORT_SRC.match(/getWorkflowDefVersion\(client, tenantId, '([^']+)'\)/);
    expect(m, '源码里没找到取版本号的调用 —— 本测试已与实现脱节').toBeTruthy();
    expect(m![1], 'def 口径实体名必须是 transport_task').toBe('transport_task');
  });
});
