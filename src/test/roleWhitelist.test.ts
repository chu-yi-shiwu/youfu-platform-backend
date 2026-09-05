// roleWhitelist.test.ts —— 注册制批次二（架构评审 R1）：070 迁移配套启动自检回归。
// 覆盖：CHECK 约束文本解析（046 四角色 / 069 六角色 / 空）、checkRoleWhitelist 判定逻辑
//（SQL 指向 role_permission 的 CHECK、missing 集合正确）。verifyRoleWhitelist 的连接管理
// 与 process.exit 依赖真实 pool，不在单测覆盖（部署时由启动门实测）。
import { describe, it, expect, vi, afterEach } from 'vitest';

// ---- pool 打桩：verifyRoleWhitelist 走真实 pool.connect()，单测必须拦下 ----
// vi.mock / vi.hoisted 会被提升到文件顶部，故放在 import 之后也能生效于下面的 await import。
const h = vi.hoisted(() => ({
  connectImpl: null as null | (() => Promise<unknown>),
  released: 0 as number,
}));

vi.mock('../db/pool.js', () => ({
  default: {
    connect: async () => {
      if (!h.connectImpl) throw new Error('[roleWhitelist.test] connectImpl 未设置');
      return h.connectImpl();
    },
  },
  withTenantClient: async (_t: string, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
  assertSafeTenantId: (t: string) => t,
}));

const {
  parseRoleCheckAllowlist,
  checkRoleWhitelist,
  verifyRoleWhitelist,
  ROLE_CHECK_SQL,
} = await import('../services/roleWhitelist.js');

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

// 046 内联建表：CHECK (role IN ('admin','operator','dispatcher','worker'))，pg 渲染为 ANY(ARRAY[...])
const DEF_046_4ROLES =
  "CHECK (role = ANY (ARRAY['admin'::text, 'operator'::text, 'dispatcher'::text, 'worker'::text]))";
// 069 同款写法（070 落地后目标形态）：6 角色
const DEF_070_6ROLES =
  "CHECK (role = ANY (ARRAY['admin'::text, 'operator'::text, 'dispatcher'::text, 'worker'::text, 'reviewer'::text, 'service_desk'::text]))";

function makeClient(rows: any[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const client = {
    query: (async (text: string, params?: any[]) => {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    }) as QueryFn,
  } as any;
  return { client, calls };
}

describe('parseRoleCheckAllowlist（CHECK 约束文本 → 角色集合）', () => {
  it('046 四角色定义 → 解析出 4 角色（缺 reviewer/service_desk）', () => {
    const allow = parseRoleCheckAllowlist(DEF_046_4ROLES);
    expect(allow.sort()).toEqual(['admin', 'dispatcher', 'operator', 'worker']);
  });

  it('070 六角色定义 → 解析出全部 6 角色（::text 类型标注被剥离）', () => {
    const allow = parseRoleCheckAllowlist(DEF_070_6ROLES);
    expect(allow.sort()).toEqual(['admin', 'dispatcher', 'operator', 'reviewer', 'service_desk', 'worker']);
  });

  it('空文本 / 无引号字面量 → 空集合', () => {
    expect(parseRoleCheckAllowlist('')).toEqual([]);
    expect(parseRoleCheckAllowlist('CHECK (role IS NOT NULL)')).toEqual([]);
  });
});

describe('checkRoleWhitelist（mock client 判定逻辑）', () => {
  it('SQL 指向 role_permission 的 CHECK 约束（conrelid + contype=c）', async () => {
    const { client, calls } = makeClient([]);
    await checkRoleWhitelist(client);
    expect(calls.length).toBe(1);
    expect(calls[0].text).toContain("conrelid = 'role_permission'::regclass");
    expect(calls[0].text).toContain("contype = 'c'");
  });

  it('DB 已应用 070（6 角色 CHECK）→ ok=true、missing 空', async () => {
    const { client } = makeClient([{ conname: 'role_permission_role_check', def: DEF_070_6ROLES }]);
    const r = await checkRoleWhitelist(client);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('DB 仍是 046（4 角色 CHECK）→ ok=false、missing=[reviewer, service_desk]', async () => {
    const { client } = makeClient([{ conname: 'role_permission_role_check', def: DEF_046_4ROLES }]);
    const r = await checkRoleWhitelist(client);
    expect(r.ok).toBe(false);
    expect(r.missing.sort()).toEqual(['reviewer', 'service_desk']);
  });

  it('多条 CHECK 共存（历史遗留）→ 交集判定（PG 多约束是 AND）', async () => {
    // A 允 4 角色 + B 仅允 reviewer：两约束都要满足 → 交集为空 → 6 角色一个都写不进。
    // 早期实现取并集是错的（并集={4角色,reviewer} 会漏报 admin 等 4 个的缺失）。
    const { client } = makeClient([
      { conname: 'role_permission_role_check', def: DEF_046_4ROLES },
      { conname: 'role_permission_role_check2', def: "CHECK (role = ANY (ARRAY['reviewer'::text]))" },
    ]);
    const r = await checkRoleWhitelist(client);
    expect(r.ok).toBe(false);
    expect(r.missing.sort()).toEqual(['admin', 'dispatcher', 'operator', 'reviewer', 'service_desk', 'worker']);
  });

  it('无 CHECK 行 → ok=false（缺全部 6 角色，fail-closed）', async () => {
    const { client } = makeClient([]);
    const r = await checkRoleWhitelist(client);
    expect(r.ok).toBe(false);
    expect(r.missing.length).toBe(6);
  });

  it('ROLE_CHECK_SQL 导出与内部使用一致（回归护栏）', () => {
    expect(ROLE_CHECK_SQL).toContain('pg_get_constraintdef');
  });
});

// ---- verifyRoleWhitelist() 本体：失败即 process.exit(1)（拒绝启动），此前完全不测 ----
// 重要性：一旦误判，生产会直接拒绝启动；反之若该拦不拦，新租户开通必 23514 整体回滚。
interface FakeConn {
  client: { query: (text: string) => Promise<{ rows: any[]; rowCount: number }>; release: () => void };
  calls: string[];
}

function fakeConn(rows: any[]): FakeConn {
  const calls: string[] = [];
  return {
    calls,
    client: {
      query: async (text: string) => {
        calls.push(text);
        return { rows, rowCount: rows.length };
      },
      release: () => {
        h.released += 1;
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  h.connectImpl = null;
  h.released = 0;
});

describe('verifyRoleWhitelist（启动门 · 失败即拒绝启动）', () => {
  it('①6 角色齐全 → 不退出，且连接用后释放', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const conn = fakeConn([{ conname: 'role_permission_role_check', def: DEF_070_6ROLES }]);
    h.connectImpl = async () => conn.client;

    await verifyRoleWhitelist();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(conn.calls[0]).toContain('pg_get_constraintdef');
    expect(h.released, '连接必须释放（QA 修正：exit 前必须先 release）').toBe(1);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('自检通过');
  });

  it('②缺 reviewer（DB 仍是 4 角色）→ exit(1) 且输出含修复命令与缺失角色', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const conn = fakeConn([{ conname: 'role_permission_role_check', def: DEF_046_4ROLES }]);
    h.connectImpl = async () => conn.client;

    await verifyRoleWhitelist();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const out = errSpy.mock.calls.flat().map(String).join(' ');
    expect(out).toContain('reviewer');
    expect(out).toContain('service_desk');
    expect(out).toContain('070_role_permission_roles_widen.sql'); // 修复命令必须可直接复制执行
    expect(h.released, 'exit 之前必须释放连接').toBe(1);
  });

  it('③连不上 DB → 只 warn 不退出（沿用既有启动行为，交给首请求自然报错）', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.connectImpl = async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:5432');
    };

    await verifyRoleWhitelist();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().map(String).join(' ')).toContain('DB 连接不可用');
    expect(h.released).toBe(0);
  });

  it('④CHECK 含无关单引号字面量（复合条件）时不误判：仍按角色集合判定', async () => {
    // 复合条件里出现与角色无关的字面量（如长度约束），不应把 6 角色判成缺失。
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const defWithExtraLiteral =
      `CHECK (((role = ANY (ARRAY['admin'::text, 'operator'::text, 'dispatcher'::text, ` +
      `'worker'::text, 'reviewer'::text, 'service_desk'::text])) AND (length(role) > 0)))`;
    // 无关字面量 '' 会被解析进集合，但不影响 6 角色是否齐全的判定
    expect(parseRoleCheckAllowlist(defWithExtraLiteral)).toContain('admin');
    const conn = fakeConn([{ conname: 'role_permission_role_check', def: defWithExtraLiteral }]);
    h.connectImpl = async () => conn.client;

    await verifyRoleWhitelist();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('⑤CHECK 含排除条件（role <> \'reviewer\'）→ reviewer 判缺失，exit(1)（fail-closed，已修复）', async () => {
    // 历史 fail-open 缺陷（审查 B 路发现）：旧解析器用 /'([^']*)'/g 抽所有引号字面量，
    // 把 `role <> 'reviewer'` 的排除字面量误当放行 → 自检通过 → 开通仍 23514 整体回滚。
    // 语义感知版解析器（2026-09-05 修复）：排除类字面量进 deny 集，绝不信放行。
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const negativeDef =
      `CHECK ((role <> 'reviewer') AND (role = ANY (ARRAY['admin'::text, 'operator'::text, ` +
      `'dispatcher'::text, 'worker'::text, 'service_desk'::text])))`;

    // 解析层：reviewer 被排除，其余 5 角色放行
    const parsed = parseRoleCheckAllowlist(negativeDef).sort();
    expect(parsed).toEqual(['admin', 'dispatcher', 'operator', 'service_desk', 'worker']);

    const conn = fakeConn([{ conname: 'role_permission_role_check', def: negativeDef }]);
    h.connectImpl = async () => conn.client;
    await verifyRoleWhitelist();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.flat().map(String).join(' ')).toContain('reviewer');
  });

  it('⑥纯排除约束（仅 role <> \'dev\'）→ ROLES 未被排除者放行，dev 本就不在 ROLES → 自检通过', async () => {
    // 纯 deny（无 allow 子条件）：DB 放行除 dev 外的一切值；dev 不属于 6 角色 → 6 角色全可写。
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const conn = fakeConn([{ conname: 'rp_check', def: "CHECK ((role <> 'dev'))" }]);
    h.connectImpl = async () => conn.client;
    await verifyRoleWhitelist();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('⑦矛盾条件（role = \'admin\' AND role <> \'admin\'）→ 有效集为空，missing 全部，exit(1)（fail-closed）', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseRoleCheckAllowlist("CHECK ((role = 'admin') AND (role <> 'admin'))")).toEqual([]);
    const conn = fakeConn([{ conname: 'rp_check', def: "CHECK ((role = 'admin') AND (role <> 'admin'))" }]);
    h.connectImpl = async () => conn.client;
    await verifyRoleWhitelist();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('⑧OR 语义静态不可判定 → fail-closed（fail-open 是本门禁最危险方向）', () => {
    expect(parseRoleCheckAllowlist("CHECK ((role = 'admin' OR role = 'operator'))")).toEqual([]);
    expect(
      parseRoleCheckAllowlist("CHECK (role = ANY (ARRAY['admin'::text])) OR (role = 'operator')"),
    ).toEqual([]);
  });

  it('⑨IN 形态与无引号辅助条件：IN 列表正确入集，length(role) > 0 不影响判定', () => {
    expect(
      parseRoleCheckAllowlist("CHECK (role IN ('admin','operator'))").sort(),
    ).toEqual(['admin', 'operator']);
    // 复合：ANY 6 角色 AND 长度条件（无引号）→ 6 角色完整保留
    const parsed = parseRoleCheckAllowlist(
      `CHECK (((role = ANY (ARRAY['admin'::text, 'operator'::text, 'dispatcher'::text, ` +
        `'worker'::text, 'reviewer'::text, 'service_desk'::text])) AND (length(role) > 0)))`,
    ).sort();
    expect(parsed).toEqual(['admin', 'dispatcher', 'operator', 'reviewer', 'service_desk', 'worker']);
  });

  it('⑩IS NOT NULL（无角色条件）→ 空集（无引号字面量，无法确认放行 → fail-closed）', () => {
    expect(parseRoleCheckAllowlist('CHECK (role IS NOT NULL)')).toEqual([]);
  });
});
