// 097 的三条**结构性**护栏（纯静态扫描）。
//
// 【为什么不用「逐个端点写一条 it」的做法】
//   那样做，下次有人新增一个改流程的端点却忘了挂闸门，测试**照样全绿**——
//   护栏必须能自己发现新成员。所以这里扫源码：凡是会改写流程定义的写端点，必须有闸门。
//
// 扫描规则（src/routes/*.ts，排除测试）：
//   ① 端点函数体内出现「改流程定义」的调用（存草稿/落 live/删在途/应用优化）⇒ 必须调用归属闸门；
//      平台侧路由（含 platformAdminAuth）例外——它本就是平台身份，走平台通道，不套租户闸门。
//   ② 平台侧（097 新增）的写端点必须调用 audit() 留痕。
//   ③ openapi 契约里 097 新增的 6 个平台端点必须存在且声明 security。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const ROUTES_DIR = join(ROOT, 'src', 'routes');

/**
 * 「改流程端点」的两条判据（命中其一即算）：
 *   A. 端点体里有流程权限点校验（workflow.edit / workflow.approve）——
 *      覆盖那些**间接**写库（走引擎函数、体内看不到 def 写入字面量）的端点；
 *   B. 端点体里出现改流程定义的调用（存草稿/落 live/删在途/应用优化）。
 * 只留 B 会漏掉 3 个间接写入的端点（实测），只留 A 会漏掉 optimize 系旁路（实测）。
 */
const DEF_WRITE_RE = /upsertWorkflowDefDraft|saveWorkflowDef|deleteWorkflowDefChange|applyWorkflowOptimizations/;
const WF_PERM_RE = /requirePermission\([^)]*'workflow\.(edit|approve)'/;
/** 归属闸门调用。 */
const GUARD_RE = /assertWorkflowConfigEditableByTenant/;

interface Endpoint {
  file: string;
  method: string;
  path: string;
  body: string;
  line: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p, out); continue; }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** 按 `router.<method>('path',` 切块：每块的正文到下一个端点声明（或文件末）为止。 */
function parseEndpoints(file: string): Endpoint[] {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const marks: Array<{ method: string; path: string; line: number; idx: number }> = [];
  const re = /^router\.(get|put|post|patch|delete)\(\s*'([^']+)'/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    marks.push({ method: m[1], path: m[2], line, idx: m.index });
  }
  const out: Endpoint[] = [];
  for (let i = 0; i < marks.length; i++) {
    const startLine = marks[i].line;
    const endLine = i + 1 < marks.length ? marks[i + 1].line : lines.length;
    out.push({
      file: relative(ROOT, file).replace(/\\/g, '/'),
      method: marks[i].method,
      path: marks[i].path,
      line: startLine,
      body: lines.slice(startLine - 1, endLine - 1).join('\n'),
    });
  }
  return out;
}

const ROUTE_FILES = walk(ROUTES_DIR);
const ALL_ENDPOINTS = ROUTE_FILES.flatMap(parseEndpoints);

/** 平台侧路由：走 platformAdminAuth，不套租户闸门。 */
function isPlatformRoute(file: string): boolean {
  return /platformAdminAuth/.test(readFileSync(file, 'utf8'));
}

const TENANT_ROUTES = ROUTE_FILES.filter((f) => !isPlatformRoute(f));

