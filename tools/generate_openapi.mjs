// M-3 OpenAPI 规范生成器：扫描 src/server.ts 挂载表 + 路由文件真实声明，
// 生成 docs/openapi.json（OpenAPI 3.1，JSON 形态——无新增 npm 依赖，序列化零歧义）。
//
// 口径声明（诚实边界）：
// - 路径/方法 100% 来自代码扫描（server.ts app.use 挂载 + router.<verb>('<path>') 声明）；
// - summary/description 取自路由声明上方紧邻的中文注释块（启发式，可能不完整）；
// - 请求/响应 schema 为宽松骨架（object + additionalProperties），字段以服务端实现为准，禁止编造；
// - 状态码取自 handler 窗口内 res.status(NNN) 字面量 + res.json 推定的 200（启发式）；
// - security 分类依据 src/middleware/apiGuard.ts 与 src/middleware/openApiAuth.ts 语义。
//
// 用法：node tools/generate_openapi.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'server.ts');

// ---------- 1. 解析 server.ts：import 变量名 → 路由文件 ----------
const serverSrc = readFileSync(SERVER, 'utf8');

// 默认导入：import xxxRouter from './routes/yyy.js' 或 './webhook/routes.js'
const importMap = new Map(); // varName -> 'routes/yyy.ts' | 'webhook/routes.ts'
for (const m of serverSrc.matchAll(/import\s+(\w+)\s+from\s+'(\.\/(?:routes|webhook)\/[\w.-]+)\.js'/g)) {
  importMap.set(m[1], `${m[2]}.ts`.replace(/^\.\//, ''));
}

// 挂载表：app.use('<prefix>', xxxRouter)（仅收 importMap 内的 router 变量，
// 天然排除 apiGuardMiddleware / authMiddleware / express.static 等非 router 挂载）
const mounts = [];
for (const m of serverSrc.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
  if (importMap.has(m[2])) mounts.push({ prefix: m[1], file: importMap.get(m[2]), varName: m[2] });
}

// server.ts 内联 app.get（/health API + 三个管理页 HTML 外壳）
const serverInlineGets = [];
for (const m of serverSrc.matchAll(/app\.get\(\s*'([^']+)'/g)) {
  serverInlineGets.push(m[1]);
}
const SERVER_DASHBOARD_PAGES = ['/process-mining', '/master-data', '/workflow-admin']; // 非 API，不入 spec
const SERVER_API_INLINE = serverInlineGets.filter((p) => !SERVER_DASHBOARD_PAGES.includes(p));

// ---------- 2. 扫描路由文件 ----------
const VERB_RE = /^\s*router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/;

// 路由声明上方紧邻的注释块（逐行向上，遇非注释/空行即止）
function extractComment(lines, declIdx) {
  const out = [];
  let i = declIdx - 1;
  while (i >= 0) {
    const line = lines[i].trim();
    if (line === '' || !/^(\/\/|\*|\/\*\*)/.test(line)) break;
    out.unshift(line.replace(/^\/\*\*|^\/\/^ \*?|^\/\/\s?|^\*\s?|\*\/$/g, '').trim());
    i--;
  }
  // 去掉注释里自带的方法+路径前缀（如 "GET /api/v1/webhooks/subscriptions —— 注册订阅"）
  return out
    .filter(Boolean)
    .map((l) => l.replace(/^(GET|POST|PUT|PATCH|DELETE)\s+\/\S+\s*[——-]\s*/, ''))
    .filter(Boolean);
}

// res.status(<arg>) 参数 → 状态码集合：
// - 纯数字字面量（可能多个）→ 全部加入；
// - 三元/变量表达式 → 提取其中的三位数字字面量（如 `core.created ? 201 : 200` → {201,200}）；
//   一个字面量都提不出（如 res.status(result.status) 变量转发）→ 回退推定 200。
function statusCodesFromArg(arg) {
  const codes = new Set();
  const nums = [...arg.matchAll(/\b(\d{3})\b/g)].map((m) => m[1]);
  if (nums.length) nums.forEach((n) => codes.add(n));
  else codes.add('200');
  return codes;
}

// 判定"有成功响应体"（推定 200）：json/send/sendFile/end 显式响应，或 stream.pipe(res) 流式响应
const HAS_BODY_RE = /res\.(json|send|sendFile|end)\(|\.pipe\(res\)/;

// 扫一段行区间 [start, end) 的状态码与响应体迹象
function scanStatusesInRange(lines, start, end) {
  const codes = new Set();
  let hasBody = false;
  for (let i = start; i < end && i < lines.length; i++) {
    for (const m of lines[i].matchAll(/res\.status\(([^)]*)\)/g)) {
      for (const c of statusCodesFromArg(m[1])) codes.add(c);
    }
    if (HAS_BODY_RE.test(lines[i])) hasBody = true;
  }
  return { codes, hasBody };
}

// 本地函数定义识别：function name( / const name = (支持 async arrow / function 表达式)
const FUNC_DEF_RE = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=]*?)?=>|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?function/;

