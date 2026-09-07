// adminAgent.test.ts —— 注册制批次一 卡3（P0-4）：管理对话 agent 回归。
// 覆盖：输出协议解析、建议卡构造规范化（缺字段 missing_fields / username 自动建议 / 手机号丢弃）、
// runAdminTurn 工具输出 → 卡片、非法输出 → 诚实 reply、意图不明 → 追问。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const llmState = { chatResults: [] as string[] };

vi.mock('../services/llm.js', () => ({
  chatCompletion: vi.fn(async () => {
    const content = llmState.chatResults.shift();
    if (content === undefined) throw new Error('no more scripted chat results');
    return { content, promptTokens: 10, completionTokens: 10, model: 'test', provider: 'test' };
  }),
}));

import {
  parseAdminAction,
  buildAdminSystemPrompt,
  buildConfirmCard,
  runAdminTurn,
  matchOnboardingIntent,
  sanitizeTicketQueryArgs,
  toolsForRole,
  ADMIN_TOOL_NAMES,
  READONLY_TOOL_NAMES,
} from '../services/adminAgent.js';

beforeEach(() => {
  llmState.chatResults = [];
});

describe('parseAdminAction（JSON 动作协议，白名单 = 建卡 + 只读查询三工具）', () => {
  it('解析 reply', () => {
    expect(parseAdminAction('{"action":"reply","content":"请说明对象"}')).toEqual({ action: 'reply', content: '请说明对象' });
  });
  it('解析 parse_intent 工具', () => {
    const a = parseAdminAction('{"action":"tool","tool":"parse_intent","args":{"type":"dict_entry","dict_type":"location","payload":{"code":"3F-A01","name":"三楼会议室"}}}');
    expect(a?.action).toBe('tool');
    expect(a?.tool).toBe('parse_intent');
  });
  it('白名单外工具 / 非法 JSON → null', () => {
    expect(parseAdminAction('{"action":"tool","tool":"drop_table"}')).toBeNull();
    expect(parseAdminAction('not json')).toBeNull();
  });
  it('形状归一：模型平铺参数（顶层 type/payload 无 args）→ 收敛为 args（live 0907 实锤形态）', () => {
    const a = parseAdminAction('{"action":"tool","tool":"parse_intent","type":"dict_entry","dict_type":"location","payload":{"code":"3F-A01","name":"三楼会议室"}}');
    expect(a?.action).toBe('tool');
    expect((a as any).args.type).toBe('dict_entry');
    expect((a as any).args.payload.code).toBe('3F-A01');
  });
  it('形状归一：仅 payload 一键包裹 → 解包', () => {
    const a = parseAdminAction('{"action":"tool","tool":"query_tickets","payload":{"status":"processing"}}');
    expect((a as any).args.status).toBe('processing');
  });
  it('嵌套 args 形态继续兼容', () => {
    const a = parseAdminAction('{"action":"tool","tool":"query_tickets","args":{"priority":"urgent"}}');
    expect((a as any).args.priority).toBe('urgent');
  });
  it('工具名清单 = parse_intent + query_tickets + get_stats（智能体批次一）', () => {
    expect(ADMIN_TOOL_NAMES).toEqual(['parse_intent', 'query_tickets', 'get_stats']);
    expect(READONLY_TOOL_NAMES).toEqual(['query_tickets', 'get_stats']);
  });
});

describe('toolsForRole（角色分层：配置角色全工具，其余仅只读）', () => {
  it('admin/operator → 全量三工具', () => {
    expect(toolsForRole('admin')).toEqual(ADMIN_TOOL_NAMES);
    expect(toolsForRole('operator')).toEqual(ADMIN_TOOL_NAMES);
  });
  it('reviewer/service_desk → 仅只读查询（无 parse_intent）', () => {
    expect(toolsForRole('reviewer')).toEqual(READONLY_TOOL_NAMES);
    expect(toolsForRole('service_desk')).toEqual(READONLY_TOOL_NAMES);
  });
  it('worker → 仅只读；role 缺省 → 全量（向后兼容：一层门禁在路由层）', () => {
    expect(toolsForRole('worker')).toEqual(READONLY_TOOL_NAMES);
    expect(toolsForRole(undefined)).toEqual(ADMIN_TOOL_NAMES);
  });
});

