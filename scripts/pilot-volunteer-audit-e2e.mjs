// 志愿者模块功能审计（隔离租户）
// 目标：验证已实现闭环，并探测关键能力是否缺失（编辑/删除/详情/取消报名/导出/签到时间窗）。
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { signJwt } from '../dist/middleware/auth.js';

const { Client } = pg;
const BASE = 'http://127.0.0.1:4101/api/v1';
const UPLOAD_ROOT = '/opt/youfu/pilot/uploads';
const RUN = `vol${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TENANT = `uat-vol-${RUN}`;
const PASS = 'Vol!2026';

function loadEnv() {
  for (const f of ['.env', '/opt/youfu/pilot/initial-credentials.txt']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const db = new Client({
  host: process.env.PGHOST || '127.0.0.1', port: 5432, database: process.env.PGDATABASE || 'youfu_pilot',
  user: process.env.PGUSER || 'youfu_app', password: process.env.PGPASSWORD,
});
function hash(p) { const s = crypto.randomBytes(16); return `scrypt$${s.toString('hex')}$${crypto.scryptSync(p, s, 64).toString('hex')}`; }
function request(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(p.startsWith('http') ? p : BASE + p);
    const r = http.request(u, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };
const results = [];
function record(name, status, note) { results.push({ name, status, note }); console.log(`[vol-audit] ${status} ${name}${note ? ' — ' + note : ''}`); }

async function sql(q, params = []) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const r = await db.query(q, params);
  await db.query('COMMIT');
  return r;
}

async function cleanup() {
  const sql = `BEGIN; SET LOCAL session_replication_role = replica;
DO $$ DECLARE r record; BEGIN
FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'
LOOP EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${TENANT}'; END LOOP; END $$; COMMIT;`;
  try { execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' }); } catch (e) { console.error('cleanup', e.message); }
  rmSync(path.join(UPLOAD_ROOT, TENANT), { recursive: true, force: true });
}

