// 资产报障流程可达性预检（2026-11-20）
// 问题不是“主站和 pilot 流程不同”，而是配置缺边会让资产维修工单无法取消/完成。
// 本函数只读流程定义，输出可发布性结论，不在运行时代码里硬编码租户状态。
import type { WorkflowDef } from '../engine/stateMachine.js';

export interface WorkflowReadiness {
  ok: boolean;
  initial: string;
  reachable_states: string[];
  cancel_from: string[];
  done_from: string[];
  issues: Array<{ code: string; message: string }>;
}

export function analyzeWorkflowReadiness(def: WorkflowDef): WorkflowReadiness {
  const initial = def.initial;
  const transitions = Array.isArray(def.transitions) ? def.transitions : [];
  const states = new Set<string>(Array.isArray(def.states) ? def.states : []);
  const issues: WorkflowReadiness['issues'] = [];

  if (!initial || !states.has(initial)) {
    issues.push({ code: 'BAD_INITIAL', message: `初始状态 ${initial || '(空)'} 不在 states 中` });
  }

  // BFS：只认可从初始状态实际可达的边，避免“定义里有一堆状态但业务走不到”。
  const reachable = new Set<string>();
  const queue = [initial];
  while (queue.length > 0) {
    const from = queue.shift()!;
    if (reachable.has(from)) continue;
    reachable.add(from);
    for (const t of transitions) {
      if (t.from === from && !reachable.has(t.to)) queue.push(t.to);
    }
  }

  const cancelTransitions = transitions.filter(
    (t) => reachable.has(t.from) && (t.to === 'cancelled' || t.event === 'cancel'),
  );
  const doneSet = new Set(
    Array.isArray(def.config?.doneStates) && def.config.doneStates.length > 0
      ? def.config.doneStates
      : ['completed', 'closed', 'evaluated'],
  );
  const doneTransitions = transitions.filter((t) => reachable.has(t.from) && doneSet.has(t.to));

  if (cancelTransitions.length === 0) {
    issues.push({
      code: 'NO_CANCEL_PATH',
      message: '从初始状态可达的范围内不存在取消边：资产报障生成的工单取消后无法回写资产',
    });
  }
  if (doneTransitions.length === 0) {
    issues.push({
      code: 'NO_DONE_PATH',
      message: '从初始状态可达的范围内不存在完成态：资产维修无法闭环回写',
    });
  }

  return {
    ok: issues.length === 0,
    initial,
    reachable_states: [...reachable],
    cancel_from: [...new Set(cancelTransitions.map((t) => t.from))],
    done_from: [...new Set(doneTransitions.map((t) => `${t.from}->${t.to}`))],
    issues,
  };
}
