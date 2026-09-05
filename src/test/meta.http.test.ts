// meta.http.test.ts —— #938 展示标签字典公开端点（GET /api/v1/meta/labels）。
// 真·express + 真 HTTP（仿 acceptance.http.test.ts 范式），mock 掉 DB 连接池。
// 覆盖：① 响应形态 { ok, labels:{scope:{key:label}} } + 四 scope 种子抽查
//       ② Cache-Control 短缓存头；③ 无鉴权可访问（测试不挂 auth 即证明）；
//       ④ DB 故障 → 500（前端/mp 有内置兜底，不阻塞展示）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock 掉 DB 连接池（fail 开关供故障用例切换） ----
const h = vi.hoisted(() => ({ fail: false, rows: [] as Array<{ scope: string; key: string; label: string }> }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async () => { throw new Error('[meta.http.test] 单测不使用 withTenantClient'); },
  assertSafeTenantId: (t: string) => t,
  default: {
    query: async () => {
      if (h.fail) throw new Error('[meta.http.test] db down');
      return { rows: h.rows, rowCount: h.rows.length };
    },
  },
}));

import metaRouter from '../routes/meta.js';

// 种子形态对齐 073_label_dict.sql（label_dict SELECT scope,key,label）
const SEED: Array<{ scope: string; key: string; label: string }> = [
  { scope: 'wo_status', key: 'draft', label: '草稿' },
  { scope: 'wo_status', key: 'created', label: '已建单' },
  { scope: 'wo_status', key: 'pending_accept', label: '待受理' },
  { scope: 'wo_status', key: 'pending_dispatch', label: '待派单' },
  { scope: 'wo_status', key: 'assigned', label: '已派单' },
  { scope: 'wo_status', key: 'claim_hall', label: '抢单大厅' },
  { scope: 'wo_status', key: 'processing', label: '处理中' },
  { scope: 'wo_status', key: 'paused', label: '暂停中' },
  { scope: 'wo_status', key: 'suspended', label: '已挂起' },
  { scope: 'wo_status', key: 'pending_review', label: '待审核' },
  { scope: 'wo_status', key: 'review_passed', label: '审核通过' },
  { scope: 'wo_status', key: 'transporting', label: '运送中' },
  { scope: 'wo_status', key: 'accompanying', label: '陪护中' },
  { scope: 'wo_status', key: 'auditing', label: '待审核' },
  { scope: 'wo_status', key: 'review', label: '复核中' },
  { scope: 'wo_status', key: 'completed', label: '已完成' },
  { scope: 'wo_status', key: 'closed', label: '已关闭' },
  { scope: 'wo_status', key: 'cancelled', label: '已撤销' },
  { scope: 'wo_status', key: 'evaluated', label: '已评价' },
  { scope: 'source', key: 'wechat', label: '微信' },
  { scope: 'source', key: 'backend', label: '后台' },
  { scope: 'source', key: 'phone', label: '电话' },
  { scope: 'business_type', key: 'work_order', label: '工单' },
  { scope: 'business_type', key: 'inspection_task', label: '巡检任务' },
  { scope: 'business_type', key: 'transport_task', label: '运送任务' },
  { scope: 'priority', key: 'normal', label: '普通' },
  { scope: 'priority', key: 'urgent', label: '加急' },
  { scope: 'priority', key: 'critical', label: '危急' },
  { scope: 'priority', key: 'low', label: '低' },
];

// ---- 真实 express + 真 HTTP ----
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
  app.use('/api/v1', metaRouter); // 不挂 authMiddleware —— 公开端点语义即「免鉴权可访问」
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function getLabels(): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const r = await fetch(`${baseUrl}/meta/labels`);
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  return { status: r.status, headers: r.headers, body: parsed };
}

describe('GET /api/v1/meta/labels（#938 展示标签字典 · 公开端点）', () => {
  it('DB 故障 → 500 且 ok:false（前端/mp 走内置兜底，不阻塞展示）', async () => {
    h.fail = true;
    const r = await getLabels();
    expect(r.status).toBe(500);
    h.fail = false;
  });

  it('200 形态 { ok, labels } + 四 scope 种子抽查', async () => {
    h.rows = SEED;
    const r = await getLabels();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const labels = r.body.labels as Record<string, Record<string, string>>;
    expect(labels).toBeTruthy();
    // 抽查：wo_status / source / business_type / priority 各命中
    expect(labels.wo_status.draft).toBe('草稿');
    expect(labels.wo_status.pending_dispatch).toBe('待派单');
    expect(labels.wo_status.evaluated).toBe('已评价');
    expect(labels.source.wechat).toBe('微信');
    expect(labels.source.phone).toBe('电话');
    expect(labels.business_type.inspection_task).toBe('巡检任务');
    expect(labels.business_type.transport_task).toBe('运送任务');
    expect(labels.priority.urgent).toBe('加急');
    expect(labels.priority.low).toBe('低');
    // 形态：value 一律 string（标签），不混入其他类型
    for (const scope of Object.keys(labels)) {
      for (const [k, v] of Object.entries(labels[scope])) {
        expect(typeof k).toBe('string');
        expect(typeof v).toBe('string');
      }
    }
  });

  it('Cache-Control 短缓存头（public, max-age=300）', async () => {
    const r = await getLabels();
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('种子弹数覆盖：四 scope 齐全（19+3+3+4=29）', async () => {
    const r = await getLabels();
    const labels = r.body.labels as Record<string, Record<string, string>>;
    expect(Object.keys(labels.wo_status).length).toBe(19);
    expect(Object.keys(labels.source).length).toBe(3);
    expect(Object.keys(labels.business_type).length).toBe(3);
    expect(Object.keys(labels.priority).length).toBe(4);
  });
});
