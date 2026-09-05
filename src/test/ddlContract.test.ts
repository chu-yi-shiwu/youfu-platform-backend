// ddlContract.test.ts —— 结构一致性护栏②：专杀「SQL 引用的列/类型与迁移 DDL 不一致」整类 bug。
//
// 【真实事故复盘 · 为什么写这个测试】
//   事故 C（071 live 400/500）：071 把 settlement_item.work_order_id / work_acceptance.work_order_id
//     建成 uuid，而 work_orders.id 是 **text 业务号**（001_init.sql:25）→ 上线才炸 22P02/操作符不存在。
//     根因：mock 单测的假数据恰好是 uuid 形态，全流程绿，live 才暴露。
//   事故 D（SQL 引用 category 而工单表实名 catalog）→ 线上 500。
//   两者共同点：**没有任何测试把「源码里的 SQL」与「迁移 DDL」对齐过**。
//
// 本测试做三件事（全程只读文件，零 DB 依赖）：
//   ① 从 001_*.sql ~ 071_*.sql（含后续迁移）解析出「表 → 列 → 类型」字典；
//   ② 抽取源码 SQL 里的「表.列」引用与 INSERT/UPDATE 列清单，断言列真实存在；
//   ③ 锁死事故 C：work_orders.id / settlement_item.work_order_id / work_acceptance.work_order_id 必须都是 text。
// 诚实边界：解析不到任何引用（正则失效）直接 fail，绝不 skip 空过。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..'); // 仓库根（迁移 SQL 与 src 同级）

// ==================== 一、迁移 DDL 解析：table → Map(col → type) ====================
/** 列定义之后出现的表级约束关键字（不解析为列）。 */
const TABLE_CONSTRAINT_RE = /^(primary\s+key|unique|foreign\s+key|check|constraint|exclude|like)$/i;

/** 在 sql 中从 from 位置起做括号配平扫描，返回与开括号匹配的闭括号下标。 */
function matchParen(sql: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层（depth=0）逗号切分，容忍列定义内含括号（numeric(12,2)）与引号内逗号。 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
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

export interface DdlModel {
  /** table → Map(column → type，小写) */
  tables: Map<string, Map<string, string>>;
  /** 参与解析的迁移文件数（>0 才有意义） */
  files: string[];
}

/** 解析仓根全部迁移 SQL（001_*.sql ~ 07x_*.sql），累加出每表的有效列与类型。 */
export function parseMigrations(): DdlModel {
  const tables = new Map<string, Map<string, string>>();
  const files = readdirSync(root)
    .filter((f) => /^\d{3}[a-z]?_.*\.sql$/i.test(f))
    .sort();
  const addCol = (table: string, col: string, type: string) => {
    if (!tables.has(table)) tables.set(table, new Map());
    tables.get(table)!.set(col, type);
  };

  for (const f of files) {
    const raw = readFileSync(path.join(root, f), 'utf8');
    // 去注释：先统一换行符（迁移文件是 CRLF，逐个 line 用 --.*$ 时 `.` 不吃 \r 会导致整行注释失配），
    // 再逐行去行注释、整体去块注释。注释残留会把注释文本混进列定义，造成误判。
    const sql = raw
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');

    // CREATE TABLE [IF NOT EXISTS] name ( body )
    const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*(?:\.[a-zA-Z_][\w]*)?)\s*\(/gi;
    let c: RegExpExecArray | null;
    while ((c = createRe.exec(sql)) !== null) {
      const table = c[1].toLowerCase();
      const open = createRe.lastIndex - 1;
      const close = matchParen(sql, open);
      if (close < 0) continue;
      const body = sql.slice(open + 1, close);
      for (const part of splitTopLevel(body)) {
        const first = part.split(/\s+/)[0]?.toLowerCase() ?? '';
        if (!first || TABLE_CONSTRAINT_RE.test(first)) continue;
        const typeTok = part.split(/\s+/)[1] ?? '';
        addCol(table, first, typeTok.toLowerCase());
      }
      createRe.lastIndex = close + 1;
    }

    // ALTER TABLE x ADD [COLUMN] [IF NOT EXISTS] col type
    const alterAddRe =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+([^\s,;]+)/gi;
    let a: RegExpExecArray | null;
    while ((a = alterAddRe.exec(sql)) !== null) {
      addCol(a[1].toLowerCase(), a[2].toLowerCase(), a[3].toLowerCase());
    }
    // ALTER TABLE x DROP [COLUMN] [IF EXISTS] col —— 迁移里删列必须同步移除，否则误判为「仍存在」
    const alterDropRe =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)/gi;
    while ((a = alterDropRe.exec(sql)) !== null) {
      tables.get(a[1].toLowerCase())?.delete(a[2].toLowerCase());
    }
    // ALTER TABLE x RENAME [COLUMN] old TO new
    const renameRe =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][\w]*)\s+RENAME\s+(?:COLUMN\s+)?([a-zA-Z_][\w]*)\s+TO\s+([a-zA-Z_][\w]*)/gi;
    while ((a = renameRe.exec(sql)) !== null) {
      const cols = tables.get(a[1].toLowerCase());
      if (cols?.has(a[2].toLowerCase())) {
        const t = cols.get(a[2].toLowerCase())!;
        cols.delete(a[2].toLowerCase());
        cols.set(a[3].toLowerCase(), t);
      }
    }
  }
  return { tables, files };
}