describe('097 护栏①：凡是改流程定义的租户侧端点，必须挂归属闸门', () => {
  // 只认**写方法**：GET /pending 之类虽然要 workflow.approve 权限，但它是读端点，
  // 挂闸门会让「客户看不见待自己审批的清单」——那不是收口，是自残。
  const defWriters = TENANT_ROUTES
    .flatMap(parseEndpoints)
    .filter((e) => e.method !== 'get')
    .filter((e) => DEF_WRITE_RE.test(e.body) || WF_PERM_RE.test(e.body));

  it('扫描必须真的扫到东西（空集通过不算通过 —— 解析失效要红，不许静默空过）', () => {
    expect(ALL_ENDPOINTS.length).toBeGreaterThan(50);
    // 13 = workflowDef 11 + optimize 的 PUT /workflow/def、generate-mining、apply-workflow
    expect(defWriters.length).toBeGreaterThanOrEqual(13);
  });

  it('逐个断言：改流程的端点都有闸门，一个都不能漏', () => {
    const missing = defWriters
      .filter((e) => !GUARD_RE.test(e.body))
      .map((e) => `${e.file}:${e.line} ${e.method.toUpperCase()} ${e.path}`);
    expect(missing, `以下端点会改写流程定义却没有归属闸门（客户可绕过收口）：\n${missing.join('\n')}`).toEqual([]);
  });

  it('闸门数量与改流程端点数量一致（防止有人加了端点却复制粘贴漏改）', () => {
    // 只数**真的调用**：排除 import 行与注释行，否则 import 语句会把计数顶高、掩盖缺失。
    const guardCount = TENANT_ROUTES.reduce((n, f) => {
      const lines = readFileSync(f, 'utf8').split('\n');
      return n + lines.filter((l) => GUARD_RE.test(l)
        && !l.trim().startsWith('import')
        && !l.trim().startsWith('//')
        && !l.trim().startsWith('*')).length;
    }, 0);
    expect(guardCount).toBe(defWriters.length);
  });

  it('读端点不得被误伤：GET 类端点一个都不该挂闸门（客户必须看得见自己的流程）', () => {
    const guardedGets = TENANT_ROUTES
      .flatMap(parseEndpoints)
      .filter((e) => e.method === 'get' && GUARD_RE.test(e.body));
    expect(guardedGets.map((e) => `${e.file}:${e.line} ${e.path}`)).toEqual([]);
  });
});

describe('097 护栏②：平台侧写端点必须留痕（写操作零例外）', () => {
  const platformFiles = ROUTE_FILES.filter((f) => relative(ROOT, f).includes('platformWorkflow'));

  it('扫到平台侧路由文件（防白名单写错导致空集恒绿）', () => {
    expect(platformFiles.length).toBe(1);
  });

  it('所有非 GET 端点都必须调用 audit()', () => {
    const missing = platformFiles
      .flatMap(parseEndpoints)
      .filter((e) => e.method !== 'get')
      .filter((e) => !/await audit\(/.test(e.body))
      .map((e) => `${e.file}:${e.line} ${e.method.toUpperCase()} ${e.path}`);
    expect(missing, `平台侧下列写端点没有留痕：\n${missing.join('\n')}`).toEqual([]);
  });

  it('GET 端点不留痕（读操作无副作用，不该污染审计流）', () => {
    const auditedGets = platformFiles
      .flatMap(parseEndpoints)
      .filter((e) => e.method === 'get' && /await audit\(/.test(e.body));
    expect(auditedGets.map((e) => `${e.file}:${e.line} ${e.path}`)).toEqual([]);
  });

  it('平台侧路由整体挂在 platformAdminAuth 上（router.use，不是逐端点）', () => {
    const text = readFileSync(platformFiles[0], 'utf8');
    expect(/router\.use\(platformAdminAuth\)/.test(text)).toBe(true);
  });
});

describe('097 护栏③：openapi 契约必须收录这 6 个平台端点且声明 security', () => {
  const spec = JSON.parse(readFileSync(join(ROOT, 'docs', 'openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, { security?: unknown[] }>>;
  };

  const NEEDED: Array<[string, string]> = [
    ['/api/v1/platform/config/workflow-config-owner', 'get'],
    ['/api/v1/platform/config/workflow-config-owner', 'put'],
    ['/api/v1/platform/tenants/{id}/workflow-def/{entityType}', 'get'],
    ['/api/v1/platform/tenants/{id}/workflow-def/{entityType}', 'put'],
    ['/api/v1/platform/tenants/{id}/workflow-def/{entityType}/submit', 'post'],
    ['/api/v1/platform/tenants/{id}/workflow-def/{entityType}/approve', 'post'],
    ['/api/v1/platform/tenants/{id}/workflow-def/{entityType}/reject', 'post'],
    ['/api/v1/platform/tenants/{id}/workflow-def-pending', 'get'],
  ];

  for (const [p, method] of NEEDED) {
    it(`${method.toUpperCase()} ${p} 已在契约中且声明 security`, () => {
      const item = spec.paths[p];
      expect(item, `契约缺少路径 ${p}`).toBeTruthy();
      const op = item?.[method];
      expect(op, `契约缺少 ${method.toUpperCase()} ${p}`).toBeTruthy();
      expect(Array.isArray(op?.security) && op!.security!.length > 0,
        `${method.toUpperCase()} ${p} 未声明 security（平台端点必须带鉴权声明）`).toBe(true);
    });
  }

  it('契约总路径数不得倒退（新增端点后应增加，不能因为重生成把既有路径弄丢）', () => {
    expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(254);
  });
});
