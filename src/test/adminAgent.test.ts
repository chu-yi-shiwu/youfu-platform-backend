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
  ADMIN_TOOL_NAMES,
} from '../services/adminAgent.js';

beforeEach(() => {
  llmState.chatResults = [];
});

describe('parseAdminAction（JSON 动作协议，白名单仅 parse_intent）', () => {
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
  it('工具名清单 = parse_intent 单工具', () => {
    expect(ADMIN_TOOL_NAMES).toEqual(['parse_intent']);
  });
});

describe('buildAdminSystemPrompt', () => {
  it('声明不落库边界与两种卡片类型', () => {
    const p = buildAdminSystemPrompt();
    expect(p).toContain('绝不直接创建');
    expect(p).toContain('worker_onboarding');
    expect(p).toContain('dict_entry');
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
