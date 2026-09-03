#!/usr/bin/env node
// check_basicdata_columns.mjs —— M0-1 C 件：基础数据列声明静态门禁。
//
// 目的（对应 2026-09-03 全量审查 D-07 复发防线）：
//   basicData.ts 的 TYPES[t].columns 白名单若声明了数据库不存在的列，
//   更新路径拼出 `SET updated_at = now()` 之类语句即 500（D-07 根因正是
//   白名单声明 updated_at 而 047 建 4 表无此列）。
//   本脚本静态解析迁移 DDL 与 basicData.ts，校验「声明的列 ⊆ 全部迁移累加后的有效列」，
//   违例即 exit 1，可挂 CI / releaseGate / pre-commit。
//
// 用法：node scripts/check_basicdata_columns.mjs   （仓库根目录执行）
// 退出码：0 = 全部一致；1 = 存在声明列在 DDL 中不存在。

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 1. 解析 basicData.ts 的 TYPES：table -> columns[] ----------
const ts = readFileSync(join(root, 'src/routes/basicData.ts'), 'utf8');
const typesStart = ts.indexOf('const TYPES');
const typesBlock = ts.slice(typesStart, ts.indexOf('\n};', typesStart));
const declared = new Map(); // table -> Set(col)
const typeRe = /table:\s*'(\w+)',\s*columns:\s*\[([^\]]+)\]/g;
let m;
while ((m = typeRe.exec(typesBlock)) !== null) {
  const table = m[1];
  const cols = m[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (!declared.has(table)) declared.set(table, new Set());
  cols.forEach((c) => declared.get(table).add(c));
}
if (declared.size === 0) {
  console.error('[check_basicdata_columns] FATAL: 未能从 basicData.ts 解析到任何 TYPES 声明（正则失配？）');
  process.exit(1);
}

// ---------- 2. 解析全部迁移 SQL：table -> 有效列（CREATE TABLE + ALTER ADD COLUMN 累加） ----------
const effective = new Map(); // table -> Set(col)
const addCols = (table, cols) => {
  if (!effective.has(table)) effective.set(table, new Set());
  cols.forEach((c) => effective.get(table).add(c));
};
const sqlFiles = readdirSync(root).filter((f) => /^\d{3}[a-z]?_.*\.sql$/.test(f)).sort();
for (const f of sqlFiles) {
  const sql = readFileSync(join(root, f), 'utf8');
  // CREATE TABLE [IF NOT EXISTS] name ( ... );  —— 捕获到独立 ");" 行，容忍列内逗号与约束
  const createRe = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\);/g;
  let c;
  while ((c = createRe.exec(sql)) !== null) {
    const table = c[1];
    const body = c[2];
    for (const line of body.split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('--')) continue;
      // 列定义行：列名开头 + 跟类型（排除表级约束 PRIMARY KEY/UNIQUE/FOREIGN/CHECK/CONSTRAINT）
      const cm = l.match(/^([a-z_][a-z0-9_]*)\s+(?!PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b|CONSTRAINT\b)([\w("']+)/i);
      if (cm) addCols(table, [cm[1]]);
    }
  }
  // ALTER TABLE name ADD [COLUMN] [IF NOT EXISTS] col ...
  const alterRe = /ALTER TABLE\s+(?:IF EXISTS\s+)?(\w+)\s+ADD\s+(?:COLUMN\s+)?(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
  let a;
  while ((a = alterRe.exec(sql)) !== null) addCols(a[1], [a[2]]);
}

// ---------- 3. 校验：声明列 ⊆ 有效列 ----------
const problems = [];
for (const [table, cols] of declared) {
  const eff = effective.get(table);
  if (!eff) {
    problems.push(`表 ${table}：在任何迁移 DDL 中都未找到 CREATE TABLE/ALTER 定义`);
    continue;
  }
  for (const col of cols) {
    if (!eff.has(col)) problems.push(`表 ${table}：白名单声明列 "${col}" 不存在于任何迁移 DDL（重演 D-07 必 500 模式）`);
  }
}

// ---------- 4. 报告 ----------
console.log(`[check_basicdata_columns] basicData.ts 声明类型数=${declared.size}，扫描迁移文件数=${sqlFiles.length}`);
if (problems.length > 0) {
  console.error('[check_basicdata_columns] FAIL —— 列声明漂移：');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('[check_basicdata_columns] PASS —— 全部声明列均存在于迁移 DDL');
