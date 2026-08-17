// Phase A 全链路真验（跑在 ECS，node16，对 localhost:4001 调真实后端）
// 覆盖：建单自动派单+通知 → 转台 → 改派 → 退回 → 处理/挂起/暂停/恢复/挂起 → 审核 → 完成 → 关闭 → 满意度
//      + 无匹配工单落抢单大厅 → 抢单 → 通知表非空断言
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
    const r = http.request(
      { host: BASE, port: PORT, path: '/api/v1' + path, method, headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json;
          try { json = JSON.parse(buf); } catch { json = { raw: buf }; }
          resolve({ status: res.statusCode, json });
        });
      },
    );
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
const uid = () => 'PA' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

(async () => {
  console.log('== 登录 ==');
  const login = await req('POST', '/auth/login', { username: 'phasea_admin', password: 'phasea888', tenant: TENANT });
  TOKEN = login.json.token || '';
  check('登录拿 token', !!TOKEN, 'role=' + (login.json.user && login.json.user.role));

  console.log('== 取服务台 ==');
  const desks = await req('GET', '/service-desks');
  const deskA = desks.json.items && desks.json.items[0] && desks.json.items[0].id;
  const deskB = desks.json.items && desks.json.items[1] && desks.json.items[1].id;
  check('至少 2 个服务台', !!deskA && !!deskB, 'deskA=' + deskA + ' deskB=' + deskB);

  console.log('== 建单(带服务台/部门/技能) → 期望自动派单 ==');
  const id1 = uid();
  const c1 = await req('POST', '/open/work_order', {
    id: id1, business_type: 'electric', catalog: '维修', priority: 'normal',
    title: '走廊灯不亮', location: '1F', contact: '13800000000',
    skill_tags: ['electric'], source: 'phone', fault_type: '照明', service_desk: deskA, department: 'A',
  });
  check('建单 201/200', c1.status === 201 || c1.status === 200, 'status=' + c1.status);
  check('自动派单 auto_flow=true', c1.json.auto_flow === true, 'assignee=' + c1.json.assignee + ' status=' + c1.json.status);
  check('派到本部人员 W-A1', c1.json.assignee === 'W-A1', 'assignee=' + c1.json.assignee);
  check('服务台已写入', c1.json.service_desk === deskA, 'service_desk=' + c1.json.service_desk);

  console.log('== 转台 deskA → deskB ==');
  const tp = await req('POST', '/open/work_order/' + id1 + '/transpond', { deskId: deskB, reason: '跨部门' });
  check('转台 200', tp.status === 200, 'status=' + tp.status);
  check('服务台已变更', tp.json.ticket && tp.json.ticket.service_desk === deskB, 'service_desk=' + (tp.json.ticket && tp.json.ticket.service_desk));

  console.log('== 改派 forward → W-B1 ==');
  const fw = await req('POST', '/open/work_order/' + id1 + '/transition', { to: 'assigned', assignee: 'W-B1' });
  check('改派 200', fw.status === 200, 'status=' + fw.status);
  const d1 = await req('GET', '/open/work_order/' + id1);
  check('assignee=W-B1', d1.json.ticket && d1.json.ticket.assignee_id === 'W-B1', 'assignee=' + (d1.json.ticket && d1.json.ticket.assignee_id));

  console.log('== 退回 return → pending_dispatch ==');
  const rt = await req('POST', '/open/work_order/' + id1 + '/transition', { to: 'pending_dispatch', return_reason: '信息不全' });
  check('退回 200', rt.status === 200, 'status=' + rt.status);
  const d2 = await req('GET', '/open/work_order/' + id1);
  check('状态=pending_dispatch', d2.json.ticket && d2.json.ticket.status === 'pending_dispatch', 'status=' + (d2.json.ticket && d2.json.ticket.status));

  console.log('== 重新派单 dispatch → W-A1 ==');
  const dp = await req('POST', '/open/work_order/' + id1 + '/transition', { to: 'assigned', assignee: 'W-A1' });
  check('派单 200', dp.status === 200, 'status=' + dp.status);

  console.log('== 处理→挂起→恢复→暂停→恢复→审核→完成→关闭→满意度 (全态机) ==');
  const seq = [
    ['processing', null, '处理中'],
    ['paused', null, '挂起'],
    ['processing', null, '恢复'],
    ['suspended', { suspend_reason: '等配件' }, '暂停(挂起)'],
    ['processing', null, '恢复'],
    ['pending_review', null, '提交审核'],
    ['review_passed', null, '审核通过'],
    ['completed', null, '完成'],
    ['closed', { close_reason: '已修复' }, '关闭'],
    ['evaluated', { satisfaction_score: 5, score: 5 }, '满意度评价'],
  ];
  let okSeq = true;
  for (const [to, extra, label] of seq) {
    const body = Object.assign({ to }, extra || {});
    const r = await req('POST', '/open/work_order/' + id1 + '/transition', body);
    if (r.status !== 200) { okSeq = false; console.log('    FAIL 步骤[' + label + '] to=' + to + ' status=' + r.status + ' err=' + JSON.stringify(r.json)); }
  }
  check('全态机流转 10 步全 200', okSeq);
  const d3 = await req('GET', '/open/work_order/' + id1);
  check('最终状态=evaluated', d3.json.ticket && d3.json.ticket.status === 'evaluated', 'status=' + (d3.json.ticket && d3.json.ticket.status));
  check('满意度评分=5', d3.json.ticket && d3.json.ticket.satisfaction_score === 5, 'score=' + (d3.json.ticket && d3.json.ticket.satisfaction_score));

  console.log('== 无匹配工单 → 抢单大厅(claim_hall) ==');
  const id2 = uid();
  const c2 = await req('POST', '/open/work_order', {
    id: id2, business_type: 'rare', catalog: '维修', title: '极冷门技能单',
    skill_tags: ['zzz_no_such_skill'], department: 'A',
  });
  check('无匹配 auto_flow=false', c2.json.auto_flow === false, 'auto_flow=' + c2.json.auto_flow);
  check('落 claim_hall', c2.json.status === 'claim_hall', 'status=' + c2.json.status);
  const hall = await req('GET', '/open/claim-hall');
  const inHall = hall.json.items && hall.json.items.some((it) => it.id === id2);
  check('抢单大厅含该单', inHall, 'hall_total=' + (hall.json.total));

  console.log('== 抢单 claim → W-C1 (跨部门应被拦，这里 woDept=A,worker=C 会被拒；改用同部门 W-A1) ==');
  // 部门不匹配测试：W-C1 部门 C ≠ 工单部门 A → 预期 403
  const claimBad = await req('POST', '/open/work_order/' + id2 + '/claim', { workerId: 'W-C1' });
  check('跨部门抢单被拒(403)', claimBad.status === 403, 'status=' + claimBad.status);
  // 同部门 W-A1 部门 A == 工单部门 A → 预期成功
  const claimOk = await req('POST', '/open/work_order/' + id2 + '/claim', { workerId: 'W-A1' });
  check('同部门抢单成功(200)', claimOk.status === 200, 'status=' + claimOk.status);
  const d4 = await req('GET', '/open/work_order/' + id2);
  check('抢单后状态=assigned', d4.json.ticket && d4.json.ticket.status === 'assigned', 'status=' + (d4.json.ticket && d4.json.ticket.status));

  console.log('== 通知表非空断言(A5) ==');
  const notes = await req('GET', '/open/notifications');
  const types = (notes.json.items || []).map((n) => n.type);
  check('通知条数 > 0', (notes.json.total || 0) > 0, 'total=' + notes.json.total);
  check('含 dispatch 通知', types.includes('dispatch'), 'types=' + JSON.stringify(types));
  check('含 transpond 通知', types.includes('transpond'), 'types=' + JSON.stringify(types));
  check('含 forward 通知', types.includes('forward'), 'types=' + JSON.stringify(types));
  check('含 claim 通知', types.includes('claim'), 'types=' + JSON.stringify(types));

  console.log('== 事件流含 transpond/forward/return ==');
  const ev = await req('GET', '/open/work_order/' + id1 + '/events');
  const evTypes = (ev.json.items || []).map((e) => e.type);
  check('事件流含 transpond', evTypes.includes('transpond'), 'evTypes=' + JSON.stringify(evTypes));
  const hasForward = (ev.json.items || []).some((e) => e.payload && e.payload.transition_event === 'forward');
  check('事件流含 forward(改派)', hasForward);
  check('事件流含 return/enter 退回', evTypes.includes('return') || evTypes.includes('transition'));

  console.log('\n==== 真验结果: PASS=' + pass + '  FAIL=' + fail + ' ====');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('VERIFY_ERROR', e); process.exit(2); });
