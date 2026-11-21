// Tenant data migration: source DB -> target DB, tenant-scoped, fail-closed.
// Usage (on the DB host, as postgres peer):
//   sudo -u postgres env NODE_PATH=/opt/youfu/backend/node_modules node scripts/migrate-tenant-data.cjs \
//     --source-db youfu_pilot --target-db youfu_migrate_dryrun --tenant zixing-hospital --execute
//   add --production when target-db=youfu; add --replace for a controlled resync.
// Default is a read-only plan. AI/inference logs, model state and idempotency keys are intentionally skipped.
const fs = require('fs');
const pg = require('pg');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const SOURCE_DB = arg('--source-db', 'youfu_pilot');
const TARGET_DB = arg('--target-db');
const TENANT = arg('--tenant', 'zixing-hospital');
const EXECUTE = process.argv.includes('--execute');
const PRODUCTION = process.argv.includes('--production');
const REPLACE = process.argv.includes('--replace');
// Transient/AI tables are intentionally not migrated: model state, inference logs,
// embeddings and idempotency replay keys belong to the runtime environment, not tenant business data.
const SKIP_TABLES = new Set([
  'ai_case_embeddings',
  'ai_conversation',
  'ai_conversation_turn',
  'ai_feedback',
  'ai_inference_log',
  'ai_shadow_suggestions',
  'idempotency_key',
  'llm_call_log',
  'model_state',
  'optimization_feedback',
]);
if (!TARGET_DB) {
  console.error('missing --target-db');
  process.exit(2);
}
if (EXECUTE && TARGET_DB === 'youfu' && !PRODUCTION) {
  console.error('refusing to write main DB without --production');
  process.exit(2);
}

function client(db) {
  return new pg.Client({ database: db, user: 'postgres', host: process.env.PGHOST_SOCKET || '/run/postgresql' });
}

