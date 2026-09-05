// 启动自检：role_permission.role CHECK 角色白名单门（架构评审 R1 · 注册制批次二）。
// ───────────────────────────────────────────────────────────────────────────
// 背景：046 内联建表时 role_permission.role 的 CHECK 仅放行 4 角色，069 只放宽了
// account_user.role 未同步本表 → 批次二开通第④步按 6 角色写权限行必报 23514，
// 新租户开通事务整体回滚。修复靠 070 迁移（superuser 部署时真跑）；
// 本模块在应用启动时核对 DB 侧 CHECK 是否已放行全部 6 角色，未放行则拒绝启动（fail-fast）。
// 诚实边界：连不上 DB 时不在此处炸（沿用既有启动行为——首请求自然报错），
// 自检只在成功取得连接后判定；用真实 pool 客户端跑完即释放。
// ───────────────────────────────────────────────────────────────────────────
import type { PoolClient } from 'pg';
import pool from '../db/pool.js';
import { ROLES } from '../middleware/role.js';

export const ROLE_CHECK_SQL =
  `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint` +
  ` WHERE conrelid = 'role_permission'::regclass AND contype = 'c'`;

/**
 * 纯函数：从 CHECK 约束定义文本解析出**有效放行**的角色集合（语义感知版）。
 *
 * pg_get_constraintdef 渲染形态：
 *   `CHECK ((role = ANY (ARRAY['admin'::text, ...])))`（046/069/070，PG15 双层括号）
 *   `CHECK (role IN ('admin', ...))`、`CHECK (role = 'admin')`、`CHECK (role <> 'reviewer')`
 *
 * 解析规则（fail-closed：语义不明按"不放行"处理，宁可误拒启动不可放走真缺陷）：
 *   1. 按**顶层 AND** 拆子条件；放行类子条件（= ANY / IN / = 'x'）之间取交集；
 *   2. 排除类子条件（<> / != / NOT IN / NOT (…ANY…)）的字面量进 deny 集，从结果中扣除；
 *   3. 出现**顶层 OR** 或**含引号字面量却识别不出角色条件**的子条件 → 视为语义不明 → 返回 []
 *      （历史上用 /'([^']*)'/g 抽所有单引号字面量的写法，会把 `role <> 'reviewer'`
 *        的排除字面量误当放行 → fail-open，本版已修复）；
 *   4. 仅有排除类子条件（无任何放行类）→ 返回 ROLES 中未被排除者；
 *   5. 文本无引号字面量（如 IS NOT NULL）→ 无角色条件可确认 → 返回 []（fail-closed）。
 */
export function parseRoleCheckAllowlist(defText: string): string[] {
  if (!defText) return [];

  // 剥掉 "CHECK" 前缀与包裹括号，让 AND 拆分相对约束本体（否则 AND 在深度≥2 拆不出来）
  const clauses = splitTopLevelAnd(stripConstraintParens(defText));
  const allowSets: string[][] = [];
  const deny = new Set<string>();
  let sawAllowClause = false;
  let sawDenyClause = false;

  for (const clause of clauses) {
    // 子条件内出现 OR（无论括号深度）→ 放行语义需布尔求值，静态不可判定 → fail-closed
    if (/\sOR\s/i.test(clause)) return [];

    const literals = clause.match(/'([^']*)'/g) ?? [];

    let m: RegExpMatchArray | null;
    if ((m = clause.match(/role\s*<>\s*'([^']*)'/i)) || (m = clause.match(/role\s*!=\s*'([^']*)'/i))) {
      deny.add(m[1]);
      sawDenyClause = true;
      continue;
    }
    if ((m = clause.match(/role\s+NOT\s+IN\s*\(([^)]*)\)/i))) {
      for (const l of m[1].match(/'([^']*)'/g) ?? []) deny.add(l.slice(1, -1));
      sawDenyClause = true;
      continue;
    }
    if ((m = clause.match(/NOT\s*\(\s*role\s*=\s*ANY\s*\(\s*ARRAY\s*\[([^\]]*)\]/i))) {
      for (const l of m[1].match(/'([^']*)'/g) ?? []) deny.add(l.slice(1, -1));
      sawDenyClause = true;
      continue;
    }
    if ((m = clause.match(/role\s*=\s*ANY\s*\(\s*ARRAY\s*\[([^\]]*)\]/i)) || (m = clause.match(/role\s+IN\s*\(([^)]*)\)/i))) {
      const set = (m[1].match(/'([^']*)'/g) ?? []).map((l) => l.slice(1, -1));
      if (set.length === 0) return []; // 有结构无字面量 → 语义不明
      allowSets.push(set);
      sawAllowClause = true;
      continue;
    }
    if ((m = clause.match(/role\s*=\s*'([^']*)'/i))) {
      allowSets.push([m[1]]);
      sawAllowClause = true;
      continue;
    }
    // 子条件含引号字面量却识别不出任何角色条件 → 语义不明 → fail-closed
    if (literals.length > 0) return [];
    // 无引号的辅助条件（length(role) > 0 等）不限制角色 → 忽略
  }

  if (allowSets.length === 0) {
    // 仅排除类（或既无放行也无排除但有引号已被上面拦截）：
    // 有 deny → ROLES 未被排除者可写；既无 allow 也无 deny 也无引号 → 无角色条件可确认 → fail-closed
    if (sawDenyClause) return ROLES.filter((r) => !deny.has(r));
    return [];
  }

  // 放行类子条件之间取交集（AND 语义），再扣除排除项
  const [first, ...rest] = allowSets;
  const intersect = first.filter((r) => rest.every((s) => s.includes(r)));
  return intersect.filter((r) => !deny.has(r));
}

