// SaaS 前置（2026-09-01）：新租户开通断链回归护栏。
// 此前 POST /platform/tenants 只建 registry + 复制 fault_category → 新机构「无人可登录、无流程可流转」。
// provisionNewTenantContent 现一次建齐：①分类复制（沿用模板逻辑）②workflow_def（模板源 def 或默认 4 态）
// ③admin 账号（scrypt 哈希）④行业权限基线。本文件验证主链路 + 上下文收口 + 失败回滚 + PII 不复制边界。
//
// 【测试质量修正（本轮）】
//   原 :125 断言 `Object.keys(INDUSTRY_PERM_PRESETS).length === 0`（"预设表为空"）——
//   典型的「测试跟着实现写」反模式：业务登记第一个行业 preset 时该断言必然变红，
//   逼后人改测试而不是改实现。现改为 beforeEach 清空 + afterEach 还原，
//   断言回归真实语义：「该行业无 preset → 0 行落库 + permBaseline=inherited」。
//   原自指路径用例断言 `setLocals[0] 含 SRC_T` 在自指下 new==src 恒真、证明不了任何事；
//   现补**非自指路径**用例（最后一次 SET LOCAL = 新租户、全程仅 1 次切换、切后不回源）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

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

// ---- 预设表隔离：每个用例都在"该行业无 preset"的干净前提下跑，跑完还原 ----
// 目的：登记第一个行业 preset 时本文件不会变红（原断言会逼后人改测试）。
const presetBackup: Record<string, unknown> = {};

function snapshotPresets(): void {
  for (const k of Object.keys(INDUSTRY_PERM_PRESETS)) {
    presetBackup[k] = INDUSTRY_PERM_PRESETS[k as keyof typeof INDUSTRY_PERM_PRESETS];
    delete INDUSTRY_PERM_PRESETS[k as keyof typeof INDUSTRY_PERM_PRESETS];
  }
}

function restorePresets(): void {
  for (const k of Object.keys(INDUSTRY_PERM_PRESETS)) {
    delete INDUSTRY_PERM_PRESETS[k as keyof typeof INDUSTRY_PERM_PRESETS];
  }
  Object.assign(INDUSTRY_PERM_PRESETS, presetBackup);
  for (const k of Object.keys(presetBackup)) delete presetBackup[k];
}

