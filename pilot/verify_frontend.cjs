// 前端契约真验（跑在 ECS node16，对 localhost:4001 调真实后端）
// 目的：验证前端 Phase A 改动调用的每个端点在真实后端均按契约返回 2xx 且结构正确。
// 覆盖：login → GET /service-desks → GET /workers → GET /open/claim-hall
//      → POST /open/work_order(带 service_desk+department) → GET /open/work_order/:id(available)
//      → POST /open/work_order/:id/transition(forward 改派选人) → POST /open/work_order/:id/transpond(转台)
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
const uid = () => 'FE' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

(async () => {
  console.log('== 1. 登录(前端 Login.tsx) ==');
  const login = await req('POST', '/auth/login', { username: 'phasea_admin', password: 'phasea888', tenant: TENANT });
  TOKEN = login.json.token || '';
  check('登录拿 token', !!TOKEN, 'role=' + (login.json.user && login.json.user.role));

  console.log('== 2. GET /service-desks（前端下拉） ==');
  const desks = await req('GET', '/service-desks');
  const items = (desks.json && desks.json.items) || [];
  const deskA = items[0] && items[0].id;
  const deskB = items[1] && items[1].id;
  check('服务台接口 200', desks.status === 200, 'n=' + items.length);
  check('至少 2 个服务台', !!deskA && !!deskB, 'A=' + deskA + ' B=' + deskB);

  console.log('== 2b. GET /tenant-info（顶部租户名/服务热线） ==');
  const tenantInfo = await req('GET', '/tenant-info');
  check('租户信息 200', tenantInfo.status === 200);
  check('租户信息含 name', tenantInfo.json && tenantInfo.json.data && typeof tenantInfo.json.data.name === 'string', 'name=' + (tenantInfo.json && tenantInfo.json.data && tenantInfo.json.data.name));
  check('租户信息含 hotline', tenantInfo.json && tenantInfo.json.data && typeof tenantInfo.json.data.hotline === 'string', 'hotline=' + (tenantInfo.json && tenantInfo.json.data && tenantInfo.json.data.hotline));

  console.log('== 3. GET /workers（前端改派/抢单选人） ==');
  const wk = await req('GET', '/workers');
  const workers = (wk.json && wk.json.items) || [];
  const wB = workers.find((w) => w.department === 'B') || workers[0];
  check('工人接口 200', wk.status === 200, 'n=' + workers.length);
  check('工人含 department 字段', workers.every((w) => 'department' in w), 'sample=' + (workers[0] && workers[0].department));

  console.log('== 4. GET /open/claim-hall（前端抢单大厅） ==');
  const hall = await req('GET', '/open/claim-hall');
  check('抢单大厅 200', hall.status === 200, 'n=' + ((hall.json && hall.json.items) || []).length);

  console.log('== 5. POST /open/work_order（Intake 带 service_desk+department，同前端 body） ==');
  const id1 = uid();
  const c1 = await req('POST', '/open/work_order', {
    id: id1, business_type: 'repair', catalog: 'electrician',
    title: '走廊灯不亮', location: '1F', priority: 'normal',
    source: 'backend', skill_tags: ['electric'],
    service_desk: deskA, department: 'A',
  });
  check('建单 200/201', c1.status === 200 || c1.status === 201, 'status=' + c1.status);
  check('建单回传 service_desk', c1.json && c1.json.service_desk === deskA, 'sd=' + (c1.json && c1.json.service_desk));
  check('建单回传 department', c1.json && c1.json.department === 'A', 'dep=' + (c1.json && c1.json.department));
  const status0 = c1.json && c1.json.status;
  check('自动派单→assigned', status0 === 'assigned', 'status=' + status0);

  console.log('== 6. GET /open/work_order/:id（TicketDetail 动态按钮 available） ==');
  const det = await req('GET', '/open/work_order/' + id1);
  const avail = (det.json && det.json.available) || [];
  const events = avail.map((a) => a.event);
  check('详情 200', det.status === 200);
  check('available 含 forward(改派)', events.includes('forward'), 'ev=' + JSON.stringify(events));
  check('available 含 return(退回)', events.includes('return'));
  check('available 含 receive(接单)', events.includes('receive'));

  console.log('== 7. POST transition forward(改派选人)（TicketDetail select worker） ==');
  const fwd = await req('POST', '/open/work_order/' + id1 + '/transition', { to: 'assigned', assignee: wB.id });
  check('改派 200', fwd.status === 200, 'status=' + fwd.status);
  check('改派后 assignee=目标工人', fwd.json && fwd.json.assignee === wB.id, 'assignee=' + (fwd.json && fwd.json.assignee));

  console.log('== 8. POST transpond 转台（TicketDetail 转台按钮） ==');
  const tr = await req('POST', '/open/work_order/' + id1 + '/transpond', { deskId: deskB, reason: '测试转台' });
  check('转台 200', tr.status === 200, 'status=' + tr.status);
  const trTicket = (tr.json && tr.json.ticket) || {};
  check('转台后 service_desk=deskB', trTicket.service_desk === deskB, 'sd=' + trTicket.service_desk);

  console.log('\n== 结果 ==');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本异常', e); process.exit(2); });
