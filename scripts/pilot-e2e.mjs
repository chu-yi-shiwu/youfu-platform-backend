// 试点端到端验收脚本（2026-11-09）
//
// 前置：已执行 seed-pilot-demo.mjs（demo_admin / demo_operator / demo_w1..6）。
// 流程：运营建单 → 规则自动归属 → 自动/人工派单 → 师傅接单/完成 → 管理员关闭/评价
//       → 工作台校验 → 越权校验 → 清理。
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=.env \
//     /opt/node16/bin/node <本脚本路径>
import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import pg from 'pg';

const { Client } = pg;
const BASE = (process.env.PILOT_BASE_URL || 'http://127.0.0.1:4101').replace(/\/+$/, '');
const TENANT = process.env.PILOT_TENANT || 'zixing-hospital';
const PASSWORD = process.env.PILOT_DEMO_PASSWORD || 'Demo123!';
const TAG = 'pilot-e2e';
// 本次 E2E 创建的自动结算草稿（空明细）没有 work_order 反向列，只能按测试时间窗 + created_by 清理。
const TEST_STARTED_AT = new Date(Date.now() - 60_000);

function loadEnv() {
  const f = process.env.ENV_FILE || '.env';
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const db = new Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'youfu_pilot',
  user: process.env.PGUSER || 'youfu_app',
  password: process.env.PGPASSWORD,
});

function request(method, path, body, token) {
  const url = new URL(path, BASE + '/');
  const lib = url.protocol === 'https:' ? https : http;
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': String(data.length) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = {};
          try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
          resolve({ status: res.statusCode || 0, body: json });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log(`  ✅ ${msg}`);
}

async function login(username, channel) {
  const r = await request('POST', '/api/v1/auth/login', {
    username, password: PASSWORD, tenant: TENANT, channel,
  });
  if (r.status !== 200 || !r.body.token) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const workerUser = (workerId) => {
  const m = /^DEMO-W(\d+)$/.exec(workerId || '');
  return m ? `demo_w${Number(m[1])}` : null;
};

async function getTicket(token, id) {
  const r = await request('GET', `/api/v1/open/work_order/${id}`, undefined, token);
  if (r.status !== 200) throw new Error(`get ${id} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.ticket;
}

async function cleanup(id) {
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  for (const table of [
    'ai_conversation', 'ai_shadow_suggestions', 'feedback', 'inventory_log', 'ticket_learn_log',
    'work_acceptance', 'webhook_delivery', 'settlement_item', 'ticket_event', 'notification',
  ]) {
    await db.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND work_order_id::text=$2`, [TENANT, id]);
  }
  await db.query(
    `DELETE FROM settlement WHERE tenant_id=$1 AND created_by='auto:evaluated' AND created_at >= $2`,
    [TENANT, TEST_STARTED_AT],
  );
  await db.query(`DELETE FROM domain_event WHERE tenant_id=$1 AND entity_type='work_order' AND entity_id=$2`, [TENANT, id]);
  await db.query(`DELETE FROM idempotency_key WHERE tenant_id=$1 AND work_order_id=$2`, [TENANT, id]);
  await db.query(`DELETE FROM work_orders WHERE tenant_id=$1 AND id=$2`, [TENANT, id]);
  await db.query('COMMIT');
  await db.end();
}

let E2E_ID = null;

