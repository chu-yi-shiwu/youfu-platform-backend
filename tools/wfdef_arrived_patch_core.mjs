// workflow_def 到场态（arrived）补丁 · 纯函数核心（2026-09-06 任务⑤）
//
// 背景：stateMachine.ts 的 RICH_WORK_ORDER_DEF 已支持 arrived 态（assigned 与 processing 之间），
// 但存量租户 workflow_def.def（jsonb）仍是旧图，arrived 边不生效。本模块把「判断是否需要打补丁
// + JSON 补丁」抽成零依赖纯函数，供主脚本（wfdef_arrived_patch_20260906.mjs）与 vitest 共用。
//
// 纪律（异构防御）：存量 def 异构（有的带 claim_hall/paused/suspended，巡检类 states 是
// pending/in_progress/done）→ 只对「states 同时含 assigned 与 processing 且不含 arrived」的 def
// 打补丁，且只做增量插入，绝不整体替换成 RICH 模板，绝不删除/改写既有状态与转移。
//
// 三条新增边与 src/engine/stateMachine.ts RICH_WORK_ORDER_DEF 逐字段对齐（读码写死）：
//   assigned --arrive--> arrived      allowedRoles: ['admin','worker']
//   arrived  --start-->  processing   allowedRoles: ['admin','worker']
//   arrived  --cancel--> cancelled    allowedRoles: ['admin','dispatcher'], requiredFields: ['cancel_reason']

/** 与 RICH_WORK_ORDER_DEF 对齐的三条 arrived 边（顺序即插入顺序）。 */
export const ARRIVED_TRANSITIONS = [
  { from: 'assigned', to: 'arrived', event: 'arrive', allowedRoles: ['admin', 'worker'] },
  { from: 'arrived', to: 'processing', event: 'start', allowedRoles: ['admin', 'worker'] },
  {
    from: 'arrived',
    to: 'cancelled',
    event: 'cancel',
    requiredFields: ['cancel_reason'],
    allowedRoles: ['admin', 'dispatcher'],
  },
];

/**
 * 判断一个 workflow_def 是否需要到场态补丁（纯函数可单测）。
 * 条件：def 结构完整（states/transitions 均为数组）、states 同时含 'assigned' 与 'processing'、
 * 且不含 'arrived'。巡检类图（pending/in_progress/done）等不满足 → false，不动。
 */
export function needsArrivedPatch(def) {
  if (!def || typeof def !== 'object') return false;
  if (!Array.isArray(def.states) || !Array.isArray(def.transitions)) return false;
  return def.states.includes('assigned') && def.states.includes('processing') && !def.states.includes('arrived');
}

function sameEdge(t, edge) {
  return t.from === edge.from && t.event === edge.event && t.to === edge.to;
}

/**
 * 对单个 def 做 JSON 增量补丁（纯函数、不可变入参、幂等可单测）：
 *  - needsArrivedPatch 为真 → 在 states 中 'assigned' 索引之后插入 'arrived'（其余状态顺序不动）；
 *  - 对 ARRIVED_TRANSITIONS 逐条检查 (from,event,to) 三元组，缺失才追加（字段与 RICH 定义逐字段一致）；
 *    已有部分边（如上次中断的半截补丁）只补缺，不重复插入 → 幂等；
 *  - 不满足 needsArrivedPatch 且无缺边 → 原样返回 changed=false。
 * 返回 { def: 新 def（深拷贝增量版）, changed, addedStates, addedEdges, statesBefore, statesAfter }。
 */
export function applyArrivedPatch(def) {
  const untouched = {
    def,
    changed: false,
    addedStates: 0,
    addedEdges: 0,
    statesBefore: Array.isArray(def?.states) ? [...def.states] : null,
    statesAfter: Array.isArray(def?.states) ? [...def.states] : null,
  };
  if (!def || typeof def !== 'object') return untouched;
  if (!Array.isArray(def.states) || !Array.isArray(def.transitions)) return untouched;

  // 浅拷贝容器 + 逐项拷贝 transitions（不改动入参对象）
  const next = {
    ...def,
    states: [...def.states],
    transitions: def.transitions.map((t) => (t && typeof t === 'object' ? { ...t } : t)),
  };

  let addedStates = 0;
  let addedEdges = 0;

  // 补丁候选门禁：states 同时含 assigned 与 processing 才是 work_order 形态的图
  // （巡检类 pending/in_progress/done 等异构图整体跳过——若无条件追加边，
  //   会给不含 assigned/arrived 的图塞进引用不存在状态的脏边）。
  const isWorkOrderGraph = next.states.includes('assigned') && next.states.includes('processing');

  if (isWorkOrderGraph && !next.states.includes('arrived')) {
    const idx = next.states.indexOf('assigned');
    next.states.splice(idx + 1, 0, 'arrived'); // assigned 之后插入，processing 之前
    addedStates += 1;
  }

  if (isWorkOrderGraph) {
    for (const edge of ARRIVED_TRANSITIONS) {
      // 幂等：只按 (from,event,to) 判重——若租户自定义了同三元组但不同 allowedRoles 的边，尊重现状不覆盖
      if (!next.transitions.some((t) => t && typeof t === 'object' && sameEdge(t, edge))) {
        next.transitions.push({ ...edge, allowedRoles: [...edge.allowedRoles] });
        addedEdges += 1;
      }
    }
  }

  const changed = addedStates > 0 || addedEdges > 0;
  return {
    def: next,
    changed,
    addedStates,
    addedEdges,
    statesBefore: [...def.states],
    statesAfter: [...next.states],
  };
}

/**
 * 对一批 workflow_def 行打补丁（纯函数）。
 * 行结构：{ tenant_id, entity_type, version, def }（def 可能为对象或 JSON 字符串，均兼容）。
 * 返回 { patched: [...变更行摘要], unchanged: n }，patched 元素：
 * { tenant_id, entity_type, version_before, def_before, def_after, addedStates, addedEdges, statesBefore, statesAfter }
 */
export function patchWorkflowDefRows(rows) {
  const patched = [];
  let unchanged = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    let def = row.def;
    if (typeof def === 'string') {
      try {
        def = JSON.parse(def);
      } catch {
        unchanged += 1; // 解析不了的脏数据不动、不猜（诚实留白，人工排查）
        continue;
      }
    }
    const r = applyArrivedPatch(def);
    if (!r.changed) {
      unchanged += 1;
      continue;
    }
    patched.push({
      tenant_id: row.tenant_id,
      entity_type: row.entity_type,
      version_before: row.version,
      def_before: typeof row.def === 'string' ? row.def : def,
      def_after: r.def,
      addedStates: r.addedStates,
      addedEdges: r.addedEdges,
      statesBefore: r.statesBefore,
      statesAfter: r.statesAfter,
    });
  }
  return { patched, unchanged };
}
