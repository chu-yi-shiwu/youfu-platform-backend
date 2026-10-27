import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { doneStates } from '../engine/stateMachine.js';

// AI 端点测试：mock LLM + DB，覆盖 /preview /similar /feedback /agent-stats /gen-config 关键逻辑
const dbCalls: string[] = [];
// 与 dbCalls 下标一一对应的实参快照（多版本口径用例要断言喂给 status = ANY($n) 的数组）
const dbParams: unknown[][] = [];
// T1-B 多版本口径用例的两份 def：v1（老版本，完成态多一个 'X'）/ live（当前版本）。
const DEF_V1 = { initial: 'draft', states: ['draft', 'done', 'X'], transitions: [], config: { doneStates: ['done', 'X'] } };
const DEF_LIVE = { initial: 'draft', states: ['draft', 'done'], transitions: [], config: { doneStates: ['done'] } };
// 版本探针开关：默认关（其余用例走 live 单版本，行为不变），仅多版本口径用例打开
const defVersionState = { enabled: false };
// K2 embedding 行为的可塑状态：默认关（走关键词路径），K2 测试里打开
const embeddingState = { enabled: false, vec: null as number[] | null };

// I4 灰度总开关可塑状态：默认开（常规路径走 ON）；I4 门禁测试里翻关
const aiFeaturesState = { enabled: true };

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    const client = {
      query: async (sql: string, params: any[] = []) => {
        dbCalls.push(sql);
        dbParams.push(params ?? []);
        let rows: any[] = [];
        // T1-B 版本探测分支（仅多版本口径用例打开）。
        // ⚠️ 必须**提前 return**：这几条 SQL 都含 business_flow_tasks / workflow_def 子串，
        //    若并进下面的 else-if 链，会被后面的同名分支覆盖（探针静默失效、用例假绿）。
        if (defVersionState.enabled) {
          // ① 探「当前在用版本」：业务流任务行上锁着 v1（外加哨兵 0 = 走 live）
          if (sql.includes('DISTINCT def_version')) return { rows: [{ def_version: 1 }], rowCount: 1 };
          // ② live 版本号 = 2 ⇒ v1 必须回查 history 快照（不是 live）
          if (sql.includes('SELECT version FROM workflow_def')) return { rows: [{ version: 2 }], rowCount: 1 };
          // ③ v1 历史快照
          if (sql.includes('workflow_def_history')) return { rows: [{ def: DEF_V1 }], rowCount: 1 };
          // ④ live def（def_version = 0 的哨兵行走这份）
          if (sql.includes('FROM workflow_def')) return { rows: [{ def: DEF_LIVE }], rowCount: 1 };
        }
        if (sql.includes('FROM ai_feedback')) {
          rows = [{ action: 'adopt', c: 2 }, { action: 'ignore', c: 1 }];
        } else if (sql.includes('ai_inference_log')) {
          rows = [];
        } else if (sql.includes('uone_knowledge') && sql.includes('category')) {
          rows = [{ id: 99261, desc_text: '检验科冷库换LED筒灯', title: '应急照明灯问题', category: '应急照明灯问题', priority: '2' }];
        } else if (sql.includes('uone_knowledge') && sql.includes('ILIKE')) {
          rows = [{ id: 99261, desc_text: '走廊灯不亮', title: '应急照明灯问题', category: '应急照明灯问题', priority: '2' }];
        } else if (sql.includes('business_flow_tasks')) {
          rows = [{ title: '本机构单', d: 'desc', entity_type: 'repair' }];
        } else if (sql.includes('FROM ai_case_embeddings')) {
          rows = [{ ref_id: 'bf1', ref_type: 'business_flow_task', category: '照明', priority: 'normal', source_text: '走廊灯不亮已修复', embedding: embeddingState.vec ?? [] }];
        } else if (sql.includes('upsert_case_embedding')) {
          rows = [];
        } else if (sql.includes('work_orders')) {
          rows = [{ id: 'w1', title: '待复核单', order_no: 'WO_001', created_at: '2026-08-22 22:58' }];
        } else if (sql.includes('SELECT count')) {
          rows = [{ c: 1 }];
        } else if (sql.includes('INSERT INTO ai_feedback')) {
          rows = [];
        } else if (sql.includes('tenant_settings')) {
          // I4 灰度总开关：按可塑状态返回（getAiFeaturesEnabled 读 settings->>'ai_features_enabled'）
          rows = [{ flag: aiFeaturesState.enabled ? 'true' : 'false' }];
        }
        return { rows, rowCount: rows.length };
      },
    };
    return fn(client);
  },
}));

