// psqlMeta 契约护栏 —— 防止"psql 元命令被当 SQL 发给服务端"再次卡死全新库初始化。
//
// 【事故背景】085 开始，迁移文件里引入了 psql 客户端元命令 `\echo`（部署契约本是
//   `psql -f xxx.sql`，psql 认它；但 init-db.ts / src/db/migrate.ts 走 pg 协议把文件
//   原文整段丢给服务端，服务端解析器遇 `\` 直接 syntax error）。
//   084 及之前一个 `\echo` 都没有 → 全新库初始化到 084 之后必炸，085 起全军覆没。
//
// 【防线】两处执行入口在 query 前必须经 stripPsqlMeta() 清洗；本文件固化该契约。
// 全部断言零 DB 依赖，纯静态/纯函数，可在任何环境跑。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripPsqlMeta } from '../db/psqlMeta.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..', '..');
const migFiles = readdirSync(backendRoot)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort();

const readRepo = (p: string) => readFileSync(join(backendRoot, p), 'utf8');

describe('stripPsqlMeta —— 单元行为', () => {
  it('剥离行首 \\echo 元命令（含前导空格）', () => {
    const r = stripPsqlMeta("SELECT 1;\n\\echo '--- hi ---'\n  \\echo 'indented'\nSELECT 2;");
    expect(r.sql).toBe('SELECT 1;\n\n\nSELECT 2;');
    expect(r.stripped).toEqual(["\\echo '--- hi ---'", "\\echo 'indented'"]);
  });

  it('保持行数不变（便于报错定位到原始行号）', () => {
    const src = "A\n\\echo x\nB";
    expect(stripPsqlMeta(src).sql.split('\n')).toHaveLength(3);
    expect(stripPsqlMeta(src).sql.split('\n')[1]).toBe('');
  });

  it('不误伤 DO $$ ... $$ 块体内的反斜杠（元命令识别必须先跟踪美元引用）', () => {
    const src = [
      "DO $$",
      "BEGIN",
      "  RAISE NOTICE 'tab:\\there';",
      "END $$;",
      "\\echo '--- after ---'",
    ].join('\n');
    const r = stripPsqlMeta(src);
    expect(r.sql).toContain("RAISE NOTICE 'tab:\\there';"); // 块内原样保留
    expect(r.sql).not.toContain('\\echo'); // 块外的照剥
  });

  it('不误伤 $tag$ 命名美元引用块体', () => {
    const src = "DO $body$\nBEGIN\n  -- \\notacommand\nEND $body$;\n\\echo 'z'";
    const r = stripPsqlMeta(src);
    expect(r.sql).toContain('-- \\notacommand');
    expect(r.stripped).toEqual(["\\echo 'z'"]);
  });

  it('不以字母开头的反斜杠（如字符串转义）一律不剥离', () => {
    const src = "SELECT E'\\\\';\nSELECT '\\'';";
    expect(stripPsqlMeta(src).stripped).toEqual([]);
    expect(stripPsqlMeta(src).sql).toBe(src);
  });

  it('纯 SQL 输入零改动（幂等且无副作用）', () => {
    const src = 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c int;\nSELECT 1;';
    const r = stripPsqlMeta(src);
    expect(r.sql).toBe(src);
    expect(r.stripped).toEqual([]);
  });
});

