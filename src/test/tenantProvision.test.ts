// SaaS 前置（2026-09-01）：新租户开通断链回归护栏。
// 此前 POST /platform/tenants 只建 registry + 复制 fault_category → 新机构「无人可登录、无流程可流转」。
// provisionNewTenantContent 现一次建齐：①分类复制（沿用模板逻辑）②workflow_def（模板源 def 或默认 4 态）
// ③admin 账号（scrypt 哈希）。本文件验证四条主链路 + 上下文收口 + PII 不复制边界（注释锚定）。
import { describe, it, expect } from 'vitest';

const { provisionNewTenantContent, INDUSTRY_PERM_PRESETS } = await import('../repo/tenantProvision.js');

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

interface FakeSpec {
  srcCategories: any[];      // 模板源 fault_category 行
  srcDef?: unknown;          // 模板源 work_order workflow_def（缺省 = 无）
  insertRowCounts?: Record<string, number>; // 按 SQL 关键字模拟受影响行数
}

function makeClient(spec: FakeSpec) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const client = {
    query: (async (text: string, params?: any[]) => {
      calls.push({ text, params });
      if (text.includes('SELECT code, name, sort, enabled FROM fault_category')) {
        return { rows: spec.srcCategories };
      }
      if (text.includes("SELECT def FROM workflow_def WHERE tenant_id = $1 AND entity_type = 'work_order'")) {
        return { rows: spec.srcDef !== undefined ? [{ def: spec.srcDef }] : [] };
      }
      if (text.includes('INSERT INTO fault_category')) {
        return { rows: [], rowCount: spec.insertRowCounts?.fault_category ?? 1 };
      }
      return { rows: [], rowCount: 1 };
    }) as QueryFn,
  } as any;
  return { client, calls };
}

const NEW_T = 't-new-hospital';
const SRC_T = 't-verification';