async function main() {
  console.log(`[e2e] base=${BASE} tenant=${TENANT}`);
  const admin = await login('demo_admin', 'pc');
  const operator = await login('demo_operator', 'pc');
  console.log('  ✅ admin / operator 登录');

  // 渠道强校验：运营不能走小程序
  const bad = await request('POST', '/api/v1/auth/login', {
    username: 'demo_operator', password: PASSWORD, tenant: TENANT, channel: 'mp',
  });
  assert(bad.status === 403 && bad.body.code === 'CHANNEL_FORBIDDEN', '运营账号 mp 登录被拒（CHANNEL_FORBIDDEN）');

  const before = await request('GET', '/api/v1/stats/workbench', undefined, admin);
  assert(before.status === 200, '工作台读取成功');
  const beforeSat = Number(before.body.rates?.satisfaction_count || 0);

  const id = crypto.randomUUID();
  E2E_ID = id;
  const create = await request('POST', '/api/v1/open/work_order', {
    id,
    business_type: 'repair',
    title: 'E2E 漏水验证单',
    description: 'E2E 漏水验证单',
    reporter_name: 'E2E',
    priority: 'normal',
    ext: { demo_seed: TAG },
  }, operator);
  assert(create.status === 201 || create.status === 200, `运营建单成功（HTTP ${create.status}）`);
  assert(create.body.department_name === '维修组', `规则自动归属维修组（实际 ${create.body.department_name}）`);
  assert(String(create.body.department_source || '').startsWith('rule:'), `部门来源为规则（${create.body.department_source}）`);

  let ticket = await getTicket(admin, id);
  let assignee = ticket.assignee_id;
  if (!assignee) {
    const fwd = await request('POST', `/api/v1/open/work_order/${id}/transition`, {
      to: 'assigned', assignee: 'DEMO-W001',
    }, admin);
    assert(fwd.status === 200, `自动派单未命中，管理员改派成功（HTTP ${fwd.status}）`);
    ticket = await getTicket(admin, id);
    assignee = ticket.assignee_id;
  }
  assert(!!assignee, `工单已派给师傅（${assignee}）`);
  const workerName = workerUser(assignee);
  assert(!!workerName, `可映射师傅账号（${assignee} → ${workerName}）`);

  const worker = await login(workerName, 'mp');
  const mine = await request('GET', '/api/v1/open/work_order/' + id, undefined, worker);
  assert(mine.status === 200, '师傅可读取本人任务');
  const list = await request('GET', `/api/v1/open/work_orders?assignee=${encodeURIComponent(assignee)}&limit=5`, undefined, worker);
  assert(list.status === 200 && (list.body.items || []).some((x) => x.id === id), '师傅任务列表包含本单');

  // 越权：另一个 demo 师傅看不到本单
  const otherName = ['demo_w1', 'demo_w2', 'demo_w3', 'demo_w4'].find((u) => u !== workerName);
  const other = await login(otherName, 'mp');
  const deny = await request('GET', '/api/v1/open/work_order/' + id, undefined, other);
  assert([403, 404].includes(deny.status), `其他师傅不可见本单（HTTP ${deny.status}）`);

  for (const [to, label] of [['processing', '接单/开始处理'], ['completed', '完成']]) {
    const r = await request('POST', `/api/v1/open/work_order/${id}/transition`, { to }, worker);
    assert(r.status === 200, `师傅${label}（HTTP ${r.status}）`);
  }
  const closed = await request('POST', `/api/v1/open/work_order/${id}/transition`, { to: 'closed', close_reason: 'E2E 验收关闭' }, admin);
  assert(closed.status === 200, `管理员关闭（HTTP ${closed.status}）`);
  const evaluated = await request('POST', `/api/v1/open/work_order/${id}/transition`, { to: 'evaluated', score: 5 }, admin);
  assert(evaluated.status === 200, `管理员评价 5 分（HTTP ${evaluated.status}）`);

  ticket = await getTicket(admin, id);
  assert(ticket.status === 'evaluated', '工单最终状态 evaluated');
  assert(ticket.satisfaction_score === 5, '满意度分数 5');
  assert(ticket.department_name === '维修组', '详情责任部门为维修组');

  const after = await request('GET', '/api/v1/stats/workbench', undefined, admin);
  assert(Number(after.body.rates?.satisfaction_count || 0) === beforeSat + 1, '工作台满意度计数 +1');
  assert(after.body.total === before.body.total + 1, '工作台 total +1');

  await cleanup(id);
  console.log(`[e2e] PASS（工单 ${id} 已清理）`);
}

main().catch(async (e) => {
  console.error('[e2e] FAILED', e.message || e);
  if (E2E_ID) {
    try { await cleanup(E2E_ID); console.error('[e2e] 已清理失败工单', E2E_ID); } catch (ce) { console.error('[e2e] 清理失败', ce.message || ce); }
  }
  process.exit(1);
});