describe('迁移文件 —— 经清洗后必须可被 pg 协议直接执行', () => {
  it('全部迁移文件清洗后不含任何行首反斜杠元命令', () => {
    const offenders: string[] = [];
    for (const f of migFiles) {
      const { sql } = stripPsqlMeta(readRepo(f));
      for (const line of sql.split(/\r?\n/)) {
        if (/^\s*\\[a-zA-Z]/.test(line)) offenders.push(`${f}: ${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('085..089 确实含 \\echo（清洗非空），证明事故面仍存在、剥离不可省略', () => {
    const hit = migFiles.filter((f) => stripPsqlMeta(readRepo(f)).stripped.length > 0);
    // 断言"至少包含"而非"恰好等于"：后续迁移（如 091）沿用 \echo 部署惯例不应误报为失败。
    for (const f of [
      '085_settlement_material_row_grain.sql',
      '086_consumable_consume_backfill.sql',
      '087_zombie_perm_rows_cleanup.sql',
      '088_v3_settlement_void_and_workflow_locks.sql',
      '089_volunteer_intake_perm_backfill.sql',
    ]) {
      expect(hit).toContain(f);
    }
  });

  it('084 及之前不含任何元命令（锁定"085 是首个引入者"这一根因结论）', () => {
    const early = migFiles.filter((f) => /^0([0-7]\d|8[0-4])_/.test(f));
    const dirty = early.filter((f) => stripPsqlMeta(readRepo(f)).stripped.length > 0);
    expect(dirty).toEqual([]);
  });

  it('清洗只影响元命令行，其余字节逐字不变（零语义变更）', () => {
    for (const f of migFiles) {
      const src = readRepo(f);
      const { sql, stripped } = stripPsqlMeta(src);
      const srcLines = src.split(/\r?\n/);
      const outLines = sql.split(/\r?\n/);
      expect(outLines).toHaveLength(srcLines.length);
      for (let i = 0; i < srcLines.length; i += 1) {
        if (srcLines[i].trim() === '') {
          expect(outLines[i]).toBe(srcLines[i]); // 原本就是空行：不得被改动
        } else if (outLines[i] === '') {
          expect(stripped).toContain(srcLines[i].trim()); // 被剥离：原文本必须留痕
        } else {
          expect(outLines[i]).toBe(srcLines[i]); // 其余逐字不变
        }
      }
    }
  });
});

describe('执行入口 —— 两处 query 必须先清洗', () => {
  it('src/db/migrate.ts 在 pool.query 前调用 stripPsqlMeta', () => {
    const src = readRepo('src/db/migrate.ts');
    expect(src).toMatch(/stripPsqlMeta\(/);
    // 项目 moduleResolution=node16，相对导入必须带 .js 扩展名（全仓 615 处同款）
    expect(src).toMatch(/import\s*\{[^}]*stripPsqlMeta[^}]*\}\s*from\s*'\.\/psqlMeta\.js'/);
    // 清洗必须发生在 query 之前：文件里 strip 调用点行号 < 第一个 pool.query(sql) 行号
    const stripAt = src.split(/\n/).findIndex((l) => l.includes('stripPsqlMeta('));
    const queryAt = src.split(/\n/).findIndex((l) => /\.query\(sql\)/.test(l));
    expect(stripAt).toBeGreaterThan(0);
    expect(queryAt).toBeGreaterThan(0);
    expect(stripAt).toBeLessThan(queryAt);
  });

  it('scripts/init-db.ts 在 migPool.query 前调用 stripPsqlMeta', () => {
    const src = readRepo('scripts/init-db.ts');
    expect(src).toMatch(/stripPsqlMeta\(/);
    // 必须用 migPool 精确定位：runOnce() 内部也有一个 .query(sql)，会抢先命中导致误判
    const s = src.split(/\n/).findIndex((l) => l.includes('stripPsqlMeta('));
    const q = src.split(/\n/).findIndex((l) => /migPool\.query\(sql\)/.test(l));
    expect(s).toBeGreaterThan(0);
    expect(q).toBeGreaterThan(0);
    expect(s).toBeLessThan(q);
  });
});

describe('scripts/init-db.ts —— crypto 用法必须可解析（ESM 无全局 crypto.randomBytes）', () => {
  it('从 node:crypto 具名导入 randomBytes', () => {
    const src = readRepo('scripts/init-db.ts');
    expect(src).toMatch(/import\s*\{[^}]*\brandomBytes\b[^}]*\}\s*from\s*'node:crypto'/);
  });

  it('不再出现裸 crypto.randomBytes（该文件内无 crypto 命名空间导入）', () => {
    const src = readRepo('scripts/init-db.ts');
    expect(src).not.toMatch(/crypto\.randomBytes/);
    expect(src).not.toMatch(/import\s+\*\s+as\s+crypto/);
  });
});