vi.mock('../services/llm.js', () => {
  const cosine = (a: number[], b: number[]) => {
    if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    const d = Math.sqrt(na) * Math.sqrt(nb);
    return d === 0 ? 0 : dot / d;
  };
  return {
    llmConfigured: () => true,
    llmInferCategory: vi.fn(async (desc: string, cats: string[]) => {
      if (desc.includes('走廊')) return { category: '照明', priority: 'normal', asset: '走廊灯' };
      if (desc.includes('水龙头')) return { category: '水电', priority: 'urgent', asset: '水龙头' };
      return null;
    }),
    llmGenConfig: vi.fn(async (req: string) =>
      ({
        name: '陪检业务',
        fields: [
          { key: 'patient_name', label: '患者姓名', type: 'text', required: true, options: [] },
          { key: 'exam_item', label: '检查项目', type: 'text', required: true, options: [] },
        ],
        initial: 'draft',
        states: ['draft', 'assigned', 'processing', 'completed'],
        transitions: [],
      })),
    // K2 向量嵌入客户端：默认关（向量路径休眠，关键词兜底不变）；K2 测试打开
    embeddingConfigured: () => embeddingState.enabled,
    embeddingModel: () => 'embedding-3',
    embedText: vi.fn(async () => embeddingState.vec),
    cosineSimilarity: cosine,
  };
});

async function loadRouter() {
  vi.resetModules();
  const mod = await import('../routes/aiPreview.js');
  return mod.default;
}

function findHandler(router: any, method: string, path: string) {
  const layer = router.stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method]);
  return layer && layer.route.stack[0].handle;
}

function makeReq(body?: any, query?: any): Request {
  return { body: body || {}, query: query || {} } as unknown as Request;
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (obj: unknown) => { res.body = obj; res.sent = true; return res; };
  res.locals = { auth: { tenantId: 't-test', userId: 'u1', username: 'test' } };
  return res;
}

describe('aiPreview · /preview 三层分类', () => {
  beforeEach(() => { dbCalls.length = 0; });

  it('LLM 命中 → 返回分类/优先级/置信度，并写推理日志', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/preview');
    const res = makeRes();
    await handler(makeReq({ description: '3楼走廊灯不亮' }), res, () => {});
    expect(res.body.ok).toBe(true);
    expect(res.body.result.category).toBe('照明');
    expect(res.body.result.priority).toBe('normal');
    expect(dbCalls.some((s) => s.includes('INSERT INTO ai_inference_log'))).toBe(true);
  });

  it('LLM 未命中 → result null + 人工选择提示', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/preview');
    const res = makeRes();
    await handler(makeReq({ description: '完全无法识别的乱码xyz' }), res, () => {});
    expect(res.body.result).toBe(null);
    expect(res.body.message).toContain('人工选择');
  });

  it('description 超长截断（≤500 校验）', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/preview');
    const res = makeRes();
    await handler(makeReq({ description: 'x'.repeat(600) }), res, (e: any) => {
      expect(e).toBeDefined();
    });
  });
});

