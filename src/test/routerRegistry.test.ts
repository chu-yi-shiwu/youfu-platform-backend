// routerRegistry.test.ts —— 结构一致性护栏①（最高性价比）：一次性消灭「router 漏挂载 / 白名单漏登记」整类 bug。
//
// 【真实事故复盘 · 为什么写这个测试】
//   事故 A（批次三 live 404）：新增 router 只在 server.ts 里 import，漏写 app.use →
//     该 router 全部路径上线 404。既有 mountSmoke.test.ts 只正则查它自己修过的两个文件
//     （settlement/acceptance），**新增任何 router 再犯零拦截**。
//   事故 B（RV-001 同源）：/api/v1 下新增首段未登记进 KNOWN_V1_SEGMENTS →
//     apiGuardMiddleware 把合法路径当未知路径 404（先于鉴权，prod 下表现为「明明有权限却 404」）。
//
// 本测试不依赖真实 DB / HTTP，纯 fs + 正则做三向比对：
//   ① 每个 router 模块都在 server.ts 有 import + app.use 挂载（删掉任一 app.use → 变红）；
//   ② 每个路由首段都登记在 apiGuard 白名单（新增首段漏登记 → 变红）；
//   ③ 反向：白名单里的段必须在某个 router 里被真实用到（白名单冗余 → 变红）。
//
// 实现取舍（刻意不用 import.meta.glob）：backend 的 tsconfig types 只有 ["node"]，
// `import.meta.glob` 在 tsc 下报 TS2339（Property 'glob' does not exist on type 'ImportMeta'）。
// tsconfig 是共享配置，不为测试而改；改用 fs.readdir + 源文本正则抽取，纯 Node API、零类型风险。
// 诚实边界：抽不到任何路径的 router 直接 fail（而不是 skip），防正则失效后测试空过。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_API_PREFIXES, KNOWN_V1_SEGMENTS } from '../middleware/apiGuard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '..');
const serverSrc = readFileSync(path.resolve(here, '../../src/server.ts'), 'utf8');

// ==================== 1. 解析 server.ts：import <Var> from '<spec>' / app.use('<prefix>', <Var>) ====================
interface ServerShape {
  varBySpec: Map<string, string>;
  prefixByVar: Map<string, string>;
}

/** 纯函数：从 server.ts 源文本抽取「import 说明符→变量名」与「变量名→挂载前缀」。 */
export function parseServer(src: string): ServerShape {
  const varBySpec = new Map<string, string>();
  const ir = /import\s+(\w+)\s+from\s+'([^']+)'/g;
  let x: RegExpExecArray | null;
  while ((x = ir.exec(src)) !== null) varBySpec.set(x[2], x[1]);

  const prefixByVar = new Map<string, string>();
  const mr = /app\.use\(\s*'([^']*)'\s*,\s*(\w+)\s*\)/g;
  while ((x = mr.exec(src)) !== null) prefixByVar.set(x[2], x[1]);
  return { varBySpec, prefixByVar };
}

const { varBySpec, prefixByVar } = parseServer(serverSrc);