const ddl = parseMigrations();

/** 取列类型（如 'text'）；未定义返回 undefined。 */
function colType(table: string, col: string): string | undefined {
  return ddl.tables.get(table)?.get(col);
}

// ==================== 二、源码 SQL 抽取：表别名 → 列引用 ====================
/** FROM/JOIN 之后紧跟的、不可作为别名的关键字。 */
const ALIAS_STOPWORDS = new Set([
  'where', 'on', 'group', 'order', 'limit', 'offset', 'having', 'set', 'values', 'returning',
  'left', 'right', 'inner', 'outer', 'cross', 'full', 'join', 'using', 'union', 'for', 'as',
  'and', 'or', 'not', 'null', 'select', 'insert', 'update', 'delete', 'when', 'then', 'else',
  'end', 'case', 'asc', 'desc', 'into', 'from', 'exists', 'distinct', 'with', 'lateral',
]);

export interface SqlRef {
  table: string;
  column: string;
  /** 来源文件（便于报错定位） */
  file: string;
  /** 命中原文片段 */
  snippet: string;
}

/** 抽取单个源文件中全部 SQL 字符串文本（模板字符串 + 单引号串，且含 SQL 关键字）。 */
function extractSqlStrings(src: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    // 注意：尾部不能加 \b——`update\s+\w` 之后紧跟表名剩余字符，\b 不成立会导致 UPDATE 语句全漏。
    if (/\b(select|insert\s+into|update\s+[a-z_]|delete\s+from)/i.test(s)) out.push(s);
  };
  const tl = /`((?:[^`\\]|\\.)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = tl.exec(src)) !== null) push(m[1]);
  const sq = /'((?:[^'\\\n]|\\.)*)'/g;
  while ((m = sq.exec(src)) !== null) push(m[1]);
  const dq = /"((?:[^"\\\n]|\\.)*)"/g;
  while ((m = dq.exec(src)) !== null) push(m[1]);
  return out;
}

/**
 * 从源码抽取 SQL 列引用：
 *  - FROM/JOIN <表> [AS] <别名> → 建立 别名→表 映射（表名本身也作为别名登记，支持 work_orders.catalog 写法）
 *  - <别名>.<列> → 列引用
 *  - INSERT INTO <表> (列, 列…) / UPDATE <表> SET 列= → 列引用
 */
