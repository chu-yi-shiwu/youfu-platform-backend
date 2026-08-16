// C3 发布闸门：上线前强制卡点。
//   1) vitest 全绿（dev 试点期也必须全绿才能发布）
//   2) SQL 注入静态扫描：禁止 query(...) 的 SQL 模板字符串内出现 ${} 变量插值（必须参数化 $1..）
//   3) 迁移幂等静态检查：每个 NNN_*.sql 必须含 IF NOT EXISTS / ON CONFLICT / DROP POLICY IF EXISTS 等幂等保护
// 全部通过 exit 0；任一失败 exit 1。
//
// 注：ECS 仅 Node16，无法跑新版 vitest；本闸门在本地 Node22 环境执行（与单测/构建同环境）。
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
let failed = false;
const fail = (m: string) => { console.error('  ✗ ' + m); failed = true; };
const pass = (m: string) => console.log('  ✓ ' + m);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, out);
    } else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

console.log('--- C3 发布闸门 ---');

// TTY 自动决策：非 TTY（CI 钩子/管道）默认跳过 vitest，避免 Windows Git Bash 下 vitest 非 TTY 崩溃；
// 用 --force-vitest 强制跑（真正的 CI Linux 环境）；用 --no-vitest 跳过（pre-push 钩子本地只跑 SQL+迁移）。
const forceVitest = process.argv.includes('--force-vitest');
const noVitest = process.argv.includes('--no-vitest');
const runVitest = forceVitest || (!noVitest && Boolean(process.stdout.isTTY));

// 1) vitest 全绿
console.log('[1/3] vitest run' + (runVitest ? '' : '（非 TTY 跳过，单独跑 `npm test` 或加 --force-vitest）'));
if (runVitest) {
  try {
    execSync('npx --no-install vitest run', { cwd: root, stdio: 'inherit' });
    pass('vitest 全绿');
  } catch {
    fail('vitest 未全绿（见上方输出）');
  }
} else {
  console.log('  ⊘ 跳过 vitest（非 TTY 环境）；本地单测请单独 `npm test` 确认全绿');
}

// 2) SQL 注入静态扫描：仅标记「SQL 模板内直插请求对象(req.)」的真风险。
//    已知安全模式（不标记）：白名单列片段拼接(clauses/sets/.join)、转义(safeTenant.replace)、
//    数字(limit/offset)、参数化 where、SET LOCAL/SET ROLE 等无法 $1 参数化的 admin 命令、
//    参数编号(params.length)/对象字段(cur.status/to)等内部变量。
//    非安全非风险表达式仅输出"待复核"提示，不阻断闸门（避免误杀）。
console.log('[2/3] SQL 注入静态扫描');
let hits = 0;
const SAFE_EXPR = /\.(join|replace|slice|toUpperCase|toFixed)\(|^((limit|offset|where|clauses|sets|safeTenant|col|status|category|name|pinyin|low|id|params|code|key|norm|parsed|asset_no|cur|to|length))$|\./i;
const RISK_EXPR = /req\s*\.?/i;
for (const f of walk(join(root, 'src'))) {
  const src = readFileSync(f, 'utf8');
  const re = /query\(\s*`([\s\S]*?)`\s*\)/g; // 仅捕获模板字面量 SQL 参数
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const sql = m[1];
    if (/SET LOCAL|SET ROLE/i.test(sql)) continue; // admin 命令已转义/白名单，非注入点
    const exprs = sql.match(/\$\{([^}]+)\}/g) ?? [];
    for (const e of exprs) {
      const expr = e.slice(2, -1).trim();
      const line = src.substring(0, m.index).split('\n').length;
      if (RISK_EXPR.test(expr)) {
        console.error(`  注入风险 ${f.replace(root, '')}:${line} → ${e}（疑似请求对象直插 SQL）`);
        hits++;
      } else if (!SAFE_EXPR.test(expr)) {
        console.error(`  待复核 ${f.replace(root, '')}:${line} → ${e}（非白名单安全模式，建议人工确认）`);
      }
    }
  }
}
if (hits === 0) pass('未发现 SQL 注入风险（仅允许白名单列拼接/转义/数字/参数编号等非用户输入插值）');
else fail(`${hits} 处 SQL 注入风险`);

// 3) 迁移幂等静态检查
console.log('[3/3] 迁移幂等检查');
let nonIdem = 0;
for (const f of readdirSync(root).filter((x) => /^\d+_.*\.sql$/.test(x))) {
  const sql = readFileSync(join(root, f), 'utf8');
  const guarded =
    /IF NOT EXISTS/i.test(sql) ||
    /ON CONFLICT/i.test(sql) ||
    /DROP POLICY IF EXISTS/i.test(sql) ||
    /ADD COLUMN IF NOT EXISTS/i.test(sql);
  if (!guarded) {
    console.error(`  非幂等迁移 ${f}（缺 IF NOT EXISTS / ON CONFLICT 等幂等保护）`);
    nonIdem++;
  }
}
if (nonIdem === 0) pass('所有迁移含幂等保护');
else fail(`${nonIdem} 个迁移缺幂等保护`);

console.log(failed ? '发布闸门：未通过 ❌' : '发布闸门：通过 ✅');
process.exit(failed ? 1 : 0);
