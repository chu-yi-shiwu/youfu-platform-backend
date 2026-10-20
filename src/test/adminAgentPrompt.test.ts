// adminAgentPrompt.test.ts —— R2-C：管理智能体系统提示词里的状态名必须跟随租户自己的流程定义。
// 背景：few-shot 里把 "assigned,processing" 写死在提示词中（模型被样例教着输出这两个名字），
// 租户自定义流程根本没有这两个状态时，执行侧（adminAgentTools F10 白名单）会把它们过滤成空条件
// ⇒ 查什么都是 0 单且对话里看不出原因。修法：提示词的状态词汇一律从租户 def 派生。
// 覆盖：① 租户无 assigned/processing → 提示词不得再出现这两个名字；
//      ② 内置流程（含 assigned/processing）→ few-shot 逐字零回归 + 无 def 时整段零回归；
//      ③ 租户无任何活跃态 → 不输出带 status 的 few-shot，改用不带 status 的示例。
import { describe, it, expect } from 'vitest';

import {
  buildAdminSystemPrompt,
  promptStatusNames,
  ADMIN_TOOL_NAMES,
  READONLY_TOOL_NAMES,
} from '../services/adminAgent.js';
import { DEFAULT_WORK_ORDER_DEF, type WorkflowDef } from '../engine/stateMachine.js';

// 改动前写在提示词里的那条 few-shot（逐字），零回归基准
const LEGACY_STATUS_SHOT =
  '{"action":"tool","tool":"query_tickets","args":{"status":"assigned,processing","limit":5}}';

/** 线性流程：states[i] --next--> states[i+1]，末态为终态/完成态 */
function linearDef(states: string[], config?: WorkflowDef['config']): WorkflowDef {
  const transitions = states.slice(0, -1).map((from, i) => ({ from, to: states[i + 1], event: 'next' }));
  return { initial: states[0], states, transitions, config };
}

// 租户自定义流程：根本没有 assigned / processing 这两个状态名
const CUSTOM_DEF = linearDef(['draft', 'inbox', 'doing', 'finish']);
// 极端自定义流程：只有一个终态，无任何活跃态
const NO_ACTIVE_DEF: WorkflowDef = { initial: 'finished', states: ['finished'], transitions: [], config: {} };

describe('promptStatusNames（提示词状态词汇从租户 def 派生）', () => {
  it('自定义流程 → 取活跃态（剔除初态）前两个，不含内置写死名', () => {
    expect(promptStatusNames(CUSTOM_DEF)).toEqual(['inbox', 'doing']);
  });
  it('内置默认流程 → assigned,processing（与改动前样例逐字一致）', () => {
    expect(promptStatusNames(DEFAULT_WORK_ORDER_DEF)).toEqual(['assigned', 'processing']);
  });
  it('无活跃态 / 无 def → 空数组（调用方据此切换为不带 status 的示例）', () => {
    expect(promptStatusNames(NO_ACTIVE_DEF)).toEqual([]);
    expect(promptStatusNames(null)).toEqual([]);
    expect(promptStatusNames(undefined)).toEqual([]);
  });
});

describe('buildAdminSystemPrompt · 租户无 assigned/processing（R2-C 主场景）', () => {
  it('提示词不再出现 assigned / processing 这两个本租户不存在的状态名', () => {
    const p = buildAdminSystemPrompt(ADMIN_TOOL_NAMES, { def: CUSTOM_DEF });
    expect(p).not.toContain('assigned');
    expect(p).not.toContain('processing');
  });
  it('注入本机构可用状态行，且 few-shot 的 status 换成租户真实活跃态', () => {
    const p = buildAdminSystemPrompt(ADMIN_TOOL_NAMES, { def: CUSTOM_DEF });
    expect(p).toContain('本机构可用状态：draft,inbox,doing,finish');
    expect(p).toContain('"status":"inbox,doing"');
  });
  it('只读角色白名单同样生效（无 parse_intent 说明，状态词汇仍租户化）', () => {
    const p = buildAdminSystemPrompt(READONLY_TOOL_NAMES, { def: CUSTOM_DEF });
    expect(p).not.toContain('parse_intent');
    expect(p).not.toContain('assigned');
    expect(p).toContain('本机构可用状态：draft,inbox,doing,finish');
  });
});

