// E2 效果回写调度：复用批次 D G3 cron 模式（后端进程内 60s setInterval，单进程无重复触发风险）。
// 每 60s 扫描到期未回写的模板应用（≥7 天）→ 拉取 after 指标并评分（V3 双轮飞轮）。
import { runDueEffectRefreshes } from '../services/templateEffects.js';
import { tryAcquireSchedulerLock, releaseSchedulerLock } from './lock.js';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** 单次扫描（供手动触发/测试复用）。 */
export async function runTemplateEffectsOnce(): Promise<number> {
  if (running) return 0; // 本进程防重入（上次未完成则跳过本轮）
  // R25-001：跨进程互斥，多副本部署下仅一个进程执行本轮，防模板效果双回写。
  if (!(await tryAcquireSchedulerLock('template-effects'))) return 0;
  running = true;
  try {
    const n = await runDueEffectRefreshes();
    if (n > 0) console.log(`[template-effects] auto-refreshed ${n} due applies`);
    return n;
  } catch (e) {
    // R25-002：原 .catch(() => undefined) 静默吞掉扫描级异常（如 DB 抖动），导致调度失效不可见。
    // 此处显式记录，保留可观测性；单条刷新失败仍由 runDueEffectRefreshes 内部逐条捕获。
    console.error('[template-effects] runDueEffectRefreshes failed:', e);
    return 0;
  } finally {
    running = false;
    await releaseSchedulerLock('template-effects');
  }
}

export function startTemplateEffectsScheduler(): void {
  if (timer) return;
  // 启动后立即跑一次，之后每 60s；R25-002：外层 catch 仅作兜底（同步异常），不静默吞错。
  void runTemplateEffectsOnce().catch((e) => console.error('[template-effects] tick error:', e));
  timer = setInterval(() => {
    void runTemplateEffectsOnce().catch((e) => console.error('[template-effects] tick error:', e));
  }, TICK_MS);
  console.log('[scheduler] template effects scheduler started (tick 60s)');
}
