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
  seq: 0,
};

function makeClient() {
  return {
    query: async (text: unknown, params?: unknown[]) => {
      const sql = String(text);
      const p = (params ?? []) as any[];
      if (sql.includes('workflow_def')) {
        if (/SELECT version/i.test(sql)) return { rows: [], rowCount: 0 };
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
          // 列表查询（worker 可见范围 OR 条件）
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
});
