/* eslint-disable */
// T303a live-probe：优服家侧 token 三链 + 收单幂等 + 配置驱动 SQL 留痕
// 前置：t303a-pg（postgres:15, 5433）+ youfu server :4300（AUTH_MODE=prod）
const crypto = require('node:crypto');
const { Pool } = require('pg');

const BASE = 'http://127.0.0.1:4300/api/v1';
const WH_SECRET = 't303a-wh-secret';
const SVC_KEY = 't303a-service-key-energy';
const JWT_SECRET = 't303a-jwt-secret';

const out = [];
const log = (k, v) => {
  let s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  // 脱敏：token/签名只留前 12 字符指纹（真验证据不需要完整凭证）
  s = s.replace(/(eyJ[A-Za-z0-9_-]{10})[A-Za-z0-9._-]+/g, '$1...<redacted>');
  out.push(`### ${k}\n${s}\n`);
};

// 与能源平台 dispatchToYoufu 同签名域：`${ts}.${rawBody}`
function signedFetch(path, bodyObj, opts = {}) {
  const raw = JSON.stringify(bodyObj);
  const ts = Date.now() + (opts.tsOffsetMs || 0);
  const sig = crypto.createHmac('sha256', WH_SECRET).update(`${ts}.${raw}`, 'utf8').digest('hex');
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Energy-Timestamp': String(ts), 'X-Energy-Signature': opts.tamper ? 'f'.repeat(64) : sig },
    body: raw,
  });
}