// 引号/注释感知的花括号配对：从 lines[startIdx] 起找第一个 '{'，返回平衡 '}' 所在行号（含）。
// 跳过字符串字面量（' " `）与 // /* */ 注释内的花括号，防模板串 `${...}` 干扰配对。
function findBlockEnd(lines, startIdx) {
  let depth = 0, started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const s = lines[i];
    let q = null; // 当前处于的引号态：' " `
    for (let j = 0; j < s.length; j++) {
      const ch = s[j], nx = s[j + 1];
      if (q) {
        if (ch === '\\') { j++; continue; }
        if (ch === q) q = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { q = ch; continue; }
      if (ch === '/' && nx === '/') break;      // 行注释
      if (ch === '/' && nx === '*') {           // 块注释（ assume 单行内闭合即可，跨行块注释本仓库函数头常见 —— 保守按扫描到 */ 为止）
        const end = s.indexOf('*/', j + 2);
        if (end === -1) { j = s.length; continue; }
        j = end + 1; continue;
      }
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; if (started && depth === 0) return i; }
    }
  }
  return lines.length - 1;
}

// 收集文件内本地函数定义：name -> [startIdx, endIdx]（函数体行范围）
function localFunctionBodies(lines) {
  const bodies = new Map();
  lines.forEach((line, idx) => {
    const m = FUNC_DEF_RE.exec(line);
    if (!m) return;
    const name = m[1] ?? m[2] ?? m[3];
    if (!name || bodies.has(name)) return;
    bodies.set(name, [idx, findBlockEnd(lines, idx) + 1]);
  });
  return bodies;
}

