// M-3 OpenAPI 覆盖机器门（双向）：代码扫描全集 vs docs/openapi.json
//
// 设计原则：独立重算路由全集（不 import 生成器共享逻辑）——生成器与门禁各自解析，
// 避免同一套解析 bug 互相包庇。解析实现刻意走不同写法（逐行 split + 行级正则，
// 与生成器的 matchAll 全文扫描互为印证）。
//
// 豁免清单（代码侧存在但允许不在 spec 中出现的路径）见下方 CODE_ONLY_EXEMPTS，每项附理由。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------- A. 独立重算代码路由全集 ----------
// A1. server.ts：import 变量 → 文件；app.use 挂载 → 前缀
const serverSrc = readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8');

const importToFile = new Map<string, string>();
for (const line of serverSrc.split(/\r?\n/)) {
  const m = /^import\s+(\w+)\s+from\s+'(\.\/(?:routes|webhook)\/[\w.-]+)\.js'/.exec(line);
  if (m) importToFile.set(m[1], `${m[2].replace(/^\.\//, '')}.ts`);
}

const mounts: Array<{ prefix: string; file: string }> = [];
for (const line of serverSrc.split(/\r?\n/)) {
  const m = /app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/.exec(line);
  if (m && importToFile.has(m[2])) mounts.push({ prefix: m[1], file: importToFile.get(m[2])! });
}
// 挂载表非空（防止解析逻辑退化导致空集“全绿”假阴性）
expect(mounts.length).toBeGreaterThanOrEqual(35);

// A2. server.ts 内联 app.get
const serverInline: string[] = [];
for (const line of serverSrc.split(/\r?\n/)) {
  const m = /app\.get\(\s*'([^']+)'/.exec(line);
  if (m) serverInline.push(m[1]);
}

// A3. 路由文件清单：挂载表里的文件 + src/routes 目录全量 *.ts（排除非路由文件）
const routesDir = join(ROOT, 'src', 'routes');
const dirFiles = readdirSync(routesDir).filter((f) => f.endsWith('.ts'));
const NON_ROUTER_FILES = new Set([
  'publicReportSchema.ts', // 纯 zod schema 模块，不导出 router
  'equipment.test.ts', // 单测文件
]);
const scannedFiles = new Set<string>([...mounts.map((m) => m.file), ...dirFiles.filter((f) => !NON_ROUTER_FILES.has(f)).map((f) => `routes/${f}`)]);

const codeOps = new Set<string>(); // "GET /api/v1/xxx"
const perFileCount = new Map<string, number>();
for (const rel of scannedFiles) {
  const src = readFileSync(join(ROOT, 'src', rel), 'utf8');
  let count = 0;
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/.exec(line);
    if (!m) continue;
    count++;
    // 该文件被挂载的每个前缀都生成一条（多前缀挂同文件时对外路径可能不同）
    for (const { prefix, file } of mounts) {
      if (file !== rel) continue;
      codeOps.add(`${m[1].toUpperCase()} ${(prefix + m[2]).replace(/:(\w+)/g, '{$1}').replace(/\/+/g, '/')}`);
    }
  }
  perFileCount.set(rel, count);
}
// server.ts 内联 API（/health）；三个管理页 HTML 外壳豁免（见 CODE_ONLY_EXEMPTS）
for (const p of serverInline) codeOps.add(`GET ${p}`);

// 代码侧豁免清单：存在于代码但允许缺席 spec 的路径。每一项必须给理由。
const CODE_ONLY_EXEMPTS = new Map<string, string>([
  // server.ts 内联 app.get：顶层管理页 HTML 外壳（requireDashboardAuth 保护），
  // 属页面路由而非 API，返回 HTML 文件而非 JSON，不纳入 API 规范。
  ['/process-mining', 'server.ts 管理页 HTML 外壳（过程挖掘看板），非 API'],
  ['/master-data', 'server.ts 管理页 HTML 外壳（主数据配置页），非 API'],
  ['/workflow-admin', 'server.ts 管理页 HTML 外壳（流程规则管理页），非 API'],
]);

// ---------- B. 读取 spec 并展开为操作全集 ----------
const specPath = join(ROOT, 'docs', 'openapi.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const specOps = new Set<string>();
for (const [p, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
  for (const method of Object.keys(item)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    specOps.add(`${method.toUpperCase()} ${p}`);
  }
}

// ---------- C. 双向比对 ----------
describe('M-3 OpenAPI 覆盖机器门（docs/openapi.json vs 代码扫描）', () => {
  it('代码扫描的每个 mounted route 都出现在 spec（豁免清单除外）', () => {
    const missing: string[] = [];
    for (const op of codeOps) {
      if (CODE_ONLY_EXEMPTS.has(op.replace(/^[A-Z]+ /, ''))) continue;
      if (!specOps.has(op)) missing.push(op);
    }
    expect(missing, `spec 缺失 ${missing.length} 个代码端点:\n${missing.join('\n')}`).toEqual([]);
  });

  it('spec 中的每个 path+method 都存在于代码扫描结果', () => {
    const extra: string[] = [];
    for (const op of specOps) {
      if (!codeOps.has(op)) extra.push(op);
    }
    expect(extra, `spec 包含 ${extra.length} 个代码中不存在的端点:\n${extra.join('\n')}`).toEqual([]);
  });

  it('端点规模 sanity：spec 操作数应与代码扫描数一致且 ≥ 250（防扫描器退化）', () => {
    const codeEffective = [...codeOps].filter((op) => !CODE_ONLY_EXEMPTS.has(op.replace(/^[A-Z]+ /, ''))).length;
    expect(specOps.size).toBe(codeEffective);
    expect(specOps.size).toBeGreaterThanOrEqual(250);
  });

  it('spec 基本结构：OpenAPI 3.1 + bearerAuth 定义 + servers 指向生产域名', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('优服家 API');
    expect(spec.components?.securitySchemes?.bearerAuth?.scheme).toBe('bearer');
    expect(spec.servers?.[0]?.url).toBe('https://youfu.banerz.cn');
    // 公开端点语义抽查（apiGuard/openApiAuth 语义）：公开路径 security 应为空数组
    expect(spec.paths['/health'].get.security).toEqual([]);
    expect(spec.paths['/api/v1/public/scan'].get.security).toEqual([]);
    expect(spec.paths['/api/v1/wechat/jssdk-config'].get.security).toEqual([]);
    // 租户业务端点默认 bearerAuth
    expect(spec.paths['/api/v1/open/work_order'].post.security).toEqual([{ bearerAuth: [] }]);
    // 开放 API 走 app_key 双因子
    expect(spec.paths['/api/v1/open-api/tenants/summary'].get.security).toEqual([{ openApiKey: [] }, { openApiSecret: [] }]);
  });
});
