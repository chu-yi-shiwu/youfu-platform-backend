// roleDef 仓储单测 —— 地基第二步："角色"从内置 6 个常量变成租户可配置。
// 零真实 DB：以 mock PoolClient 覆盖命中/未命中/表缺失三条路径（含 fail-closed 降级）。
import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { isBuiltinRole, isRoleUsable, listCustomRoles, listAllRoles } from '../repo/roleDef.js';

/** mock：按 SQL 是否含 role_def 决定返回；throwErr 模拟 090 未应用（表不存在）。 */
function mkClient(rows: Array<Record<string, unknown>> = [], throwErr = false): PoolClient {
  return {
    query: async (sql: string) => {
      if (throwErr) throw new Error('relation "role_def" does not exist');
      if (String(sql).includes('LIMIT 1')) return { rows: rows.slice(0, 1), rowCount: Math.min(rows.length, 1) } as any;
      return { rows, rowCount: rows.length } as any;
    },
  } as unknown as PoolClient;
}

const T = 't-1';

describe('isBuiltinRole', () => {
  it('内置 6 角色恒为内置', () => {
    for (const r of ['admin', 'operator', 'dispatcher', 'worker', 'reviewer', 'service_desk']) {
      expect(isBuiltinRole(r)).toBe(true);
    }
  });
  it('自定义岗位与空值都不是内置', () => {
    expect(isBuiltinRole('repair_lead')).toBe(false);
    expect(isBuiltinRole('')).toBe(false);
    expect(isBuiltinRole(undefined)).toBe(false);
  });
});

describe('isRoleUsable', () => {
  it('内置角色不查库即通过', async () => {
    // 即使 client 会抛错（表不存在），内置角色也必须可用——不得因 090 未应用而锁死内置体系
    await expect(isRoleUsable(mkClient([], true), T, 'operator')).resolves.toBe(true);
  });

  it('自定义岗位在 role_def 中启用 → 可用', async () => {
    await expect(isRoleUsable(mkClient([{ '?column?': 1 }]), T, 'repair_lead')).resolves.toBe(true);
  });

  it('自定义岗位不在 role_def 中 → 不可用（防凭空造岗）', async () => {
    await expect(isRoleUsable(mkClient([]), T, 'repair_lead')).resolves.toBe(false);
  });

  it('090 未应用（表不存在）→ 自定义不可用但不抛错（fail-closed 降级）', async () => {
    await expect(isRoleUsable(mkClient([], true), T, 'repair_lead')).resolves.toBe(false);
  });

  it('空角色不可用', async () => {
    await expect(isRoleUsable(mkClient([{ '?column?': 1 }]), T, '')).resolves.toBe(false);
  });

  // 【用户要求①】退场角色不可再分配给新账号——这是"拿掉"在分配层的落点。
  // ⚠️ 只挡"新建/改派"，不动存量账号的数据：存量 dispatcher/service_desk 账号
  //    的角色值与既有权限原样保留，改派由管理员决策。
  it('退场角色 dispatcher / service_desk 不可再分配（拿掉已生效）', async () => {
    for (const r of ['dispatcher', 'service_desk']) {
      await expect(isRoleUsable(mkClient([{ '?column?': 1 }]), T, r)).resolves.toBe(false);
    }
  });

  it('对照：未退场的内置角色仍可分配（不得误伤）', async () => {
    for (const r of ['admin', 'operator', 'worker', 'reviewer']) {
      await expect(isRoleUsable(mkClient([], true), T, r)).resolves.toBe(true);
    }
  });
});

describe('listCustomRoles', () => {
  it('返回启用中的自定义岗位', async () => {
    const rows = [
      { code: 'repair_lead', name: '维修组长', description: null, enabled: true, sort: 10 },
      { code: 'site_ops', name: '现场运营', description: 'x', enabled: true, sort: 20 },
    ];
    await expect(listCustomRoles(mkClient(rows), T)).resolves.toEqual(rows);
  });

  it('表缺失 → 空数组，不抛错', async () => {
    await expect(listCustomRoles(mkClient([], true), T)).resolves.toEqual([]);
  });
});

describe('listAllRoles（内置 ∪ 自定义）', () => {
  // 【用户要求①】退场的 dispatcher/service_desk 不再出现在可选项里（内置 6 → 可选项 4）
  it('无自定义岗位时 = 内置 4 个（已剔除退场），顺序不变', async () => {
    const all = await listAllRoles(mkClient([]), T);
    expect(all).toEqual(['admin', 'operator', 'worker', 'reviewer']);
    expect(all).not.toContain('dispatcher');
    expect(all).not.toContain('service_desk');
  });

  it('自定义岗位追加在后，内置在前（前端下拉顺序稳定）', async () => {
    const all = await listAllRoles(
      mkClient([{ code: 'repair_lead', name: '维修组长', description: null, enabled: true, sort: 10 }]),
      T,
    );
    expect(all.slice(0, 4)).toEqual(['admin', 'operator', 'worker', 'reviewer']);
    expect(all[4]).toBe('repair_lead');
  });

  it('去重：自定义不得重复内置 code（090 已禁，此处再兜一层）', async () => {
    const all = await listAllRoles(
      mkClient([{ code: 'admin', name: '冒名', description: null, enabled: true, sort: 1 }]),
      T,
    );
    expect(all.filter((r) => r === 'admin')).toHaveLength(1);
  });
});
