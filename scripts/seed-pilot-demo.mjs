// 试点模拟数据种子（2026-11-09）
//
// 目标：不依赖医院真实数据，生成一套可反复重建的“资兴市人民医院”演示数据，
// 供产品演示、真机走查和 E2E 验收使用。
//
// 安全边界：
//   - 只在本脚本创建的 DEMO_* 部门 / DEMO-W* 人员 / demo_* 账号 /
//     demo_* 目录 / [DEMO] 规则 / ext.demo_seed='pilot-demo' 工单范围内增删；
//   - 不覆盖既有的“总务科”和 W0001；
//   - --clean 可一键清理全部模拟数据。
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=/opt/youfu/pilot/backend/.env \
//     /opt/node16/bin/node <本脚本路径> --tenant=zixing-hospital --orders=100
//   ... --clean
import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const args = process.argv.slice(2);
const arg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const TENANT = arg('tenant', process.env.PILOT_TENANT || 'zixing-hospital');
const ORDERS = Math.max(0, Math.min(500, Number(arg('orders', '100')) || 100));
const CLEAN = args.includes('--clean');
const DEMO_PASSWORD = arg('password', 'Demo123!');
const TAG = 'pilot-demo';

// 与 src/account.ts 的 hashPassword 同算法，避免种子账号登录失败。
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function loadEnv() {
  const f = process.env.ENV_FILE || '.env';
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
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

async function main() {
  await db.connect();
  await db.query('BEGIN');
  await db.query(
    `SELECT set_config('app.tenant_id',$1,true),
            set_config('app.scope','system',true),
            set_config('app.user_id','',true),
            set_config('app.worker_ids','{}',true),
            set_config('app.claim_hall','false',true)`,
    [TENANT],
  );

  if (CLEAN) {
    await clean();
    await db.query('COMMIT');
    console.log(`[seed] cleaned tenant=${TENANT}`);
    await db.end();
    return;
  }

  // 幂等：每次重建都先清掉上一轮 demo 数据，不重复堆叠。
  await clean();
  const depts = await seedDepartments();
  await seedLocations();
  const categories = await seedCategories();
  const workers = await seedWorkers(depts);
  await seedRules(depts);
  await seedOrders(depts, categories, workers);
  await refreshLoads(workers);
  const counts = await summary();

  await db.query('COMMIT');
  console.log(`[seed] tenant=${TENANT} orders=${ORDERS}`);
  console.log(`[seed] depts=${counts.depts} workers=${counts.workers} rules=${counts.rules} demo_orders=${counts.orders}`);
  console.log(`[seed] demo accounts: demo_admin / demo_operator / demo_w1..${workers.length}（密码 ${DEMO_PASSWORD}）`);
  await db.end();
}

async function clean() {
  const ids = (
    await db.query(`SELECT id FROM work_orders WHERE tenant_id=$1 AND ext->>'demo_seed'=$2`, [TENANT, TAG])
  ).rows.map((r) => r.id);
  for (const table of [
    'ai_conversation', 'ai_shadow_suggestions', 'feedback', 'inventory_log', 'ticket_learn_log',
    'work_acceptance', 'webhook_delivery', 'settlement_item', 'ticket_event', 'notification',
  ]) {
    if (ids.length) await db.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND work_order_id::text = ANY($2::text[])`, [TENANT, ids]);
  }
  if (ids.length) {
    await db.query(`DELETE FROM domain_event WHERE tenant_id=$1 AND entity_type='work_order' AND entity_id = ANY($2::text[])`, [TENANT, ids]);
    await db.query(`DELETE FROM idempotency_key WHERE tenant_id=$1 AND work_order_id = ANY($2::text[])`, [TENANT, ids]);
    await db.query(`DELETE FROM work_orders WHERE tenant_id=$1 AND id = ANY($2::text[])`, [TENANT, ids]);
  }
  await db.query(`DELETE FROM department_route_rule WHERE tenant_id=$1 AND name LIKE '[DEMO]%'`, [TENANT]);
  await db.query(`DELETE FROM department_route_rule WHERE tenant_id=$1 AND department_id IN (
    SELECT id FROM dept WHERE tenant_id=$1 AND code LIKE 'DEMO\_%' ESCAPE '\'
  )`, [TENANT]);
  await db.query(`DELETE FROM worker WHERE tenant_id=$1 AND id LIKE 'DEMO-W%'`, [TENANT]);
  await db.query(`DELETE FROM account_user WHERE tenant_id=$1 AND username LIKE 'demo\_%' ESCAPE '\\'`, [TENANT]);
  await db.query(`DELETE FROM location_dict WHERE tenant_id=$1 AND code LIKE 'DEMO-LOC-%'`, [TENANT]);
  await db.query(`DELETE FROM fault_category WHERE tenant_id=$1 AND code LIKE 'demo\_%' ESCAPE '\\'`, [TENANT]);
  await db.query(`DELETE FROM dept WHERE tenant_id=$1 AND code LIKE 'DEMO\_%' ESCAPE '\\'`, [TENANT]);
}

async function seedDepartments() {
  const defs = [
    { name: '维修组', code: 'DEMO_WX' },
    { name: '保洁组', code: 'DEMO_BJ' },
    { name: '安保组', code: 'DEMO_AB' },
  ];
  const out = {};
  for (const d of defs) {
    const found = await db.query('SELECT id FROM dept WHERE tenant_id=$1 AND code=$2 LIMIT 1', [TENANT, d.code]);
    if (found.rowCount) {
      out[d.name] = found.rows[0].id;
    } else {
      const r = await db.query(
        'INSERT INTO dept (tenant_id,name,code,remark,is_default) VALUES ($1,$2,$3,$4,false) RETURNING id',
        [TENANT, d.name, d.code, 'pilot-demo'],
      );
      out[d.name] = r.rows[0].id;
    }
  }
  const general = await db.query(`SELECT id FROM dept WHERE tenant_id=$1 AND code='ZW' LIMIT 1`, [TENANT]);
  out['总务科'] = general.rows[0]?.id || null;
  return out;
}

async function seedLocations() {
  const defs = [
    ['DEMO-LOC-001', '住院部', '住院'],
    ['DEMO-LOC-002', '门诊楼', '门诊'],
    ['DEMO-LOC-003', '医技楼', '医技'],
    ['DEMO-LOC-004', '行政楼', '行政'],
    ['DEMO-LOC-005', '急诊科', '急诊'],
  ];
  for (const [code, name, category] of defs) {
    await db.query(
      `INSERT INTO location_dict (tenant_id,code,name,category,enabled)
       VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (tenant_id,code) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, enabled=true`,
      [TENANT, code, name, category],
    );
  }
}

async function seedCategories() {
  const defs = [
    ['demo_repair_water', '水管漏水', 'repair', ['repair', 'plumbing']],
    ['demo_repair_electric', '电路跳闸', 'repair', ['repair', 'electric']],
    ['demo_repair_ac', '空调不制冷', 'repair', ['repair', 'hvac']],
    ['demo_repair_door', '门窗损坏', 'repair', ['repair']],
    ['demo_repair_network', '网络故障', 'repair', ['repair', 'network']],
    ['demo_clean_daily', '日常保洁', 'cleaning', ['cleaning']],
    ['demo_security_patrol', '安保巡查', 'security', ['security']],
    ['demo_other', '其他', 'repair', ['repair']],
  ];
  const out = {};
  for (const [code, name, businessType, skills] of defs) {
    const r = await db.query(
      `INSERT INTO fault_category (tenant_id,code,name,sort,enabled,business_type,skill_tags)
       VALUES ($1,$2,$3,100,true,$4,$5::jsonb)
       ON CONFLICT (tenant_id,code) DO UPDATE SET name=EXCLUDED.name, enabled=true, business_type=EXCLUDED.business_type, skill_tags=EXCLUDED.skill_tags
       RETURNING id`,
      [TENANT, code, name, businessType, JSON.stringify(skills)],
    );
    out[code] = r.rows[0].id;
  }
  return out;
}

async function seedWorkerAccount(username, displayName, role) {
  const hash = hashPassword(DEMO_PASSWORD);
  const r = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (tenant_id,username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role, active=true
     RETURNING id`,
    [TENANT, username, hash, displayName, role],
  );
  return r.rows[0].id;
}

async function seedWorkers(depts) {
  const defs = [
    ['DEMO-W001', '张师傅', '维修组', ['repair', 'plumbing']],
    ['DEMO-W002', '李师傅', '维修组', ['repair', 'electric']],
    ['DEMO-W003', '王师傅', '维修组', ['repair', 'hvac']],
    ['DEMO-W004', '赵师傅', '维修组', ['repair', 'network']],
    ['DEMO-W005', '陈保洁', '保洁组', ['cleaning']],
    ['DEMO-W006', '周安保', '安保组', ['security']],
  ];
  await seedWorkerAccount('demo_admin', '演示管理员', 'admin');
  await seedWorkerAccount('demo_operator', '演示运营', 'operator');
  const out = [];
  let i = 1;
  for (const [id, name, deptName, skills] of defs) {
    const accountId = await seedWorkerAccount(`demo_w${i}`, name, 'worker');
    await db.query(
      `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id,phone)
       VALUES ($1,$2,$3,$4::text[],0,true,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, skill_tags=EXCLUDED.skill_tags, active=true,
         account_id=EXCLUDED.account_id, department_id=EXCLUDED.department_id, phone=EXCLUDED.phone`,
      [id, TENANT, name, skills, accountId, depts[deptName], `1380000000${i}`],
    );
    out.push({ id, name, deptName, skills, username: `demo_w${i}` });
    i += 1;
  }
  return out;
}

async function seedRules(depts) {
  const rules = [
    ['[DEMO] 保洁类 → 保洁组', { business_type: 'cleaning' }, 950],
    ['[DEMO] 安保类 → 安保组', { business_type: 'security' }, 950],
    ['[DEMO] 漏水 → 维修组', { description_contains: '漏水' }, 900],
    ['[DEMO] 空调 → 维修组', { description_contains: '空调' }, 900],
    ['[DEMO] 电路 → 维修组', { description_contains: '电路' }, 900],
    ['[DEMO] 网络 → 维修组', { description_contains: '网络' }, 900],
  ];
  await db.query(`DELETE FROM department_route_rule WHERE tenant_id=$1 AND name LIKE '[DEMO]%'`, [TENANT]);
  for (const [name, match, priority] of rules) {
    const dept = name.includes('保洁') ? depts['保洁组'] : name.includes('安保') ? depts['安保组'] : depts['维修组'];
    await db.query(
      `INSERT INTO department_route_rule (tenant_id,name,priority,enabled,match_json,department_id)
       VALUES ($1,$2,$3,true,$4::jsonb,$5)`,
      [TENANT, name, priority, JSON.stringify(match), dept],
    );
  }
}

async function seedOrders(depts, categories, workers) {
  const deptOfWorkers = {};
  for (const w of workers) (deptOfWorkers[w.deptName] ||= []).push(w);
  const byDept = {
    维修组: deptOfWorkers['维修组'] || [],
    保洁组: deptOfWorkers['保洁组'] || [],
    安保组: deptOfWorkers['安保组'] || [],
  };
  const statuses = [
    ...Array(20).fill('pending_dispatch'),
    ...Array(20).fill('assigned'),
    ...Array(15).fill('processing'),
    ...Array(20).fill('completed'),
    ...Array(10).fill('closed'),
    ...Array(10).fill('evaluated'),
    ...Array(5).fill('cancelled'),
  ];
  const defsByDept = {
    维修组: [
      { title: '住院部 3 楼水管漏水', category: 'demo_repair_water', location: '住院部 3 楼' },
      { title: '门诊二楼空调不制冷', category: 'demo_repair_ac', location: '门诊楼 2 楼' },
      { title: '住院部 5 楼电路跳闸', category: 'demo_repair_electric', location: '住院部 5 楼' },
      { title: '门诊大厅门窗损坏', category: 'demo_repair_door', location: '门诊楼 1 楼' },
      { title: '行政楼网络中断', category: 'demo_repair_network', location: '行政楼 4 楼' },
      { title: '手术室空调异响', category: 'demo_repair_ac', location: '医技楼 3 楼' },
      { title: '门诊三楼灯管不亮', category: 'demo_repair_electric', location: '门诊楼 3 楼' },
      { title: '住院部 8 楼卫生间堵塞', category: 'demo_repair_water', location: '住院部 8 楼' },
    ],
    保洁组: [
      { title: '急诊科需要日常保洁', category: 'demo_clean_daily', location: '急诊科' },
      { title: '住院部 5 楼保洁', category: 'demo_clean_daily', location: '住院部 5 楼' },
      { title: '门诊大厅地面清洁', category: 'demo_clean_daily', location: '门诊楼 1 楼' },
      { title: '医技楼走廊保洁', category: 'demo_clean_daily', location: '医技楼 1 楼' },
    ],
    安保组: [
      { title: '住院部夜间安保巡查', category: 'demo_security_patrol', location: '住院部' },
      { title: '门诊楼消防通道巡查', category: 'demo_security_patrol', location: '门诊楼' },
      { title: '医技楼门禁异常', category: 'demo_security_patrol', location: '医技楼' },
    ],
  };
  const deptKeys = ['维修组', '维修组', '维修组', '保洁组', '安保组'];

  for (let i = 0; i < ORDERS; i += 1) {
    const status = statuses[i % statuses.length];
    const deptName = deptKeys[i % deptKeys.length];
    const deptId = depts[deptName];
    const pool = byDept[deptName] || workers;
    const worker = pool.length ? pool[i % pool.length] : null;
    const defs = defsByDept[deptName] || defsByDept.维修组;
    const def = defs[i % defs.length];
    const categoryCode = def.category;
    const categoryId = categories[categoryCode] || categoryCode;
    const title = def.title;
    const location = def.location;
    const needsWorker = !['pending_dispatch', 'cancelled'].includes(status);
    const assignee = needsWorker && worker ? worker.id : null;
    const id = crypto.randomUUID();
    const createdAt = new Date(Date.now() - (i % 30) * 86400000 - (i % 12) * 3600000);
    const slaDue = ['pending_dispatch', 'assigned', 'processing'].includes(status)
      ? new Date(Date.now() - (i % 5 === 0 ? 2 : -1) * 86400000)
      : null;
    const score = status === 'evaluated' ? (i % 3 === 0 ? 4 : 5) : null;
    const orderNo = `DEMO-${createdAt.toISOString().slice(0, 10).replace(/-/g, '')}-${String(i + 1).padStart(4, '0')}`;
    await db.query(
      `INSERT INTO work_orders
        (id,tenant_id,order_no,business_type,catalog,priority,location,title,description,contact,
         reporter_name,assets,status,source,fault_type,department_id,department_source,assignee_id,
         auto_flow,satisfaction_score,sla_due_at,ext,created_at,updated_at,def_version)
       VALUES ($1,$2,$3,'repair',$4,$5,$6,$7,$7,NULL,$8,'[]'::jsonb,$9,'backend',NULL,$10,'demo',$11,
               $12,$13,$14,$15::jsonb,$16,$16,0)`,
      [
        id, TENANT, orderNo, categoryId,
        i % 7 === 0 ? 'urgent' : 'normal',
        location,
        title,
        ['张三', '李四', '王五', '赵六'][i % 4],
        status, deptId, assignee,
        status !== 'pending_dispatch' && status !== 'cancelled',
        score, slaDue, JSON.stringify({ demo_seed: TAG }), createdAt,
      ],
    );
    await db.query(
      `INSERT INTO ticket_event (tenant_id,work_order_id,type,from_status,to_status,actor,payload)
       VALUES ($1,$2,'create',NULL,'draft','system','{}'::jsonb)`,
      [TENANT, id],
    );
    if (assignee) {
      await db.query(
        `INSERT INTO ticket_event (tenant_id,work_order_id,type,from_status,to_status,actor,payload)
         VALUES ($1,$2,'assign','draft',$3,'system',$4::jsonb)`,
        [TENANT, id, status, JSON.stringify({ worker_id: assignee, demo_seed: TAG })],
      );
    }
  }
}

async function refreshLoads(workers) {
  for (const w of workers) {
    await db.query(
      `UPDATE worker SET load = (
         SELECT count(*) FROM work_orders
          WHERE tenant_id=$1 AND assignee_id=$2
            AND status IN ('assigned','arrived','processing','transporting','accompanying','paused','suspended','pending_review','review_passed')
       ) WHERE tenant_id=$1 AND id=$2`,
      [TENANT, w.id],
    );
  }
}

async function summary() {
  const one = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].c);
  return {
    depts: await one(`SELECT count(*)::int c FROM dept WHERE tenant_id=$1 AND code LIKE 'DEMO\\_%' ESCAPE '\\'`, [TENANT]),
    workers: await one(`SELECT count(*)::int c FROM worker WHERE tenant_id=$1 AND id LIKE 'DEMO-W%'`, [TENANT]),
    rules: await one(`SELECT count(*)::int c FROM department_route_rule WHERE tenant_id=$1 AND name LIKE '[DEMO]%'`, [TENANT]),
    orders: await one(`SELECT count(*)::int c FROM work_orders WHERE tenant_id=$1 AND ext->>'demo_seed'=$2`, [TENANT, TAG]),
  };
}

main().catch(async (e) => {
  console.error('[seed] FAILED', e);
  try { await db.query('ROLLBACK'); } catch { /* ignore */ }
  await db.end().catch(() => {});
  process.exit(1);
});
