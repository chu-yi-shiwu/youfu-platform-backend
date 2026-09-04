// roleWhitelist.test.ts —— 注册制批次二（架构评审 R1）：070 迁移配套启动自检回归。
// 覆盖：CHECK 约束文本解析（046 四角色 / 069 六角色 / 空）、checkRoleWhitelist 判定逻辑
//（SQL 指向 role_permission 的 CHECK、missing 集合正确）。verifyRoleWhitelist 的连接管理
// 与 process.exit 依赖真实 pool，不在单测覆盖（部署时由启动门实测）。
import { describe, it, expect } from 'vitest';

const { parseRoleCheckAllowlist, checkRoleWhitelist, ROLE_CHECK_SQL } = await import('../services/roleWhitelist.js');

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

  it('多条 CHECK 共存（历史遗留）→ 集合并集判定', async () => {
    const { client } = makeClient([
      { conname: 'role_permission_role_check', def: DEF_046_4ROLES },
      { conname: 'role_permission_role_check2', def: "CHECK (role = ANY (ARRAY['reviewer'::text]))" },
    ]);
    const r = await checkRoleWhitelist(client);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['service_desk']);
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