describe('provisionNewTenantContent（SaaS 前置开通补全护栏）', () => {
  it('模板源有分类+有 def → 分类复制、流程图走 template、admin 建号且密码 scrypt 哈希', async () => {
    const richDef = { initial: 'draft', states: ['draft', 'assigned', 'processing', 'completed'], transitions: [] };
    const { client, calls } = makeClient({
      srcCategories: [{ code: 'PRINTER', name: '打印机故障', sort: 1, enabled: true }],
      srcDef: richDef,
    });
    const r = await provisionNewTenantContent(client, {
      tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T,
    });
    expect(r.categoriesCopied).toBe(1);
    expect(r.workflowDefSource).toBe('template');
    expect(r.adminUsername).toBe('admin');
    expect(r.adminPassword).toBeTruthy();
    // workflow_def 落库内容 = 模板源 def 原样
    const wfIns = calls.find((c) => c.text.includes("INSERT INTO workflow_def"))!;
    expect(wfIns.params![0]).toBe(NEW_T);
    // 批次三：def 落库 = 模板源 def + 验收边幂等注入（模板原有结构保留）
    const savedDef = JSON.parse(wfIns.params![1]);
    expect(savedDef.initial).toBe(richDef.initial);
    expect(savedDef.states).toEqual(expect.arrayContaining(richDef.states));
    expect(savedDef.transitions.some((t: any) => t.event === 'acceptance_pass' && t.to === 'closed')).toBe(true);
    expect(savedDef.transitions.some((t: any) => t.event === 'acceptance_reject' && t.to === 'processing')).toBe(true);
    // admin 账号：role=admin、密码是 scrypt 哈希（绝不存明文）
    const accIns = calls.find((c) => c.text.includes("INSERT INTO account_user"))!;
    expect(accIns.params![0]).toBe(NEW_T);
    expect(accIns.params![1]).toBe('admin');
    expect(accIns.params![2]).toMatch(/^scrypt\$/);
    expect(accIns.params![4]).toBe('admin');
  });

  it('模板源无 def → 落引擎默认 4 态图（与 getWorkflowDef 兜底同口径）', async () => {
    const { client, calls } = makeClient({ srcCategories: [] });
    const r = await provisionNewTenantContent(client, {
      tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T,
    });
    expect(r.workflowDefSource).toBe('default');
    const wfIns = calls.find((c) => c.text.includes("INSERT INTO workflow_def"))!;
    const def = JSON.parse(wfIns.params![1]);
    // 批次三：默认 4 态 + 注入验收边后的目标态 closed（幂等注入补态）
    expect(def.states).toEqual(expect.arrayContaining(['draft', 'assigned', 'processing', 'completed']));
    expect(def.states).toContain('closed');
    expect(def.config?.doneStates).toEqual(['completed']);
    expect(def.transitions.some((t: any) => t.event === 'acceptance_pass')).toBe(true);
  });

  it('读上下文=模板源、写上下文=新租户（RLS SET LOCAL 收口断言）', async () => {
    const { client, calls } = makeClient({
      srcCategories: [{ code: 'X', name: 'X', sort: 1, enabled: true }],
    });
    await provisionNewTenantContent(client, { tenantId: NEW_T, name: '测试', sourceTenantId: SRC_T });
    const setCalls = calls.filter((c) => c.text.startsWith('SET LOCAL app.tenant_id'));
    expect(setCalls[0].text).toContain(SRC_T);   // 先读源
    expect(setCalls[setCalls.length - 1].text).toContain(NEW_T); // 最终写上下文收口在新租户
    const roleCalls = calls.filter((c) => c.text === 'SET ROLE youfu_app');
    expect(roleCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('显式传入 admin_username/admin_password → 原样使用不生成随机', async () => {
    const { client, calls } = makeClient({ srcCategories: [] });
    const r = await provisionNewTenantContent(client, {
      tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T,
      adminUsername: 'zhang_admin', adminPassword: 'SuperSecret-2026',
    });
    expect(r.adminUsername).toBe('zhang_admin');
    expect(r.adminPassword).toBe('SuperSecret-2026');
    const accIns = calls.find((c) => c.text.includes("INSERT INTO account_user"))!;
    expect(accIns.params![1]).toBe('zhang_admin');
    expect(accIns.params![2]).toMatch(/^scrypt\$/);
  });

  it('诚实边界：sourceTenantId=自身 → 跳过跨租户读（零复制），仍落默认图+admin', async () => {
    const { client, calls } = makeClient({ srcCategories: [] });
    const r = await provisionNewTenantContent(client, {
      tenantId: SRC_T, name: '自指', sourceTenantId: SRC_T,
    });
    expect(r.categoriesCopied).toBe(0);
    expect(calls.find((c) => c.text.includes('FROM fault_category'))).toBeUndefined(); // 不跨租户读
    expect(r.workflowDefSource).toBe('default');
    expect(calls.find((c) => c.text.includes('INSERT INTO account_user'))).toBeDefined();
  });
});

describe('provisionNewTenantContent 第④步：行业权限基线（注册制批次二 · 混合式）', () => {
  it('preset 缺失（第一版全行业未配置）→ 0 行 role_permission 落库，permBaseline=inherited', async () => {
    expect(Object.keys(INDUSTRY_PERM_PRESETS).length).toBe(0); // 机制就位、行为=继承默认的定案口径
    const { client, calls } = makeClient({ srcCategories: [] });
    const r = await provisionNewTenantContent(client, {
      tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T, category: 'hospital',
    });
    expect(r.permBaseline).toBe('inherited');
    expect(r.permRolesSnapshotted).toEqual([]);
    expect(calls.find((c) => c.text.includes('INSERT INTO role_permission'))).toBeUndefined();
  });

  it('preset ≠ 默认矩阵 → 该角色全量行落库 + permBaseline=snapshot', async () => {
    // worker 默认 = [inspect.execute, asset.scan]；登记为不同集合 → 落库定格
    INDUSTRY_PERM_PRESETS.hospital = { worker: ['inspect.execute'] };
    try {
      const { client, calls } = makeClient({ srcCategories: [] });
      const r = await provisionNewTenantContent(client, {
        tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T, category: 'hospital',
      });
      expect(r.permBaseline).toBe('snapshot');
      expect(r.permRolesSnapshotted).toEqual(['worker']);
      const ins = calls.filter((c) => c.text.includes('INSERT INTO role_permission'));
      expect(ins.length).toBe(1);
      expect(ins[0].params).toEqual([NEW_T, 'worker', 'inspect.execute']);
    } finally {
      delete INDUSTRY_PERM_PRESETS.hospital; // 还原全局，避免污染其他用例
    }
  });

  it('preset = 默认矩阵（集合相等、无序）→ 0 行落库（继承基线，不无谓定格）', async () => {
    INDUSTRY_PERM_PRESETS.hospital = { worker: ['asset.scan', 'inspect.execute'] }; // 与默认同集合，顺序不同
    try {
      const { client, calls } = makeClient({ srcCategories: [] });
      const r = await provisionNewTenantContent(client, {
        tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T, category: 'hospital',
      });
      expect(r.permBaseline).toBe('inherited');
      expect(r.permRolesSnapshotted).toEqual([]);
      expect(calls.find((c) => c.text.includes('INSERT INTO role_permission'))).toBeUndefined();
    } finally {
      delete INDUSTRY_PERM_PRESETS.hospital;
    }
  });

  it('admin 恒不参与基线：即使 preset 登记了 admin 也跳过（admin 恒全放行）', async () => {
    INDUSTRY_PERM_PRESETS.hospital = { admin: ['dashboard.view'] };
    try {
      const { client, calls } = makeClient({ srcCategories: [] });
      const r = await provisionNewTenantContent(client, {
        tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T, category: 'hospital',
      });
      expect(r.permBaseline).toBe('inherited');
      expect(calls.find((c) => c.text.includes('INSERT INTO role_permission'))).toBeUndefined();
    } finally {
      delete INDUSTRY_PERM_PRESETS.hospital;
    }
  });

  it('自指路径：SET LOCAL / SET ROLE 补在②之前，②③④写入全部有新租户写上下文（QA 修正回归）', async () => {
    INDUSTRY_PERM_PRESETS.hospital = { worker: ['inspect.execute'] };
    try {
      const { client, calls } = makeClient({ srcCategories: [] });
      await provisionNewTenantContent(client, {
        tenantId: SRC_T, name: '自指', sourceTenantId: SRC_T, category: 'hospital',
      });
      const idx = (pred: (c: { text: string }) => boolean) => calls.findIndex(pred);
      const firstSetLocal = idx((c) => c.text.startsWith('SET LOCAL app.tenant_id'));
      const firstSetRole = idx((c) => c.text === 'SET ROLE youfu_app');
      const wfIns = idx((c) => c.text.includes('INSERT INTO workflow_def'));       // ②
      const accIns = idx((c) => c.text.includes('INSERT INTO account_user'));      // ③
      const permIns = idx((c) => c.text.includes('INSERT INTO role_permission'));  // ④
      expect(firstSetLocal).toBeGreaterThanOrEqual(0);
      expect(firstSetRole).toBeGreaterThan(firstSetLocal);
      // QA 修正点：上下文切换必须发生在②之前（否则自指路径下②③写库 42501）
      expect(firstSetLocal).toBeLessThan(wfIns);
      expect(firstSetRole).toBeLessThan(wfIns);
      expect(accIns).toBeGreaterThan(firstSetRole);
      expect(permIns).toBeGreaterThan(firstSetRole);
      // 最终写上下文收口在新租户，且全程只有一次 SET LOCAL（无源租户来回切换）
      const setLocals = calls.filter((c) => c.text.startsWith('SET LOCAL app.tenant_id'));
      expect(setLocals.length).toBe(1);
      expect(setLocals[0].text).toContain(SRC_T);
    } finally {
      delete INDUSTRY_PERM_PRESETS.hospital;
    }
  });
});