describe('buildAdminSystemPrompt · 零回归', () => {
  it('内置默认流程（含 assigned/processing）→ 带 status 的 few-shot 逐字不变', () => {
    const p = buildAdminSystemPrompt(ADMIN_TOOL_NAMES, { def: DEFAULT_WORK_ORDER_DEF });
    expect(p).toContain(LEGACY_STATUS_SHOT);
    expect(p).toContain('本机构可用状态：draft,assigned,processing,completed');
  });
  it('未传 def（既有调用路径）→ 整段提示词与改动前逐字相同', () => {
    expect(buildAdminSystemPrompt(ADMIN_TOOL_NAMES)).toMatchInlineSnapshot(`
      "你是优服家管理后台的 AI 管家。你绝不直接创建或修改任何数据：创建类操作只输出「建议卡」JSON（由用户确认后提交），查询类操作只调用只读工具。你的每一条输出都必须是一个 JSON 对象，以 { 开头、以 } 结尾。
      可用工具（必须以 JSON 输出调用）：
      1. parse_intent {"type":"dict_entry","dict_type":"location|reporter","payload":{...}} —— 解析为字典建议卡：
         location（位置字典）payload 字段：code(编号)、name(名称)、category(类别，设备/房间/工位)、default_reporter_name(默认报修人姓名，仅供参考)；
         reporter（报修人字典）payload 字段：code(编号)、name(姓名)、phone(手机号)、role(角色说明)。
      2. parse_intent {"type":"worker_onboarding","payload":{...}} —— 解析为员工入驻建议卡：
         payload 字段：username(登录用户名)、display_name(姓名)、phone(手机号)、skill_tags(技能标签数组)。
      3. query_tickets {"status":"...","priority":"urgent|normal|low","department":"...","service_desk":"...","source":"...","today_only":true,"limit":5} —— 只读查询工单：
         各参数只放用户明确说出的条件，不用的字段省略；status 可逗号分隔多个；limit 建议 5，最大 10。
      4. get_stats {} —— 今日工单概览（今日新增按状态分布 + 当前未完成总数）。用户问「今天/现在整体情况」时用这个。
      输出协议（唯一合法输出，二选一）：
      {"action":"tool","tool":"<工具名>","args":{...}}
      {"action":"reply","content":"<给用户的文字>"}
      判断流程（每条消息按序执行）：
      ① 用户的问题能否由上面的工具回答？能 → 必须输出工具调用 JSON；涉及工单数量/状态/明细的问题，禁止不调用工具就用文字回答，禁止凭空编造数字；
      ② 用户意图明确但关键信息不足以成卡/成查询 → 输出 reply JSON 诚实追问，只问缺的那一项；
      ③ 用户要求创建数据时输出 parse_intent 工具调用，args 只放用户明确说出的字段，绝不编造；
      示例：
      用户：新增位置 3F-A01 三楼会议室 → {"action":"tool","tool":"parse_intent","args":{"type":"dict_entry","dict_type":"location","payload":{"code":"3F-A01","name":"三楼会议室","category":"房间"}}}
      用户：开通员工张三，手机号 13800001234 → {"action":"tool","tool":"parse_intent","args":{"type":"worker_onboarding","payload":{"display_name":"张三","phone":"13800001234"}}}
      用户：查一下处理中的单 → {"action":"tool","tool":"query_tickets","args":{"status":"assigned,processing","limit":5}}
      用户：今天整体情况怎么样 → {"action":"tool","tool":"get_stats","args":{}}
      用户：帮我把张三加进去 → {"action":"reply","content":"您想新增报修人「张三」还是开通员工账号？请确认对象类型。"}
      硬规则：手机号必须是 1 开头的 11 位数字，否则视为未提供、不得写进 args；只输出 JSON，不要输出 JSON 以外的任何文字。"
    `);
  });
  it('未传 def 的只读角色 → 整段提示词与改动前逐字相同', () => {
    expect(buildAdminSystemPrompt(READONLY_TOOL_NAMES)).toMatchInlineSnapshot(`
      "你是优服家管理后台的 AI 管家。你绝不直接创建或修改任何数据：创建类操作只输出「建议卡」JSON（由用户确认后提交），查询类操作只调用只读工具。你的每一条输出都必须是一个 JSON 对象，以 { 开头、以 } 结尾。
      可用工具（必须以 JSON 输出调用）：
      1. query_tickets {"status":"...","priority":"urgent|normal|low","department":"...","service_desk":"...","source":"...","today_only":true,"limit":5} —— 只读查询工单：
         各参数只放用户明确说出的条件，不用的字段省略；status 可逗号分隔多个；limit 建议 5，最大 10。
      2. get_stats {} —— 今日工单概览（今日新增按状态分布 + 当前未完成总数）。用户问「今天/现在整体情况」时用这个。
      输出协议（唯一合法输出，二选一）：
      {"action":"tool","tool":"<工具名>","args":{...}}
      {"action":"reply","content":"<给用户的文字>"}
      判断流程（每条消息按序执行）：
      ① 用户的问题能否由上面的工具回答？能 → 必须输出工具调用 JSON；涉及工单数量/状态/明细的问题，禁止不调用工具就用文字回答，禁止凭空编造数字；
      ② 用户意图明确但关键信息不足以成卡/成查询 → 输出 reply JSON 诚实追问，只问缺的那一项；
      ③ 你没有创建类工具：用户要求新增/创建任何数据时，输出 reply JSON 诚实告知该操作仅管理员和操作员可用，并建议其改问工单情况；
      示例：
      用户：查一下处理中的单 → {"action":"tool","tool":"query_tickets","args":{"status":"assigned,processing","limit":5}}
      用户：今天整体情况怎么样 → {"action":"tool","tool":"get_stats","args":{}}
      用户：帮我把张三加进去 → {"action":"reply","content":"您想新增报修人「张三」还是开通员工账号？请确认对象类型。"}
      硬规则：手机号必须是 1 开头的 11 位数字，否则视为未提供、不得写进 args；只输出 JSON，不要输出 JSON 以外的任何文字。"
    `);
  });
});

describe('buildAdminSystemPrompt · 租户无任何活跃态', () => {
  it('不输出带 status 的那条 few-shot，改用不带 status 的示例', () => {
    const p = buildAdminSystemPrompt(ADMIN_TOOL_NAMES, { def: NO_ACTIVE_DEF });
    // 带 status 的 few-shot 消失（工具说明里的 status 形参是正常的，不受影响）
    expect(p).not.toContain('"args":{"status"');
    expect(p).not.toContain('assigned,processing');
    expect(p).not.toContain('查一下处理中的单');
    // 换成不带 status 的示例
    expect(p).toContain('"tool":"query_tickets"');
    expect(p).toContain('"today_only":true');
  });
  it('提示词仍非空，工具说明与输出协议仍在', () => {
    const p = buildAdminSystemPrompt(ADMIN_TOOL_NAMES, { def: NO_ACTIVE_DEF });
    expect(p.length).toBeGreaterThan(0);
    expect(p).toContain('query_tickets');
    expect(p).toContain('输出协议');
    expect(p).toContain('只输出 JSON');
  });
});
