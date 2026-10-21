// 097 平台级开关的**边界护栏**（纯静态扫描，零 DB）：
//   platform_config 是「谁能改流程」这道闸的唯一数据源，它的隔离**不靠 RLS**，
//   而靠「只有平台侧代码能碰它」。这条纪律一旦破（有人在租户路由里 import、或后续迁移
//   给它加了个 tenant_id 列），没有任何运行时报错——只是开关悄悄变成租户可见/可改。
//   所以只能靠静态扫描钉死。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const here = __dirname;
const ROOT = join(here, '..', '..'); // 仓库根
const SRC = join(ROOT, 'src');

/** 递归收集 src 下所有 .ts（排除测试与 .d.ts）。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p, out); continue; }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const TS_FILES = walk(SRC);
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, '/');

/**
 * 剥掉 SQL 注释后再判断。
 * 【为什么必须剥】097 的注释里写了「本表故意不带 tenant_id / 若误加租户 RLS…」——
 *   不剥注释的话，这两句**设计说明本身**会被当成违规语句命中，护栏变成只会误报的摆设。
 *   注意只剥双横线行注释与斜杠星号块注释，**保留字符串字面量里的双横线不动**（本仓迁移无此情形）。
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** 迁移 SQL（根目录 <三位数字>_*.sql）。 */
const SQL_FILES = readdirSync(ROOT)
  .filter((f) => /^\d{3}_.*\.sql$/.test(f))
  .map((f) => ({ name: f, text: stripSqlComments(readFileSync(join(ROOT, f), 'utf8')) }));

describe('097 边界①：谁可以碰 platform_config（源码引用白名单）', () => {
  const importers = TS_FILES
    .filter((p) => /from\s+['"][^'"]*repo\/platformConfig\.js['"]/.test(readFileSync(p, 'utf8')))
    .map(rel);

  it('至少有人用（防止白名单写错导致空集恒绿 —— 空集通过不是通过）', () => {
    expect(importers.length).toBeGreaterThan(0);
  });

  it('引用方只有「守卫（只读）」和「平台路由（读写）」两处，不得扩散', () => {
    expect(importers.sort()).toEqual([
      'src/middleware/workflowConfigGuard.ts',
      'src/routes/platformWorkflow.ts',
    ]);
  });

  it('src/routes 下引用它的必须是平台路由（文件名以 platform 开头）', () => {
    const routeImporters = importers.filter((f) => f.startsWith('src/routes/'));
    for (const f of routeImporters) {
      expect(f.split('/').pop()!.startsWith('platform')).toBe(true);
    }
  });

  it('SQL 里出现 platform_config 的也只能是平台侧代码（租户路由零命中）', () => {
    const hits = TS_FILES
      .filter((p) => /platform_config/.test(readFileSync(p, 'utf8')))
      .map(rel);
    for (const f of hits) {
      // 归档/脚本类放宽（根目录 scripts 不在 src 内，扫不到）；src 内只允许平台侧
      const ok = f.includes('platform') || f.includes('workflowConfigGuard') || f.includes('platformConfig');
      expect(ok, 'src 内出现 platform_config 的文件不在白名单：' + f).toBe(true);
    }
  });
});

describe('097 边界②：platform_config 永远不得长出 tenant_id（含后续迁移 ALTER）', () => {
  it('没有 SQL 语句既提 platform_config 又提 tenant_id', () => {
    const offenders: string[] = [];
    for (const { name, text } of SQL_FILES) {
      // 按语句切分：只针对真正操作 platform_config 的语句判断，避免误伤同文件里的其它表
      for (const stmt of text.split(';')) {
        if (/platform_config/i.test(stmt) && /tenant_id/i.test(stmt)) {
          offenders.push(`${name}: ${stmt.trim().slice(0, 120)}`);
        }
      }
    }
    expect(offenders, `发现给平台级表加租户列的语句：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('没有后续迁移给 platform_config 加 RLS（误加 ⇒ 平台侧直连恒空行 ⇒ 开关永远拨不动）', () => {
    const offenders: string[] = [];
    for (const { name, text } of SQL_FILES) {
      for (const stmt of text.split(';')) {
        if (/platform_config/i.test(stmt) && /row\s+level\s+security/i.test(stmt)) {
          offenders.push(`${name}: ${stmt.trim().slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('迁移文件清单本身能扫到（解析不到就 fail，绝不空过 —— 与 ddlContract 同款诚实边界）', () => {
    expect(SQL_FILES.length).toBeGreaterThanOrEqual(97);
    expect(SQL_FILES.some((f) => f.name.startsWith('097_'))).toBe(true);
  });
});