// handler 窗口：从声明行到下一个 router.<verb>/router.use/export default 之前；
// 若窗口内调用了同文件的本地具名函数（如 uploads.ts handler 委托 serveUpload），
// 把这些函数体的状态码扫描并入（委托函数中的 res.status/sendFile 与 handler 自身等价）。
function extractStatuses(lines, declIdx, funcBodies) {
  const end = (() => {
    for (let i = declIdx + 1; i < lines.length; i++) {
      if (/^\s*(router\.(get|post|put|patch|delete|use)|export default)/.test(lines[i])) return i;
    }
    return lines.length;
  })();
  const { codes, hasBody } = scanStatusesInRange(lines, declIdx + 1, end);
  // 窗口内被调用的本地函数 → 并入其函数体扫描结果
  const windowText = lines.slice(declIdx + 1, end).join('\n');
  for (const m of windowText.matchAll(/(\w+)\s*\(/g)) {
    const body = funcBodies.get(m[1]);
    if (!body) continue;
    const sub = scanStatusesInRange(lines, body[0] + 1, body[1]);
    sub.codes.forEach((c) => codes.add(c));
    if (sub.hasBody) codes.add('200');
  }
  if (hasBody || codes.size === 0) codes.add('200');
  return [...codes].sort();
}

function scanRouterFile(relFile) {
  const abs = join(ROOT, 'src', relFile);
  const src = readFileSync(abs, 'utf8');
  const lines = src.split(/\r?\n/);
  const funcBodies = localFunctionBodies(lines);
  const routes = [];
  lines.forEach((line, idx) => {
    const m = VERB_RE.exec(line);
    if (!m) return;
    const method = m[1].toLowerCase();
    const rawPath = m[3];
    const oasPath = rawPath.replace(/:(\w+)/g, '{$1}');
    routes.push({
      method,
      path: oasPath,
      line: idx + 1,
      summary: extractComment(lines, idx)[0] ?? '',
      description: extractComment(lines, idx).slice(1).join('\n'),
      statuses: extractStatuses(lines, idx, funcBodies),
    });
  });
  return routes;
}

// ---------- 3. 安全分类（依据 apiGuard.ts / openApiAuth.ts 语义） ----------
// - /health、/api/v1/public/*（publicReport/publicAiChat 挂 auth 之前）、/api/v1/wechat/*（JSSDK 签名）→ 公开
// - /api/v1/open-api/*（openApiAuth：X-App-Key + X-App-Secret 双头；其 /health 免凭据）→ openApiKey
// - /uploads/{tenant}/{file}（双通道：youfu_dash JWT cookie 或 ?token=public_view_token）→ 公开+注记
// - 其余 → bearerAuth（JWT；authMiddleware 挂 /api 全局）
function securityFor(fullPath) {
  if (fullPath === '/health') return { security: [], note: '健康检查，公开' };
  if (fullPath === '/api/v1/open-api/health') return { security: [], note: '开放 API 连通性探针，免 app 凭据' };
  if (fullPath.startsWith('/api/v1/open-api/')) return { security: [{ openApiKey: [] }, { openApiSecret: [] }] };
  if (fullPath.startsWith('/api/v1/public/')) return { security: [], note: '免登录公开端点（限流保护）' };
  if (fullPath.startsWith('/api/v1/wechat/')) return { security: [], note: '微信 JSSDK 公开签名端点（限流保护）' };
  if (fullPath.startsWith('/uploads/')) return { security: [], note: '双通道鉴权：youfu_dash JWT cookie（同源 <img>/<audio> 自动携带）或 ?token=<public_view_token>' };
  return { security: [{ bearerAuth: [] }] };
}

// ---------- 4. 组装 OpenAPI 3.1 ----------
const tagOf = (relFile) => (relFile.endsWith('webhook/routes.ts') ? 'webhook' : relFile.replace(/^routes\/|\.ts$/g, ''));
const paths = {};
const tagDocs = new Map(); // tag -> 路由文件列表
let totalOps = 0;

for (const { prefix, file } of mounts) {
  const routes = scanRouterFile(file);
  const tag = tagOf(file);
  if (!tagDocs.has(tag)) tagDocs.set(tag, []);
  tagDocs.get(tag).push(`src/${file}`);
  for (const r of routes) {
    const full = (prefix + r.path).replace(/\/+/g, '/');
    const sec = securityFor(full);
    const op = {
      tags: [tag],
      summary: r.summary || `${r.method.toUpperCase()} ${full}`,
      description: [
        r.description,
        r.summary ? '' : '',
        `来源：src/${file}:${r.line}`,
        r.statuses.length ? `服务端响应状态码（代码扫描）：${r.statuses.join(', ')}` : '',
        sec.note,
        '请求/响应体为骨架占位（宽松 object），字段以服务端实现为准。',
      ]
        .filter((s) => s !== '')
        .join('\n\n'),
      security: sec.security,
      responses: Object.fromEntries(
        r.statuses.map((c) => [
          c,
          {
            description: `HTTP ${c}`,
            content: { 'application/json': { schema: { type: 'object', additionalProperties: true, description: '骨架占位：字段以服务端实现为准' } } },
          },
        ]),
      ),
    };
    // 路径参数
    const params = [...full.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: '路径参数（原代码声明形如 :param）',
    }));
    if (params.length) op.parameters = params;
    // 请求体（有 body 语义的方法）
    if (['post', 'put', 'patch'].includes(r.method)) {
      op.requestBody = {
        required: false,
        content: { 'application/json': { schema: { type: 'object', additionalProperties: true, description: '骨架占位：请求字段以服务端实现为准' } } },
      };
    }
    paths[full] = paths[full] ?? {};
    if (paths[full][r.method]) {
      console.warn(`[warn] 重复操作 ${r.method.toUpperCase()} ${full}（src/${file}:${r.line}），覆盖保留`);
    }
    paths[full][r.method] = op;
    totalOps++;
  }
}