async function tenantTables(c) {
  const r = await c.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='tenant_id'
      ORDER BY table_name`,
  );
  return r.rows.map((x) => x.table_name);
}

async function topoOrder(c, tables) {
  const set = new Set(tables);
  const fks = await c.query(`
    SELECT child.relname AS child, parent.relname AS parent
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE con.contype='f' AND n.nspname='public'
      AND child.relname = ANY($1)
      AND parent.relname = ANY($1)
  `, [tables]);
  const indeg = new Map(tables.map((t) => [t, 0]));
  const children = new Map(tables.map((t) => [t, []]));
  for (const { child, parent } of fks.rows) {
    if (child === parent) continue;
    if (!set.has(child) || !set.has(parent)) continue;
    children.get(parent).push(child);
    indeg.set(child, (indeg.get(child) || 0) + 1);
  }
  const q = tables.filter((t) => (indeg.get(t) || 0) === 0).sort();
  const order = [];
  while (q.length) {
    const t = q.shift();
    order.push(t);
    for (const ch of children.get(t).sort()) {
      indeg.set(ch, indeg.get(ch) - 1);
      if (indeg.get(ch) === 0) q.push(ch);
    }
  }
  if (order.length !== tables.length) {
    const left = tables.filter((t) => !order.includes(t));
    throw new Error('FK cycle among tenant tables: ' + left.join(','));
  }
  return { order, edges: fks.rowCount };
}

async function columns(c, table) {
  const r = await c.query(
    `SELECT column_name, data_type, is_identity, is_generated, column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position`,
    [table],
  );
  return r.rows;
}

(async () => {
  const src = client(SOURCE_DB);
  const dst = client(TARGET_DB);
  await src.connect();
  await dst.connect();

  const allTables = await tenantTables(src);
  const tables = allTables.filter((t) => !SKIP_TABLES.has(t));
  const skipped = allTables.filter((t) => SKIP_TABLES.has(t));
  const { order, edges } = await topoOrder(src, tables);

  await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const data = new Map();
  for (const table of order) {
    const r = await src.query(`SELECT * FROM "${table}" WHERE tenant_id=$1`, [TENANT]);
    data.set(table, r.rows);
  }
  await src.query('COMMIT');

  const pre = [];
  for (const table of order) {
    const r = await dst.query(`SELECT count(*)::int AS c FROM "${table}" WHERE tenant_id=$1`, [TENANT]);
    pre.push({ table, targetRows: r.rows[0].c });
  }
  const dirty = pre.filter((x) => x.targetRows !== 0);
  if (dirty.length && !REPLACE) {
    throw new Error('target tenant already has rows (use --replace for a controlled resync): ' + JSON.stringify(dirty.slice(0, 10)));
  }

  if (!EXECUTE) {
    console.log(JSON.stringify({ mode: 'plan', source: SOURCE_DB, target: TARGET_DB, tenant: TENANT, tables: tables.length, skipped, fkEdges: edges, rows: [...data.values()].reduce((n, r) => n + r.length, 0), order }, null, 2));
    await src.end();
    await dst.end();
    return;
  }

  await dst.query('BEGIN');
  const inserted = [];
  try {
    if (REPLACE) {
      for (const table of [...order].reverse()) {
        await dst.query(`DELETE FROM "${table}" WHERE tenant_id=$1`, [TENANT]);
      }
    }
    for (const table of order) {
      const rows = data.get(table) || [];
      if (rows.length === 0) {
        inserted.push({ table, rows: 0 });
        continue;
      }
      const targetCols = await columns(dst, table);
      const typeByCol = new Map(targetCols.map((c) => [c.column_name, c.data_type]));
      const colNames = targetCols
        .filter((c) => c.is_identity !== 'YES' && c.is_generated !== 'ALWAYS')
        // Serial PKs are environment-local: let the target sequence allocate new IDs.
        // No tenant table has an FK pointing at these serial PKs (verified).
        .filter((c) => !/^nextval\(/i.test(c.column_default || ''))
        .map((c) => c.column_name);
      const srcCols = new Set(Object.keys(rows[0]));
      const cols = colNames.filter((c) => srcCols.has(c));
      if (cols.length === 0) throw new Error(`no common columns for ${table}`);
      const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const values = cols.map((c) => {
          const v = row[c];
          const t = typeByCol.get(c);
          if ((t === 'json' || t === 'jsonb') && v !== null && typeof v !== 'string') {
            return JSON.stringify(v);
          }
          return v;
        });
        try {
          await dst.query(sql, values);
        } catch (e) {
          throw new Error(`${table} row ${i + 1}: ${e.message}`);
        }
      }
      inserted.push({ table, rows: rows.length });
    }
    await dst.query('COMMIT');
  } catch (e) {
    await dst.query('ROLLBACK');
    throw e;
  }

  const validation = [];
  for (const table of order) {
    const s = await src.query(`SELECT count(*)::int AS c FROM "${table}" WHERE tenant_id=$1`, [TENANT]);
    const t = await dst.query(`SELECT count(*)::int AS c FROM "${table}" WHERE tenant_id=$1`, [TENANT]);
    validation.push({ table, source: s.rows[0].c, target: t.rows[0].c, ok: s.rows[0].c === t.rows[0].c });
  }
  const bad = validation.filter((x) => !x.ok);
  if (bad.length) throw new Error('count mismatch: ' + JSON.stringify(bad));

  const report = {
    mode: 'execute',
    source: SOURCE_DB,
    target: TARGET_DB,
    tenant: TENANT,
    tables: tables.length,
    skipped,
    fkEdges: edges,
    insertedRows: inserted.reduce((n, x) => n + x.rows, 0),
    validation,
    checks: {
      tenant: (await dst.query('SELECT count(*)::int AS c FROM tenant_registry WHERE tenant_id=$1', [TENANT])).rows[0].c,
      dept: (await dst.query('SELECT count(*)::int AS c FROM dept WHERE tenant_id=$1', [TENANT])).rows[0].c,
      accounts: (await dst.query('SELECT count(*)::int AS c FROM account_user WHERE tenant_id=$1', [TENANT])).rows[0].c,
      workers: (await dst.query('SELECT count(*)::int AS c FROM worker WHERE tenant_id=$1', [TENANT])).rows[0].c,
      workOrders: (await dst.query('SELECT count(*)::int AS c FROM work_orders WHERE tenant_id=$1', [TENANT])).rows[0].c,
    },
  };
  fs.writeFileSync('/tmp/migrate_tenant_report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, validation: undefined, checks: report.checks }));
  console.log('out=/tmp/migrate_tenant_report.json');
  await src.end();
  await dst.end();
})().catch((e) => {
  console.error('MIGRATION ERROR', e.message);
  process.exit(1);
});
