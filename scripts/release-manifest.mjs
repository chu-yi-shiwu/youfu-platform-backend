// 生成可追溯发布清单（2026-11-20）
// CI 在指定 commit 上构建后执行；部署目录必须保存同一份 manifest。
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; }
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push({ path: p.replaceAll('\\', '/'), bytes: st.size, sha256: sha256File(p) });
  }
  return out;
}

const commit = process.env.GITHUB_SHA || process.env.GIT_COMMIT || sh('git rev-parse HEAD');
const tree = process.env.GITHUB_ACTIONS === 'true' ? '' : sh('git status --porcelain');
const migrations = readdirSync('.')
  .filter((f) => /^\d+_.+\.sql$/.test(f))
  .sort();
const distFiles = (() => {
  try { return walk('dist'); } catch { return []; }
})();
const distDigest = createHash('sha256')
  .update(distFiles.map((f) => `${f.path}:${f.sha256}`).join('\n'))
  .digest('hex');

const manifest = {
  commit: commit || null,
  cleanTree: tree === '',
  buildTime: new Date().toISOString(),
  node: process.version,
  packageLockSha256: (() => { try { return sha256File('package-lock.json'); } catch { return null; } })(),
  migrations,
  migrationCount: migrations.length,
  distFileCount: distFiles.length,
  distSha256: distDigest,
  distFiles,
};
writeFileSync('release-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`[release-manifest] commit=${manifest.commit} clean=${manifest.cleanTree} migrations=${manifest.migrationCount} dist=${manifest.distFileCount} digest=${manifest.distSha256.slice(0, 12)}`);