async function main() {
  const taskRef = 't303a-live-' + Date.now();

  // ===== 链1：service_key 签发 =====
  const okEx = await fetch(BASE + '/energy/token-exchange', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service_key: SVC_KEY, worker_id: 'w-elec-001' }),
  });
  const exBody = await okEx.json();
  const token = exBody.token; // 真值供后续链使用（不落盘）
  if (exBody.token) exBody.token = exBody.token.slice(0, 12) + '...<redacted>';
  log('链1-签发 token-exchange（w-elec-001）', { status: okEx.status, body: exBody });

  const tokParts = token.split('.');
  const payload = JSON.parse(Buffer.from(tokParts[1], 'base64url').toString('utf8'));
  log('token payload（worker_ref/tid/exp）', payload);
  log('token 时效（exp-iat 秒）', payload.exp - payload.iat);

  // 过期 token（exp 已过）
  const nowSec = Math.floor(Date.now() / 1000);
  const expiredToken = [tokParts[0], Buffer.from(JSON.stringify({ sub: 'w-elec-001', worker_ref: 'youfu:w-elec-001', scope: 'energy_collection', tid: 't-verification', iat: nowSec - 100, exp: nowSec - 5 })).toString('base64url'), require('node:crypto').createHmac('sha256', JWT_SECRET).update(`${tokParts[0]}.${Buffer.from(JSON.stringify({ sub: 'w-elec-001', worker_ref: 'youfu:w-elec-001', scope: 'energy_collection', tid: 't-verification', iat: nowSec - 100, exp: nowSec - 5 })).toString('base64url')}`).digest('base64url')].join('.');

  // ===== 链2：过期 401 =====
  const rExp = await fetch(BASE + '/energy/tasks?assignee=w-elec-001', { headers: { Authorization: `Bearer ${expiredToken}` } });
  log('链2-过期 token → GET /energy/tasks', { status: rExp.status, body: await rExp.json() });

  // ===== 链3：越权 403 =====
  const rFb = await fetch(BASE + '/energy/tasks?assignee=w-elec-002', { headers: { Authorization: `Bearer ${token}` } });
  log('链3-越权（w-elec-001 查 w-elec-002）', { status: rFb.status, body: await rFb.json() });

  // ===== 收单：篡改签名 401 =====
  const rBad = await signedFetch('/energy/webhook/dispatch', { task_ref: taskRef, site: '资兴市中医医院', title: '用能数据采集-2025 采暖季（真验）', deadline: '2026-09-30', form_url: 'https://energy.example.com/collection/form/t303a' }, { tamper: true });
  log('收单-篡改签名', { status: rBad.status, body: await rBad.json() });

  // ===== 收单：合法 → 201 =====
  const rOk = await signedFetch('/energy/webhook/dispatch', { task_ref: taskRef, site: '资兴市中医医院', title: '用能数据采集-2025 采暖季（真验）', deadline: '2026-09-30', form_url: 'https://energy.example.com/collection/form/t303a' });
  const okBody = await rOk.json();
  log('收单-合法签名 → 201', { status: rOk.status, status_after_dispatch: okBody.item && okBody.item.status, id: okBody.item && okBody.item.id, data: okBody.item && okBody.item.data });

  // ===== 收单：重放 → 200 idempotent =====
  const rRe = await signedFetch('/energy/webhook/dispatch', { task_ref: taskRef, site: '资兴市中医医院', title: '用能数据采集-2025 采暖季（真验）', deadline: '2026-09-30', form_url: 'https://energy.example.com/collection/form/t303a' });
  const reBody = await rRe.json();
  log('收单-task_ref 重放', { status: rRe.status, idempotent_replay: reBody.idempotent_replay, same_id: reBody.item && reBody.item.id === okBody.item.id });

  // ===== 收单：结构化采集字段 → 422 零进 PG =====
  const rPol = await signedFetch('/energy/webhook/dispatch', { task_ref: taskRef + '-polluted', site: '资兴市中医医院', title: '污染尝试', electricity_kwh: 123456, meter_no: 'DB-001' });
  log('收单-结构化采集字段（红线）', { status: rPol.status, body: await rPol.json() });

  // ===== 管理员分配（真验可见性准备）：assignee=w-elec-001（SQL 留痕）=====
  const pool = new Pool({ host: '127.0.0.1', port: 5433, database: 'youfu', user: 'youfu_app', password: 't303a_app' });
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.tenant_id', 't-verification', true)");
  const upd = await c.query("UPDATE business_flow_tasks SET assignee = 'w-elec-001', updated_at = now() WHERE data->>'task_ref' = $1 RETURNING id, assignee, status", [taskRef]);
  log('SQL 留痕-分配 assignee', { rows: upd.rows });

  // ===== 链3 补充：本人 → 200 可见 =====
  const rOk2 = await fetch(BASE + '/energy/tasks?assignee=w-elec-001', { headers: { Authorization: `Bearer ${token}` } });
  const ok2 = await rOk2.json();
  log('本人列表 → 200', { status: rOk2.status, items: (ok2.items || []).map((it) => ({ id: it.id, title: it.title, status: it.status, task_ref: it.data && it.data.task_ref })) });

  // ===== SQL 留痕：workflow_def + business_flow_tasks =====
  const def = await c.query("SELECT tenant_id, entity_type, version, jsonb_array_length(def->'states') AS states, def->'initial' AS initial FROM workflow_def WHERE entity_type='energy_collection'");
  log('SQL 留痕-workflow_def（配置驱动）', def.rows);
  const task = await c.query("SELECT id, tenant_id, entity_type, title, status, location, assignee, created_by, data->>'task_ref' AS task_ref, data->>'form_url' AS form_url, data->>'electricity_kwh' AS electricity_kwh_should_be_null FROM business_flow_tasks WHERE data->>'task_ref' = $1", [taskRef]);
  log('SQL 留痕-business_flow_tasks（任务壳）', task.rows);
  // 领域事件表名以 information_schema 实际为准（事务外查询，避免污染主事务）
  const evtTable = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'domain%'");
  if (evtTable.rows[0]) {
    const ev = await pool.query(`SELECT type, actor, entity_type FROM ${evtTable.rows[0].table_name} WHERE entity_id = $1 ORDER BY created_at LIMIT 5`, [okBody.item.id]).catch(() => null);
    if (ev) log(`SQL 留痕-${evtTable.rows[0].table_name}`, ev.rows);
  }
  await c.query('COMMIT');
  c.release();
  await pool.end();

  require('fs').writeFileSync('D:/energy-platform-work-archive/tmp-t303a-live-out.txt', out.join('\n'), 'utf8');
  console.log('PROBE DONE');
}

main().catch((e) => { console.error('PROBE FAIL', e); process.exit(1); });
