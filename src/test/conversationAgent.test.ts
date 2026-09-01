// L3 对话管家 agent 单测（R36）
// 覆盖：动作协议解析 / 系统提示词防幻觉约束 / 工具循环（search→reply）/ consent 硬拒 / 不合规输出诚实降级
import { describe, it, expect, vi } from 'vitest';

const llmState = {
  chatResults: [] as string[], // 每次 chatCompletion 依序返回的模型输出
  embeddingEnabled: false,
  vec: [1, 0, 0] as number[],
};

const dbRows: Record<string, any[]> = {}; // 按 SQL 片段注册返回行
const dbCalls: string[] = [];

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    const client = {
      query: async (sql: string, _params: any[] = []) => {
        dbCalls.push(sql);
        for (const [frag, rows] of Object.entries(dbRows)) {
          if (sql.includes(frag)) return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return fn(client);
  },
}));

vi.mock('../services/llm.js', () => ({
  chatCompletion: vi.fn(async () => {
    const content = llmState.chatResults.shift();
    if (content === undefined) throw new Error('no more scripted chat results');
    return { content, promptTokens: 10, completionTokens: 10, model: 'test', provider: 'test' };
  }),
  llmInferCategory: vi.fn(async () => null),
  embeddingConfigured: () => llmState.embeddingEnabled,
  embedText: vi.fn(async () => (llmState.embeddingEnabled ? llmState.vec : null)),
  cosineSimilarity: (a: number[], b: number[]) => (a[0] === b[0] ? 0.9 : 0),
}));

vi.mock('../repo/tenantSettings.js', () => ({
  getLlmEnabled: vi.fn(async () => false),
  getAiFeaturesEnabled: vi.fn(async () => true),
}));

vi.mock('../repo/ticket.js', () => ({
  createWithIdem: vi.fn(async (_client: any, dto: any) => ({
    row: { id: dto.id, order_no: 'WO_TEST_001', title: dto.title, status: 'draft' },
    created: true,
  })),
}));

vi.mock('../routes/workOrder.js', () => ({
  autoDispatchAfterCreate: vi.fn(async () => ({ autoFlow: true, assignee: 'w1', reason: 'test', dispatchTarget: 'worker' })),
}));

import { parseAgentAction, buildSystemPrompt, runAgentTurn, conversationAvailable, TOOL_NAMES } from '../services/conversationAgent.js';

describe('parseAgentAction（JSON 动作协议）', () => {
  it('解析 reply 动作', () => {
    expect(parseAgentAction('{"action":"reply","content":"好的"}')).toEqual({ action: 'reply', content: '好的' });
  });
  it('解析 tool 动作（含 args）', () => {
    const a = parseAgentAction('{"action":"tool","tool":"search_history","args":{"description":"灯不亮"}}');
    expect(a?.action).toBe('tool');
    expect(a?.tool).toBe('search_history');
  });
  it('未知工具 / 非法 JSON / 缺 content → null', () => {
    expect(parseAgentAction('{"action":"tool","tool":"hack_db"}')).toBeNull();
    expect(parseAgentAction('not json')).toBeNull();
    expect(parseAgentAction('{"action":"reply"}')).toBeNull();
  });
  it('工具名清单 = MVP 三工具', () => {
    expect(TOOL_NAMES).toEqual(['search_history', 'create_ticket', 'check_status']);
  });
});

describe('buildSystemPrompt（防幻觉三件套）', () => {
  it('包含「绝不编造」「必须带工单号」「consent 征得同意」约束', () => {
    const p = buildSystemPrompt('测试机构');
    expect(p).toContain('绝不编造');
    expect(p).toContain('工单号');
    expect(p).toContain('明确同意');
  });
});

describe('runAgentTurn（工具循环 + 落库）', () => {
  it('search_history → 工具结果回灌 → reply 收敛', async () => {
    llmState.embeddingEnabled = true;
    llmState.chatResults = [
      '{"action":"tool","tool":"search_history","args":{"description":"走廊灯不亮"}}',
      '{"action":"reply","content":"找到相似历史单 WO_A，相似度 0.9。"}',
    ];
    dbRows['FROM ai_case_embeddings'] = [
      { ref_id: 'wo1', ref_type: 'work_order', category: '照明', priority: 'normal', source_text: '走廊灯不亮已修复', embedding: [1, 0, 0] },
    ];
    dbRows['FROM work_orders WHERE tenant_id = $1 AND id = ANY'] = [{ id: 'wo1', order_no: 'WO_A' }];
    dbRows['INSERT INTO ai_conversation ('] = [{ id: 'conv1' }];
    dbRows['INSERT INTO ai_conversation_turn'] = [{ id: 1 }];
    dbRows['UPDATE ai_conversation'] = [];

    const r = await runAgentTurn({ tenantId: 't1', tenantName: '测试机构', conversationId: 'conv1', userText: '走廊灯不亮', consent: false });
    expect(r.assistantText).toContain('WO_A');
    expect(r.toolTrace).toHaveLength(1);
    expect(r.toolTrace[0].ok).toBe(true);
    // 用户话轮 + 工具话轮 + 助手话轮 = 3 次 INSERT turn
    const turnInserts = dbCalls.filter((s) => s.includes('INSERT INTO ai_conversation_turn')).length;
    expect(turnInserts).toBe(3);
  });

  it('consent 硬拒：未同意时 create_ticket 被拒且不建单', async () => {
    llmState.chatResults = [
      '{"action":"tool","tool":"create_ticket","args":{"description":"空调坏了"}}',
      '{"action":"reply","content":"需要您先同意才能建单。"}',
    ];
    dbCalls.length = 0;
    dbRows['INSERT INTO ai_conversation_turn'] = [{ id: 1 }];
    dbRows['UPDATE ai_conversation'] = [];

    const r = await runAgentTurn({ tenantId: 't1', tenantName: '测试机构', conversationId: 'conv1', userText: '帮我建单', consent: false });
    expect(r.toolTrace[0].ok).toBe(false);
    expect(r.toolTrace[0].summary).toContain('consent');
    expect(dbCalls.some((s) => s.includes('INSERT INTO work_orders'))).toBe(false);
  });

  it('模型输出不合规 → 固定话术诚实降级', async () => {
    llmState.chatResults = ['这是自由文本不是 JSON'];
    dbCalls.length = 0;
    dbRows['INSERT INTO ai_conversation_turn'] = [{ id: 1 }];
    dbRows['UPDATE ai_conversation'] = [];

    const r = await runAgentTurn({ tenantId: 't1', tenantName: '测试机构', conversationId: 'conv1', userText: '在吗', consent: false });
    expect(r.assistantText).toContain('换个说法');
  });
});

describe('conversationAvailable（双开关诚实降级）', () => {
  it('AI 开 + LLM 未授权 → LLM_NOT_AUTHORIZED', async () => {
    const r = await conversationAvailable('t1');
    expect(r).toEqual({ ok: false, reason: 'LLM_NOT_AUTHORIZED' });
  });
});