// server.ts 内联 API（/health）
for (const p of SERVER_API_INLINE) {
  if (paths[p]) continue;
  paths[p] = {
    get: {
      tags: ['server'],
      summary: '健康检查（不含 DB，永远 200）',
      description: '来源：src/server.ts（app.get 内联声明）',
      security: [],
      responses: {
        '200': {
          description: '服务存活',
          content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
        },
      },
    },
  };
  totalOps++;
}

const now = new Date().toISOString();
const spec = {
  openapi: '3.1.0',
  info: {
    title: '优服家 API',
    version: '0.0.0-generated',
    description: [
      '多租户物业 SaaS 后端开放规范（M-3 交付）。',
      '**口径**：本文件由 `tools/generate_openapi.mjs` 自动扫描 `src/server.ts` 挂载表与 `src/routes/*.ts`、`src/webhook/routes.ts` 路由声明生成（generated，非手写）。',
      '**诚实边界**：summary/description 取自路由上方中文注释（启发式）；请求/响应 schema 为宽松骨架，字段一律以服务端实现为准，不编造字段。',
      '**鉴权**：租户/管理端 JWT Bearer；开放 API 走 X-App-Key + X-App-Secret（openApiAuth）；公开端点见各操作 security: []。',
    ].join('\n\n'),
    'x-generated-at': now,
    'x-generator': 'tools/generate_openapi.mjs',
    'x-source': 'src/server.ts + src/routes/*.ts + src/webhook/routes.ts（代码扫描口径）',
  },
  servers: [{ url: 'https://youfu.banerz.cn' }],
  tags: [...tagDocs.entries()].map(([name, files]) => ({
    name,
    description: `路由文件：${[...new Set(files)].join(', ')}`,
  })).concat([{ name: 'server', description: 'server.ts 内联端点（/health）' }]),
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '租户/管理端 JWT（Authorization: Bearer <token>，authMiddleware）' },
      openApiKey: { type: 'apiKey', in: 'header', name: 'X-App-Key', description: '开放 API 应用凭据（openApiAuth 双因子之一）' },
      openApiSecret: { type: 'apiKey', in: 'header', name: 'X-App-Secret', description: '开放 API 应用凭据（openApiAuth 双因子之二）' },
    },
  },
};

// ---------- 5. 落盘 ----------
const docsDir = join(ROOT, 'docs');
if (!existsSync(docsDir)) mkdirSync(docsDir);
const outPath = join(docsDir, 'openapi.json');
writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');

// ---------- 6. 摘要 ----------
console.log(`[openapi] 已生成 ${outPath}`);
console.log(`[openapi] 端点操作总数：${totalOps}；路径数：${Object.keys(paths).length}`);
console.log(`[openapi] 扫描挂载：${mounts.length} 条 app.use；涉及路由文件：${new Set(mounts.map((m) => m.file)).size} 个`);
for (const { prefix, file } of mounts) {
  const n = scanRouterFile(file).length;
  console.log(`  ${prefix.padEnd(20)} src/${file.padEnd(28)} ${n} 个端点`);
}
console.log(`[openapi] server.ts 内联 API：${SERVER_API_INLINE.join(', ') || '无'}`);
console.log(`[openapi] 排除的管理页 HTML 外壳（非 API）：${SERVER_DASHBOARD_PAGES.join(', ')}`);