// ==================== 2. 枚举 router 模块 + 从源文本抽取路由路径 ====================
/** 路由注册写法：router.get('...') / router.post('...') / router.use('...') / router.route('...') */
const ROUTE_CALL_RE = /\brouter\.(?:get|post|put|patch|delete|use|all|route)\(\s*['"`]([^'"`]*)['"`]/g;
/** 是否为 router 模块：建了 Router()（schema/纯逻辑模块会被排除，如 publicReportSchema.ts）。 */
const IS_ROUTER_RE = /\bRouter\s*\(/;

interface RouterMod {
  /** 模块在 src 下的相对路径（如 routes/settlement.ts）。 */
  rel: string;
  /** server.ts 中的 import 说明符（如 ./routes/settlement.js）。 */
  spec: string;
  paths: string[];
}

const routerMods: RouterMod[] = [];
const nonRouterModules: string[] = [];

function loadRouterMods(dirRel: string, names: string[]): void {
  for (const name of names) {
    const rel = `${dirRel}/${name}`;
    const src = readFileSync(path.join(srcRoot, dirRel, name), 'utf8');
    const paths: string[] = [];
    let m: RegExpExecArray | null;
    ROUTE_CALL_RE.lastIndex = 0;
    while ((m = ROUTE_CALL_RE.exec(src)) !== null) paths.push(m[1]);
    if (IS_ROUTER_RE.test(src)) routerMods.push({ rel, spec: `./${rel.replace(/\.ts$/, '.js')}`, paths });
    else nonRouterModules.push(rel);
  }
}

loadRouterMods(
  'routes',
  readdirSync(path.join(srcRoot, 'routes'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort(),
);
loadRouterMods(
  'webhook',
  readdirSync(path.join(srcRoot, 'webhook'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort(),
);

/** 路径首段（去空段；:param 段返回 ''，交由调用方按语义处理）。 */
function firstSeg(p: string): string {
  const seg = p.split('/').filter(Boolean)[0] ?? '';
  return seg.startsWith(':') ? '' : seg;
}

interface Mounted extends RouterMod {
  /** 挂载前缀（server.ts 原文，如 /api/v1、/api/v1/inspection、/uploads）。 */
  prefix: string;
}

const mounted: Mounted[] = [];
const unmounted: string[] = [];
for (const r of routerMods) {
  const varName = varBySpec.get(r.spec);
  const prefix = varName ? prefixByVar.get(varName) : undefined;
  if (prefix !== undefined) mounted.push({ ...r, prefix });
  else unmounted.push(r.rel);
}

/** 挂载在 /api 之下、且落在 v1 命名空间的 router。 */
const apiMounted = mounted.filter((x) => x.prefix.startsWith('/api/'));

describe('① router 挂载完整性（import 了就必须 app.use · 事故 A 防复发）', () => {
  it('全部 router 模块都在 server.ts 中被 import', () => {
    const missing = routerMods.filter((r) => !varBySpec.has(r.spec)).map((r) => r.rel);
    expect(missing, `以下 router 模块未被 server.ts import（新增 router 漏接线）：${missing.join(', ')}`).toEqual([]);
  });

  it('全部 router 模块都有 app.use 挂载（漏挂载 = 合法路径全 404）', () => {
    expect(unmounted, `以下 router 只 import 未 app.use（重演批次三 404 事故）：${unmounted.join(', ')}`).toEqual([]);
  });

  it('枚举规模与非 router 模块识别（防正则静默失效）', () => {
    // 抽不到 router → 断言失去意义，直接 fail 而不是空过。
    expect(routerMods.length).toBeGreaterThanOrEqual(40);
    const totalPaths = routerMods.reduce((s, r) => s + r.paths.length, 0);
    expect(totalPaths).toBeGreaterThan(150);
    // publicReportSchema.ts / webhook/dispatch.ts 是纯 schema/逻辑模块，必须被识别为非 router（不是被漏掉）。
    expect(nonRouterModules).toContain('routes/publicReportSchema.ts');
    expect(nonRouterModules).toContain('webhook/dispatch.ts');
  });

  it('每个 router 都抽到至少 1 条路由路径（正则失配即 fail）', () => {
    const empty = routerMods.filter((x) => x.paths.length === 0).map((x) => x.rel);
    expect(empty, `以下 router 抽不到任何路径（路由注册写法变了？）：${empty.join(', ')}`).toEqual([]);
  });

  it('⚙自检：删掉一行 app.use，挂载检查必须能发现（证明本组断言不是空过）', () => {
    // 不改动 server.ts 本体（避免与并行改动冲突）：对源文本副本做变异，验证探测器本身有效。
    const line = "app.use('/api/v1', settlementRouter);";
    expect(serverSrc, 'server.ts 挂载行形态变化，本自检需同步更新').toContain(line);
    const mutated = parseServer(serverSrc.replace(line, ''));
    const varName = mutated.varBySpec.get('./routes/settlement.js');
    expect(varName).toBe('settlementRouter'); // import 还在（正是事故 A 的形态：只 import 不挂载）
    expect(mutated.prefixByVar.has('settlementRouter')).toBe(false); // 探测器必须报漏挂载
  });

  it('批次三 卡4 新增 router 必须已挂载且首段被白名单覆盖（settlement/acceptance 回归）', () => {
    const st = mounted.find((x) => x.rel === 'routes/settlement.ts');
    const ac = mounted.find((x) => x.rel === 'routes/acceptance.ts');
    expect(st?.prefix).toBe('/api/v1');
    expect(ac?.prefix).toBe('/api/v1');
    expect(st?.paths.some((p) => firstSeg(p) === 'settlements')).toBe(true);
    expect(ac?.paths.some((p) => firstSeg(p) === 'open')).toBe(true);
    expect(KNOWN_V1_SEGMENTS.has('settlements')).toBe(true);
    expect(KNOWN_V1_SEGMENTS.has('open')).toBe(true);
  });
});

describe('② 路由首段必须登记进 apiGuard 白名单（RV-001 同源防复发）', () => {
  it('挂在 /api/v1 的 router：内部每个首段都必须在 KNOWN_V1_SEGMENTS', () => {
    const problems: string[] = [];
    for (const x of apiMounted) {
      if (x.prefix !== '/api/v1') continue;
      for (const seg of new Set(x.paths.map(firstSeg).filter(Boolean))) {
        if (!KNOWN_V1_SEGMENTS.has(seg)) problems.push(`${x.rel} → /v1/${seg}`);
      }
    }
    expect(problems, `以下首段未登记白名单（合法路径会被 apiGuard 误 404）：${problems.join('; ')}`).toEqual([]);
  });

  it('挂在 /api/v1/<前缀> 的 router：挂载前缀必须在 KNOWN_API_PREFIXES', () => {
    const problems: string[] = [];
    for (const x of apiMounted) {
      if (x.prefix === '/api/v1') continue;
      const p = x.prefix.replace(/^\/api/, ''); // /api/v1/flow → /v1/flow
      if (!KNOWN_API_PREFIXES.includes(p)) problems.push(`${x.rel} → ${p}`);
    }
    expect(problems, `以下挂载前缀未登记 KNOWN_API_PREFIXES（合法路径会被误 404）：${problems.join('; ')}`).toEqual([]);
  });

  it('isKnownApiPath 对全部真实路由首段均放行（端到端串一遍守卫）', async () => {
    const { isKnownApiPath } = await import('../middleware/apiGuard.js');
    const problems: string[] = [];
    for (const x of apiMounted) {
      const rel = x.prefix.replace(/^\/api/, '');
      for (const seg of new Set(x.paths.map(firstSeg).filter(Boolean))) {
        const probe = x.prefix === '/api/v1' ? `${rel}/${seg}` : rel;
        if (!isKnownApiPath(probe)) problems.push(`${x.rel} → ${probe}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('③ 反向：白名单不得冗余（白名单里的段必须在某个 router 里被真实用到）', () => {
  it('KNOWN_API_PREFIXES 每一项都对应一个真实挂载', () => {
    const used = new Set(
      apiMounted.filter((x) => x.prefix !== '/api/v1').map((x) => x.prefix.replace(/^\/api/, '')),
    );
    const redundant = KNOWN_API_PREFIXES.filter((p) => !used.has(p));
    expect(redundant, `白名单前缀已无对应挂载（清理或排查漏挂载）：${redundant.join(', ')}`).toEqual([]);
  });

  it('KNOWN_V1_SEGMENTS 每一项都被某个 router 真实用作首段', () => {
    const used = new Set<string>();
    for (const x of routerMods) for (const seg of x.paths.map(firstSeg)) if (seg) used.add(seg);
    const redundant = Array.from(KNOWN_V1_SEGMENTS).filter((s) => !used.has(s));
    expect(redundant, `白名单段已无 router 使用（清理或排查路由被删）：${redundant.join(', ')}`).toEqual([]);
  });
});
