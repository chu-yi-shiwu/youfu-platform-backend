import pg from 'pg';
const { Client } = pg;
const c = new Client({ host:'8.136.107.153', port:5432, user:'postgres', password:'youfu2026', database:'youfu' });
await c.connect();
const r = await c.query(`
SELECT w.id AS wid, w.name, w.account_id,
  (SELECT a.id FROM account_user a WHERE a.tenant_id='t-verification' AND a.id = w.id LIMIT 1) AS same_id_acct,
  (SELECT a.wx_openid FROM account_user a WHERE a.tenant_id='t-verification' AND (a.id=w.account_id OR a.id=w.id) LIMIT 1) AS wx_openid
FROM worker w WHERE w.tenant_id='t-verification' ORDER BY w.id;
`);
console.log('count=', r.rowCount);
for (const row of r.rows) {
  console.log(JSON.stringify(row));
}
await c.end();