async function main() {
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,'VOL UAT','active')`, [TENANT]);
  const admin = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,'vol_admin',$2,'志愿者管理员','admin',true) RETURNING id`, [TENANT, hash(PASS)]);
  const wa = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,'vol_worker',$2,'测试师傅','worker',true) RETURNING id`, [TENANT, hash(PASS)]);
  await db.query(`INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id) VALUES ($1,$2,'测试师傅','{}'::text[],0,true,$3)`, [`VW-${RUN}`, TENANT, wa.rows[0].id]);
  const wb = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,'vol_worker2',$2,'测试师傅2','worker',true) RETURNING id`, [TENANT, hash(PASS)]);
  await db.query(`INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id) VALUES ($1,$2,'测试师傅2','{}'::text[],0,true,$3)`, [`VW2-${RUN}`, TENANT, wb.rows[0].id]);
  await db.query('COMMIT');
  const now = Math.floor(Date.now() / 1000);
  const adminToken = signJwt({ sub: admin.rows[0].id, tid: TENANT, role: 'admin', username: 'vol_admin', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);
  const workerToken = signJwt({ sub: wa.rows[0].id, tid: TENANT, role: 'worker', username: 'vol_worker', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);
  const worker2Token = signJwt({ sub: wb.rows[0].id, tid: TENANT, role: 'worker', username: 'vol_worker2', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);

  const start = new Date(Date.now() + 3600e3).toISOString();
  const end = new Date(Date.now() + 7200e3).toISOString();
  const create = await request('POST', '/volunteer/activities', { title: '审计活动', batch: 'B1', location: '门诊', start_at: start, end_at: end, slots: 2 }, adminToken);
  assert(create.status === 201, `建活动 ${create.status}`);
  const aid = create.body.item.id;
  record('创建活动', 'PASS', `slots=2, id=${aid.slice(0, 8)}`);

  // 关键能力探测
  const detail = await request('GET', `/volunteer/activities/${aid}`, undefined, adminToken);
  record('活动详情接口 GET /activities/:id', detail.status >= 200 && detail.status < 300 ? 'PASS' : 'MISSING', `HTTP ${detail.status}`);
  const edit = await request('PUT', `/volunteer/activities/${aid}`, { title: '审计活动-改' }, adminToken);
  record('编辑活动 PUT /activities/:id', edit.status >= 200 && edit.status < 300 ? 'PASS' : 'MISSING', `HTTP ${edit.status}`);
  const exp = await request('GET', `/volunteer/activities/${aid}/export`, undefined, adminToken);
  record('报名名单导出', exp.status >= 200 && exp.status < 300 ? 'PASS' : 'MISSING', `HTTP ${exp.status}`);

  // 报名闭环
  const s1 = await request('POST', `/volunteer/activities/${aid}/signup`, { user_name: '测试师傅' }, workerToken);
  assert(s1.status === 201, `报名 ${s1.status}`);
  const dup = await request('POST', `/volunteer/activities/${aid}/signup`, { user_name: '测试师傅' }, workerToken);
  assert(dup.status === 409, `重复报名 ${dup.status}`);
  const s2 = await request('POST', `/volunteer/activities/${aid}/signup`, { user_name: '志愿者B' }, adminToken);
  assert(s2.status === 201, `第二人报名 ${s2.status}`);
  const full = await request('POST', `/volunteer/activities/${aid}/signup`, { user_name: '志愿者C' }, adminToken);
  assert(full.status === 409, `满员 ${full.status}`);
  record('报名 / 重复 / 满员', 'PASS', '201 / 409 / 409');

  const my = await request('GET', '/volunteer/my-records', undefined, workerToken);
  assert(my.status === 200 && my.body.items.length === 1, 'my-records');
  const recId = my.body.items[0].id;
  record('我的报名记录', 'PASS', `status=${my.body.items[0].status}`);

  const recs = await request('GET', `/volunteer/activities/${aid}/records`, undefined, adminToken);
  const otherRec = (recs.body.items || []).find((x) => x.user_name === '志愿者B');
  const cancel = otherRec
    ? await request('DELETE', `/volunteer/records/${otherRec.id}`, undefined, adminToken)
    : { status: 0, body: {} };
  record('管理员取消报名', cancel.status >= 200 && cancel.status < 300 ? 'PASS' : 'MISSING', `HTTP ${cancel.status}`);

  // 签到时间窗探测：活动开始前 3 小时签到应 409（窗口=开始前2小时）
  const far = await request('POST', '/volunteer/activities', {
    title: '未开窗活动',
    start_at: new Date(Date.now() + 3 * 3600e3).toISOString(),
    end_at: new Date(Date.now() + 4 * 3600e3).toISOString(),
    slots: 1,
  }, adminToken);
  assert(far.status === 201, `建未开窗活动 ${far.status}`);
  await request('POST', `/volunteer/activities/${far.body.item.id}/signup`, { user_name: '测试师傅' }, workerToken);
  const farMy = await request('GET', '/volunteer/my-records', undefined, workerToken);
  const farRec = (farMy.body.items || []).find((x) => x.activity_id === far.body.item.id);
  const early = farRec ? await request('POST', `/volunteer/records/${farRec.id}/checkin`, {}, adminToken) : { status: 0 };
  record('活动开始前 3 小时签到', early.status === 409 ? 'PASS' : `HTTP ${early.status}`, '窗口=开始前2小时');

  // 漏洞回归（2026-11-14）：本人直接点签到必须 403，只能扫码（管理员可代签）。
  const directSelf = await request('POST', `/volunteer/records/${recId}/checkin`, {}, workerToken);
  record(
    'worker 直接点签到 403 SCAN_REQUIRED',
    directSelf.status === 403 && directSelf.body.code === 'SCAN_REQUIRED' ? 'PASS' : `HTTP ${directSelf.status} code=${directSelf.body.code}`,
    '只能扫码签到',
  );

  // 签到时间窗探测：主活动开始前 1 小时，处于开窗范围（管理员现场代签）
  const earlyMain = await request('POST', `/volunteer/records/${recId}/checkin`, {}, adminToken);
  record('活动开始前 1 小时签到', earlyMain.status === 200 ? 'PASS' : `HTTP ${earlyMain.status}`, earlyMain.status === 200 ? '处于开窗范围' : '');
  assert(earlyMain.status === 200, `管理员代签 ${earlyMain.status}`);
  const checkout = await request('POST', `/volunteer/records/${recId}/checkout`, {}, workerToken);
  assert(checkout.status === 200, `签退 ${checkout.status}`);
  const approve = await request('POST', `/volunteer/records/${recId}/approve`, {}, adminToken);
  assert(approve.status === 200, `核销 ${approve.status}`);
  record('签到 / 签退 / 核销', 'PASS', `duration=${checkout.body.item?.duration_min ?? 0}min`);

  // 关闭 / 重开
  const close = await request('PUT', `/volunteer/activities/${aid}/status`, { status: 'closed' }, adminToken);
  assert(close.status === 200, `关闭 ${close.status}`);
  const closedSignup = await request('POST', `/volunteer/activities/${aid}/signup`, { user_name: '志愿者D' }, adminToken);
  assert(closedSignup.status === 409, `关闭后报名 ${closedSignup.status}`);
  const reopen = await request('PUT', `/volunteer/activities/${aid}/status`, { status: 'open' }, adminToken);
  assert(reopen.status === 200, `重开 ${reopen.status}`);
  record('结束 / 重开活动', 'PASS', '关闭后报名 409');

  const delBusy = await request('DELETE', `/volunteer/activities/${aid}`, undefined, adminToken);
  record('删除有报名活动', delBusy.status === 409 ? 'PASS' : `HTTP ${delBusy.status}`, '有报名应 409');
  const empty = await request('POST', '/volunteer/activities', { title: '空活动待删', slots: 1 }, adminToken);
  assert(empty.status === 201, `建空活动 ${empty.status}`);
  const delEmpty = await request('DELETE', `/volunteer/activities/${empty.body.item.id}`, undefined, adminToken);
  record('删除无报名活动', delEmpty.status === 200 ? 'PASS' : `HTTP ${delEmpty.status}`, '无报名应 200');

  // 已过期活动
  const endedCreate = await request('POST', '/volunteer/activities', {
    title: '已结束活动', start_at: new Date(Date.now() - 7200e3).toISOString(), end_at: new Date(Date.now() - 3600e3).toISOString(), slots: 2,
  }, adminToken);
  assert(endedCreate.status === 201, `建已结束活动 ${endedCreate.status}`);
  const endedSignup = await request('POST', `/volunteer/activities/${endedCreate.body.item.id}/signup`, { user_name: '志愿者E' }, adminToken);
  assert(endedSignup.status === 409, `已结束报名 ${endedSignup.status}`);
  const list = await request('GET', '/volunteer/activities', undefined, adminToken);
  const endedRow = (list.body.items || []).find((x) => x.id === endedCreate.body.item.id);
  record('过期活动状态', endedRow?.effective_status === 'ended' ? 'PASS' : 'GAP', `effective_status=${endedRow?.effective_status}`);

  // ===== 增强项验证 =====
  // 1) 黑名单
  const bl = await request('POST', '/volunteer/blacklist', { user_name: '黑名单志愿者', reason: '审计' }, adminToken);
  assert(bl.status === 200, `加黑名单 ${bl.status}`);
  const blAct = await request('POST', '/volunteer/activities', { title: '黑名单活动', slots: 1 }, adminToken);
  const blSignup = await request('POST', `/volunteer/activities/${blAct.body.item.id}/signup`, { user_name: '黑名单志愿者' }, adminToken);
  record('黑名单报名拦截', blSignup.status === 403 ? 'PASS' : `HTTP ${blSignup.status}`, blSignup.body?.code || '');
  await request('DELETE', `/volunteer/blacklist/${bl.body.item.id}`, undefined, adminToken);

  // 2) 签到码 + 扫码签到 + 积分规则
  const codeAct = await request('POST', '/volunteer/activities', {
    title: '签到码活动', start_at: new Date(Date.now() + 3600e3).toISOString(), end_at: new Date(Date.now() + 7200e3).toISOString(), slots: 1,
  }, adminToken);
  assert(codeAct.status === 201, `建签到码活动 ${codeAct.status}`);
  const codeAid = codeAct.body.item.id;
  const codeDetail = await request('GET', `/volunteer/activities/${codeAid}`, undefined, adminToken);
  const code = codeDetail.body.item?.checkin_code;
  assert(!!code, '活动应生成签到码');
  await request('POST', `/volunteer/activities/${codeAid}/signup`, { user_name: '测试师傅' }, workerToken);
  const byCode = await request('POST', '/volunteer/checkin-by-code', { code }, workerToken);
  record('扫码签到', byCode.status === 200 ? 'PASS' : `HTTP ${byCode.status}`, `code=${code}`);

  await request('PUT', '/volunteer/points-rule', { points_per_hour: 2 }, adminToken);
  const rule = await request('GET', '/volunteer/points-rule', undefined, adminToken);
  assert(Number(rule.body.points_per_hour) === 2, '积分规则应=2');
  const codeRecs = await request('GET', `/volunteer/activities/${codeAid}/records`, undefined, adminToken);
  const codeRec = (codeRecs.body.items || [])[0];
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`UPDATE volunteer_record SET check_in_at = now() - interval '2 hours' WHERE id=$1 AND tenant_id=$2`, [codeRec.id, TENANT]);
  await db.query('COMMIT');
  const checkout2 = await request('POST', `/volunteer/records/${codeRec.id}/checkout`, {}, workerToken);
  record('积分规则生效', checkout2.status === 200 && Number(checkout2.body.item?.points) === 4 ? 'PASS' : 'GAP', `points=${checkout2.body.item?.points}`);

  // 3) 取消报名截止
  const cancelAct = await request('POST', '/volunteer/activities', {
    title: '取消截止活动', start_at: new Date(Date.now() + 7200e3).toISOString(), end_at: new Date(Date.now() + 10800e3).toISOString(),
    cancel_deadline: new Date(Date.now() - 3600e3).toISOString(), slots: 1,
  }, adminToken);
  await request('POST', `/volunteer/activities/${cancelAct.body.item.id}/signup`, { user_name: '测试师傅' }, workerToken);
  const cancelRecs = await request('GET', `/volunteer/activities/${cancelAct.body.item.id}/records`, undefined, adminToken);
  const cancelRec = (cancelRecs.body.items || [])[0];
  const cancelLate = await request('DELETE', `/volunteer/records/${cancelRec.id}`, undefined, workerToken);
  record('取消报名截止', cancelLate.status === 409 ? 'PASS' : `HTTP ${cancelLate.status}`, cancelLate.body?.code || '');

  // 4) 活动变更通知
  await request('PUT', `/volunteer/activities/${codeAid}`, { title: '签到码活动-已变更' }, adminToken);
  const notes = await request('GET', `/open/notifications?recipient=${encodeURIComponent(`VW-${RUN}`)}`, undefined, workerToken);
  const hit = (notes.body.items || []).some((x) => x.title === '志愿活动变更通知');
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const noteCount = await db.query(`SELECT count(*)::int c, min(channel) ch FROM notification WHERE tenant_id=$1 AND recipient=$2`, [TENANT, `VW-${RUN}`]);
  await db.query('COMMIT');
  record('活动变更通知', hit ? 'PASS' : 'GAP', `list=${(notes.body.items || []).length}, db=${noteCount.rows[0].c}, channel=${noteCount.rows[0].ch}`);


  // ===== 全面回归（方案 V-*） =====
  // 校验
  const missTitle = await request('POST', '/volunteer/activities', { title: '', slots: 1 }, adminToken);
  record('缺标题 422', missTitle.status === 422 ? 'PASS' : `HTTP ${missTitle.status}`);
  const badRange = await request('POST', '/volunteer/activities', { title: '坏时间', start_at: new Date(Date.now() + 7200e3).toISOString(), end_at: new Date(Date.now() + 3600e3).toISOString(), slots: 1 }, adminToken);
  record('活动起止非法 422', badRange.status === 422 ? 'PASS' : `HTTP ${badRange.status}`);
  const badDeadline = await request('POST', '/volunteer/activities', { title: '坏截止', end_at: new Date(Date.now() + 7200e3).toISOString(), signup_deadline: new Date(Date.now() + 10800e3).toISOString(), slots: 1 }, adminToken);
  record('报名截止晚于结束 422', badDeadline.status === 422 ? 'PASS' : `HTTP ${badDeadline.status}`);

  // 权限
  const wCreate = await request('POST', '/volunteer/activities', { title: 'worker建活动', slots: 1 }, workerToken);
  record('worker 建活动 403', wCreate.status === 403 ? 'PASS' : `HTTP ${wCreate.status}`);
  const wBlack = await request('GET', '/volunteer/blacklist', undefined, workerToken);
  record('worker 读黑名单 403', wBlack.status === 403 ? 'PASS' : `HTTP ${wBlack.status}`);

  // 签到码唯一
  const code1 = await request('POST', '/volunteer/activities', { title: '码活动1', slots: 1 }, adminToken);
  const code2 = await request('POST', '/volunteer/activities', { title: '码活动2', slots: 1 }, adminToken);
  const d1 = await request('GET', `/volunteer/activities/${code1.body.item.id}`, undefined, adminToken);
  const d2 = await request('GET', `/volunteer/activities/${code2.body.item.id}`, undefined, adminToken);
  record('签到码唯一', d1.body.item.checkin_code && d2.body.item.checkin_code && d1.body.item.checkin_code !== d2.body.item.checkin_code ? 'PASS' : 'GAP');

  // 取消报名：权限 / 状态 / 重新报名
  const cAct = await request('POST', '/volunteer/activities', { title: '取消测试', start_at: new Date(Date.now() + 3600e3).toISOString(), end_at: new Date(Date.now() + 7200e3).toISOString(), slots: 2 }, adminToken);
  const cAid = cAct.body.item.id;
  await request('POST', `/volunteer/activities/${cAid}/signup`, { user_name: '测试师傅' }, workerToken);
  await request('POST', `/volunteer/activities/${cAid}/signup`, { user_name: '志愿者X' }, adminToken);
  const cRecs = await request('GET', `/volunteer/activities/${cAid}/records`, undefined, adminToken);
  const cWorkerRec = (cRecs.body.items || []).find((x) => x.user_name === '测试师傅');
  const cOtherRec = (cRecs.body.items || []).find((x) => x.user_name === '志愿者X');
  const w2Cancel = await request('DELETE', `/volunteer/records/${cWorkerRec.id}`, undefined, worker2Token);
  record('非本人取消 403', w2Cancel.status === 403 ? 'PASS' : `HTTP ${w2Cancel.status}`);
  await request('POST', `/volunteer/records/${cWorkerRec.id}/checkin`, {}, adminToken);
  const lateCancel = await request('DELETE', `/volunteer/records/${cWorkerRec.id}`, undefined, workerToken);
  record('已签到取消 409', lateCancel.status === 409 ? 'PASS' : `HTTP ${lateCancel.status}`);
  const okCancel = await request('DELETE', `/volunteer/records/${cOtherRec.id}`, undefined, adminToken);
  record('管理员取消 200', okCancel.status === 200 ? 'PASS' : `HTTP ${okCancel.status}`);
  const reSign = await request('POST', `/volunteer/activities/${cAid}/signup`, { user_name: '志愿者X' }, adminToken);
  record('取消后重新报名', reSign.status === 201 ? 'PASS' : `HTTP ${reSign.status}`);

  // 取消截止
  const cdAct = await request('POST', '/volunteer/activities', { title: '取消截止', start_at: new Date(Date.now() + 7200e3).toISOString(), end_at: new Date(Date.now() + 10800e3).toISOString(), cancel_deadline: new Date(Date.now() - 3600e3).toISOString(), slots: 1 }, adminToken);
  await request('POST', `/volunteer/activities/${cdAct.body.item.id}/signup`, { user_name: '测试师傅2' }, worker2Token);
  const cdRecs = await request('GET', `/volunteer/activities/${cdAct.body.item.id}/records`, undefined, adminToken);
  const cdCancel = await request('DELETE', `/volunteer/records/${(cdRecs.body.items || [])[0].id}`, undefined, worker2Token);
  record('过取消截止 409', cdCancel.status === 409 ? 'PASS' : `HTTP ${cdCancel.status}`);

  // 补签 / 过期签到（DB 造记录）
  const lateAct = await request('POST', '/volunteer/activities', { title: '两日前活动', start_at: new Date(Date.now() - 3 * 86400e3).toISOString(), end_at: new Date(Date.now() - 2 * 86400e3).toISOString(), slots: 1 }, adminToken);
  const lateRec = await sql(`INSERT INTO volunteer_record (tenant_id,activity_id,user_name,status) VALUES ($1,$2,'测试师傅','registered') RETURNING id`, [TENANT, lateAct.body.item.id]);
  const lateIn = await request('POST', `/volunteer/records/${lateRec.rows[0].id}/checkin`, {}, adminToken);
  record('结束后2天补签 200', lateIn.status === 200 && lateIn.body.item?.check_in_late === true ? 'PASS' : `HTTP ${lateIn.status}`);
  const oldAct = await request('POST', '/volunteer/activities', { title: '五日前活动', start_at: new Date(Date.now() - 6 * 86400e3).toISOString(), end_at: new Date(Date.now() - 5 * 86400e3).toISOString(), slots: 1 }, adminToken);
  const oldRec = await sql(`INSERT INTO volunteer_record (tenant_id,activity_id,user_name,status) VALUES ($1,$2,'测试师傅2','registered') RETURNING id`, [TENANT, oldAct.body.item.id]);
  const oldIn = await request('POST', `/volunteer/records/${oldRec.rows[0].id}/checkin`, {}, adminToken);
  record('结束后5天签到 409', oldIn.status === 409 ? 'PASS' : `HTTP ${oldIn.status}`);

  // 签退 / 核销状态机
  const stAct = await request('POST', '/volunteer/activities', { title: '状态机活动', start_at: new Date(Date.now() + 3600e3).toISOString(), end_at: new Date(Date.now() + 7200e3).toISOString(), slots: 1 }, adminToken);
  await request('POST', `/volunteer/activities/${stAct.body.item.id}/signup`, { user_name: '测试师傅' }, workerToken);
  const stRecs = await request('GET', `/volunteer/activities/${stAct.body.item.id}/records`, undefined, adminToken);
  const stRec = (stRecs.body.items || [])[0];
  const coEarly = await request('POST', `/volunteer/records/${stRec.id}/checkout`, {}, workerToken);
  record('未签到签退 409', coEarly.status === 409 ? 'PASS' : `HTTP ${coEarly.status}`);
  await request('POST', `/volunteer/records/${stRec.id}/checkin`, {}, adminToken);
  const apEarly = await request('POST', `/volunteer/records/${stRec.id}/approve`, {}, adminToken);
  record('未签退核销 409', apEarly.status === 409 ? 'PASS' : `HTTP ${apEarly.status}`);
  const coOk = await request('POST', `/volunteer/records/${stRec.id}/checkout`, {}, workerToken);
  const apOk = await request('POST', `/volunteer/records/${stRec.id}/approve`, {}, adminToken);
  const apAgain = await request('POST', `/volunteer/records/${stRec.id}/approve`, {}, adminToken);
  record('签退→核销→重复核销', coOk.status === 200 && apOk.status === 200 && apAgain.status === 409 ? 'PASS' : `HTTP ${coOk.status}/${apOk.status}/${apAgain.status}`);

  // 积分 0 / 非法
  await request('PUT', '/volunteer/points-rule', { points_per_hour: 0 }, adminToken);
  const pAct = await request('POST', '/volunteer/activities', { title: '零积分', start_at: new Date(Date.now() + 3600e3).toISOString(), end_at: new Date(Date.now() + 7200e3).toISOString(), slots: 1 }, adminToken);
  await request('POST', `/volunteer/activities/${pAct.body.item.id}/signup`, { user_name: '测试师傅' }, workerToken);
  const pRecs = await request('GET', `/volunteer/activities/${pAct.body.item.id}/records`, undefined, adminToken);
  const pRec = (pRecs.body.items || [])[0];
  await request('POST', `/volunteer/records/${pRec.id}/checkin`, {}, adminToken);
  await sql(`UPDATE volunteer_record SET check_in_at = now() - interval '2 hours' WHERE id=$1 AND tenant_id=$2`, [pRec.id, TENANT]);
  const pCo = await request('POST', `/volunteer/records/${pRec.id}/checkout`, {}, workerToken);
  record('积分规则0 → 0分', pCo.status === 200 && Number(pCo.body.item?.points) === 0 ? 'PASS' : `points=${pCo.body.item?.points}`);
  const pBad = await request('PUT', '/volunteer/points-rule', { points_per_hour: -1 }, adminToken);
  record('积分规则非法 422', pBad.status === 422 ? 'PASS' : `HTTP ${pBad.status}`);
  await request('PUT', '/volunteer/points-rule', { points_per_hour: 1 }, adminToken);

  // 导出内容
  const expMain = await request('GET', `/volunteer/activities/${aid}/export`, undefined, adminToken);
  const expText = String(expMain.body?.raw || '');
  record('导出中文表头/字段', expText.includes('姓名') && expText.includes('状态') && expText.includes('签到时间') && expText.includes('补签') ? 'PASS' : 'GAP');

  // 并发抢最后 1 名额
  const raceAct = await request('POST', '/volunteer/activities', { title: '并发最后名额', slots: 1 }, adminToken);
  const racers = await Promise.all(Array.from({ length: 10 }, (_, i) => request('POST', `/volunteer/activities/${raceAct.body.item.id}/signup`, { user_name: `并发${i}` }, adminToken)));
  const wins = racers.filter((r) => r.status === 201).length;
  record('10并发抢1名额', wins === 1 ? 'PASS' : `wins=${wins}`);

  // 统计 / 人员档案
  const stats = await request('GET', '/volunteer/stats', undefined, adminToken);
  const people = await request('GET', '/volunteer/people', undefined, adminToken);
  record('统计/人员档案', stats.status === 200 && people.status === 200 && stats.body.stats && Array.isArray(people.body.items) ? 'PASS' : `HTTP ${stats.status}/${people.status}`);
  const overview = await request('GET', '/volunteer/stats/overview', undefined, adminToken);
  const ovActs = overview.body.activities || [];
  const ovRace = ovActs.find((x) => x.id === raceAct.body.item.id);
  record(
    '统计总览 统计+活动明细/口径一致',
    overview.status === 200
      && overview.body.stats
      && Array.isArray(ovActs)
      && !!ovRace
      && Number(ovRace.signup_count) === 1
      && Number(ovRace.checked_in_count) === 0
      ? 'PASS'
      : `HTTP ${overview.status} acts=${ovActs.length} race=${JSON.stringify(ovRace || null)}`,
  );
  const ovWorker = await request('GET', '/volunteer/stats/overview', undefined, workerToken);
  record('统计总览 worker 403', ovWorker.status === 403 ? 'PASS' : `HTTP ${ovWorker.status}`);

  // 通知：无变化 / 状态变更不发送
  const nBefore = await sql(`SELECT count(*)::int c FROM notification WHERE tenant_id=$1 AND recipient=$2`, [TENANT, `VW-${RUN}`]);
  await request('PUT', `/volunteer/activities/${aid}`, { title: (await request('GET', `/volunteer/activities/${aid}`, undefined, adminToken)).body.item.title }, adminToken);
  await request('PUT', `/volunteer/activities/${aid}/status`, { status: 'closed' }, adminToken);
  await request('PUT', `/volunteer/activities/${aid}/status`, { status: 'open' }, adminToken);
  const nAfter = await sql(`SELECT count(*)::int c FROM notification WHERE tenant_id=$1 AND recipient=$2`, [TENANT, `VW-${RUN}`]);
  record('无变化/状态变更不通知', nBefore.rows[0].c === nAfter.rows[0].c ? 'PASS' : `before=${nBefore.rows[0].c} after=${nAfter.rows[0].c}`);

  console.log('[vol-audit] SUMMARY', JSON.stringify(results, null, 2));
  const missing = results.filter((r) => r.status === 'MISSING' || r.status === 'GAP' || r.status.startsWith('ALLOWED'));
  console.log(`[vol-audit] ${missing.length ? 'GAPS=' + missing.length : 'NO_GAPS'}`);
}

main()
  .then(async () => { await cleanup(); await db.end(); console.log('[vol-audit] cleaned', TENANT); process.exit(0); })
  .catch(async (e) => { console.error('[vol-audit] FAIL', e.message); await cleanup(); try { await db.end(); } catch {} process.exit(1); });
