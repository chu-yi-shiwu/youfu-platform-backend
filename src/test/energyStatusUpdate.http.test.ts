// energyStatusUpdate.http.test.ts —— T303b G4 状态回流 HTTP 测试。
// 覆盖：合法推进 dispatched→submitted（workflow_def 引擎）、同状态重复回调
// 幂等回放 200（不 422）、非法跳转 422、验签失败 401、未知 task_ref 404。
// 模式复用 energyCollection.http.test.ts：vi.mock 池与 eventBus，引擎真跑。
import { describe, it, expect, vi, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.hoisted(() => {
  process.env.JWT_SECRET = 't303b-test-jwt-secret';
  process.env.ENERGY_WEBHOOK_SECRET = 't303b-test-wh-secret';
  process.env.ENERGY_DISPATCH_TENANT = 't-verification';
});

// ---- 内存态业务表（替代 PG），与 energyCollection.http.test.ts 同构 ----
const state = {
  tasks: [] as any[],
  defRow: null as Record<string, unknown> | null,
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
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('business_flow_tasks')) {
        if (/SELECT \* FROM business_flow_tasks WHERE id = \$1/i.test(sql)) {
          const row = state.tasks.find((t) => t.id === p[0] && t.tenant_id === p[1]);
          return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/SELECT \* FROM business_flow_tasks/i.test(sql)) {
          // task_ref 定位（status-update 与 dispatch 幂等共用形态）
          if (sql.includes("data->>'task_ref'")) {
            const row = state.tasks.find(
              (t) => t.tenant_id === p[0] && t.entity_type === p[1] && t.data.task_ref === p[2],
            );
            return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
          }
          const items = state.tasks.filter((t) => t.tenant_id === p[0]);
          return { rows: items, rowCount: items.length };
        }
        if (/INSERT INTO business_flow_tasks/i.test(sql)) {
          state.seq += 1;
          const row = {
            id: `uuid-t303b-${state.seq}`,
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
          // transitionEntity extra 合并：status=$3 之外的 JSON 合并体在末参
          row.status = p[2];
          const mergeJson = p[p.length - 1];
          if (typeof mergeJson === 'string') {
            try {
              row.data = { ...row.data, ...JSON.parse(mergeJson) };
            } catch { /* 无合并体 */ }
          }
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

const WH_SECRET = 't303b-test-wh-secret';

let server: Server;
let url = '';

function signedFetch(path: string, bodyObj: Record<string, unknown>, opts?: { tsOffsetMs?: number; tamper?: boolean; sig?: string }) {
  const raw = JSON.stringify(bodyObj);
  const ts = Date.now() + (opts?.tsOffsetMs ?? 0);
  const sig = opts?.sig ?? (opts?.tamper ? 'a'.repeat(64) : crypto.createHmac('sha256', WH_SECRET).update(`${ts}.${raw}`, 'utf8').digest('hex'));
  return fetch(url + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Energy-Timestamp': String(ts),
      'X-Energy-Signature': sig,
    },
    body: raw,
  });
}

/** 预置一张卡在指定状态的能耗采集任务（data 含 task_ref） */
function seedTask(taskRef: string, status: string) {
  state.seq += 1;
  const row = {
    id: `uuid-seed-${state.seq}`,
    tenant_id: 't-verification',
    entity_type: 'energy_collection',
    title: 'T303b 回流验证任务',
    status,
    data: { task_ref: taskRef, site: '资兴市中医医院', source: 'energy-platform' },
    location: '资兴市中医医院',
    assignee: null,
    created_by: 'energy-webhook',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  state.tasks.push(row);
  return row;
}

const payloadOf = (taskRef: string) => ({
  task_ref: taskRef,
  status: 'submitted',
  submitted_at: new Date().toISOString(),
  record_ref: '42',
});

beforeAll(async () => {
  const app = express();
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/v1', router);
  app.use(errorMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as AddressInfo;
  url = `http://127.0.0.1:${addr.port}`;
});

describe('POST /energy/webhook/status-update —— T303b G4 状态回流', () => {
  it('S01 验签失败链：缺头/篡改签名/超出时间窗 → 一律 401', async () => {
    const anon = await fetch(url + '/api/v1/energy/webhook/status-update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadOf('t303b-s01-ref-0001')),
    });
    expect(anon.status).toBe(401);
    const tampered = await signedFetch('/api/v1/energy/webhook/status-update', payloadOf('t303b-s01-ref-0001'), { tamper: true });
    expect(tampered.status).toBe(401);
    const stale = await signedFetch('/api/v1/energy/webhook/status-update', payloadOf('t303b-s01-ref-0001'), { tsOffsetMs: -10 * 60 * 1000 });
    expect(stale.status).toBe(401);
  });

  it('S02 合法推进：dispatched --submit--> submitted（引擎真跑）+ 溯源字段落 data', async () => {
    const row = seedTask('t303b-s02-ref-0001', 'dispatched');
    const r = await signedFetch('/api/v1/energy/webhook/status-update', payloadOf('t303b-s02-ref-0001'));
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.ok).toBe(true);
    expect(b.idempotent_replay).toBeUndefined();
    expect(b.item.status).toBe('submitted');
    expect(b.item.data.record_ref).toBe('42');
    expect(b.item.data.submitted_by).toBe('energy-platform');
    void row;
  });

  it('S03 同状态重复回调 → 200 idempotent_replay（不 422），状态不再变化', async () => {
    seedTask('t303b-s03-ref-0001', 'submitted');
    const r = await signedFetch('/api/v1/energy/webhook/status-update', payloadOf('t303b-s03-ref-0001'));
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b.idempotent_replay).toBe(true);
    expect(b.item.status).toBe('submitted');
  });

  it('S04 非法跳转 → 422（archived 状态无 submit 边，workflow_def 引擎拒绝）', async () => {
    seedTask('t303b-s04-ref-0001', 'archived');
    const r = await signedFetch('/api/v1/energy/webhook/status-update', payloadOf('t303b-s04-ref-0001'));
    expect(r.status).toBe(422);
    const b = (await r.json()) as any;
    expect(b.code).toBe('BAD_STATE');
  });

  it('S05 未知 task_ref → 404；任务壳多字段（strict）→ 422', async () => {
    const nf = await signedFetch('/api/v1/energy/webhook/status-update', payloadOf('t303b-s05-none-0001'));
    expect(nf.status).toBe(404);
    const polluted = { ...payloadOf('t303b-s02-ref-0001'), electricity_kwh: 1 } as any;
    const r2 = await signedFetch('/api/v1/energy/webhook/status-update', polluted);
    expect(r2.status).toBe(422);
  });
});
