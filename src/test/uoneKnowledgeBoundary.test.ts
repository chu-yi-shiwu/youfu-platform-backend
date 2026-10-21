// uoneKnowledgeBoundary.test.ts —— 结构一致性护栏③：锁死 uone_knowledge 的「全局离线库」定性。
//
// 【为什么写这个测试】
//   src/routes/aiPreview.ts 的旧注释曾写：知识源 =「uone_knowledge（离线预灌）+ 租户自身已完成单（增量）」。
//   后半句是**假的**：049_uone_knowledge.sql 建表时根本没有 tenant_id 列，全仓也没有针对该表的
//   ENABLE ROW LEVEL SECURITY（060 只给 ai_case_embeddings / ai_feedback / ai_inference_log 三张
//   AI 表补了 RLS）。若后来人照着旧注释去实现「租户增量写全局库」，就是一条直接的跨租户泄露。
//   同理，sql/uone_knowledge_dedup_20260906.sql 旧注释断言该表「受租户 RLS 约束（见 060）」也是错的，
//   会误导运维以为删除会被 RLS 静默架空。
//
// 本测试全程只读文件、零 DB 依赖，断言两条事实锚：
//   ① 049 CREATE TABLE uone_knowledge 的字段块**不含 tenant_id**
//      → 谁哪天给它补了租户维度，这条会红，提醒同步检查 RLS / 灌数脚本 / 检索口径；
//   ② src/ 下所有 .ts **不存在**向该表的 INSERT（大小写不敏感、允许跨行与任意空白）
//      → 谁照着旧注释把租户数据写进全局库，这条立刻红。
// 诚实边界：解析不到建表语句或扫不到文件，直接 fail，绝不 skip 空过。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..'); // 仓库根（迁移 SQL 与 src 同级）
const srcDir = path.join(root, 'src');

/** 在 sql 中从 openIdx 起做括号配平扫描，返回与开括号匹配的闭括号下标（失败 -1）。 */
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

/** 抽取 `CREATE TABLE [IF NOT EXISTS] uone_knowledge ( ... )` 的字段块原文（不含最外层括号）。 */
function parseCreateTableBody(sql: string): string {
  const head = /create\s+table\s+(?:if\s+not\s+exists\s+)?uone_knowledge\s*\(/i.exec(sql);
  if (!head) return '';
  const openIdx = head.index + head[0].length - 1;
  const closeIdx = matchParen(sql, openIdx);
  if (closeIdx < 0) return '';
  return sql.slice(openIdx + 1, closeIdx);
}

/** 递归收集 dir 下所有 .ts 文件的绝对路径。 */
function collectTs(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectTs(p));
    else if (ent.isFile() && /\.ts$/i.test(ent.name)) out.push(p);
  }
  return out;
}

describe('uone_knowledge 定性护栏（全局离线库 · 无租户维度）', () => {
  it('① 049_uone_knowledge.sql 的建表字段块不含 tenant_id', () => {
    const sql = readFileSync(path.join(root, '049_uone_knowledge.sql'), 'utf8');
    const body = parseCreateTableBody(sql);
    // 解析不到建表语句 = 护栏失效（迁移改名/改结构），必须 fail 而不是空过。
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/\btenant_id\b/i);
    // 顺带锁死「确实有列被解析到」，防止正则退化成空块导致上一条假绿。
    expect(body).toMatch(/\bid\b/i);
  });

  it('② src/ 下不存在向 uone_knowledge 的 INSERT', () => {
    const files = collectTs(srcDir);
    expect(files.length).toBeGreaterThan(0);
    // \s+ 覆盖跨行与任意空白；末尾 'knowledge' 拆拼接，避免本文件自身的正则文本被自己命中。
    const re = new RegExp('insert\\s+into\\s+uone_' + 'knowledge', 'i');
    const hits = files.filter((f) => re.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