/**
 * 剥掉 `CHECK` 前缀与包裹约束本体的括号对。
 * pg_get_constraintdef 渲染：`CHECK (role = ANY (...))` / PG15 双层 `CHECK ((role = ANY (...)))`。
 * 仅剥「首括号与尾括号互相配对」的壳；`(a) AND (b)` 的首括号配对在中途，不剥。
 */
function stripConstraintParens(text: string): string {
  let t = text.trim().replace(/^CHECK\s*/i, '');
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let matched = true;
    let inQuote = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === "'") inQuote = !inQuote;
      if (inQuote) continue;
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0 && i !== t.length - 1) {
          matched = false; // 首括号在中途闭合 → 不是包裹壳
          break;
        }
      }
    }
    if (!matched) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** 按括号深度 0 的 AND 拆分子条件（引号内不拆）。 */
function splitTopLevelAnd(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") inQuote = !inQuote;
    if (!inQuote) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (depth === 0 && /^AND$/i.test(text.slice(i, i + 3)) && /\s/.test(text[i - 1] ?? ' ') && /\s/.test(text[i + 3] ?? ' ')) {
        parts.push(buf);
        buf = '';
        i += 2; // 跳过 AND
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * 在给定 client 上执行白名单判定（不释放连接，由调用方管理生命周期）。
 * 返回 missing = ROLES 中未被 CHECK 放行的角色；missing 为空即自检通过。
 */
export async function checkRoleWhitelist(
  client: PoolClient,
): Promise<{ ok: boolean; missing: string[]; constraints: Array<{ conname: string; def: string }> }> {
  const r = await client.query(ROLE_CHECK_SQL);
  const constraints = r.rows.map((row: { conname: string; def: string }) => ({
    conname: row.conname,
    def: row.def ?? '',
  }));
  // 多条 CHECK 约束在 PG 中是 AND 关系：一条约束放行的角色必须在**每条**约束里都被放行。
  // （早期实现取并集是错的：A 允 4 角色 + B 仅允 reviewer，DB 实际只允许写 reviewer。）
  // 解析失败/无角色条件的约束 → 空集 → 交集为空 → missing 全部（fail-closed）。
  const allow = new Set<string>();
  let first = true;
  for (const c of constraints) {
    const clauseAllow = parseRoleCheckAllowlist(c.def);
    if (first) {
      for (const role of clauseAllow) allow.add(role);
      first = false;
    } else {
      for (const role of [...allow]) if (!clauseAllow.includes(role)) allow.delete(role);
    }
  }
  const missing = ROLES.filter((role) => !allow.has(role));
  return { ok: missing.length === 0, missing, constraints };
}

// 连接超时护栏：DB 不可达时自检最多等 10s 后放弃（不炸、不阻塞调度器启动）。
const SELF_CHECK_CONNECT_TIMEOUT_MS = 10_000;

/**
 * 启动门：查询 DB 侧 role_permission CHECK 并断言 6 角色全部放行；
 * 任一缺失 → 输出明确修复命令并 process.exit(1)（拒绝启动，避免开通中途 23514 整体回滚）。
 */
export async function verifyRoleWhitelist(): Promise<void> {
  let client: PoolClient | null = null;
  try {
    client = await Promise.race([
      pool.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('role whitelist self-check connect timeout')), SELF_CHECK_CONNECT_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    // 连不上 DB：沿用既有启动行为（不在此处炸），交给首个请求自然报错。
    console.warn(`[startup] 角色白名单自检跳过：DB 连接不可用（${(e as Error).message}）`);
    return;
  }
  let rejectStartup = false;
  try {
    const res = await checkRoleWhitelist(client);
    if (!res.ok) {
      rejectStartup = true; // 先标记，finally 释放连接后再 exit（QA 修正：exit 在 try 内会绕过 release）
      console.error(
        `🔴 070 迁移未应用：role_permission.role CHECK 缺角色 ${res.missing.join('、')}，` +
          `拒绝启动（新租户开通会整体回滚）。` +
          `修复：在数据库服务器以 superuser 执行 sudo -u postgres psql youfu -f 070_role_permission_roles_widen.sql，然后重启本服务。` +
          `（当前 CHECK：${res.constraints.map((c) => `${c.conname}: ${c.def}`).join(' | ') || '无 CHECK 约束'}）`,
      );
    } else {
      console.log('[startup] role_permission.role CHECK 含全部 6 角色白名单，自检通过');
    }
  } finally {
    client.release();
  }
  if (rejectStartup) process.exit(1);
}
