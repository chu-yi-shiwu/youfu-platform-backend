#!/usr/bin/env node
// workflow_def 到场态（arrived）补丁主脚本（2026-09-06 任务⑤）
//
// 用途：代码里 RICH_WORK_ORDER_DEF 已支持 arrived，但存量租户 workflow_def.def（jsonb）仍是旧图，
// arrived 边不生效。本脚本对全量租户逐行 JSON 增量打补丁（异构图防御：只增不改不删，绝不整体替换）。
//
// 运行环境：ECS CentOS7，root 执行，psql 走 `sudo -u postgres psql`（可用 PSQL_CMD 覆盖，
//   如 `PSQL_CMD=psql` 或 `PSQL_CMD="psql -h 127.0.0.1 -U postgres"`；库名默认 youfu，可用 PGDATABASE 覆盖）。
// 零 npm 依赖：仅 node 内置 child_process + fs + 纯函数核心（./wfdef_arrived_patch_core.mjs）。
//
// 用法：
//   node wfdef_arrived_patch_20260906.mjs --dry-run   # 只打印将改动的行与 diff，不写库
//   node wfdef_arrived_patch_20260906.mjs             # 备份（幂等跳过）+ 打补丁 + 输出改动摘要
// 幂等：重复跑不重复插入（边按 from/event/to 判重，states 按 arrived 存在性判重）。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsArrivedPatch, patchWorkflowDefRows } from './wfdef_arrived_patch_core.mjs';

const BACKUP_TABLE = 'workflow_def_backup_20260906';
const dryRun = process.argv.includes('--dry-run');

// psql 命令：默认 sudo -u postgres psql；PSQL_CMD 环境变量可整体覆盖（按空白切分）。
const psqlArgs = (process.env.PSQL_CMD || 'sudo -u postgres psql').trim().split(/\s+/);
const database = process.env.PGDATABASE || 'youfu';

/** 执行一条/一段 SQL：-qAt 静默元组输出、ON_ERROR_STOP 出错即停（不做半截补丁）。 */
function psql(sql, { outFile } = {}) {
  const args = [...psqlArgs, '-d', database, '-v', 'ON_ERROR_STOP=1', '-qAt'];
  if (outFile) {
    args.push('-f', outFile);
  } else {
    args.push('-c', sql);
  }
  return execFileSync(args[0], args.slice(1), { encoding: 'utf8' });
}

/** SQL 字符串字面量转义（单引号翻倍）。 */
function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

console.log(`[wfdef-arrived-patch] dry-run=${dryRun} db=${database} psql="${psqlArgs.join(' ')}"`);

// ── 1. 备份（幂等：表已存在则跳过）─────────────────────────────────────────────
const backupExists = psql(`SELECT to_regclass('public.${BACKUP_TABLE}') IS NOT NULL;`).trim() === 't';
if (backupExists) {
  console.log(`[backup] ${BACKUP_TABLE} 已存在，跳过（幂等）`);
} else if (dryRun) {
  console.log(`[backup] dry-run：将执行 CREATE TABLE ${BACKUP_TABLE} AS SELECT * FROM workflow_def;`);
} else {
  psql(`CREATE TABLE ${BACKUP_TABLE} AS SELECT * FROM workflow_def;`);
  console.log(`[backup] 已创建 ${BACKUP_TABLE}（全量快照，含 RLS 前数据面，仅供对账回滚参考）`);
}

// ── 2. 拉取全部 workflow_def 行（json_agg 单值输出，规避 TSV 分隔符歧义）────────
const raw = psql(
  `SELECT COALESCE(json_agg(row_to_json(q))::text, '[]'::text)
     FROM (SELECT tenant_id, entity_type, version, def FROM workflow_def ORDER BY tenant_id, entity_type) q;`,
).trim();
const rows = JSON.parse(raw);
console.log(`[scan] workflow_def 共 ${rows.length} 行`);

// ── 3. 逐行补丁（纯函数核心）──────────────────────────────────────────────────
const { patched, unchanged } = patchWorkflowDefRows(rows);
const candidates = rows.filter((r) => {
  let def = r.def;
  if (typeof def === 'string') {
    try {
      def = JSON.parse(def);
    } catch {
      return false;
    }
  }
  return needsArrivedPatch(def);
});
console.log(`[scan] 命中补丁条件（states 含 assigned+processing 且无 arrived）：${candidates.length} 行；无需改动：${unchanged} 行`);

if (patched.length === 0) {
  console.log('[done] 无需改动（可能已全部补过或均不满足条件），退出 0');
  process.exit(0);
}

// ── 4. 摘要输出（dry-run 与实跑共用同一份 diff 打印）──────────────────────────
for (const p of patched) {
  console.log(
    `[patch] tenant=${p.tenant_id} entity=${p.entity_type} version=${p.version_before}→${p.version_before + 1} ` +
      `states=[${p.statesBefore.join(',')}] → [${p.statesAfter.join(',')}] 新增边=${p.addedEdges}`,
  );
}

if (dryRun) {
  console.log(`[done] dry-run 结束：将改动 ${patched.length} 行，未写库`);
  process.exit(0);
}

// ── 5. 生成 UPDATE 语句写库（dollar-quoting 防注入；version 自增、updated_at 刷新）──
// 每条语句独立 dollar-quote 标签；标签撞车（JSON 文本恰含 $tag$）则追加 x 后缀直至安全。
function dollarQuote(json, seed) {
  let tag = seed;
  while (json.includes(`$${tag}$`)) tag = `${tag}x`;
  return `$${tag}$${json}$${tag}$`;
}
const stmts = patched.map((p, i) => {
  const json = JSON.stringify(p.def_after);
  return (
    `UPDATE workflow_def SET def = ${dollarQuote(json, `wfpatch${i}`)}::jsonb, ` +
    `version = version + 1, updated_at = now() ` +
    `WHERE tenant_id = ${q(p.tenant_id)} AND entity_type = ${q(p.entity_type)};`
  );
});

const tmp = mkdtempSync(join(tmpdir(), 'wfpatch-'));
// sudo -u postgres psql 需要读该文件：mkdtemp 默认 0700（仅 root 可入），放开为 0755/0644
chmodSync(tmp, 0o755);
const sqlFile = join(tmp, 'patch.sql');
writeFileSync(sqlFile, stmts.join('\n'), 'utf8');
chmodSync(sqlFile, 0o644);
try {
  psql('', { outFile: sqlFile });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`[done] 已更新 ${patched.length} 行（version 各 +1）。回滚参考：${BACKUP_TABLE} 快照 + 对账 SQL tools/wfdef_arrived_patch_20260906.sql`);
