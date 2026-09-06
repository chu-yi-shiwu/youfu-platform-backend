#!/usr/bin/env node
/**
 * pre-commit typecheck 强制门（T-U01-P1 · 2026-09-06）
 *
 * 背景：typecheck 门禁（P2-3 上线）当日即被击穿——491cd7a 引入 4 个类型错而测试全绿，
 * 无人拦截。本脚本把 `npm run typecheck`（tsc --noEmit，全仓含测试）挂进 pre-commit
 * 链，作为 DoD 门禁之外的第二道本地强制：类型错不过，提交被拦。
 *
 * 接线方式（.git/hooks/pre-commit 在 DoD 门之后追加）：
 *   TYPECHECK_HOOK="scripts/precommit_typecheck.mjs"
 *   if [ -f "$TYPECHECK_HOOK" ]; then
 *     "$NODE_DOD" "$TYPECHECK_HOOK" || exit 1
 *   fi
 * （.git/hooks 不入版本库；本文件即仓内真身——换机重建时把上述三行加回 hook 即可。）
 *
 * 设计：秒级纯本地检查，与 DoD 门的硬护栏（禁连网/连库）同纪律；失败时输出人话指引，
 * 紧急通道与 DoD 门一致（git commit --no-verify，会留痕）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(ROOT, 'package.json');

if (!existsSync(PKG)) {
  console.log('⚠️ [pre-commit/typecheck] 未找到 package.json，跳过');
  process.exit(0);
}

let hasScript = false;
try {
  hasScript = Boolean(JSON.parse(readFileSync(PKG, 'utf8')).scripts?.typecheck);
} catch (e) {
  console.log(`⚠️ [pre-commit/typecheck] package.json 解析失败，跳过：${e.message}`);
  process.exit(0);
}

if (!hasScript) {
  console.log('⚠️ [pre-commit/typecheck] 无 typecheck script（P2-3 未落地？），跳过');
  process.exit(0);
}

console.log('🔍 [pre-commit/typecheck] tsc --noEmit 全仓类型门...');
try {
  execFileSync('npm', ['run', 'typecheck'], { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' });
} catch (e) {
  console.log('');
  console.log('❌ [pre-commit/typecheck] 类型门未通过，已拦截本次提交。');
  console.log('   修复类型错误后重新 git commit；紧急跳过：git commit --no-verify（会留痕，月度自检可查）');
  process.exit(typeof e.status === 'number' && e.status !== 0 ? e.status : 1);
}
console.log('✅ [pre-commit/typecheck] 类型门通过');
process.exit(0);
