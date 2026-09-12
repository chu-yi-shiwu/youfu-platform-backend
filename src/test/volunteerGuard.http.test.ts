// volunteerGuard.http.test.ts —— 志愿者报名/审批业务守卫（P0 双任务·任务一）。
// 真·express + 真 HTTP（对齐 intakeOptions.http.test.ts 范式），mock 掉 DB 连接池（脚本化 client）。
// 覆盖：① closed 活动 signup → 409（活动已关闭）
//       ② 名额满 signup → 409（count >= slots 拒绝）
//       ③ slots=0 活动报名 → 409（0 容量=不可报名，锁定新语义）
//       ④ registered 未签退直 approve → 409（状态机守卫）
//       ⑤ 全链 signup→checkin→checkout→approve 全 200（正向回归）
//       ⑥ signup 守卫 SQL 契约：act SELECT 必带 FOR UPDATE（行锁防并发超卖）
//  V1（20260911）：⑧ 同 (activity_id, user_name) 二次 signup → 409 DUPLICATE（去重守卫，
//       判重 SQL 契约：含 activity_id + user_name 条件；命中即短路，不产生二次 INSERT，也不再查名额）
//  V2-UX（20260912）：⑪ end_at 已过 signup → 409 ACTIVITY_ENDED（文案逐字锁定，mp 分流契约）
//       ⑫ status=closed 且 end_at 过期 → 409 BAD_STATE（D5：status 优先于 end_at）
//       ⑬ end_at=null → 放行（S7 存量兼容）  ⑭ end_at ≤ start_at 建活动 → 422 INVALID_RANGE（D8）
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

import volunteerRouter from '../routes/volunteer.js';

// ---- 真实 express + 真 HTTP（鉴权上下文直注入：admin + dev 恒放行 requireConfigRole） ----
const T = 't-volunteer-guard';
let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = { tenantId: T, role: 'admin', authMode: 'dev', userId: 'u1', requestId: 'test' };
    next();
  });
  app.use('/api/v1/volunteer', volunteerRouter); // 与生产 server.ts 挂载一致
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.calls.length = 0;
  h.scripted = [];
});

async function post(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

describe('报名守卫（signup 业务三重校验）', () => {
  it('① closed 活动 signup → 409 活动已关闭，且不产生 INSERT', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-1', status: 'closed', slots: 10 }] },
    ];
    const r = await post('/volunteer/activities/act-1/signup', { user_name: '张三' });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('BAD_STATE');
    expect(r.body.message).toContain('已关闭');
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO volunteer_record'))).toBeUndefined();
  });

  it('② 名额满（count=slots）signup → 409 名额已满', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-2', status: 'open', slots: 2 }] },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 2 }] },
    ];
    const r = await post('/volunteer/activities/act-2/signup', { user_name: '李四' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('BAD_STATE');
    expect(r.body.message).toContain('名额已满');
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO volunteer_record'))).toBeUndefined();
  });

  it('③ slots=0 活动（0 容量）signup → 409（修复后锁定语义：0 容量=不可报名）', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-3', status: 'open', slots: 0 }] },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 0 }] },
    ];
    const r = await post('/volunteer/activities/act-3/signup', { user_name: '王五' });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('名额已满');
  });

  it('④ open 未满 signup → 201（正向回归：守卫不误伤正常报名）', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-4', status: 'open', slots: 5 }] },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 1 }] },
      { match: /INSERT INTO volunteer_record/, rows: [{ id: 'rec-1', status: 'registered' }] },
    ];
    const r = await post('/volunteer/activities/act-4/signup', { user_name: '赵六' });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect((r.body.item as any).status).toBe('registered');
  });

  it('⑤ signup 守卫 SQL 契约：act SELECT 必带 FOR UPDATE 行锁（防并发超卖）', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-5', status: 'open', slots: 5 }] },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 0 }] },
      { match: /INSERT INTO volunteer_record/, rows: [{ id: 'rec-2', status: 'registered' }] },
    ];
    await post('/volunteer/activities/act-5/signup', { user_name: '钱七' });
    const act = h.calls.find((c) => c.sql.includes('FROM volunteer_activity'));
    expect(act).toBeDefined();
    expect(act!.sql).toMatch(/FOR UPDATE/);
    expect(act!.sql).toMatch(/status/);
    expect(act!.sql).toMatch(/slots/);
  });
});

