// 切片 1 真验（跑在 ECS node16，对 localhost:4001 调真实后端）
// 1) 巡检 UI 后端闭合：GET /inspection/tasks、GET /inspection/tasks/:id(available 含 checkin)、
//    通用 transition 端点驱动 pending→in_progress→done、非法流转 422。
// 2) P1 收尾：reporter_name 顶层列持久化（建单带 reporter_name → 详情读回一致）。
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
const uid = () => 'P1' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

(async () => {
  console.log('== 0. 登录 ==');
  const login = await req('POST', '/auth/login', { username: 'phasea_admin', password: 'phasea888', tenant: TENANT });
  TOKEN = login.json.token || '';
  check('登录拿 token', !!TOKEN, 'role=' + (login.json.user && login.json.user.role));

  console.log('== 1. 巡检列表 ==');
  const list = await req('GET', '/inspection/tasks');
  check('巡检列表 200', list.status === 200, 'n=' + (list.json.items ? list.json.items.length : '?'));

  console.log('== 2. 巡检新建 + 详情 available + 通用 transition 端到端 ==');
  const create = await req('POST', '/inspection/tasks', { title: uid() + '巡检单', type: 'plan' });
  check('巡检新建 201', create.status === 201, 'status=' + (create.json.item && create.json.item.status));
  const id = create.json.item && create.json.item.id;
  check('巡检新建即 pending', create.json.item && create.json.item.status === 'pending');
  if (id) {
    const det = await req('GET', '/inspection/tasks/' + id);
    check('巡检详情 200', det.status === 200);
    const avail = (det.json.item && det.json.item.available) || [];
    check('详情 available 含 checkin（引擎驱动）', avail.some((t) => t.event === 'checkin'), 'n=' + avail.length);

    const c1 = await req('POST', '/inspection/tasks/' + id + '/transition', { event: 'checkin' });
    check('checkin → in_progress', c1.status >= 200 && c1.status < 300 && c1.json.item && c1.json.item.status === 'in_progress', 'status=' + (c1.json.item && c1.json.item.status));

    const c2 = await req('POST', '/inspection/tasks/' + id + '/transition', { event: 'complete', note: '一切正常' });
    check('complete → done', c2.status >= 200 && c2.status < 300 && c2.json.item && c2.json.item.status === 'done', 'status=' + (c2.json.item && c2.json.item.status));

    const bad = await req('POST', '/inspection/tasks/' + id + '/transition', { event: 'checkin' });
    check('终态后再 checkin 非法 422', bad.status === 422, 'got ' + bad.status);
  }

  console.log('== 3. P1 收尾：reporter_name 顶层列持久化 ==');
  const woId = uid();
  const createWo = await req('POST', '/open/work_order', {
    id: woId,
    business_type: 'repair',
    catalog: 'repair-plumbing',
    title: uid() + '报修',
    reporter_name: '张三丰',
    source: 'backend',
  });
  check('建单 201', createWo.status === 201, 'order_no=' + (createWo.json.order_no || createWo.json.id));
  if (createWo.status === 201) {
    const detWo = await req('GET', '/open/work_order/' + woId);
    check('详情读回 reporter_name=张三丰', detWo.json.ticket && detWo.json.ticket.reporter_name === '张三丰', 'got=' + (detWo.json.ticket && detWo.json.ticket.reporter_name));
  }

  console.log(`\n==== 切片1 结果：PASS=${pass}  FAIL=${fail} ====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
