// 发布基线：把 backend + frontend 的真实 commit、迁移、OpenAPI 与构建产物绑定成一份可追溯清单。
//
// 用法（Windows 无 PATH git 时用 GIT_BIN 指向 PortableGit）：
//   GIT_BIN=... node scripts/release-baseline.mjs --frontend ../youfu_frontend_dev
//   node scripts/release-baseline.mjs --frontend ../youfu_frontend_dev --allow-dirty
//
// 默认 fail-closed：任一仓库无法读取 commit 或工作树不干净 → 退出码 1。
// 生成 release-baseline.json（不入源码库，作为发布 artifact 与部署目录证据）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
const allowDirty = argv.includes('--allow-dirty');
const frontendDir = argValue('--frontend') ? resolve(argValue('--frontend')) : null;
const outFile = resolve(argValue('--out') || 'release-baseline.json');
const gitBin = process.env.GIT_BIN || 'git';

function git(dir, args) {
  try {
    return execFileSync(gitBin, ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function walk(dir, root = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, root, out);
    else out.push({ path: p.slice(root.length + 1).replaceAll('\\', '/'), bytes: st.size, sha256: sha256File(p) });
  }
  return out;
}

function bundle(dir) {
  if (!dir || !existsSync(dir)) return null;
  const files = walk(dir).sort((a, b) => a.path.localeCompare(b.path));
  const sha256 = createHash('sha256').update(files.map((f) => `${f.path}:${f.sha256}`).join('\n')).digest('hex');
  return { dir, fileCount: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), sha256, files };
}

function repo(dir, distDirs) {
  if (!dir) return null;
  const commit = git(dir, ['rev-parse', 'HEAD']);
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(dir, ['status', '--porcelain']);
  const packageLock = existsSync(join(dir, 'package-lock.json')) ? sha256File(join(dir, 'package-lock.json')) : null;
  return {
    dir,
    commit: commit || null,
    branch: branch || null,
    clean: status === '',
    dirtyFiles: status ? status.split('\n').slice(0, 50) : [],
    packageLockSha256: packageLock,
    artifacts: Object.fromEntries(Object.entries(distDirs).map(([k, v]) => [k, bundle(join(dir, v))])),
  };
}

const backend = repo(resolve('.'), { dist: 'dist' });
const migrations = readdirSync('.')
  .filter((f) => /^\d+_.+\.sql$/.test(f))
  .sort()
  .map((f) => ({ name: f, sha256: sha256File(f) }));
const openapi = existsSync('docs/openapi.json') ? sha256File('docs/openapi.json') : null;
const frontend = frontendDir
  ? repo(frontendDir, { dist: 'dist', pilotDist: 'dist-pilot-path' })
  : null;

const errors = [];
if (!backend?.commit) errors.push('backend: 无法读取 git commit');
if (backend && !backend.clean) errors.push(`backend: 工作树不干净（${backend.dirtyFiles.length} 个文件）`);
if (frontend) {
  if (!frontend.commit) errors.push('frontend: 无法读取 git commit');
  if (!frontend.clean) errors.push(`frontend: 工作树不干净（${frontend.dirtyFiles.length} 个文件）`);
}
if (errors.length && !allowDirty) {
  console.error('[release-baseline] FAIL');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
}

const baseline = {
  schemaVersion: 1,
  releaseId: `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${(backend?.commit || 'nogit').slice(0, 12)}`,
  generatedAt: new Date().toISOString(),
  node: process.version,
  backend: { ...backend, openapiSha256: openapi, migrationCount: migrations.length, migrations },
  frontend,
  warnings: errors,
};
writeFileSync(outFile, JSON.stringify(baseline, null, 2) + '\n');
console.log(`[release-baseline] ${baseline.releaseId}`);
console.log(`  backend  commit=${backend?.commit ?? '-'} clean=${backend?.clean} migrations=${migrations.length} openapi=${openapi?.slice(0, 12) ?? '-'}`);
if (frontend) console.log(`  frontend commit=${frontend.commit ?? '-'} clean=${frontend.clean} dist=${frontend.artifacts.dist?.sha256.slice(0, 12) ?? '-'}`);
if (errors.length) console.log(`  warnings: ${errors.join('; ')}`);
console.log(`  out=${outFile}`);
