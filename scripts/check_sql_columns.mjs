#!/usr/bin/env node
// check_sql_columns.mjs —— 全仓 SQL 列存在性静态门禁（M0-1 C 件的口径扩到全仓）。
//
// 目的（对应批次三两起真实事故）：
//   事故① 071 把 settlement_item.work_order_id / work_acceptance.work_order_id 建成 uuid，
//          而 work_orders.id 是 **text 业务号**（001_init.sql:25）→ live 才炸 22P02。
//   事故② SQL 引用 `category` 而工单表实名 `catalog` → 线上 500。
//   共同根因：**没有任何门禁把「源码里的 SQL」与「迁移 DDL」对齐过**。
//
// 与 check_basicdata_columns.mjs 的关系：
//   原脚本只校验 basicData.ts 的 TYPES[].columns 白名单（D-07 复发防线）。
//   本脚本把口径扩到**全仓 src/**/*.ts 的真实 SQL 字符串**，并保留 basicData 的既有校验
//   （原脚本行为不动，本脚本是加宽，不是替代）。
//
// 用法：node scripts/check_sql_columns.mjs   （仓库根目录执行）
// 退出码：0 = 全部一致；1 = 存在列漂移 / 解析不到引用（防正则失效后空过）。
//
// 建议接入 releaseGate（由主会话接线，本脚本不改 package.json）：
//   node scripts/check_sql_columns.mjs || exit 1

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ==================== 一、解析迁移 DDL：table → Set(col)（+ 类型，供 text/uuid 断言）====================
const TABLE_CONSTRAINT_RE = /^(primary\s+key|unique|foreign\s+key|check|constraint|exclude|like)$/i;

function matchParen(sql, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let inQuote = false;
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") inQuote = !inQuote;
    if (!inQuote) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 0) {
        parts.push(buf);
        buf = '';
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** table → Map(col → type) */
const tables = new Map();
function addCol(table, col, type) {
  if (!tables.has(table)) tables.set(table, new Map());
  tables.get(table).set(col, type);
}

const sqlFiles = readdirSync(root).filter((f) => /^\d{3}[a-z]?_.*\.sql$/i.test(f)).sort();
for (const f of sqlFiles) {
  const raw = readFileSync(join(root, f), 'utf8');
  // 迁移文件是 CRLF：先统一换行符，否则逐行 `--.*$` 的 `.` 不吃 \r 会导致整行注释失配
  const sql = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');

  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_]\w*)\s*\(/gi;
  let m;
  while ((m = createRe.exec(sql)) !== null) {
    const table = m[1].toLowerCase();
    const open = createRe.lastIndex - 1;
    const close = matchParen(sql, open);
    if (close < 0) continue;
    for (const part of splitTopLevel(sql.slice(open + 1, close))) {
      const first = part.split(/\s+/)[0]?.toLowerCase() ?? '';
      if (!first || TABLE_CONSTRAINT_RE.test(first)) continue;
      addCol(table, first, (part.split(/\s+/)[1] ?? '').toLowerCase());
    }
    createRe.lastIndex = close + 1;
  }

  const addRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_]\w*)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_]\w*)\s+([^\s,;]+)/gi;
  while ((m = addRe.exec(sql)) !== null) addCol(m[1].toLowerCase(), m[2].toLowerCase(), m[3].toLowerCase());

  const dropRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_]\w*)\s+DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([a-zA-Z_]\w*)/gi;
  while ((m = dropRe.exec(sql)) !== null) tables.get(m[1].toLowerCase())?.delete(m[2].toLowerCase());

  const renRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_]\w*)\s+RENAME\s+(?:COLUMN\s+)?([a-zA-Z_]\w*)\s+TO\s+([a-zA-Z_]\w*)/gi;
  while ((m = renRe.exec(sql)) !== null) {
    const cols = tables.get(m[1].toLowerCase());
    if (cols?.has(m[2].toLowerCase())) {
      const t = cols.get(m[2].toLowerCase());
      cols.delete(m[2].toLowerCase());
      cols.set(m[3].toLowerCase(), t);
    }
  }
}

