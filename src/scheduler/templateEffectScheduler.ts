// E2 效果回写调度：复用批次 D G3 cron 模式（后端进程内 60s setInterval，单进程无重复触发风险）。
// 每 60s 扫描到期未回写的模板应用（≥7 天）→ 拉取 after 指标并评分（V3 双轮飞轮）。
import { runDueEffectRefreshes } from '../services/templateEffects.js';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** 单次扫描（供手动触发/测试复用）。 */
export async function runTemplateEffectsOnce(): Promise<number> {
  if (running) return 0; // 防重入（上次未完成则跳过本轮）
  running = true;
  try {
    const n = await runDueEffectRefreshes();
    if (n > 0) console.log(`[template-effects] auto-refreshed ${n} due applies`);
    return n;
  } finally {
    running = false;
  }
}

export function startTemplateEffectsScheduler(): void {
  if (timer) return;
  // 启动后立即跑一次，之后每 60s
  void runTemplateEffectsOnce().catch(() => undefined);
  timer = setInterval(() => {
    void runTemplateEffectsOnce().catch(() => undefined);
  }, TICK_MS);
  console.log('[scheduler] template effects scheduler started (tick 60s)');
}
