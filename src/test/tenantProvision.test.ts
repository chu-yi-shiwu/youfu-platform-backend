// SaaS 前置（2026-09-01）：新租户开通断链回归护栏。
// 此前 POST /platform/tenants 只建 registry + 复制 fault_category → 新机构「无人可登录、无流程可流转」。
// provisionNewTenantContent 现一次建齐：①分类复制（沿用模板逻辑）②workflow_def（模板源 def 或默认 4 态）
// ③admin 账号（scrypt 哈希）。本文件验证四条主链路 + 上下文收口 + PII 不复制边界（注释锚定）。
import { describe, it, expect } from 'vitest';

const { provisionNewTenantContent } = await import('../repo/tenantProvision.js');

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
    expect(JSON.parse(wfIns.params![1])).toEqual(richDef);
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
    expect(def.states).toEqual(['draft', 'assigned', 'processing', 'completed']);
    expect(def.config?.doneStates).toEqual(['completed']);
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
