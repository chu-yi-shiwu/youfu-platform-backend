// 资产管理模块功能审计（2026-11-17）
// 目的：验证建档/查询/编辑/调拨/报障/维保/历史/导入导出/权限，识别关键功能缺失。
// 写操作只在 uat-asset-* 租户，结束清理。
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const BASE = (process.env.PILOT_API_BASE || 'http://127.0.0.1:4101/api/v1').replace(/\/+$/, '');
const UPLOAD_ROOT = process.env.UPLOAD_DIR || '/opt/youfu/pilot/uploads';
const RUN = (process.env.E2E_RUN_ID || `as${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
const TENANT = `uat-asset-${RUN}`;
const PASS = 'Asset!2026';
const SOURCE_TENANT = process.env.SOURCE_TENANT || 'zixing-hospital';
const isoDate = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

function loadEnv() {
  for (const f of [process.env.ENV_FILE || '.env']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const db = new Client({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'youfu_pilot',
  user: process.env.PGUSER || 'youfu_app', password: process.env.PGPASSWORD,
});

function request(method, p, body, token, extra) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const u = new URL(p.startsWith('http') ? p : BASE + p);
    const req = http.request(u, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(extra || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) req.write(data);
    req.end();
  });
}

function hashPassword(p) {
  const s = crypto.randomBytes(16);
  return `scrypt$${s.toString('hex')}$${crypto.scryptSync(p, s, 64).toString('hex')}`;
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`[${ok ? 'PASS' : 'GAP'}] ${name}${detail ? ' — ' + detail : ''}`);
}
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const expect = (r, code) => Array.isArray(code) ? code.includes(r.status) : r.status === code;

async function tenantQuery(sql, params = []) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const r = await db.query(sql, params);
  await db.query('COMMIT');
  return r;
}

async function setup() {
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [SOURCE_TENANT]);
  const src = await db.query(`SELECT def, version FROM workflow_def WHERE tenant_id=$1 AND entity_type='work_order' ORDER BY version DESC LIMIT 1`, [SOURCE_TENANT]);
  await db.query('COMMIT');
  if (!src.rowCount) throw new Error('source workflow_def missing');

  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,'资产审计租户','active')`, [TENANT]);
  const dept = await db.query(`INSERT INTO dept (tenant_id,name,code,is_default,enabled) VALUES ($1,'资产科','ASSET',true,true) RETURNING id`, [TENANT]);
  const deptId = dept.rows[0].id;
  await db.query(`INSERT INTO fault_category (tenant_id,code,name,business_type,skill_tags,sort,enabled) VALUES ($1,'repair','维修','repair','[]'::jsonb,1,true)`, [TENANT]);
  await db.query(`INSERT INTO location_dict (tenant_id,code,name,category,enabled) VALUES ($1,'ASSET-LOC','资产库房','位置',true)`, [TENANT]);
  await db.query(`INSERT INTO workflow_def (tenant_id,entity_type,def,version,updated_by) VALUES ($1,'work_order',$2::jsonb,$3,'asset-audit')`, [TENANT, JSON.stringify(src.rows[0].def), src.rows[0].version]);
  const accounts = {};
  for (const [u, role] of [['asset_admin', 'admin'], ['asset_admin2', 'admin'], ['asset_op', 'operator'], ['asset_w1', 'worker']]) {
    const acc = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`, [TENANT, u, hashPassword(PASS), u, role]);
    accounts[u] = acc.rows[0].id;
    if (role === 'worker') {
      await db.query(`INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id) VALUES ($1,$2,$3,'{}'::text[],0,true,$1,$4)`, [acc.rows[0].id, TENANT, '资产师傅', deptId]);
    }
  }
  await db.query('COMMIT');

  const jwt = await import('../dist/middleware/auth.js');
  const now = Math.floor(Date.now() / 1000);
  const token = (u, role) => jwt.signJwt({ sub: accounts[u], tid: TENANT, role, username: u, tv: 0, iat: now, exp: now + 7200 }, process.env.JWT_SECRET);
  return {
    admin: token('asset_admin', 'admin'),
    admin2: token('asset_admin2', 'admin'),
    op: token('asset_op', 'operator'),
    worker: token('asset_w1', 'worker'),
    workerId: accounts.asset_w1,
    deptId,
  };
}

async function cleanup() {
  try {
    const sql = `
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$ DECLARE r record; BEGIN
FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'
LOOP EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${TENANT}'; END LOOP; END $$;
COMMIT;`;
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', `DELETE FROM platform_audit WHERE target_tenant='${TENANT}'`], { stdio: 'pipe' });
    for (const root of new Set([process.env.UPLOAD_DIR, '/opt/youfu/uploads', '/opt/youfu/pilot/uploads'].filter(Boolean))) {
      rmSync(path.join(root, TENANT), { recursive: true, force: true });
    }
    console.log('[asset-audit] cleaned', TENANT);
  } catch (e) { console.error('[asset-audit] cleanup failed', e.message); }
}

async function completeOrder(id, ctx) {
  // 只走前向路径；排除当前态，避免把 assigned→assigned(forward)/processing→pending_dispatch(return) 当成前进。
  // completed 优先于审核分支：pilot 的 processing 可直达 completed，避免绕 pending_review 形成回环。
  const pref = ['assigned', 'arrived', 'processing', 'completed', 'pending_review', 'review_passed', 'closed'];
  const trail = [];
  for (let i = 0; i < 12; i++) {
    const d = await request('GET', `/open/work_order/${id}`, undefined, ctx.admin);
    const t = d.body?.ticket || d.body?.item || d.body;
    if (['completed', 'closed', 'evaluated'].includes(t?.status)) return { ok: true, trail };
    const avail = d.body?.available || t?.available || [];
    trail.push(`${t?.status}:${avail.map((a) => a.to).join('/')}`);
    const to = pref.find((x) => x !== t?.status && avail.some((a) => a.to === x));
    if (!to) return { ok: false, status: d.status, body: { status: t?.status, available: avail.map((a) => a.to), trail } };
    // 按流程定义下发的 allowedRoles 选择令牌：主站 processing→pending_review 仅 worker 可执行。
    const roles = (avail.find((a) => a.to === to)?.allowedRoles) || [];
    const token = roles.includes('admin') || roles.length === 0 ? ctx.admin : (roles.includes('worker') ? ctx.worker : ctx.admin);
    const r = await request('POST', `/open/work_order/${id}/transition`, { to, remark: '审计流转', assignee: ctx.workerId }, token);
    if (!ok2xx(r)) return { ok: false, status: r.status, body: r.body };
  }
  return { ok: false, status: 0, body: { reason: 'too many transitions', trail } };
}

async function main() {
  const ctx = await setup();
  const { admin, admin2, op, worker, workerId } = ctx;

  // 1) 建档
  const create = await request('POST', '/assets', {
    name: '审计-输液泵', model: 'IP-01', pinyin: 'shuyebeng', location: '资产库房', status: 'in_use',
    has_sno: true, sno: 'SN-AUDIT-001', financial_category: '医疗设备', price: 8800.5, supplier: '审计供应商', purchase_date: '2025-06-01',
    responsible_user: '张三', department: 'ICU', warranty_until: isoDate(5), warranty_vendor: '审计保修方', useful_life_months: 36,
  }, admin);
  const asset = create.body?.item;
  check('创建资产（全字段）', expect(create, 201), `status=${create.status}`);
  check('自动生成资产编号/二维码', !!asset?.asset_no && asset?.qr_code === `AST-${asset?.asset_no}`, `${asset?.asset_no} / ${asset?.qr_code}`);
  check('责任人/部门/保修/折旧字段回读', asset?.responsible_user === '张三' && asset?.department === 'ICU' && asset?.warranty_until === isoDate(5) && asset?.useful_life_months === 36, `${asset?.responsible_user}/${asset?.department}/${asset?.warranty_until}/${asset?.useful_life_months}`);
  const id = asset?.id;
  const detail = await request('GET', `/assets/${id}`, undefined, admin);
  const dep = detail.body?.item?.depreciation;
  check('单资产折旧净值', ok2xx(detail) && dep && dep.monthly > 0 && dep.accumulated > 0 && dep.net >= 0 && dep.net < 8800.5, `monthly=${dep?.monthly} accumulated=${dep?.accumulated} net=${dep?.net}`);

  // 2) 查询/筛选
  const byName = await request('GET', '/assets?name=' + encodeURIComponent('输液'), undefined, admin);
  const byPinyin = await request('GET', '/assets?pinyin=shuye', undefined, admin);
  const byLoc = await request('GET', `/assets?location=${encodeURIComponent('资产库房')}`, undefined, admin);
  const byStatus = await request('GET', '/assets?status=in_use', undefined, admin);
  const byCode = await request('GET', `/assets?code=${encodeURIComponent(asset?.asset_no || '')}`, undefined, admin);
  const byQr = await request('GET', `/assets?code=${encodeURIComponent(asset?.qr_code || '')}`, undefined, admin);
  check('按名称/拼音/位置/状态/资产号/二维码查询', [byName, byPinyin, byLoc, byStatus, byCode, byQr].every((r) => ok2xx(r) && (r.body?.items || []).some((x) => x.id === id)), `${byName.status}/${byPinyin.status}/${byLoc.status}/${byStatus.status}/${byCode.status}/${byQr.status}`);

  // 3) 编辑/停用
  const upd = await request('PUT', `/assets/${id}`, { location: '住院楼2F', status: 'standby', price: 9000 }, admin);
  check('编辑资产（位置/状态/金额）', expect(upd, 200) && upd.body?.item?.status === 'standby', `status=${upd.status}`);
  const disable = await request('PUT', `/assets/${id}`, { status: 'disabled' }, admin);
  check('停用资产（状态 disabled）', expect(disable, 200) && disable.body?.item?.status === 'disabled', `status=${disable.status}`);
  await request('PUT', `/assets/${id}`, { status: 'in_use' }, admin);
  const del = await request('DELETE', `/assets/${id}`, undefined, admin);
  check('资产不物理删除（处置替代）', del.status === 404, `DELETE /assets/:id -> ${del.status}，使用 /assets/:id/dispose 保留审计`);

  // 3.1) 报废（P1 新端点）
  const asset3 = await request('POST', '/assets', { name: '审计-待报废资产', location: '资产库房' }, admin);
  const id3 = asset3.body?.item?.id;
  const dis = await request('POST', `/assets/${id3}/dispose`, { reason: '审计报废', method: '报废', residual_value: 0 }, admin);
  const disDetail = await request('GET', `/assets?code=${encodeURIComponent(asset3.body?.item?.asset_no || '')}`, undefined, admin);
  const rowDis = (disDetail.body?.items || []).find((x) => x.id === id3);
  check('资产报废处置（原因/方式/残值）', ok2xx(dis) && rowDis?.status === 'disposed' && rowDis?.dispose_reason === '审计报废', `status=${dis.status} body=${JSON.stringify(dis.body)} asset=${rowDis?.status}`);
  const disAgain = await request('POST', `/assets/${id3}/dispose`, { reason: '重复' }, admin);
  check('重复报废被拒', expect(disAgain, 409), `status=${disAgain.status}`);

  // 4) 调拨
  const tr = await request('POST', `/assets/${id}/transfer`, { location: '手术室' }, admin);
  check('调拨资产（仅 location）', expect(tr, 200) && tr.body?.item?.location === '手术室', `status=${tr.status}`);

  // 5) 报障 -> 工单
  const fault = await request('POST', `/assets/${id}/fault`, { title: '审计-输液泵故障', description: '流速异常' }, admin);
  const woId = fault.body?.result?.id || fault.body?.result?.work_order_id || fault.body?.result?.order_id;
  const afterFault = await request('GET', `/assets?code=${encodeURIComponent(asset?.asset_no || '')}`, undefined, admin);
  const rowFault = (afterFault.body?.items || []).find((x) => x.id === id);
  check('资产报障生成工单', ok2xx(fault) && !!woId, `status=${fault.status} wo=${woId} body=${JSON.stringify(fault.body).slice(0, 200)}`);
  check('报障后资产状态=repairing', rowFault?.status === 'repairing', `status=${rowFault?.status}`);
  const woDetail = await request('GET', `/open/work_order/${woId}`, undefined, admin);
  check('工单详情回指关联资产', ok2xx(woDetail) && woDetail.body?.asset?.id === id, `asset=${woDetail.body?.asset?.asset_no || '无'}`);

  // 6) 历史（是否含调拨/报障）
  const hist = await request('GET', `/assets/${id}/history`, undefined, admin);
  const histItems = hist.body?.items || [];
  check('资产历史返回关联工单', ok2xx(hist) && histItems.some((x) => x.order_id === woId || x.id === woId), `items=${histItems.length}`);
  const eventKinds = histItems.filter((x) => x.kind === 'event').map((x) => x.event_type);
  check('资产历史包含调拨/状态变更事件', ok2xx(hist) && eventKinds.length > 0, `events=${eventKinds.join(',') || '无'} total=${histItems.length}`);

  // 7) 取消报障工单后资产状态是否回写
  // 不同租户流程允许取消的源状态不同：先按 available 推进到可取消状态（如 assigned/arrived），再取消。
  let cancel = { status: 0, body: { reason: 'no cancel path' } };
  for (let i = 0; i < 6; i++) {
    const d = await request('GET', `/open/work_order/${woId}`, undefined, admin);
    const t = d.body?.ticket || d.body?.item || d.body;
    const available = (d.body?.available || t?.available || []).map((x) => x.to);
    if (available.includes('cancelled')) {
      cancel = await request('POST', `/open/work_order/${woId}/transition`, { to: 'cancelled', cancel_reason: '审计取消', remark: '审计取消' }, admin);
      break;
    }
    const next = ['assigned', 'arrived', 'processing'].find((x) => available.includes(x));
    if (!next) break;
    const step = await request('POST', `/open/work_order/${woId}/transition`, { to: next, remark: '审计流转', assignee: workerId }, admin);
    if (!ok2xx(step)) { cancel = step; break; }
  }
  const afterCancel = await request('GET', `/assets?code=${encodeURIComponent(asset?.asset_no || '')}`, undefined, admin);
  const rowCancel = (afterCancel.body?.items || []).find((x) => x.id === id);
  const cancelDetail = await request('GET', `/open/work_order/${woId}`, undefined, admin);
  const cancelTicket = cancelDetail.body?.ticket || cancelDetail.body?.item || cancelDetail.body;
  const cancelAvail = (cancelDetail.body?.available || cancelTicket?.available || []).map((x) => x.to);
  check('取消报障工单后资产状态回写', rowCancel?.status === 'in_use', `cancel=${cancel.status} asset=${rowCancel?.status} status=${cancelTicket?.status} available=${cancelAvail.join(',')} body=${JSON.stringify(cancel.body).slice(0, 120)}`);

  // 8) 完成维修后资产状态回写
  const asset2 = await request('POST', '/assets', { name: '审计-监护仪', location: '资产库房', status: 'in_use' }, admin);
  const id2 = asset2.body?.item?.id;
  const fault2 = await request('POST', `/assets/${id2}/fault`, { title: '审计-监护仪故障' }, admin);
  const wo2 = fault2.body?.result?.id || fault2.body?.result?.work_order_id || fault2.body?.result?.order_id;
  const done = wo2 ? await completeOrder(wo2, ctx) : { ok: false };
  const afterDone = await request('GET', `/assets?code=${encodeURIComponent(asset2.body?.item?.asset_no || '')}`, undefined, admin);
  const rowDone = (afterDone.body?.items || []).find((x) => x.id === id2);
  check('完成维修工单后资产恢复 in_use', done.ok && rowDone?.status === 'in_use', `done=${JSON.stringify(done)} asset=${rowDone?.status}`);

  // 9) 维保 CRUD
  const m1 = await request('POST', `/assets/${id2}/maintenance`, { maintain_date: '2026-11-17', type: 'repair', cost: 120, vendor: '审计厂商', note: '更换传感器', next_due: isoDate(3) }, admin);
  const mid = m1.body?.item?.id;
  const mlist = await request('GET', `/assets/${id2}/maintenance`, undefined, admin);
  const mupd = mid ? await request('PUT', `/assets/maintenance/${mid}`, { note: '已复核' }, admin) : { status: 0 };
  // 保留一条“计划型”维保记录用于到期提醒校验（CRUD 用 m1 已覆盖删除）
  const m2 = await request('POST', `/assets/${id2}/maintenance`, { type: 'plan', next_due: isoDate(3) }, admin);
  const mid2 = m2.body?.item?.id;
  const mdel = mid ? await request('DELETE', `/assets/maintenance/${mid}`, undefined, admin) : { status: 0 };
  check('维保记录新增/列表/编辑/删除', expect(m1, 201) && ok2xx(mlist) && expect(mupd, 200) && expect(mdel, 200), `${m1.status}/${mlist.status}/${mupd.status}/${mdel.status}`);
  const rem = await request('GET', '/assets/reminders?days=30', undefined, admin);
  const hasWarranty = (rem.body?.warranty || []).some((x) => x.id === id);
  const hasMaint = (rem.body?.maintenance || []).some((x) => x.id === mid2);
  check('维保计划/到期提醒/保修期', expect(m2, 201) && m2.body?.item?.next_due === isoDate(3) && ok2xx(rem) && hasWarranty && hasMaint, `next_due=${m2.body?.item?.next_due} warranty=${hasWarranty} maint=${hasMaint}`);
  const disW = await request('POST', '/assets/reminders/dismiss', { kind: 'warranty', ref_id: id }, admin);
  const disM = await request('POST', '/assets/reminders/dismiss', { kind: 'maintenance', ref_id: mid2 }, admin);
  const rem2 = await request('GET', '/assets/reminders?days=30', undefined, admin);
  const stillW = (rem2.body?.warranty || []).some((x) => x.id === id);
  const stillM = (rem2.body?.maintenance || []).some((x) => x.id === mid2);
  const ignored = await request('GET', '/assets/reminders/dismissed', undefined, admin);
  const ignoredIds = (ignored.body?.items || []).map((x) => `${x.kind}:${x.ref_id}`);
  const restW = await request('POST', '/assets/reminders/restore', { kind: 'warranty', ref_id: id }, admin);
  const restM = await request('POST', '/assets/reminders/restore', { kind: 'maintenance', ref_id: mid2 }, admin);
  const rem3 = await request('GET', '/assets/reminders?days=30', undefined, admin);
  const backW = (rem3.body?.warranty || []).some((x) => x.id === id);
  const backM = (rem3.body?.maintenance || []).some((x) => x.id === mid2);
  check('到期提醒可忽略/查询/恢复', ok2xx(disW) && ok2xx(disM) && ok2xx(rem2) && !stillW && !stillM
    && ok2xx(ignored) && ignoredIds.includes(`warranty:${id}`) && ignoredIds.includes(`maintenance:${mid2}`)
    && ok2xx(restW) && ok2xx(restM) && backW && backM,
    `dismiss=${disW.status}/${disM.status} ignored=${ignoredIds.length} restore=${restW.status}/${restM.status} back=${backW}/${backM}`);

  // 10) 导入导出
  const exp = await request('GET', '/assets/export', undefined, admin);
  const header = String(exp.raw || '').split(/\r?\n/)[0] || '';
  check('导出 CSV', expect(exp, 200) && header.includes('资产编号') && header.includes('资产名称'), header.slice(0, 120));
  check('导出含责任人/部门/保修期', header.includes('责任人') && header.includes('部门') && header.includes('保修截止'), `当前表头：${header.slice(0, 160)}`);
  const tpl = await request('GET', '/assets/import-template', undefined, admin);
  const tplHeader = String(tpl.raw || '').split(/\r?\n/)[0] || '';
  check('导入模板可下载', expect(tpl, 200) && tplHeader.includes('资产编号') && tplHeader.includes('责任人') && tplHeader.includes('折旧年限'), `表头：${tplHeader.slice(0, 160)}`);
  const csv = '资产编号,资产名称,位置,状态\nAUDIT-DUP-001,审计导入资产,资产库房,在用\n' + `${asset?.asset_no},重复编号资产,资产库房,在用\n`;
  const imp = await request('POST', '/assets/import', { csv }, admin);
  check('导入 CSV（含重复资产编号）', ok2xx(imp), `status=${imp.status} body=${JSON.stringify(imp.body).slice(0, 160)}`);
  const dupList = await request('GET', `/assets?code=AUDIT-DUP-001`, undefined, admin);
  check('资产编号唯一性校验', (dupList.body?.items || []).length <= 1, `同编号条数=${(dupList.body?.items || []).length} body=${JSON.stringify(dupList.body).slice(0, 160)}`);
  const imported = (dupList.body?.items || [])[0];
  check('导入资产自动生成二维码', imported?.qr_code === `AST-${imported?.asset_no}`, `${imported?.asset_no} / ${imported?.qr_code}`);

  // 10.1) 统计 / 折旧
  const stats = await request('GET', '/assets/stats', undefined, admin);
  check('资产统计与折旧', ok2xx(stats) && Number(stats.body?.summary?.total) >= 2 && stats.body?.depreciation && typeof stats.body.depreciation.net_total === 'number', JSON.stringify(stats.body?.summary || {}).slice(0, 160));

  // 10.2) 附件（元数据 + 事件留痕）
  const upAtt = await request('POST', '/upload', {
    filename: 'audit.pdf',
    contentType: 'application/pdf',
    base64: Buffer.from('%PDF-1.4\nasset audit attachment\n').toString('base64'),
  }, admin);
  const att = await request('POST', `/assets/${id2}/attachments`, { name: '审计说明书.pdf', url: upAtt.body?.url }, admin);
  const attList = await request('GET', `/assets/${id2}/attachments`, undefined, admin);
  const attDel = att.body?.item?.id ? await request('DELETE', `/assets/attachments/${att.body.item.id}`, undefined, admin) : { status: 0 };
  const attBad = await request('POST', `/assets/${id2}/attachments`, { name: '外链.pdf', url: '/uploads/other/x.pdf' }, admin);
  check('资产附件上传/列表/删除', expect(att, 201) && ok2xx(attList) && expect(attDel, 200) && att.body?.item?.scan_status === 'unscanned', `${att.status}/${attList.status}/${attDel.status} scan=${att.body?.item?.scan_status}`);
  check('附件拒绝跨租户外链', attBad.status === 400, `status=${attBad.status}`);

  // 10.3) 批量操作（只更新部门；已处置 asset3 应被跳过）
  const batch = await request('POST', '/assets/batch', { action: 'update', ids: [id2, id3], patch: { department: '急诊' } }, admin);
  check('资产批量操作（跳过已处置）', ok2xx(batch) && batch.body?.updated === 1 && (batch.body?.skipped || []).some((x) => x.id === id3), `updated=${batch.body?.updated} skipped=${JSON.stringify(batch.body?.skipped || [])}`);

  // 10.4) 处置撤销审批（申请人不能自审）
  const rev = await request('POST', `/assets/${id3}/dispose/reversal`, { reason: '审计误报废' }, admin);
  const revId = rev.body?.item?.id;
  const revList = await request('GET', '/assets/disposal-reversals?status=pending', undefined, admin);
  const self = revId ? await request('POST', `/assets/disposal-reversals/${revId}/approve`, { note: '自审' }, admin) : { status: 0 };
  const revOk = revId ? await request('POST', `/assets/disposal-reversals/${revId}/approve`, { note: '复核通过' }, admin2) : { status: 0 };
  const afterRev = await request('GET', `/assets/${id3}`, undefined, admin);
  check('处置撤销审批（禁止自审）', expect(rev, 201) && ok2xx(revList) && (revList.body?.items || []).some((x) => x.id === revId) && self.status === 409 && expect(revOk, 200) && afterRev.body?.item?.status === 'in_use' && !!afterRev.body?.item?.disposal_reversed_at,
    `rev=${rev.status} list=${(revList.body?.items || []).length} self=${self.status} approve=${revOk.status} asset=${afterRev.body?.item?.status}`);

  // 10.5) 流程配置预检
  const ready = await request('GET', '/assets/workflow-readiness', undefined, admin);
  check('资产报障流程配置预检', ok2xx(ready) && ready.body?.ok === true && (ready.body?.cancel_from || []).length > 0 && (ready.body?.done_from || []).length > 0,
    `ok=${ready.body?.ok} cancel=${(ready.body?.cancel_from || []).join(',')} done=${(ready.body?.done_from || []).join(',')}`);

  // 11) 权限
  const workerList = await request('GET', '/assets', undefined, worker);
  const workerCreate = await request('POST', '/assets', { name: 'worker 资产' }, worker);
  const workerFault = await request('POST', `/assets/${id2}/fault`, {}, worker);
  const workerExport = await request('GET', '/assets/export', undefined, worker);
  check('worker 可读资产（扫码）', expect(workerList, 200), `status=${workerList.status}`);
  check('worker 不可建档/报障/导出', [workerCreate, workerFault, workerExport].every((r) => expect(r, 403)), `${workerCreate.status}/${workerFault.status}/${workerExport.status}`);

  // 12) 扫码解析
  const scan = await request('POST', '/scan', { raw: asset?.qr_code || '' }, admin);
  const scan2 = await request('POST', '/scan', { raw: asset?.asset_no || '' }, admin);
  check('扫码解析资产二维码', ok2xx(scan) && scan.body?.asset?.resolved === true, JSON.stringify(scan.body).slice(0, 160));
  check('扫码解析资产编号', ok2xx(scan2) && scan2.body?.asset?.resolved === true, JSON.stringify(scan2.body).slice(0, 160));
  const pub = await request('GET', `/public/scan?org=${encodeURIComponent(TENANT)}&code=${encodeURIComponent(asset?.qr_code || '')}`);
  check('小程序公开扫码路径', ok2xx(pub) && pub.body?.resolved === true && pub.body?.kind === 'asset', JSON.stringify(pub.body).slice(0, 160));

  const gaps = checks.filter((c) => !c.ok).map((c) => c.name);
  console.log('\nSUMMARY=' + JSON.stringify({ total: checks.length, pass: checks.filter((c) => c.ok).length, gaps }, null, 2));
  await cleanup();
  await db.end();
}

main().catch(async (e) => {
  console.error('FATAL', e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
