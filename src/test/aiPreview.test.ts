import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// AI 端点测试：mock LLM + DB，覆盖 /preview /similar /feedback /agent-stats /gen-config 关键逻辑
const dbCalls: string[] = [];
// K2 embedding 行为的可塑状态：默认关（走关键词路径），K2 测试里打开
const embeddingState = { enabled: false, vec: null as number[] | null };

// I4 灰度总开关可塑状态：默认开（常规路径走 ON）；I4 门禁测试里翻关
const aiFeaturesState = { enabled: true };

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    const client = {
      query: async (sql: string, params: any[] = []) => {
        dbCalls.push(sql);
        let rows: any[] = [];
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