// ==================== 二、源码 SQL 抽取 ====================
const ALIAS_STOPWORDS = new Set([
  'where', 'on', 'group', 'order', 'limit', 'offset', 'having', 'set', 'values', 'returning',
  'left', 'right', 'inner', 'outer', 'cross', 'full', 'join', 'using', 'union', 'for', 'as',
  'and', 'or', 'not', 'null', 'select', 'insert', 'update', 'delete', 'when', 'then', 'else',
  'end', 'case', 'asc', 'desc', 'into', 'from', 'exists', 'distinct', 'with', 'lateral',
]);

function extractSqlStrings(src) {
  const out = [];
  const push = (s) => {
    // 收紧点①：`select` 后必须跟空白+列/星号（`select\s+[\w*]`）。
    // 早期版本用裸 `select` 判定，把 LLM 提示词里的 "text|select|number"（llm.ts gen-config）
    // 误当 SQL 字符串，整段提示词进入校验管线后层层误报。
    if (/\b(select\s+[\w*]|insert\s+into\s+\w|update\s+[a-z_]\w*\s+set|delete\s+from\s+\w)/i.test(s)) out.push(s);
  };
  let m;
  const tl = /`((?:[^`\\]|\\.)*)`/g;
  while ((m = tl.exec(src)) !== null) push(m[1]);
  const sq = /'((?:[^'\\\n]|\\.)*)'/g;
  while ((m = sq.exec(src)) !== null) push(m[1]);
  const dq = /"((?:[^"\\\n]|\\.)*)"/g;
  while ((m = dq.exec(src)) !== null) push(m[1]);
  return out;
}

/**
 * 模板插值占位符。
 * 注意：早期版本把它替换成 `_`，而 `_` 恰好能通过 `/^[a-z_]\w*$/` 的合法标识符检查，
 * 导致 `INSERT INTO asset (${cols.join(', ')})` 被误报成「表 asset 无列 _」。
 * 现改为不可能与真列名冲突的哨兵，解析阶段显式跳过并计数（诚实记录，不静默放行）。
 */
const DYN = '__dyn__';

/** 抽取某文件的「表引用」与「列引用」。 */
function extractRefs(src) {
  const tableRefs = new Set();
  const colRefs = []; // { table, column, snippet }
  let dynamicCols = 0; // 动态拼装的列（静态不可校验），单独计数并在报告里披露
  const seen = new Set();
  const addCol = (table, column, snippet) => {
    if (column.startsWith(DYN.slice(0, -2))) {
      dynamicCols += 1; // 模板拼装列：静态无法判定，跳过而非误报
      return;
    }
    const key = `${table}.${column}`;
    if (seen.has(key)) return;
    seen.add(key);
    colRefs.push({ table, column, snippet });
  };

  for (const sql of extractSqlStrings(src)) {
    const clean = sql.replace(/\$\{[^}]*\}/g, ` ${DYN} `);

    const aliasToTable = new Map();
    const fromRe = /\b(?:from|join|into|update)\s+([a-zA-Z_]\w*)\s*(?:(?:as)\s+)?([a-zA-Z_]\w*)?/gi;
    let m;
    while ((m = fromRe.exec(clean)) !== null) {
      const table = m[1].toLowerCase();
      if (ALIAS_STOPWORDS.has(table)) continue;
      tableRefs.add(table);
      aliasToTable.set(table, table);
      const alias = (m[2] ?? '').toLowerCase();
      if (alias && !ALIAS_STOPWORDS.has(alias)) aliasToTable.set(alias, table);
    }

    const dotRe = /\b([a-zA-Z_]\w*)\s*\.\s*([a-zA-Z_]\w*)\b/g;
    while ((m = dotRe.exec(clean)) !== null) {
      const table = aliasToTable.get(m[1].toLowerCase());
      if (!table) continue;
      const col = m[2].toLowerCase();
      if (col === '*' || /^\d/.test(col)) continue;
      addCol(table, col, `${m[1]}.${m[2]}`);
    }

    const insRe = /\binsert\s+into\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)/gi;
    while ((m = insRe.exec(clean)) !== null) {
      const table = m[1].toLowerCase();
      tableRefs.add(table);
      for (const part of m[2].split(',')) {
        const col = part.trim().toLowerCase();
        if (col && /^[a-z_]\w*$/.test(col)) addCol(table, col, `INSERT INTO ${m[1]}(${col})`);
      }
    }

    const updRe = /\bupdate\s+([a-zA-Z_]\w*)\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|$)/gi;
    while ((m = updRe.exec(clean)) !== null) {
      const table = m[1].toLowerCase();
      tableRefs.add(table);
      const assignRe = /(?:^|,)\s*([a-z_]\w*)\s*=/gi;
      let a;
      while ((a = assignRe.exec(m[2])) !== null) addCol(table, a[1].toLowerCase(), `UPDATE ${m[1]} SET ${a[1]}`);
    }
  }
  return { tableRefs, colRefs, dynamicCols };
}

// ==================== 三、扫描 src/**/*.ts ====================
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const problems = [];
let scanned = 0;      // 含 SQL 的文件数
let colChecks = 0;    // 实际校验的列引用数
let dynamicColTotal = 0; // 模板拼装的动态列数（静态不可校验，报告披露）
let skippedTables = new Set();
let skippedFiles = 0;

for (const file of walk(join(root, 'src'))) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(root, file).replace(/\\/g, '/');
  // hasSQL 判定必须基于「抽出来的 SQL **字符串**」，不能对整份源码正则：
  //   注释里写 `// 来源为 SELECT * FROM work_orders ...` 也会被整文件正则命中（assetHistory.ts 事故）。
  //   SQL 一定以字符串字面量传给 query()，字符串里没有 → 就是没有。
  const sqlStrings = extractSqlStrings(src);
  if (sqlStrings.length === 0) {
    skippedFiles += 1;
    continue; // 无 SQL 的文件（纯逻辑/类型/注释里的 SQL）不参与
  }
  scanned += 1;
  const { tableRefs, colRefs, dynamicCols } = extractRefs(src);
  dynamicColTotal += dynamicCols;

  // 防正则失效：SQL 里出现了表操作对象却一个表引用都抽不到 → 判失败（不能空过）。
  // 两点边界：
  //   a) 无 FROM 的 SELECT 是合法写法且天然无表（SELECT pg_try_advisory_lock($1) /
  //      SELECT log_llm_call(...) 这类函数调用式查询），不应误报。
  //   b) 收紧点②：表操作词后必须跟空白+标识符/引号（PG 引号表名）。
  //      JSON 提示词里的 "from":"draft"（from 后是引号+冒号形态）不应命中。
  const hasTableOp = sqlStrings.some((s) => /\b(?:from|join|into|update|delete)\s+[a-zA-Z_"]/i.test(s));
  if (tableRefs.size === 0 && hasTableOp) {
    problems.push(`${rel}：SQL 含表操作（FROM/JOIN/INTO/UPDATE/DELETE）但抽取不到任何表引用（正则失配？）`);
    continue;
  }

  for (const r of colRefs) {
    const cols = tables.get(r.table);
    if (!cols) {
      skippedTables.add(r.table); // 视图/CTE/动态表名，无法校验，仅记录
      continue;
    }
    colChecks += 1;
    if (!cols.has(r.column)) {
      problems.push(`${rel}：${r.snippet} → 表 ${r.table} 无列 ${r.column}`);
    }
  }
}

// ==================== 四、basicData.ts 白名单列校验（沿用原脚本口径）====================
const bdSrc = readFileSync(join(root, 'src/routes/basicData.ts'), 'utf8');
const typesStart = bdSrc.indexOf('const TYPES');
const typesBlock = bdSrc.slice(typesStart, bdSrc.indexOf('\n};', typesStart));
const declared = new Map();
const typeRe = /table:\s*'(\w+)',\s*columns:\s*\[([^\]]+)\]/g;
let m2;
while ((m2 = typeRe.exec(typesBlock)) !== null) {
  const table = m2[1];
  if (!declared.has(table)) declared.set(table, new Set());
  for (const c of m2[2].split(',')) {
    const col = c.trim().replace(/^['"]|['"]$/g, '');
    if (col) declared.get(table).add(col);
  }
}
if (declared.size === 0) {
  problems.push('src/routes/basicData.ts：未能解析到任何 TYPES 声明（正则失配？）');
}
for (const [table, cols] of declared) {
  const eff = tables.get(table);
  if (!eff) {
    problems.push(`basicData 表 ${table}：在任何迁移 DDL 中都未找到定义`);
    continue;
  }
  for (const col of cols) {
    if (!eff.has(col)) problems.push(`basicData 表 ${table}：白名单声明列 "${col}" 不存在于迁移 DDL（重演 D-07 必 500）`);
  }
}

// ==================== 五、事故① 专项：关联工单的列必须是 text 业务号 ====================
const TEXT_COLUMN_CONTRACT = [
  ['work_orders', 'id'],
  ['settlement_item', 'work_order_id'],
  ['work_acceptance', 'work_order_id'],
];
for (const [table, col] of TEXT_COLUMN_CONTRACT) {
  const t = tables.get(table)?.get(col);
  if (t !== 'text') {
    problems.push(
      `类型契约：${table}.${col} 应为 text（与 work_orders.id 业务号同型），实际为 ${t ?? '(未找到)'}`,
    );
  }
}

// ==================== 六、报告 ====================
console.log(
  `[check_sql_columns] 迁移文件=${sqlFiles.length}，表=${tables.size}；` +
    `扫描 src 文件=${scanned}（无 SQL 跳过 ${skippedFiles}）；校验列引用=${colChecks}；` +
    `动态列（模板拼装，未静态校验）=${dynamicColTotal}；basicData 类型=${declared.size}`,
);
// 未知表豁免清单（2026-09-06 盲区收敛）：清单内的表允许"迁移中无 DDL"静默跳过，每项必须给理由；
// 清单外的未知表一律 FAIL——防未来的视图/CTE/动态表名悄悄绕过列契约校验（openapiCoverage 同款门禁模式）。
const KNOWN_SKIPPED_TABLES = new Map([
  // _migrations：迁移登记工具表，由初始化通道建立且 DDL 不在业务迁移文件中，列引用均为静态字面量。
  ['_migrations', '迁移登记工具表，DDL 不在业务迁移文件中，由初始化通道建立'],
]);
if (skippedTables.size > 0) {
  const unknown = [...skippedTables].filter((t) => !KNOWN_SKIPPED_TABLES.has(t));
  const exempted = [...skippedTables].filter((t) => KNOWN_SKIPPED_TABLES.has(t));
  if (exempted.length > 0) {
    console.log(
      `[check_sql_columns] 豁免未校验（在清单内，理由见脚本）：${exempted.sort().join(', ')}`,
    );
  }
  if (unknown.length > 0) {
    problems.push(
      `未知表无法校验列契约（不在豁免清单）：${unknown.sort().join(', ')}——` +
        `如是视图/CTE/动态表名，请在 KNOWN_SKIPPED_TABLES 登记并注明理由`,
    );
  }
}
if (problems.length > 0) {
  console.error(`[check_sql_columns] FAIL —— ${problems.length} 处列漂移：`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('[check_sql_columns] PASS —— 全部 SQL 列引用均命中迁移 DDL');
