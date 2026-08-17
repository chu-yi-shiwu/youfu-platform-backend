// P3 横向克隆真验（跑在 ECS node16，对 localhost:4001 调真实后端）
// 验证通用业务流引擎：transport_task 经 workflow_def 引擎端到端流转，
// 且每行附 available（引擎动态动作），非法流转 422。emergency_plan 冒烟一并验证。
const http = require('http');

const BASE = '127.0.0.1';
const PORT = 4001;
const TENANT = 't-phasea';
let TOKEN = '';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    const r = http.request({ host: BASE, port: PORT, path: '/api/v1' + path, method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json; try { json = JSON.parse(buf); } catch { json = { raw: buf }; }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
const uid = () => 'P3' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

async function flowLifecycle(entityType, events) {
  // 新建
  const create = await req('POST', `/flow/${entityType}`, { title: uid() + '流程', data: { item: '标本', from: '住院部', to: '检验科' } });
  check(`[${entityType}] 新建 201`, create.status === 201, 'status=' + (create.json.item && create.json.item.status));
  const id = create.json.item && create.json.item.id;
  if (!id) return;
  const initAvailable = (create.json.item && create.json.item.available) || [];
  check(`[${entityType}] 新建即附 available(动态动作)`, initAvailable.length > 0, 'n=' + initAvailable.length);

  // 列表
  const list = await req('GET', `/flow/${entityType}`);
  check(`[${entityType}] 列表 200`, list.status === 200);
  const inList = (list.json.items || []).find((x) => x.id === id);
  check(`[${entityType}] 列表含新单`, !!inList, 'status=' + (inList && inList.status));

  // 逐事件流转
  let cur = create.json.item;
  for (const ev of events) {
    const payload = { event: ev };
    if (ev === 'dispatch') payload.data = { assignee: 'W-A1' };
    const tr = await req('POST', `/flow/${entityType}/${id}/transition`, payload);
    check(`[${entityType}] 流转 ${ev} → 2xx`, tr.status >= 200 && tr.status < 300, 'status=' + (tr.json.item && tr.json.item.status));
    if (tr.json.item) cur = tr.json.item;
  }

  // 非法流转：终态后再 dispatch 应 422
  const bad = await req('POST', `/flow/${entityType}/${id}/transition`, { event: 'dispatch' });
  check(`[${entityType}] 非法流转 422`, bad.status === 422, 'got ' + bad.status);

  return cur;
}

(async () => {
  console.log('== 0. 登录 ==');
  const login = await req('POST', '/auth/login', { username: 'phasea_admin', password: 'phasea888', tenant: TENANT });
  TOKEN = login.json.token || '';
  check('登录拿 token', !!TOKEN, 'role=' + (login.json.user && login.json.user.role));

  console.log('== 1. transport_task 端到端（运送，经 TRANSPORT_DEF 引擎） ==');
  await flowLifecycle('transport_task', ['dispatch', 'receive', 'complete']);

  console.log('== 2. emergency_plan 冒烟（应急，经 EMERGENCY_DEF 引擎） ==');
  await flowLifecycle('emergency_plan', ['activate', 'process', 'resolve', 'close']);

  console.log(`\n==== P3 结果：PASS=${pass}  FAIL=${fail} ====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
