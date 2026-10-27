// energyCollection.http.test.ts —— T303a 能耗采集收单 HTTP 测试。
// 覆盖：webhook HMAC 验签（缺失/篡改/过期窗口 401）、task_ref 幂等回放、
// z.strict 白名单（结构化采集字段 422 零进 PG）、service_key 换 worker token
//（签发/过期 401/越权 403 三链，prod 语义 verifyJwt）、workflow_def DB 配置优先实证。
// 模式复用 publicAiChat.http.test.ts：vi.mock 池与 eventBus，engine 真跑，express 真 handler。
import { describe, it, expect, vi, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.hoisted(() => {
  process.env.JWT_SECRET = 't303a-test-jwt-secret';
  process.env.ENERGY_WEBHOOK_SECRET = 't303a-test-wh-secret';
  process.env.ENERGY_SERVICE_KEY = 't303a-test-service-key-0123456789';
  process.env.ENERGY_DISPATCH_TENANT = 't-verification';
});

// ---- 内存态业务表 + workflow_def 行（替代 PG）----
const state = {
  tasks: [] as any[],
  defRow: null as Record<string, unknown> | null, // 非 null 时模拟 workflow_def DB 配置
  workerAccounts: {} as Record<string, string>, // T-bridge：account_id → 业务 worker.id（无键=未绑定）
  seq: 0,
};

// T1-B 批3：SQL 调用录制（供「建单把版本号盖进 def_version」这类"写入了什么"的断言取证）。
// 只录不改语义——桩的应答逻辑一行未动。
const queryCalls: Array<{ sql: string; params: any[] }> = [];

function makeClient() {
  return {
    query: async (text: unknown, params?: unknown[]) => {
      const sql = String(text);
      const p = (params ?? []) as any[];
      queryCalls.push({ sql, params: p });
      if (/SELECT id FROM worker WHERE tenant_id = \$1 AND account_id = \$2/i.test(sql)) {
        // T-bridge 桥接反查：worker.account_id → 业务 worker.id
        const wid = state.workerAccounts[p[1]];
        return wid ? { rows: [{ id: wid }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('workflow_def')) {
        // T1-B 批3：版本号桩**必须是非零常量 5**。
        //   此前返回空 ⇒ getWorkflowDefVersion() 得 0；而「建单处硬编码 0 = 从不锁版本」
        //   是最严重的错误实现，断言 params[7] === 0 会一样通过 ⇒ 测试假绿。
        //   真实库里 workflow_def 有行时 version >= 1，故桩给 5（与 t5TransportProxy 同款）。
        //
        //   🔴 且只认真实 entity_type（'energy_collection'）：workflow_def 的 entity_type
        //   是实体名不是表名，传 'business_flow_tasks' 在 prod 里零行 ⇒ 静默 0。
        //   桩不认这个差异的话，"传错实体名"这枚雷就永远炸不到任何断言上。
        if (/SELECT version/i.test(sql)) {
          return p[1] === 'energy_collection'
            ? { rows: [{ version: 5 }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (/SELECT def FROM workflow_def/i.test(sql)) {
          return state.defRow ? { rows: [{ def: state.defRow }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 }; // INSERT/UPDATE def（ensureWorkflowDef 路径）
      }
      if (sql.includes('business_flow_tasks')) {
        if (/SELECT \* FROM business_flow_tasks WHERE id = \$1/i.test(sql)) {
          const row = state.tasks.find((t) => t.id === p[0] && t.tenant_id === p[1]);
          return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/SELECT \* FROM business_flow_tasks/i.test(sql)) {
          // 幂等查询：tenant+entity+data->>'task_ref'（params = [tid, entity, task_ref]）
          if (sql.includes("data->>'task_ref'")) {
            const row = state.tasks.find(
              (t) => t.tenant_id === p[0] && t.entity_type === p[1] && t.data.task_ref === p[2],
            );
            return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
          }
          // 列表查询（worker 可见范围 OR 条件）——P2-1（独立审查 2026-09-11）：mock 忠实模拟
          // 可见范围过滤，参数形态对齐真实 SQL：[tid, worker_ref, workerId, assignee?]
          if (sql.includes("data->>'worker_ref'")) {
            const items = state.tasks.filter(
              (t) =>
                t.tenant_id === p[0] &&
                (t.data?.worker_ref === p[1] || t.assignee === p[2]) &&
                (p.length < 4 || t.assignee === p[3]),
            );
            return { rows: items, rowCount: items.length };
          }
          const items = state.tasks.filter((t) => t.tenant_id === p[0]);
          return { rows: items, rowCount: items.length };
        }
        if (/INSERT INTO business_flow_tasks/i.test(sql)) {
          state.seq += 1;
          const row = {
            id: `uuid-t303a-${state.seq}`,
            tenant_id: p[0],
            entity_type: p[1],
            title: p[2],
            status: p[3],
            data: typeof p[4] === 'string' ? JSON.parse(p[4]) : p[4],
            location: p[5] ?? null,
            assignee: null,
            created_by: p[6] ?? null,
            // T1-B 批3：def_version 是真实列（102 迁移，NOT NULL DEFAULT 0）——桩同步落行，
            // 使后续读点（列表分组 / 详情 / 幂等回放）走的是"已锁定版本"分支，与 prod 同形。
            def_version: Number(p[7]) || 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          state.tasks.push(row);
          return { rows: [row], rowCount: 1 };
        }
        if (/UPDATE business_flow_tasks/i.test(sql)) {
          const row = state.tasks.find((t) => t.id === p[0] && t.tenant_id === p[1]);
          if (!row) return { rows: [], rowCount: 0 };
          // transitionEntity extra={} → SET 仅 status=$3 + updated_at
          row.status = p[2];
          row.updated_at = new Date().toISOString();
          return { rows: [row], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn(makeClient()),
  assertSafeTenantId: (t: string) => t,
}));
vi.mock('../db/eventBus.js', () => ({
  emitDomainEvent: vi.fn(async () => undefined),
}));

import router from '../routes/energyCollection.js';
import { errorMiddleware } from '../middleware/error.js';
import { signJwt } from '../middleware/auth.js';

const WH_SECRET = 't303a-test-wh-secret';
const SVC_KEY = 't303a-test-service-key-0123456789';

let server: Server;
let url = '';

function signedFetch(path: string, bodyObj: Record<string, unknown>, opts?: { tsOffsetMs?: number; tamper?: boolean }) {
  const raw = JSON.stringify(bodyObj);
  const ts = Date.now() + (opts?.tsOffsetMs ?? 0);
  const sig = crypto.createHmac('sha256', WH_SECRET).update(`${ts}.${raw}`, 'utf8').digest('hex');
  return fetch(url + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Energy-Timestamp': String(ts),
      'X-Energy-Signature': opts?.tamper ? 'a'.repeat(64) : sig,
    },
    body: raw,
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/v1', router);
  app.use(errorMiddleware); // 与 server.ts 同一错误映射：ZodError→422 / AppError→status
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  url = `http://127.0.0.1:${addr.port}`;
});

const shell = (taskRef: string) => ({
  task_ref: taskRef,
  site: '资兴市中医医院',
  title: '用能数据采集-2025 采暖季',
  deadline: '2026-09-30',
  form_url: 'https://energy.example.com/collection/form/t303a',
  created_at: new Date().toISOString(),
});

describe('POST /energy/webhook/dispatch —— 收单验签与幂等', () => {
  it('E01 缺签名头/篡改签名/超出时间窗 → 一律 401', async () => {
    // 缺头
    const noSig = await fetch(url + '/api/v1/energy/webhook/dispatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(shell('t-e01-no-sig')),
    });
    expect(noSig.status).toBe(401);
    // 篡改
    const bad = await signedFetch('/api/v1/energy/webhook/dispatch', shell('t-e01-bad-sig'), { tamper: true });
    expect(bad.status).toBe(401);
    // 超窗（-10min）
    const stale = await signedFetch('/api/v1/energy/webhook/dispatch', shell('t-e01-stale'), { tsOffsetMs: -10 * 60 * 1000 });
    expect(stale.status).toBe(401);
    expect(state.tasks.length).toBe(0);
  });

  it('E02 合法收单 → 201，workflow_def 引擎镜像推进 created→dispatched，任务壳落位', async () => {
    const r = await signedFetch('/api/v1/energy/webhook/dispatch', shell('t303a-e02-ref-0001'));
    expect(r.status).toBe(201);
    const b = (await r.json()) as any;
    expect(b.ok).toBe(true);
    expect(b.item.status).toBe('dispatched'); // def.initial='created' --dispatch--> 'dispatched'
    expect(b.item.entity_type).toBe('energy_collection');
    expect(b.item.data.task_ref).toBe('t303a-e02-ref-0001');
    expect(b.item.data.site).toBe('资兴市中医医院');
    expect(b.item.data.source).toBe('energy-platform');
    expect(b.item.data.worker_ref).toBeNull();
    expect(b.item.location).toBe('资兴市中医医院');
  });

  it('E02b T303c-fix：template_code 随壳收单落 data，且 /energy/tasks 原样透传（mp 端 form-session 前分流的依据）', async () => {
    const r = await signedFetch('/api/v1/energy/webhook/dispatch', {
      ...shell('t303c-fix-e02b-ref'),
      template_code: 'M11',
    });
    expect(r.status).toBe(201);
    const b = (await r.json()) as any;
    expect(b.ok).toBe(true);
    expect(b.item.data.template_code).toBe('M11');

    // worker 只读列表透传：data JSONB 原样返回（mp normEn 从 t.data.template_code 取值）
    // P2-1 mock 忠实化后的必然修正：真实可见范围过滤下"派了才可见"（P2-2 裁定），
    // 未派单任务（worker_ref=null 且 assignee=null）对 worker 不可见——先补派单再验透传。
    const trow = state.tasks.find((t) => t.data.task_ref === 't303c-fix-e02b-ref')!;
    trow.assignee = 'w-001';
    const nowSec = Math.floor(Date.now() / 1000);
    const token = signJwt(
      { sub: 'w-001', worker_ref: 'youfu:w-001', scope: 'energy_collection', tid: 't-verification', iat: nowSec, exp: nowSec + 900 },
      't303a-test-jwt-secret',
    );
    const tr = await fetch(url + '/api/v1/energy/tasks?assignee=w-001', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(tr.status).toBe(200);
    const tb = (await tr.json()) as any;
    const hit = (tb.items || []).find((t: any) => t.data && t.data.task_ref === 't303c-fix-e02b-ref');
    expect(hit).toBeTruthy();
    expect(hit.data.template_code).toBe('M11');
  });

  it('E02c T303c-fix 兼容：旧版能源 payload 无 template_code → 照收，落 null（strict 白名单内追加不破坏兼容）', async () => {
    // shell 不含 template_code —— 模拟旧版能源侧派单壳
    const r = await signedFetch('/api/v1/energy/webhook/dispatch', shell('t303c-fix-e02c-ref'));
    expect(r.status).toBe(201);
    const b = (await r.json()) as any;
    expect(b.item.data.template_code).toBeNull();
  });

  it('E02d P2-7（B 方案）：redispatch_of 随壳收单落 data（票据链优服侧可查）；旧版无此字段照收', async () => {
    // 重派壳：新 task_ref + redispatch_of 指向原单
    const r = await signedFetch('/api/v1/energy/webhook/dispatch', {
      ...shell('p2-7-e02d-ref-new'),
      redispatch_of: 't303a-e02-ref-0001',
    });
    expect(r.status).toBe(201);
    const b = (await r.json()) as any;
    expect(b.item.data.redispatch_of).toBe('t303a-e02-ref-0001');
    // 兼容：普通派单（无 redispatch_of）照收，落 null
    const plain = await signedFetch('/api/v1/energy/webhook/dispatch', shell('p2-7-e02d-ref-plain'));
    expect(plain.status).toBe(201);
    expect(((await plain.json()) as any).item.data.redispatch_of).toBeNull();
  });

  it('E03 结构化采集字段 → z.strict 422 拒收，零进 PG（红线硬保证）', async () => {
    const before = state.tasks.length;
    const polluted = { ...shell('t303a-e03-ref-0001'), electricity_kwh: 123456, meter_no: 'DB-001' };
    const r = await signedFetch('/api/v1/energy/webhook/dispatch', polluted);
    expect(r.status).toBe(422);
    expect(state.tasks.length).toBe(before);
  });

  it('E04 task_ref 幂等：重放 → 200 idempotent_replay:true，不重复建单', async () => {
    const before = state.tasks.length;
    const r = await signedFetch('/api/v1/energy/webhook/dispatch', shell('t303a-e02-ref-0001'));
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.idempotent_replay).toBe(true);
    expect(b.item.data.task_ref).toBe('t303a-e02-ref-0001');
    expect(state.tasks.length).toBe(before);
  });
});

describe('POST /energy/token-exchange + worker 只读列表 —— token 三链', () => {
  it('E05 签发链：错 key 401；正确 service_key → token（worker_ref=youfu:{id}，15min）', async () => {
    const bad = await fetch(url + '/api/v1/energy/token-exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_key: 'wrong-key-123456', worker_id: 'w-001' }),
    });
    expect(bad.status).toBe(401);

    const ok = await fetch(url + '/api/v1/energy/token-exchange', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_key: SVC_KEY, worker_id: 'w-001' }),
    });
    expect(ok.status).toBe(200);
    const b = (await ok.json()) as any;
    expect(b.token).toBeTruthy();
    expect(b.expires_in).toBe(900);
    expect(b.worker_ref).toBe('youfu:w-001');
  });

  it('E06 过期链：过期 token → GET /energy/tasks 401（verifyJwt prod 语义）', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = signJwt(
      { sub: 'w-001', worker_ref: 'youfu:w-001', scope: 'energy_collection', tid: 't-verification', iat: nowSec - 1000, exp: nowSec - 10 },
      't303a-test-jwt-secret',
    );
    const r = await fetch(url + '/api/v1/energy/tasks?assignee=w-001', {
      headers: { Authorization: `Bearer ${expired}` },
    });
    expect(r.status).toBe(401);
    // 伪造（错密钥）同样 401
    const forged = signJwt(
      { sub: 'w-001', worker_ref: 'youfu:w-001', scope: 'energy_collection', tid: 't-verification', exp: nowSec + 900 },
      'wrong-secret',
    );
    const r2 = await fetch(url + '/api/v1/energy/tasks', { headers: { Authorization: `Bearer ${forged}` } });
    expect(r2.status).toBe(401);
  });

  it('E07 越权链：assignee≠token 身份 → 403；本人 → 200 只见自己名下任务', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenA = signJwt(
      { sub: 'w-001', worker_ref: 'youfu:w-001', scope: 'energy_collection', tid: 't-verification', iat: nowSec, exp: nowSec + 900 },
      't303a-test-jwt-secret',
    );
    // 越权：A 查 B
    const forbidden = await fetch(url + '/api/v1/energy/tasks?assignee=w-002', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(forbidden.status).toBe(403);
    const fb = (await forbidden.json()) as any;
    expect(fb.code).toBe('ENERGY_FORBIDDEN');
    // 本人：200
    const ok = await fetch(url + '/api/v1/energy/tasks?assignee=w-001', {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(ok.status).toBe(200);
    const okb = (await ok.json()) as any;
    expect(okb.ok).toBe(true);
    expect(Array.isArray(okb.items)).toBe(true);
    // 无 token → 401
    const anon = await fetch(url + '/api/v1/energy/tasks');
    expect(anon.status).toBe(401);
  });

  it('E08 配置驱动实证：workflow_def DB 行优先于内置兜底（收单后落自定义目标态）', async () => {
    state.defRow = {
      initial: 'created',
      states: ['created', 'auto_accepted', 'archived'],
      transitions: [{ from: 'created', to: 'auto_accepted', event: 'dispatch' }],
      config: { doneStates: ['archived'] },
    };
    try {
      const r = await signedFetch('/api/v1/energy/webhook/dispatch', shell('t303a-e08-ref-0001'));
      expect(r.status).toBe(201);
      const b = (await r.json()) as any;
      expect(b.item.status).toBe('auto_accepted'); // DB 配置的目标态，非内置 'dispatched'
    } finally {
      state.defRow = null;
    }
  });

  // ---- T-bridge（2026-09-11）：账号 JWT 桥接第四源（修复 mp 401→全局登出循环）----

  it('E09 T-bridge：账号 JWT（operator+工人档案）→ 200 第四源可见，列表+详情双通', async () => {
    const r = await signedFetch('/api/v1/energy/webhook/dispatch', shell('t-bridge-e09-ref'));
    expect(r.status).toBe(201);
    const row = state.tasks.find((t) => t.data.task_ref === 't-bridge-e09-ref')!;
    row.assignee = 'w-chuyi'; // 任务挂业务 worker.id 名下
    state.workerAccounts['acc-chuyi'] = 'w-chuyi'; // 档案：account_id → worker.id

    const nowSec = Math.floor(Date.now() / 1000);
    const accToken = signJwt(
      { sub: 'acc-chuyi', tid: 't-verification', role: 'operator', username: 'chuyi_ops', iat: nowSec, exp: nowSec + 3600 },
      't303a-test-jwt-secret',
    );
    const res = await fetch(url + '/api/v1/energy/tasks', { headers: { Authorization: `Bearer ${accToken}` } });
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    const hit = (b.items || []).find((t: any) => t.data && t.data.task_ref === 't-bridge-e09-ref');
    expect(hit).toBeTruthy();
    // 详情同样走桥接身份
    const d = await fetch(url + `/api/v1/energy/tasks/${hit.id}`, { headers: { Authorization: `Bearer ${accToken}` } });
    expect(d.status).toBe(200);
    const db2 = (await d.json()) as any;
    expect(db2.item.data.task_ref).toBe('t-bridge-e09-ref');
  });

  it('E09b T-bridge：账号 JWT 无工人档案 → 403（非 401，杜绝 mp 全局登出）', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const accToken = signJwt(
      { sub: 'acc-noworker', tid: 't-verification', role: 'operator', username: 'no_worker', iat: nowSec, exp: nowSec + 3600 },
      't303a-test-jwt-secret',
    );
    const res = await fetch(url + '/api/v1/energy/tasks', { headers: { Authorization: `Bearer ${accToken}` } });
    expect(res.status).toBe(403);
    const b = (await res.json()) as any;
    expect(b.code).toBe('ENERGY_FORBIDDEN');
  });

  it('E09c T-bridge 回归：admin 账号 JWT 仍 401 不放大面；worker token 机器链不受影响', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const adminToken = signJwt(
      { sub: 'acc-admin', tid: 't-verification', role: 'admin', username: 'admin', iat: nowSec, exp: nowSec + 3600 },
      't303a-test-jwt-secret',
    );
    const res = await fetch(url + '/api/v1/energy/tasks', { headers: { Authorization: `Bearer ${adminToken}` } });
    expect(res.status).toBe(401);
    const wt = signJwt(
      { sub: 'w-001', worker_ref: 'youfu:w-001', scope: 'energy_collection', tid: 't-verification', iat: nowSec, exp: nowSec + 900 },
      't303a-test-jwt-secret',
    );
    const res2 = await fetch(url + '/api/v1/energy/tasks', { headers: { Authorization: `Bearer ${wt}` } });
    expect(res2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// T1-B 批3 · energy_collection 在途单锁版本
// 依据：business_flow_tasks.def_version（102 迁移，NOT NULL DEFAULT 0）记录建单当时的
// workflow_def.version，使后续对 live def 的编辑无法把在途单卡死或带偏。
// 本块三条：①建单盖章（版本号真的被写进去了，且是读出来的 live 版本而非硬编码 0）；
// ②四个读点全部版本化、列表走分组；③实体名是 energy_collection 而不是表名。
// ---------------------------------------------------------------------------
const ENERGY_SRC = readFileSync(join(__dirname, '..', 'routes', 'energyCollection.ts'), 'utf8');

/** 子串出现次数（静态读点计数用；比正则更不容易被元字符骗过）。 */
function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

describe('T1-B 批3 · energy_collection 在途单锁版本', () => {
  it('A4-盖章：dispatch 建单把当时的 live 版本号盖进 def_version', async () => {
    queryCalls.length = 0;
    // 与 E08 同款驱动：signedFetch + shell()（HMAC 签名域 `${ts}.${raw}`，body 形状不另造）。
    const r = await signedFetch('/api/v1/energy/webhook/dispatch', shell('t1b-b3-stamp-ref-0001'));
    expect(r.status).toBe(201);
    const b = (await r.json()) as any;
    expect(b.ok).toBe(true);

    // 取证：本次请求发出的 INSERT INTO business_flow_tasks
    const insert = queryCalls.filter((c) => /INSERT INTO business_flow_tasks/i.test(c.sql)).pop();
    expect(insert).toBeTruthy();
    // ① 参数数组长度 8 —— 建单语句比原来多带一个 def_version（$8）
    expect(insert!.params.length).toBe(8);
    // ② params[7] 是版本号，且等于桩里 workflow_def 的 live version（5）。
    //    🔴 断言 5 而不是 0：若产品代码硬编码 0（=从不锁版本），这里必然红。
    expect(insert!.params[7]).toBe(5);
    // ③ 列清单以 def_version 收尾（与 $8 对位，防"加了参数没加列"的错位写）
    expect(insert!.sql).toMatch(/created_by,\s*def_version\)/);
    // 落行结果同样带着这个版本号（RETURNING * 在 prod 里就是这行）
    expect(b.item.def_version).toBe(5);
  });

  it('A3-静态：四个读点都走版本化 def，列表走分组', () => {
    // 四个单点读：:113 dispatch 幂等回放 / :122 建单定初始态 / :323 详情 / :390 status-update 回放
    expect(countOf(ENERGY_SRC, 'getWorkflowDefAtVersion(client, tenantId, ENTITY')).toBe(4);
    // 列表一个批量读（N 行可能锁不同版本 ⇒ 按 def_version 分组，几个版本查几次）
    expect(countOf(ENERGY_SRC, 'getDefsForVersions(client, tenantId, ENTITY')).toBe(1);
    // 盖章只发生在建单这一处（先取版本号，再取该版本的 def）
    expect(countOf(ENERGY_SRC, 'getWorkflowDefVersion(client, tenantId, ENTITY)')).toBe(1);
  });

  it('A4-实体名：版本号不是按表名取的（传成表名会永远返回 0 且一声不响）', () => {
    // 表是 business_flow_tasks，workflow_def 的 entity_type 却是 'energy_collection'（常量 ENTITY）。
    // 传表名 ⇒ SELECT version ... WHERE entity_type='business_flow_tasks' 永远零行 ⇒ 静默返回 0
    // ⇒ 每行都"未记录"，锁版本整套机制形同虚设且不报错。故这里钉死传参是 ENTITY。
    expect(ENERGY_SRC).toContain('getWorkflowDefVersion(client, tenantId, ENTITY)');
    expect(ENERGY_SRC).not.toContain("getWorkflowDefVersion(client, tenantId, 'business_flow_tasks')");
  });
});
