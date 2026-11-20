// 新租户开通必须自带默认部门（2026-11-14 深度探针 D-平台1）
//
// 实测：通过平台注册的新租户，建单直接 422 DEPARTMENT_UNRESOLVED —— 客户首次登录不可用。
// 根因：provisionNewTenantContent 只复制分类/流程/管理员，从未创建 dept，也没提示。
// 修复：开通事务内保证「至少一个默认部门」（无部门则建「默认部门」，有部门则把第一个设为默认）。
import { describe, it, expect } from 'vitest';
import { provisionNewTenantContent } from '../repo/tenantProvision.js';

function makeClient(deptRows: Array<{ id: string }>) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes('FROM dept WHERE tenant_id = $1 AND is_default = true')) {
        return { rows: deptRows.filter((d) => d.id === 'default'), rowCount: deptRows.some((d) => d.id === 'default') ? 1 : 0 };
      }
      if (text.includes('FROM dept WHERE tenant_id = $1 ORDER BY created_at')) {
        return { rows: deptRows.slice(0, 1), rowCount: Math.min(1, deptRows.length) };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Parameters<typeof provisionNewTenantContent>[0];
  return { client, calls };
}

const base = {
  tenantId: 'uat-new-tenant',
  name: '新租户',
  sourceTenantId: 'uat-new-tenant', // 自源路径：不复制，专注开通写入
  adminUsername: 'admin',
  adminPassword: 'Passw0rd!234',
  actor: 'probe',
};

describe('新租户开通默认部门', () => {
  it('无任何部门 → 创建「默认部门」且 is_default=true', async () => {
    const { client, calls } = makeClient([]);
    await provisionNewTenantContent(client, base);
    const ins = calls.find((c) => c.text.includes('INSERT INTO dept'));
    expect(ins, '必须插入默认部门').toBeTruthy();
    expect(ins!.text).toContain('is_default');
    expect(ins!.text).toContain('默认部门');
    expect(ins!.params).toContain('uat-new-tenant');
  });

  it('已有部门但无默认 → 把最早部门设为默认，不重复建', async () => {
    const { client, calls } = makeClient([{ id: 'dept-existing' }]);
    await provisionNewTenantContent(client, base);
    expect(calls.some((c) => c.text.includes('INSERT INTO dept'))).toBe(false);
    const upd = calls.find((c) => c.text.includes('UPDATE dept SET is_default = true'));
    expect(upd).toBeTruthy();
    expect(upd!.params).toContain('dept-existing');
  });

  it('已有默认部门 → 幂等，不写 dept', async () => {
    const { client, calls } = makeClient([{ id: 'default' }]);
    await provisionNewTenantContent(client, base);
    expect(calls.some((c) => c.text.includes('INSERT INTO dept'))).toBe(false);
    expect(calls.some((c) => c.text.includes('UPDATE dept SET is_default = true'))).toBe(false);
  });
});
