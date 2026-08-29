// 业务流程配置中心 + 巡检接回引擎 真验（node16，localhost:4001）。
// 覆盖：① themes 清单 ② list ③ 下拉生成 inspection_task def ④ 生成后 list 出现
//       ⑤ 巡检 checkin→complete 走引擎（pending→in_progress→done，非硬编码）⑥ 非法流转 422。
const http = require('http');
const BASE = 'http://localhost:4001';

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
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
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, '::', detail ?? ''); }
}

(async () => {
  console.log('== 0. login (phasea admin) ==');
  const login = await req('POST', '/api/v1/auth/login', { username: 'phasea_admin', password: 'phasea888', tenant: 't-phasea' });
  const token = login.json?.token;
  check('登录 200', login.status === 200 && !!token, 'status=' + login.status);

  console.log('== 1. GET /workflow-defs/themes ==');
  const themes = await req('GET', '/api/v1/workflow-defs/themes', null, token);
  const items = themes.json?.items || [];
  check('themes 200', themes.status === 200, 'status=' + themes.status);
  check('5 个业务主题', items.length === 5, 'n=' + items.length);
  check('含 inspection_task 主题', items.some((t) => t.entityType === 'inspection_task'), JSON.stringify(items.map((t) => t.entityType)));

  console.log('== 2. GET /workflow-defs (生成前) ==');
  const before = await req('GET', '/api/v1/workflow-defs', null, token);
  const beforeItems = before.json?.items || [];
  check('list 200', before.status === 200, 'status=' + before.status);
  check('生成前含 work_order', beforeItems.some((i) => i.entityType === 'work_order'), '');
  console.log('  INFO 生成前 inspection_task 是否存在取决于历史运行（非缺陷），仅作快照：' + beforeItems.some((i) => i.entityType === 'inspection_task'));

  console.log('== 3. POST /workflow-defs/generate-from-theme {inspection_task} ==');
  const gen = await req('POST', '/api/v1/workflow-defs/generate-from-theme', { entityType: 'inspection_task' }, token);
  check('生成 200', gen.status === 200, 'status=' + gen.status);

  console.log('== 4. GET /workflow-defs (生成后) ==');
  const after = await req('GET', '/api/v1/workflow-defs', null, token);
  const afterItems = after.json?.items || [];
  check('生成后含 inspection_task', afterItems.some((i) => i.entityType === 'inspection_task'), '');
  const insp = afterItems.find((i) => i.entityType === 'inspection_task');
  check('inspection_task 状态机已落库(>=4态)', insp && insp.stateCount >= 4, JSON.stringify(insp));

  console.log('== 5. 巡检 checkin → complete 走引擎（消除硬编码） ==');
  const mk = await req('POST', '/api/v1/inspection/tasks', { title: '配置中心真验-巡检单' }, token);
  check('建巡检单 201/200', mk.status === 201 || mk.status === 200, 'status=' + mk.status);
  const tid = mk.json?.item?.id || mk.json?.result?.id;
  check('返回 task id', !!tid, 'tid=' + tid);
  const ck = await req('POST', '/api/v1/inspection/tasks/' + tid + '/checkin', {}, token);
  check('checkin 200 (pending→in_progress 经引擎)', ck.status === 200 && ck.json?.item?.status === 'in_progress', 'status=' + ck.status + ' body=' + JSON.stringify(ck.json?.item?.status));
  const cp = await req('POST', '/api/v1/inspection/tasks/' + tid + '/complete', {}, token);
  check('complete 200 (in_progress→done 经引擎)', cp.status === 200 && cp.json?.item?.status === 'done', 'status=' + cp.status + ' body=' + JSON.stringify(cp.json?.item?.status));

  console.log('== 6. 非法流转应 422（引擎校验生效） ==');
  // 新建一个再尝试异常后直接 complete（in_progress→done 合法，但 done→任何 应非法）
  const mk2 = await req('POST', '/api/v1/inspection/tasks', { title: '配置中心真验-异常流转' }, token);
  const tid2 = mk2.json?.item?.id;
  await req('POST', '/api/v1/inspection/tasks/' + tid2 + '/checkin', {}, token);
  await req('POST', '/api/v1/inspection/tasks/' + tid2 + '/complete', {}, token);
  const bad = await req('POST', '/api/v1/inspection/tasks/' + tid2 + '/checkin', {}, token);
  check('done 态再 checkin 非法的 422', bad.status === 422, 'status=' + bad.status);

  console.log('\n=== 结果: PASS=' + pass + ' FAIL=' + fail + ' ===');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('脚本异常', e); process.exit(2); });