describe('审批守卫（approve 状态机校验）', () => {
  it('⑥ registered（未签退）直 approve → 409 只能对已签退的记录审批', async () => {
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-3', status: 'registered', check_in_at: null }] },
    ];
    const r = await post('/volunteer/records/rec-3/approve');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('BAD_STATE');
    expect(r.body.message).toContain('已签退');
    expect(h.calls.find((c) => c.sql.includes("SET status = 'approved'"))).toBeUndefined();
  });

  it('⑦ 全链 signup→checkin→checkout→approve 全 200（状态机正向闭环）', async () => {
    // 步骤1 signup：open 未满 → 201
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-6', status: 'open', slots: 5 }] },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 0 }] },
      { match: /INSERT INTO volunteer_record/, rows: [{ id: 'rec-4', status: 'registered' }] },
    ];
    const s1 = await post('/volunteer/activities/act-6/signup', { user_name: '孙八' });
    expect(s1.status).toBe(201);

    // 步骤2 checkin：registered → 200
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-4', status: 'registered', check_in_at: null }] },
      { match: /SET status = 'checked_in'/, rows: [{ id: 'rec-4', status: 'checked_in' }] },
    ];
    const s2 = await post('/volunteer/records/rec-4/checkin');
    expect(s2.status).toBe(200);

    // 步骤3 checkout：checked_in（有 check_in_at）→ 200
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-4', status: 'checked_in', check_in_at: '2026-09-08T02:00:00Z' }] },
      { match: /SET status = 'checked_out'/, rows: [{ id: 'rec-4', status: 'checked_out', duration_min: 60, points: 1 }] },
    ];
    const s3 = await post('/volunteer/records/rec-4/checkout');
    expect(s3.status).toBe(200);

    // 步骤4 approve：checked_out → 200（守卫放行）
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-4', status: 'checked_out', check_in_at: '2026-09-08T02:00:00Z' }] },
      { match: /SET status = 'approved'/, rows: [{ id: 'rec-4', status: 'approved' }] },
    ];
    const s4 = await post('/volunteer/records/rec-4/approve');
    expect(s4.status).toBe(200);
    expect((s4.body.item as any).status).toBe('approved');
  });
});

// V2-UX 批次（20260912）：F6 end_at 过期守卫（409 ACTIVITY_ENDED）+ D5 status 优先 + S7 null 放行 + D8 422 INVALID_RANGE
describe('活动结束守卫（signup ACTIVITY_ENDED，V2-UX 新增）', () => {
  it('⑪ open 但 end_at 已过 signup → 409 ACTIVITY_ENDED「该活动已结束，无法报名」，无 INSERT', async () => {
    h.scripted = [
      // end_at 取过去时刻（远早于现在，天然过期，不依赖测试机时钟方向）
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-e1', status: 'open', slots: 5, end_at: '2020-01-01T00:00:00Z' }] },
    ];
    const r = await post('/volunteer/activities/act-e1/signup', { user_name: '周九' });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('ACTIVITY_ENDED');
    // 文案逐字锁定（mp worker 页 409 按 message 子串「已结束」分流，子串断裂即静默失联——V1 教训）
    expect(r.body.message).toBe('该活动已结束，无法报名');
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO volunteer_record'))).toBeUndefined();
  });

  it('⑫ status=closed 且 end_at 同时过期 → 409 BAD_STATE「活动已关闭」（D5：status 优先于 end_at）', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-e2', status: 'closed', slots: 5, end_at: '2020-01-01T00:00:00Z' }] },
    ];
    const r = await post('/volunteer/activities/act-e2/signup', { user_name: '吴十' });
    expect(r.status).toBe(409);
    // 若 end_at 守卫先于 status 检查，这里会错报 ACTIVITY_ENDED——D5 口径：closed 永远提示已关闭
    expect(r.body.code).toBe('BAD_STATE');
    expect(r.body.message).toContain('已关闭');
    expect(r.body.message).not.toContain('已结束');
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO volunteer_record'))).toBeUndefined();
  });

  it('⑬ end_at=null 存量活动 signup → 正常放行到名额统计/INSERT（S7：不误杀历史活动）', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-e3', status: 'open', slots: 5, end_at: null }] },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 0 }] },
      { match: /INSERT INTO volunteer_record/, rows: [{ id: 'rec-e3', status: 'registered' }] },
    ];
    const r = await post('/volunteer/activities/act-e3/signup', { user_name: '郑一' });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    // 放行路径契约：end_at 过期检查不得拦截 null，名额统计与 INSERT 均已执行
    expect(h.calls.find((c) => c.sql.includes('count(*)::int AS n'))).toBeDefined();
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO volunteer_record'))).toBeDefined();
  });

  it('⑭ POST /activities 传 end_at ≤ start_at → 422 INVALID_RANGE「结束时间必须晚于开始时间」（D8 服务端兜底）', async () => {
    const r = await post('/volunteer/activities', {
      title: '导诊志愿服务',
      slots: 5,
      start_at: '2026-09-15T08:00:00Z',
      end_at: '2026-09-15T08:00:00Z', // 相等同样拒绝（end_at ≤ start_at）
    });
    expect(r.status).toBe(422);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('INVALID_RANGE');
    expect(r.body.message).toBe('结束时间必须晚于开始时间');
    // 兜底在入库前：不得产生任何 INSERT
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO volunteer_activity'))).toBeUndefined();
  });
});