describe('aiPreview · /similar 知识库检索', () => {
  beforeEach(() => { embeddingState.enabled = false; embeddingState.vec = null; });
  it('category 匹配 → 返回 knowledgeId + 过滤空 category', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/similar');
    const res = makeRes();
    await handler(makeReq({ description: '走廊灯不亮', category: '照明' }), res, () => {});
    expect(res.body.ok).toBe(true);
    const sql = dbCalls.find((s) => s.includes('uone_knowledge') && s.includes('category'));
    expect(sql).toContain("category != ''"); // 空分类过滤
    expect(sql).toContain('ILIKE');
  });
});

describe('aiPreview · /feedback 真实落库', () => {
  it('合法 action → ok:true + INSERT ai_feedback', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/feedback');
    const res = makeRes();
    await handler(makeReq({ action: 'adopt', target_type: 'suggestion', target_id: '99261', payload: { title: 'x' } }), res, () => {});
    expect(res.body.ok).toBe(true);
    expect(dbCalls.some((s) => s.includes('INSERT INTO ai_feedback'))).toBe(true);
  });

  it('非法 action → 校验错误', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/feedback');
    const res = makeRes();
    let threw = false;
    await handler(makeReq({ action: 'hack' }), res, (e: any) => { threw = true; });
    expect(threw).toBe(true);
  });
});

describe('aiPreview · /agent-stats 统计', () => {
  it('返回反馈统计 + 待复核', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'get', '/agent-stats');
    const res = makeRes();
    await handler(makeReq(), res, () => {});
    expect(res.body.ok).toBe(true);
    expect(res.body.data.adoptRate).toBe(67); // adopt2/(2+1) = 66.7 → 67
  });
});

describe('aiPreview · /gen-config 配置草稿', () => {
  it('LLM 生成草稿 → 返回 fields', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/gen-config');
    const res = makeRes();
    await handler(makeReq({ requirement: '陪检业务，患者姓名、检查项目' }), res, () => {});
    expect(res.body.ok).toBe(true);
    expect(res.body.draft.fields.length).toBeGreaterThanOrEqual(1);
    expect(res.body.draft.fields[0].key).toBe('patient_name');
  });

  it('requirement 过短 → 校验错误', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/gen-config');
    const res = makeRes();
    let threw = false;
    await handler(makeReq({ requirement: 'x' }), res, (e: any) => { threw = true; });
    expect(threw).toBe(true);
  });
});

describe('aiPreview · /similar K2 向量检索', () => {
  beforeEach(() => { dbCalls.length = 0; embeddingState.enabled = true; embeddingState.vec = [1, 0, 0, 1]; });

  it('有 embedding key → 返回语义项(本机构/语义) + vectorEnabled:true + score≈1', async () => {
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/similar');
    const res = makeRes();
    await handler(makeReq({ description: '走廊灯不亮', category: '照明' }), res, () => {});
    expect(res.body.ok).toBe(true);
    expect(res.body.vectorEnabled).toBe(true); // 诚实标注向量开关状态
    const sem = (res.body.items || []).find((i: any) => i.source === '本机构(语义)');
    expect(sem).toBeTruthy();
    expect(sem.score).toBeCloseTo(1, 5); // 查询向量=库内向量 → 余弦=1
    // 关键词兜底路径仍存在（UOne 知识库项）
    expect((res.body.items || []).some((i: any) => i.source === '知识库')).toBe(true);
  });

  it('无 embedding key（默认）→ vectorEnabled:false 且零回归走关键词路径', async () => {
    embeddingState.enabled = false;
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/similar');
    const res = makeRes();
    await handler(makeReq({ description: '走廊灯不亮', category: '照明' }), res, () => {});
    expect(res.body.ok).toBe(true);
    expect(res.body.vectorEnabled).toBe(false);
    expect((res.body.items || []).some((i: any) => i.source === '知识库')).toBe(true);
    expect((res.body.items || []).every((i: any) => i.source !== '本机构(语义)')).toBe(true);
  });
});