describe('sanitizeTicketQueryArgs（只读查询参数净化：白名单+钳位）', () => {
  it('合法参数全保留', () => {
    const q = sanitizeTicketQueryArgs({ status: 'pending,processing', priority: 'urgent', department: '三号楼', today_only: true, limit: 5 })!;
    expect(q.status).toBe('pending,processing');
    expect(q.priority).toBe('urgent');
    expect(q.department).toBe('三号楼');
    expect(q.today_only).toBe(true);
    expect(q.limit).toBe(5);
  });
  it('非法 status 令牌丢弃 / 非法 priority 丢弃 / limit 超界钳位到 10', () => {
    const q = sanitizeTicketQueryArgs({ status: 'pending; DROP TABLE x, ok_state', priority: 'hacker', limit: 999 })!;
    expect(q.status).toBe('ok_state');
    expect(q.priority).toBeUndefined();
    expect(q.limit).toBe(10);
  });
  it('limit 下钳位 1；空对象 → 默认 limit 5 无条件；非对象 → null', () => {
    expect(sanitizeTicketQueryArgs({ limit: 0 })!.limit).toBe(1);
    const q = sanitizeTicketQueryArgs({})!;
    expect(q.limit).toBe(5);
    expect(q.status).toBeUndefined();
    expect(sanitizeTicketQueryArgs('hack')).toBeNull();
    expect(sanitizeTicketQueryArgs(null)).toBeNull();
    expect(sanitizeTicketQueryArgs([1, 2])).toBeNull();
  });
});

describe('buildAdminSystemPrompt（按白名单动态生成）', () => {
  it('全量白名单：声明不落库边界、两种卡片类型与查询工具', () => {
    const p = buildAdminSystemPrompt();
    expect(p).toContain('绝不直接创建或修改');
    expect(p).toContain('worker_onboarding');
    expect(p).toContain('dict_entry');
    expect(p).toContain('query_tickets');
    expect(p).toContain('get_stats');
  });
  it('只读白名单：不含 parse_intent 说明，含查询工具', () => {
    const p = buildAdminSystemPrompt(READONLY_TOOL_NAMES);
    expect(p).not.toContain('parse_intent');
    expect(p).toContain('query_tickets');
  });
});

describe('buildConfirmCard（服务端规范化，不信任模型形状）', () => {
  it('dict_entry/location：只保留白名单字段，缺必填进 missing_fields', () => {
    const card = buildConfirmCard({ type: 'dict_entry', dict_type: 'location', payload: { code: '3F-A01', name: '三楼会议室', default_reporter_id: 'hack', foo: 1 } });
    expect(card).not.toBeNull();
    expect(card!.type).toBe('dict_entry');
    const c = card as any;
    expect(c.dict_type).toBe('location');
    expect(c.payload.code).toBe('3F-A01');
    expect(c.payload.default_reporter_id).toBeUndefined(); // 白名单外丢弃
    expect(c.missing_fields).toEqual([]);
  });

  it('dict_entry/reporter：非法手机号丢弃 → phone 记为缺失', () => {
    const card = buildConfirmCard({ type: 'dict_entry', dict_type: 'reporter', payload: { code: 'zs', name: '张三', phone: '123' } }) as any;
    expect(card.payload.phone).toBeUndefined();
    expect(card.missing_fields).toContain('phone');
  });

  it('worker_onboarding：username 缺失自动建议 w+时间戳后6位', () => {
    const card = buildConfirmCard({ type: 'worker_onboarding', payload: { display_name: '张三', skill_tags: ['电工', ''] } }) as any;
    expect(card.payload.username).toMatch(/^w\d{6}$/);
    expect(card.payload.display_name).toBe('张三');
    expect(card.payload.skill_tags).toEqual(['电工']); // 空标签清洗
    expect(card.missing_fields).toEqual([]);
  });

  it('worker_onboarding：display_name 缺失 → missing_fields 提示', () => {
    const card = buildConfirmCard({ type: 'worker_onboarding', payload: {} }) as any;
    expect(card.missing_fields).toContain('display_name');
  });

  it('未知 type / dict_type → null', () => {
    expect(buildConfirmCard({ type: 'drop_table' })).toBeNull();
    expect(buildConfirmCard({ type: 'dict_entry', dict_type: 'hacker' })).toBeNull();
  });
});

describe('runAdminTurn（单次 LLM 调用，无工具循环）', () => {
  it('parse_intent 输出 → 返回规范化建议卡 + 固定话术', async () => {
    llmState.chatResults = [
      '{"action":"tool","tool":"parse_intent","args":{"type":"worker_onboarding","payload":{"display_name":"张三","phone":"13800001234"}}}',
    ];
    const r = await runAdminTurn('t1', '开通员工张三，手机号 13800001234');
    expect(r.confirm_card).toBeDefined();
    expect(r.confirm_card!.type).toBe('worker_onboarding');
    expect(r.reply).toContain('入驻');
  });

  it('reply 输出 → 原样透传，无卡片', async () => {
    llmState.chatResults = ['{"action":"reply","content":"您想新增位置还是开通员工？"}'];
    const r = await runAdminTurn('t1', '帮我把张三加进去');
    expect(r.reply).toContain('位置');
    expect(r.confirm_card).toBeUndefined();
  });

  it('非法输出（自由文本）→ 诚实固定话术', async () => {
    llmState.chatResults = ['这是自由文本不是 JSON'];
    const r = await runAdminTurn('t1', '在吗');
    expect(r.reply).toContain('换个说法');
    expect(r.confirm_card).toBeUndefined();
  });

  it('工具输出形状不合法（未知 type）→ 追问话术', async () => {
    llmState.chatResults = ['{"action":"tool","tool":"parse_intent","args":{"type":"weird"}}'];
    const r = await runAdminTurn('t1', '随便建一个');
    expect(r.reply).toContain('拿不准');
    expect(r.confirm_card).toBeUndefined();
  });
});