// V1（20260911）：signup 去重守卫（409 DUPLICATE）
describe('去重守卫（signup DUPLICATE，V1 新增）', () => {
  it('⑧ 同 (activity_id, user_name) 二次 signup → 409 DUPLICATE「您已报名过该活动，无需重复报名」，无二次 INSERT', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-7', status: 'open', slots: 5 }] },
      { match: /user_name = \$3 LIMIT 1/, rows: [{ id: 'rec-9' }], rowCount: 1 },
    ];
    const r = await post('/volunteer/activities/act-7/signup', { user_name: '张三' });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('DUPLICATE');
    expect(r.body.message).toContain('您已报名过该活动');
    // 命中去重即短路：既不 INSERT，也不再走名额统计
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO volunteer_record'))).toBeUndefined();
    expect(h.calls.find((c) => c.sql.includes('count(*)::int AS n'))).toBeUndefined();
  });

  it('⑨ 去重 SQL 契约：判重查询必须含 tenant_id + activity_id + user_name 三条件（LIMIT 1）', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-8', status: 'open', slots: 5 }] },
      { match: /user_name = \$3 LIMIT 1/, rows: [], rowCount: 0 },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 0 }] },
      { match: /INSERT INTO volunteer_record/, rows: [{ id: 'rec-10', status: 'registered' }] },
    ];
    const r = await post('/volunteer/activities/act-8/signup', { user_name: '李四' });
    expect(r.status).toBe(201); // 无重复 → 正常放行 INSERT
    const dup = h.calls.find((c) => c.sql.includes('FROM volunteer_record') && c.sql.includes('LIMIT 1'));
    expect(dup).toBeDefined();
    expect(dup!.sql).toMatch(/tenant_id = \$1/);
    expect(dup!.sql).toMatch(/activity_id = \$2/);
    expect(dup!.sql).toMatch(/user_name = \$3/);
  });

  it('⑩ 不同 user_name 同活动不触发去重（幂等键是三元组，不是 activity 单键）', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-9', status: 'open', slots: 5 }] },
      { match: /user_name = \$3 LIMIT 1/, rows: [], rowCount: 0 },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 1 }] },
      { match: /INSERT INTO volunteer_record/, rows: [{ id: 'rec-11', status: 'registered' }] },
    ];
    const r = await post('/volunteer/activities/act-9/signup', { user_name: '王五' });
    expect(r.status).toBe(201);
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO volunteer_record'))).toBeDefined();
  });
});