describe('aiPreview · I4 灰度总开关门禁（#704）', () => {
  beforeEach(() => { aiFeaturesState.enabled = true; embeddingState.enabled = false; });

  it('I4 关 → /similar 诚实降级：aiDisabled:true 且 items 空、vectorEnabled:false', async () => {
    aiFeaturesState.enabled = false;
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/similar');
    const res = makeRes();
    await handler(makeReq({ description: '走廊灯不亮', category: '照明' }), res, () => {});
    expect(res.body.ok).toBe(true);
    expect(res.body.aiDisabled).toBe(true);
    expect(res.body.items).toEqual([]);
    expect(res.body.vectorEnabled).toBe(false);
  });

  it('I4 关 → /gen-config 诚实降级：aiDisabled:true 且 draft:null', async () => {
    aiFeaturesState.enabled = false;
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/gen-config');
    const res = makeRes();
    await handler(makeReq({ requirement: '陪检业务，患者姓名、检查项目' }), res, () => {});
    expect(res.body.ok).toBe(true);
    expect(res.body.aiDisabled).toBe(true);
    expect(res.body.draft).toBe(null);
    expect(res.body.message).toContain('未开启');
  });

  it('I4 开 → /similar 正常返回（不降级）', async () => {
    aiFeaturesState.enabled = true;
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/similar');
    const res = makeRes();
    await handler(makeReq({ description: '走廊灯不亮', category: '照明' }), res, () => {});
    expect(res.body.ok).toBe(true);
    expect(res.body.aiDisabled).toBeFalsy();
  });

  it('I4 开 → /gen-config 正常生成草稿', async () => {
    aiFeaturesState.enabled = true;
    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/gen-config');
    const res = makeRes();
    await handler(makeReq({ requirement: '陪检业务，患者姓名、检查项目' }), res, () => {});
    expect(res.body.ok).toBe(true);
    expect(res.body.draft).not.toBe(null);
    expect(res.body.draft.fields[0].key).toBe('patient_name');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T1-B：doneSampleClause 的「已完成样本」是**包含判定**（status = ANY(完成态)），
// 此刻手上没有具体行 ⇒ 必须按「租户当前所有在用版本」的完成态**并集**求口径。
// 只读 live 一份 ⇒ 锁着旧版本、状态是旧版完成态的行**漏采**（AI 相似建议少一整路证据源）。
// ─────────────────────────────────────────────────────────────────────────────
describe('aiPreview · 采样口径 T1-B 多版本完成态并集', () => {
  beforeEach(() => {
    dbCalls.length = 0;
    dbParams.length = 0;
    defVersionState.enabled = true;
    aiFeaturesState.enabled = true;
    embeddingState.enabled = false;
    embeddingState.vec = null;
  });
  afterEach(() => { defVersionState.enabled = false; });

  it('完成态取各在用版本并集：锁 v1 的老行（状态 X）也进采样集', async () => {
    // 假绿防护：两版完成态必须真的不同，否则"含 X"这条断言恒真、用例本身没意义
    expect(doneStates(DEF_V1 as any)).toContain('X');
    expect(doneStates(DEF_LIVE as any)).not.toContain('X');

    const router = await loadRouter();
    const handler = findHandler(router, 'post', '/similar');
    const res = makeRes();
    await handler(makeReq({ description: '走廊灯不亮', category: '照明' }), res, () => {});
    expect(res.body.ok).toBe(true);

    const idx = dbCalls.findIndex((s) => s.includes('status = ANY('));
    expect(idx).toBeGreaterThanOrEqual(0); // 采样 SQL 必须真的带着状态集发出
    // WHERE tenant_id=$1 AND (entity_type = $2 AND status = ANY($3::text[])) ⇒ params[2] = 完成态集合
    const done = dbParams[idx][2] as string[];
    expect(done).toEqual(expect.arrayContaining(['done', 'X']));
  });
});