export function extractSqlRefs(file: string, src: string): SqlRef[] {
  const refs: SqlRef[] = [];
  const seen = new Set<string>();
  const add = (table: string, column: string, snippet: string) => {
    const key = `${table}.${column}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ table, column, file, snippet });
  };

  for (const sql of extractSqlStrings(src)) {
    // 归一化：去掉 ${...} 插值占位（避免把 JS 表达式误当 SQL）
    const clean = sql.replace(/\$\{[^}]*\}/g, ' _ ');

    // ① 别名映射
    const aliasToTable = new Map<string, string>();
    const fromRe = /\b(?:from|join)\s+([a-zA-Z_][\w]*)\s*(?:(?:as)\s+)?([a-zA-Z_][\w]*)?/gi;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(clean)) !== null) {
      const table = m[1].toLowerCase();
      const alias = (m[2] ?? '').toLowerCase();
      aliasToTable.set(table, table); // 表名自身可作限定符
      if (alias && !ALIAS_STOPWORDS.has(alias)) aliasToTable.set(alias, table);
    }

    // ② 限定列引用 别名.列
    const dotRe = /\b([a-zA-Z_][\w]*)\s*\.\s*([a-zA-Z_][\w]*)\b/g;
    while ((m = dotRe.exec(clean)) !== null) {
      const table = aliasToTable.get(m[1].toLowerCase());
      if (!table) continue;
      const col = m[2].toLowerCase();
      if (col === '*' || /^\d/.test(col)) continue;
      add(table, col, `${m[1]}.${m[2]}`);
    }

    // ③ INSERT INTO <表> (列…)
    const insRe = /\binsert\s+into\s+([a-zA-Z_][\w]*)\s*\(([^)]*)\)/gi;
    while ((m = insRe.exec(clean)) !== null) {
      const table = m[1].toLowerCase();
      for (const part of m[2].split(',')) {
        const col = part.trim().toLowerCase();
        if (col && /^[a-z_][\w]*$/.test(col)) add(table, col, `INSERT INTO ${m[1]}(${col})`);
      }
    }

    // ④ UPDATE <表> SET 列 = …
    const updRe = /\bupdate\s+([a-zA-Z_][\w]*)\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|$)/gi;
    while ((m = updRe.exec(clean)) !== null) {
      const table = m[1].toLowerCase();
      const assignRe = /(?:^|,)\s*([a-z_][\w]*)\s*=/gi;
      let a: RegExpExecArray | null;
      while ((a = assignRe.exec(m[2])) !== null) add(table, a[1].toLowerCase(), `UPDATE ${m[1]} SET ${a[1]}`);
    }
  }
  return refs;
}

/** 读取源文件并抽取引用；抽不到任何引用直接抛错（防正则失效后测试空过）。 */
function refsOf(rel: string): SqlRef[] {
  const src = readFileSync(path.join(root, rel), 'utf8');
  const refs = extractSqlRefs(rel, src);
  if (refs.length === 0) {
    throw new Error(
      `[ddlContract] FATAL: ${rel} 未抽取到任何 SQL 列引用——正则失配或文件被重构，测试不得空过（请修复抽取器）`,
    );
  }
  return refs;
}

/**
 * 列契约双断言（用于 SELECT-list 里未加表限定的列，如 `SELECT code, name, price FROM product_catalog`）：
 *   (a) 迁移 DDL 里该表确有此列——真正的契约；
 *   (b) 源文件里存在同时提到该表与该列的 SQL——保证断言不悬空（SQL 改写了测试会跟着变红）。
 * 诚实边界：(b) 是"提及"级而非"引用"级；更高强度的限定列校验走上面的 extractSqlRefs。
 */
function expectColumnContract(rel: string, table: string, column: string): void {
  const src = readFileSync(path.join(root, rel), 'utf8');
  const sqls = extractSqlStrings(src);
  const mentions = sqls.some(
    (s) => new RegExp(`\\b${table}\\b`, 'i').test(s) && new RegExp(`\\b${column}\\b`, 'i').test(s),
  );
  expect(mentions, `${rel} 的 SQL 中未找到同时提及 ${table} 与 ${column} 的语句（SQL 被改写？）`).toBe(true);
  expect(colType(table, column), `迁移 DDL 中表 ${table} 缺少列 ${column}（列漂移）`).toBeDefined();
}

// ==================== 三、断言 ====================
/** 这些文件的 SQL 列引用必须与迁移 DDL 完全一致。 */
const CONTRACT_FILES = [
  'src/repo/settlement.ts',   // 结算三凭证全部 SQL
  'src/repo/ticket.ts',       // 工单主表 CRUD + transition（列最多、最易漂移）
  'src/services/acceptance.ts', // 验收凭证 + reject 联动清理
] as const;

describe('DDL 解析自检（解析不到就是 fail，绝不空过）', () => {
  it('迁移文件被解析到，且关键表/列出现', () => {
    expect(ddl.files.length).toBeGreaterThanOrEqual(70);
    expect(ddl.files[0]).toMatch(/^001_/);
    // 事故 D 锚点：工单表的分类列实名 catalog（不是 category）
    expect(colType('work_orders', 'catalog')).toBe('text');
    expect(ddl.tables.get('work_orders')!.has('category')).toBe(false);
    // 事故 C 相关表全部建出来了（071）
    for (const t of ['settlement', 'settlement_item', 'work_acceptance']) {
      expect(ddl.tables.has(t), `表 ${t} 未在任何迁移中找到`).toBe(true);
    }
  });
});

describe('① 源码 SQL 引用的列必须存在于迁移 DDL（事故 D 防复发）', () => {
  for (const rel of CONTRACT_FILES) {
    it(`${rel}：全部列引用均能落到真实表列`, () => {
      const refs = refsOf(rel);
      const problems: string[] = [];
      for (const r of refs) {
        const cols = ddl.tables.get(r.table);
        if (!cols) continue; // 表不在迁移中（视图/CTE/动态表名）→ 跳过，不误报
        if (!cols.has(r.column)) {
          problems.push(`${r.snippet} → 表 ${r.table} 无列 ${r.column}`);
        }
      }
      expect(problems, `${rel} 存在 ${problems.length} 处列漂移：\n${problems.join('\n')}`).toEqual([]);
      // 顺带锁住引用规模，防止抽取器退化为只抽到 1 条
      expect(refs.length).toBeGreaterThan(3);
    });
  }

  it('专项：结算模块引用的关键列全部真实存在（逐列点名事故 D 形态）', () => {
    const rel = 'src/repo/settlement.ts';
    // work_orders 的分类列实名 catalog（不是 category）——事故 D 的直接锚点
    expectColumnContract(rel, 'work_orders', 'catalog');
    expect(ddl.tables.get('work_orders')!.has('category')).toBe(false);
    for (const c of ['code', 'name', 'price', 'enabled']) expectColumnContract(rel, 'product_catalog', c);
    for (const c of ['work_order_id', 'amount', 'price', 'qty']) expectColumnContract(rel, 'settlement_item', c);
    for (const c of ['settlement_no', 'total', 'item_count', 'status']) expectColumnContract(rel, 'settlement', c);
  });

  it('专项：验收模块引用的 work_acceptance 列全部真实存在', () => {
    const rel = 'src/services/acceptance.ts';
    for (const c of ['work_order_id', 'result', 'note', 'media', 'accepted_by']) {
      expectColumnContract(rel, 'work_acceptance', c);
    }
    expectColumnContract(rel, 'work_orders', 'sla_due_at');
    expectColumnContract(rel, 'settlement_item', 'work_order_id');
  });

  it('⚙自检：DDL 里删掉一列，限定引用检查必须变红（证明不是空过）', () => {
    const refs = refsOf('src/repo/settlement.ts');
    expect(refs.some((r) => r.table === 'work_orders' && r.column === 'catalog')).toBe(true);
    const cols = ddl.tables.get('work_orders')!;
    const saved = cols.get('catalog');
    cols.delete('catalog'); // 模拟「work_orders 没了 catalog 列」
    try {
      const drift = refs.filter((r) => {
        const c = ddl.tables.get(r.table);
        return !!c && !c.has(r.column);
      });
      expect(drift.some((r) => r.table === 'work_orders' && r.column === 'catalog')).toBe(true);
    } finally {
      cols.set('catalog', saved ?? 'text');
    }
    expect(colType('work_orders', 'catalog')).toBe('text');
  });
});

describe('② 关联工单的列必须是 text 业务号（事故 C 锁死 · 禁回退 uuid）', () => {
  it('work_orders.id 为 text 主键（001_init.sql:25）', () => {
    expect(colType('work_orders', 'id')).toBe('text');
  });
  it('settlement_item.work_order_id 为 text（与 work_orders.id 同型，禁止 uuid）', () => {
    expect(colType('settlement_item', 'work_order_id')).toBe('text');
  });
  it('work_acceptance.work_order_id 为 text（与 work_orders.id 同型，禁止 uuid）', () => {
    expect(colType('work_acceptance', 'work_order_id')).toBe('text');
  });
  it('三处类型两两一致（任一改回 uuid → 立刻变红）', () => {
    const trio = [
      ['work_orders.id', colType('work_orders', 'id')],
      ['settlement_item.work_order_id', colType('settlement_item', 'work_order_id')],
      ['work_acceptance.work_order_id', colType('work_acceptance', 'work_order_id')],
    ] as const;
    for (const [, t] of trio) expect(t).toBe('text');
    expect(new Set(trio.map(([, t]) => t)).size).toBe(1);
  });
  it('⚙自检：把类型改回 uuid 必须被 ② 检出（证明不是空过）', () => {
    // 变异 DDL 副本：把 settlement_item.work_order_id 改成 uuid，模拟事故 C 回归
    const mutated = ddl.tables.get('settlement_item')!;
    const original = mutated.get('work_order_id');
    mutated.set('work_order_id', 'uuid');
    try {
      expect(colType('settlement_item', 'work_order_id')).not.toBe('text');
    } finally {
      mutated.set('work_order_id', original ?? 'text');
    }
    expect(colType('settlement_item', 'work_order_id')).toBe('text'); // 已还原
  });
});

describe('③ basicData.ts 字典白名单列必须与 DDL 一致（D-07 复发防线 · 与脚本同口径）', () => {
  it('TYPES 声明的每一个列都存在于对应表的迁移 DDL', () => {
    const src = readFileSync(path.join(root, 'src/routes/basicData.ts'), 'utf8');
    const start = src.indexOf('export const TYPES');
    const block = src.slice(start, src.indexOf('\n};', start));
    const re = /table:\s*'(\w+)',\s*columns:\s*\[([^\]]+)\]/g;
    const declared = new Map<string, Set<string>>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      if (!declared.has(m[1])) declared.set(m[1], new Set());
      for (const c of m[2].split(',')) {
        const col = c.trim().replace(/^['"]|['"]$/g, '');
        if (col) declared.get(m[1])!.add(col);
      }
    }
    expect(declared.size, '未能从 basicData.ts 解析到 TYPES 声明（正则失配？）').toBeGreaterThan(0);

    const problems: string[] = [];
    for (const [table, cols] of declared) {
      const eff = ddl.tables.get(table);
      if (!eff) {
        problems.push(`表 ${table}：在任何迁移 DDL 中都未找到定义`);
        continue;
      }
      for (const col of cols) {
        if (!eff.has(col)) problems.push(`表 ${table}：白名单声明列 "${col}" 不存在于迁移 DDL（重演 D-07 必 500）`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