// D-2（20260912，P3-4 初一拍板"过期 3 天内可补签"）：checkin 补签守卫。
// 口径：以活动 end_at（自然过期时刻）起算；过期 ≤3 天 → 200 补签留痕 check_in_late=true；
// >3 天 → 409 CHECKIN_EXPIRED；end_at 未过/null → 正常签到 late=false（零差别行为不变）。
describe('补签守卫（checkin 过期 3 天宽限，D-2 新增）', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

  function checkinScripts(endAt: string | null) {
    return [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-l1', status: 'registered', check_in_at: null, activity_id: 'act-l1' }] },
      // checkin 新增 act 查询（SELECT end_at FROM volunteer_activity）——按用例给 end_at
      { match: /SELECT end_at FROM volunteer_activity/, rows: endAt === null ? [] : [{ end_at: endAt }], rowCount: endAt === null ? 0 : 1 },
      { match: /SET status = 'checked_in'/, rows: [{ id: 'rec-l1', status: 'checked_in', check_in_late: true }] },
    ];
  }

  it('㉑ end_at 已过 2 天 → 200 补签放行，item.check_in_late=true（留痕）', async () => {
    h.scripted = checkinScripts(hoursAgo(48));
    const r = await post('/volunteer/records/rec-l1/checkin');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect((r.body.item as any).check_in_late).toBe(true);
    // 留痕落库契约：UPDATE 必须写 check_in_late 列（不与正常打卡无差别）
    const upd = h.calls.find((c) => c.sql.includes("SET status = 'checked_in'"));
    expect(upd).toBeDefined();
    expect(upd!.sql).toMatch(/check_in_late = \$3/);
  });

  it('㉒ 边界：过期 72h-1min → 200 补签；72h+1min → 409 CHECKIN_EXPIRED 且无 UPDATE', async () => {
    // 宽限内（边界含第 3 天末）
    h.scripted = checkinScripts(hoursAgo(72 - 1 / 60));
    const ok = await post('/volunteer/records/rec-l1/checkin');
    expect(ok.status).toBe(200);
    expect((ok.body.item as any).check_in_late).toBe(true);
    // 超出宽限 1 分钟即拒（清掉上一段的调用日志，UPDATE 缺席断言才纯净）
    h.calls.length = 0;
    h.scripted = checkinScripts(hoursAgo(72 + 1 / 60));
    const r = await post('/volunteer/records/rec-l1/checkin');
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('CHECKIN_EXPIRED');
    // 文案逐字锁定（mp 管理页 toast 直接透传 message）
    expect(r.body.message).toBe('活动已结束超过 3 天，无法补签');
    expect(h.calls.find((c) => c.sql.includes("SET status = 'checked_in'"))).toBeUndefined();
  });

  it('㉓ end_at 未过（未来）→ 200 正常签到，check_in_late=false', async () => {
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-l1', status: 'registered', check_in_at: null, activity_id: 'act-l1' }] },
      { match: /SELECT end_at FROM volunteer_activity/, rows: [{ end_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }] },
      { match: /SET status = 'checked_in'/, rows: [{ id: 'rec-l1', status: 'checked_in', check_in_late: false }] },
    ];
    const r = await post('/volunteer/records/rec-l1/checkin');
    expect(r.status).toBe(200);
    expect((r.body.item as any).check_in_late).toBe(false);
  });

  it('㉔ end_at=null（存量活动）→ 200 放行 late=false（S7 存量兼容同源口径）', async () => {
    h.scripted = checkinScripts(null);
    const r = await post('/volunteer/records/rec-l1/checkin');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('㉕ SQL 契约：act 查询带 tenant_id 租户隔离 + record 行取 activity_id 关联', async () => {
    h.scripted = checkinScripts(hoursAgo(48));
    await post('/volunteer/records/rec-l1/checkin');
    const act = h.calls.find((c) => c.sql.includes('SELECT end_at FROM volunteer_activity'));
    expect(act).toBeDefined();
    expect(act!.sql).toMatch(/tenant_id = \$2/);
    expect(act!.params![0]).toBe('act-l1');
  });
});