beforeEach(snapshotPresets);
afterEach(restorePresets);

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
    // 架构🔴4：会话级 SET ROLE 在连接归还池后不复位（下个请求沿用 youfu_app 造成越权读），
    // 统一改事务级 SET LOCAL ROLE（随事务结束自动复位）。此处锁死该形态。
    const roleCalls = calls.filter((c) => c.text === 'SET LOCAL ROLE youfu_app');
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
  it('该行业无 preset → 0 行 role_permission 落库 + permBaseline=inherited', async () => {
    // 不再断言"预设表为空"（那会在登记第一个行业时逼后人改测试）；
    // 由 beforeEach 保证干净前提，断言回归真实语义：preset 缺失 → 继承官方默认矩阵。
    expect(INDUSTRY_PERM_PRESETS.hospital).toBeUndefined();
    const { client, calls } = makeClient({ srcCategories: [] });
    const r = await provisionNewTenantContent(client, {
      tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T, category: 'hospital',
    });
    expect(r.permBaseline).toBe('inherited');
    expect(r.permRolesSnapshotted).toEqual([]);
    expect(calls.find((c) => c.text.includes('INSERT INTO role_permission'))).toBeUndefined();
  });

  it('未登记 preset 的其它行业同样 inherited（机制对全行业成立，不绑死 hospital）', async () => {
    const { client, calls } = makeClient({ srcCategories: [] });
    const r = await provisionNewTenantContent(client, {
      tenantId: NEW_T, name: '测试学校', sourceTenantId: SRC_T, category: 'school',
    });
    expect(r.permBaseline).toBe('inherited');
    expect(calls.find((c) => c.text.includes('INSERT INTO role_permission'))).toBeUndefined();
  });

  it('preset ≠ 默认矩阵 → 该角色全量行落库 + permBaseline=snapshot', async () => {
    // worker 默认 = [inspect.execute, asset.scan]；登记为不同集合 → 落库定格
    INDUSTRY_PERM_PRESETS.hospital = { worker: ['inspect.execute'] };
    const { client, calls } = makeClient({ srcCategories: [] });
    const r = await provisionNewTenantContent(client, {
      tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T, category: 'hospital',
    });
    expect(r.permBaseline).toBe('snapshot');
    expect(r.permRolesSnapshotted).toEqual(['worker']);
    const ins = calls.filter((c) => c.text.includes('INSERT INTO role_permission'));
    expect(ins.length).toBe(1);
    expect(ins[0].params).toEqual([NEW_T, 'worker', 'inspect.execute']);
  });

  it('preset = 默认矩阵（集合相等、无序）→ 0 行落库（继承基线，不无谓定格）', async () => {
    INDUSTRY_PERM_PRESETS.hospital = { worker: ['asset.scan', 'inspect.execute'] }; // 与默认同集合，顺序不同
    const { client, calls } = makeClient({ srcCategories: [] });
    const r = await provisionNewTenantContent(client, {
      tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T, category: 'hospital',
    });
    expect(r.permBaseline).toBe('inherited');
    expect(r.permRolesSnapshotted).toEqual([]);
    expect(calls.find((c) => c.text.includes('INSERT INTO role_permission'))).toBeUndefined();
  });

  it('admin 恒不参与基线：即使 preset 登记了 admin 也跳过（admin 恒全放行）', async () => {
    INDUSTRY_PERM_PRESETS.hospital = { admin: ['dashboard.view'] };
    const { client, calls } = makeClient({ srcCategories: [] });
    const r = await provisionNewTenantContent(client, {
      tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T, category: 'hospital',
    });
    expect(r.permBaseline).toBe('inherited');
    expect(calls.find((c) => c.text.includes('INSERT INTO role_permission'))).toBeUndefined();
  });

  it('自指路径：SET LOCAL / SET LOCAL ROLE 补在②之前，②③④写入全部有新租户写上下文（QA 修正回归）', async () => {
    INDUSTRY_PERM_PRESETS.hospital = { worker: ['inspect.execute'] };
    const { client, calls } = makeClient({ srcCategories: [] });
    await provisionNewTenantContent(client, {
      tenantId: SRC_T, name: '自指', sourceTenantId: SRC_T, category: 'hospital',
    });
    const idx = (pred: (c: { text: string }) => boolean) => calls.findIndex(pred);
    const firstSetLocal = idx((c) => c.text.startsWith('SET LOCAL app.tenant_id'));
    const firstSetRole = idx((c) => c.text === 'SET LOCAL ROLE youfu_app');
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
    // 自指下只有 1 次 SET LOCAL（没有源租户可读，也就没有来回切换）
    const setLocals = calls.filter((c) => c.text.startsWith('SET LOCAL app.tenant_id'));
    expect(setLocals.length).toBe(1);
    expect(setLocals[0].text).toContain(SRC_T);
  });

  it('非自指路径：SET LOCAL 恰 2 次（SRC→NEW，全程仅 1 次切换，切后不回源）', async () => {
    // 自指用例里 new==src，`setLocals[0] 含 SRC_T` 恒真、证明不了任何事。
    // 本用例走真正的跨租户路径（SRC_T ≠ NEW_T），断言才是有信息的。
    INDUSTRY_PERM_PRESETS.hospital = { worker: ['inspect.execute'] };
    const { client, calls } = makeClient({
      srcCategories: [{ code: 'PRINTER', name: '打印机故障', sort: 1, enabled: true }],
      srcDef: { initial: 'draft', states: ['draft', 'completed'], transitions: [] },
    });
    await provisionNewTenantContent(client, {
      tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T, category: 'hospital',
    });
    const setLocals = calls.filter((c) => c.text.startsWith('SET LOCAL app.tenant_id'));
    expect(setLocals).toHaveLength(2); // 读源一次 + 切新租户一次 = 全程仅 1 次切换
    expect(setLocals[0].text).toContain(SRC_T);
    expect(setLocals[1].text).toContain(NEW_T);
    // 最后一次 SET LOCAL = 新租户（写上下文收口）
    expect(setLocals[setLocals.length - 1].text).toContain(NEW_T);

    // 切到新租户之后不得再切回源租户（无来回 ping-pong，否则后续写库落在源租户上下文）
    const firstNewIdx = calls.findIndex(
      (c) => c.text.startsWith('SET LOCAL app.tenant_id') && c.text.includes(NEW_T),
    );
    expect(firstNewIdx).toBeGreaterThan(0);
    const afterNew = calls
      .slice(firstNewIdx + 1)
      .filter((c) => c.text.startsWith('SET LOCAL app.tenant_id'));
    expect(afterNew.map((c) => c.text)).toEqual([]);

    // ②③④ 全部写在新租户上下文之后
    for (const kw of [
      'INSERT INTO fault_category',
      'INSERT INTO workflow_def',
      'INSERT INTO account_user',
      'INSERT INTO role_permission',
    ]) {
      const at = calls.findIndex((c) => c.text.includes(kw));
      expect(at, `${kw} 应发生在切换到新租户之后`).toBeGreaterThan(firstNewIdx);
    }
  });
});

