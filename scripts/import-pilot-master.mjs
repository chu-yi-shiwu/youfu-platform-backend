// 试点主数据 CSV 导入（2026-11-09）
//
// 目的：医院不会手工录入几十个部门/位置/目录/人员/路由规则。本脚本支持从 CSV 一次性导入，
// 默认 dry-run，只有显式 --apply 才写库。
//
// 用法（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=.env \
//     /opt/node16/bin/node <本脚本路径> --tenant=zixing-hospital --dir=/tmp/pilot-master
//   ... --apply
//
// 文件（可缺省，缺省则跳过）：
//   departments.csv       name,code,is_default
//   locations.csv         code,name,category
//   fault_categories.csv  code,name,business_type,skill_tags,sort
//   workers.csv           id,name,department_code,skill_tags,phone
//   route_rules.csv       name,priority,department_code,business_type,catalog_code,catalog_name_contains,location_name_contains,description_contains,source
//   contacts.csv          name,phone,email,org,dept,remark
//
// 约定：按 code/id/name 幂等 upsert；不删除未出现在 CSV 里的数据；不建账号、不改密码。
// contacts 例外：按 CSV 中出现的非空 remark 分组先删后插，便于整批电话簿重导。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const { Client } = pg;
const args = process.argv.slice(2);
const arg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const TENANT = arg('tenant', process.env.PILOT_TENANT || 'zixing-hospital');
const DIR = arg('dir', 'pilot-master');
const APPLY = args.includes('--apply');

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

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // ignore
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((h) => h.trim().replace(/^\uFEFF/, ''));
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, String(r[i] ?? '').trim()])));
}

function readFile(name) {
  const p = join(DIR, name);
  if (!existsSync(p)) return [];
  return parseCsv(readFileSync(p, 'utf8'));
}

const errors = [];
const fail = (file, line, msg) => errors.push(`${file}:${line} ${msg}`);
const bool = (v) => /^(1|true|yes|y|是)$/i.test(String(v || ''));
const list = (v) => (v ? v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : []);