describe('runAdminTurn · 只读查询工具（智能体批次一）', () => {
  const executor = vi.fn();
  beforeEach(() => {
    executor.mockReset();
  });

  it('query_tickets 命中 → 执行器结果透传（确定性话术 + result_card）', async () => {
    executor.mockResolvedValueOnce({ reply: '查询完成：共 3 单符合条件。', card: { type: 'ticket_result', total: 3, items: [] } });
    llmState.chatResults = ['{"action":"tool","tool":"query_tickets","args":{"priority":"urgent","today_only":true}}'];
    const r = await runAdminTurn('t1', '今天有多少 urgent 单', { role: 'operator', toolExecutor: executor });
    expect(executor).toHaveBeenCalledWith('query_tickets', { priority: 'urgent', today_only: true }, '今天有多少 urgent 单');
    expect(r.reply).toContain('共 3 单');
    expect(r.result_card?.type).toBe('ticket_result');
    expect(r.confirm_card).toBeUndefined();
  });

  it('reviewer 请求建卡 → 执行层拦截：诚实告知边界，不产卡不调执行器', async () => {
    llmState.chatResults = ['{"action":"tool","tool":"parse_intent","args":{"type":"worker_onboarding","payload":{"display_name":"张三"}}}'];
    const r = await runAdminTurn('t1', '开通员工张三', { role: 'reviewer', toolExecutor: executor });
    expect(r.reply).toContain('仅管理员和操作员可用');
    expect(r.confirm_card).toBeUndefined();
    expect(executor).not.toHaveBeenCalled();
  });

  it('未注入执行器时查询 → 诚实告知暂不可用', async () => {
    llmState.chatResults = ['{"action":"tool","tool":"get_stats","args":{}}'];
    const r = await runAdminTurn('t1', '今天整体情况', { role: 'operator' });
    expect(r.reply).toContain('暂时不可用');
    expect(r.result_card).toBeUndefined();
  });

  it('执行器返回 null（参数不合规/查询失败）→ 诚实换个说法话术', async () => {
    executor.mockResolvedValueOnce(null);
    llmState.chatResults = ['{"action":"tool","tool":"query_tickets","args":{}}'];
    const r = await runAdminTurn('t1', '随便查点啥', { role: 'operator', toolExecutor: executor });
    expect(r.reply).toContain('换个说法');
    expect(r.result_card).toBeUndefined();
  });

  it('上下文注入：contextPage 拼进 user 消息（只进提示词）', async () => {
    llmState.chatResults = ['{"action":"reply","content":"好的"}'];
    const { chatCompletion } = await import('../services/llm.js');
    await runAdminTurn('t1', '这单怎么催', { role: 'operator', contextPage: '/tickets/wo-1', toolExecutor: executor });
    expect(vi.mocked(chatCompletion).mock.lastCall?.[0].messages).toEqual([
      { role: 'system', content: expect.stringContaining('query_tickets') },
      { role: 'user', content: expect.stringContaining('[用户当前页面：/tickets/wo-1]') },
    ]);
  });
});

describe('新手四步引导（注册制批次二 P1：引导意图确定性短路，纯回复无卡）', () => {
  it('命中「新手/怎么开通」类意图 → 返回固定四步文案，不调 LLM、不产卡', async () => {
    llmState.chatResults = []; // 若短路失效会因无脚本结果而抛错
    for (const msg of ['怎么开通新机构？', '新手第一步做什么', '系统要怎么配置？']) {
      const r = await runAdminTurn('t1', msg);
      expect(r.reply).toContain('新手四步引导');
      expect(r.reply).toContain('基础数据');
      expect(r.confirm_card).toBeUndefined();
    }
  });

  it('未命中意图 → 正常走 LLM 链路（不受引导短路影响）', async () => {
    llmState.chatResults = ['{"action":"reply","content":"您想新增位置还是开通员工？"}'];
    const r = await runAdminTurn('t1', '帮我把张三加进去');
    expect(r.reply).toContain('位置');
  });

  it('matchOnboardingIntent 纯函数边界', () => {
    expect(matchOnboardingIntent('第一步该干嘛')).toBe(true);
    expect(matchOnboardingIntent('从哪开始录入')).toBe(true);
    expect(matchOnboardingIntent('开通员工张三')).toBe(false); // 明确建卡意图不抢引导
  });
});