// ---- 事务语义：任一步失败必须整体回滚，无残留 INSERT ----
interface TxState {
  pending: string[];
  committed: string[];
  rolledBack: string[];
}

/** 带事务语义的假 client：语句先入 pending，COMMIT 落 committed，ROLLBACK 清空并记入 rolledBack。 */
function makeTxClient(spec: FakeSpec, failOn: (text: string) => boolean) {
  const state: TxState = { pending: [], committed: [], rolledBack: [] };
  let aborted = false;
  const client = {
    query: (async (text: string, _params?: any[]) => {
      if (text === 'COMMIT') {
        state.committed.push(...state.pending);
        state.pending.length = 0;
        return { rows: [], rowCount: 0 };
      }
      if (text === 'ROLLBACK') {
        state.rolledBack.push(...state.pending);
        state.pending.length = 0;
        aborted = false;
        return { rows: [], rowCount: 0 };
      }
      if (aborted) {
        const e: any = new Error('current transaction is aborted, commands ignored until end of transaction block');
        e.code = '25P02';
        throw e;
      }
      if (failOn(text)) {
        aborted = true;
        const e: any = new Error(`simulated failure: ${text.slice(0, 60)}`);
        e.code = 'SIMULATED';
        throw e;
      }
      state.pending.push(text);
      if (text.includes('SELECT code, name, sort, enabled FROM fault_category')) return { rows: spec.srcCategories };
      if (text.includes('SELECT def FROM workflow_def')) return { rows: spec.srcDef !== undefined ? [{ def: spec.srcDef }] : [] };
      if (text.includes('INSERT INTO fault_category')) return { rows: [], rowCount: spec.insertRowCounts?.fault_category ?? 1 };
      return { rows: [], rowCount: 1 };
    }) as QueryFn,
  } as any;
  return { client, state };
}

describe('provisionNewTenantContent 失败回滚（调用方事务整体 ROLLBACK，无残留）', () => {
  it('③account_user 插入失败 → 整体回滚：workflow_def 的 INSERT 无残留', async () => {
    const { client, state } = makeTxClient(
      {
        srcCategories: [{ code: 'X', name: 'X', sort: 1, enabled: true }],
        srcDef: { initial: 'draft', states: ['draft'], transitions: [] },
      },
      (t) => t.includes('INSERT INTO account_user'),
    );
    let caught: unknown = null;
    try {
      await provisionNewTenantContent(client, { tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T });
    } catch (e) {
      caught = e;
    }
    expect(caught, 'account_user 插入失败必须向上抛出（由调用方决定回滚）').toBeTruthy();
    await client.query('ROLLBACK');

    // ② 已执行的 INSERT 必须被撤销：没有任何东西真正落库
    expect(state.committed).toEqual([]);
    expect(state.pending).toEqual([]);
    expect(state.rolledBack.some((t) => t.includes('INSERT INTO workflow_def'))).toBe(true);
    expect(state.rolledBack.some((t) => t.includes('INSERT INTO account_user'))).toBe(false); // 失败语句本身未入账
  });

  it('②workflow_def 冲突失败 → 整体回滚：无残留 INSERT', async () => {
    const { client, state } = makeTxClient({ srcCategories: [] }, (t) => t.includes('INSERT INTO workflow_def'));
    let caught: unknown = null;
    try {
      await provisionNewTenantContent(client, { tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    await client.query('ROLLBACK');

    expect(state.committed).toEqual([]);
    expect(state.pending).toEqual([]);
    // ② 先失败 → ③账号根本没执行（不会留下"有管理员但没流程"的半截租户）
    expect(state.rolledBack.some((t) => t.includes('INSERT INTO account_user'))).toBe(false);
    expect(state.rolledBack.some((t) => t.includes('INSERT INTO workflow_def'))).toBe(false);
  });

  it('无失败 → COMMIT 后全部落库（回滚假 client 的正向自检）', async () => {
    const { client, state } = makeTxClient({ srcCategories: [] }, () => false);
    await provisionNewTenantContent(client, { tenantId: NEW_T, name: '测试医院', sourceTenantId: SRC_T });
    await client.query('COMMIT');
    expect(state.committed.some((t) => t.includes('INSERT INTO workflow_def'))).toBe(true);
    expect(state.committed.some((t) => t.includes('INSERT INTO account_user'))).toBe(true);
    expect(state.pending).toEqual([]);
  });
});