async function main() {
  if (!existsSync(DIR)) {
    console.error(`[import] 目录不存在: ${DIR}`);
    process.exit(2);
  }
  await db.connect();
  await db.query('BEGIN');
  await db.query(
    `SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`,
    [TENANT],
  );

  const departments = readFile('departments.csv');
  const locations = readFile('locations.csv');
  const categories = readFile('fault_categories.csv');
  const workers = readFile('workers.csv');
  const rules = readFile('route_rules.csv');
  const contacts = readFile('contacts.csv');

  // 读取已有部门 code → id
  const existingDepts = new Map();
  for (const r of (await db.query('SELECT id,code FROM dept WHERE tenant_id=$1', [TENANT])).rows) {
    if (r.code) existingDepts.set(r.code, r.id);
  }
  const deptCodeSet = new Set([...existingDepts.keys()]);
  departments.forEach((d, i) => { if (!d.name) fail('departments.csv', i + 2, 'name 必填'); if (d.code) deptCodeSet.add(d.code); });
  for (const w of workers) {
    if (!w.id) fail('workers.csv', 0, 'id 必填');
    if (!w.name) fail('workers.csv', 0, `worker ${w.id} name 必填`);
    if (w.department_code && !deptCodeSet.has(w.department_code)) fail('workers.csv', 0, `未知部门 code: ${w.department_code}`);
  }
  for (const r of rules) {
    if (!r.name) fail('route_rules.csv', 0, 'name 必填');
    if (!r.department_code || !deptCodeSet.has(r.department_code)) fail('route_rules.csv', 0, `未知部门 code: ${r.department_code || '(空)'}`);
    const matchKeys = ['business_type', 'catalog_code', 'catalog_name_contains', 'location_name_contains', 'description_contains', 'source'];
    if (!matchKeys.some((k) => r[k])) fail('route_rules.csv', 0, `规则 ${r.name} 至少需要一个匹配条件`);
  }
  contacts.forEach((c, i) => {
    if (!c.name) fail('contacts.csv', i + 2, 'name 必填');
    if (c.phone && !/^[\d+\-*#/ ]{3,}$/.test(c.phone)) fail('contacts.csv', i + 2, `电话格式异常: ${c.phone}`);
  });

  if (errors.length) {
    console.error(`[import] 校验失败 ${errors.length} 项：`);
    errors.slice(0, 50).forEach((e) => console.error('  - ' + e));
    await db.query('ROLLBACK');
    await db.end();
    process.exit(1);
  }

  const summary = { depts: 0, locations: 0, categories: 0, workers: 0, rules: 0, contacts: 0 };
  if (!APPLY) {
    summary.depts = departments.length;
    summary.locations = locations.length;
    summary.categories = categories.length;
    summary.workers = workers.length;
    summary.rules = rules.length;
    summary.contacts = contacts.length;
    console.log('[import] DRY-RUN（未写库）', JSON.stringify({ tenant: TENANT, ...summary }));
    console.log('[import] 加 --apply 才会真正写入。');
    await db.query('ROLLBACK');
    await db.end();
    return;
  }

  // 部门
  for (const d of departments) {
    const isDefault = bool(d.is_default);
    const found = d.code ? await db.query('SELECT id FROM dept WHERE tenant_id=$1 AND code=$2 LIMIT 1', [TENANT, d.code]) : { rowCount: 0, rows: [] };
    let id;
    if (found.rowCount) {
      id = found.rows[0].id;
      await db.query('UPDATE dept SET name=$1, remark=COALESCE($2,remark), updated_at=now() WHERE tenant_id=$3 AND id=$4',
        [d.name, d.remark || null, TENANT, id]);
    } else {
      const r = await db.query(
        'INSERT INTO dept (tenant_id,name,code,remark,is_default) VALUES ($1,$2,$3,$4,false) RETURNING id',
        [TENANT, d.name, d.code || null, d.remark || null],
      );
      id = r.rows[0].id;
      if (d.code) deptCodeSet.add(d.code);
      if (d.code) existingDepts.set(d.code, id);
    }
    if (isDefault) {
      await db.query('UPDATE dept SET is_default=false WHERE tenant_id=$1 AND is_default=true AND id<>$2', [TENANT, id]);
      await db.query('UPDATE dept SET is_default=true WHERE tenant_id=$1 AND id=$2', [TENANT, id]);
    }
    if (d.code) existingDepts.set(d.code, id);
    summary.depts += 1;
  }

  // 位置
  for (const l of locations) {
    if (!l.code || !l.name) { fail('locations.csv', 0, 'code/name 必填'); continue; }
    await db.query(
      `INSERT INTO location_dict (tenant_id,code,name,category,enabled)
       VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (tenant_id,code) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, enabled=true`,
      [TENANT, l.code, l.name, l.category || null],
    );
    summary.locations += 1;
  }

  // 问题目录
  for (const c of categories) {
    if (!c.code || !c.name) { fail('fault_categories.csv', 0, 'code/name 必填'); continue; }
    let tags = c.skill_tags;
    if (tags) {
      try { tags = JSON.parse(tags); } catch { tags = list(tags); }
    } else {
      tags = [];
    }
    await db.query(
      `INSERT INTO fault_category (tenant_id,code,name,sort,enabled,business_type,skill_tags)
       VALUES ($1,$2,$3,$4,true,$5,$6::jsonb)
       ON CONFLICT (tenant_id,code) DO UPDATE SET name=EXCLUDED.name, sort=EXCLUDED.sort,
         enabled=true, business_type=EXCLUDED.business_type, skill_tags=EXCLUDED.skill_tags`,
      [TENANT, c.code, c.name, Number(c.sort) || 0, c.business_type || null, JSON.stringify(tags)],
    );
    summary.categories += 1;
  }

  // 人员（只建档，不建账号）
  for (const w of workers) {
    const deptId = w.department_code ? existingDepts.get(w.department_code) : null;
    await db.query(
      `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,department_id,phone)
       VALUES ($1,$2,$3,$4::text[],0,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, skill_tags=EXCLUDED.skill_tags,
         active=EXCLUDED.active, department_id=EXCLUDED.department_id, phone=EXCLUDED.phone`,
      [w.id, TENANT, w.name, list(w.skill_tags), !/^(0|false|no|停用)$/i.test(w.active || 'true'), deptId, w.phone || null],
    );
    summary.workers += 1;
  }

  // 路由规则：按 name 覆盖（仅覆盖 CSV 中出现的 name，不动其它规则）
  for (const r of rules) {
    const deptId = existingDepts.get(r.department_code);
    const match = {};
    for (const k of ['business_type', 'catalog_code', 'catalog_name_contains', 'location_name_contains', 'description_contains', 'source']) {
      if (r[k]) match[k] = r[k];
    }
    await db.query('DELETE FROM department_route_rule WHERE tenant_id=$1 AND name=$2', [TENANT, r.name]);
    await db.query(
      `INSERT INTO department_route_rule (tenant_id,name,priority,enabled,match_json,department_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [TENANT, r.name, Number(r.priority) || 100, !/^(0|false|no|停用)$/i.test(r.enabled || 'true'), JSON.stringify(match), deptId],
    );
    summary.rules += 1;
  }

  // 联系人：按 remark 分组整批替换；remark 为空的行只追加，不删除任何数据
  const remarks = [...new Set(contacts.map((c) => c.remark).filter(Boolean))];
  for (const remark of remarks) {
    await db.query('DELETE FROM contact WHERE tenant_id=$1 AND remark=$2', [TENANT, remark]);
  }
  for (const c of contacts) {
    await db.query(
      `INSERT INTO contact (tenant_id,name,phone,email,org,dept,remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [TENANT, c.name, c.phone || null, c.email || null, c.org || null, c.dept || null, c.remark || null],
    );
    summary.contacts += 1;
  }

  if (errors.length) {
    console.error('[import] 写入过程中出现错误，事务回滚：');
    errors.slice(0, 50).forEach((e) => console.error('  - ' + e));
    await db.query('ROLLBACK');
    await db.end();
    process.exit(1);
  }

  await db.query('COMMIT');
  console.log('[import] APPLY 完成', JSON.stringify({ tenant: TENANT, ...summary }));
  await db.end();
}

main().catch(async (e) => {
  console.error('[import] FAILED', e.message || e);
  try { await db.query('ROLLBACK'); } catch { /* ignore */ }
  await db.end().catch(() => {});
  process.exit(1);
});
