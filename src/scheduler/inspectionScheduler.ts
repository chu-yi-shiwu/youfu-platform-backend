// 巡检周期计划真 cron 调度（G3 后续增强落地）。
// 部署为后端进程内的 setInterval（单进程部署，无重复触发风险）；每 60s 扫描一次到期计划。
// 跨租户枚举走 SECURITY DEFINER 函数 inspection_due_plan_tenants()（绕过 RLS 只读枚举），
// 逐租户调用 runDuePlansForTenant 复用既有生成逻辑（RLS 隔离保持不变）。
import pool from '../db/pool.js';
import { runDuePlansForTenant } from '../routes/inspection.js';
import { tryAcquireSchedulerLock, releaseSchedulerLock } from './lock.js';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false; // 防重入：单次扫描超过 tick 间隔时避免叠加执行

export async function runInspectionSchedulerOnce(): Promise<number> {
  if (running) return 0; // 本进程上次未完成则跳过本轮
  // R25-001：跨进程互斥，多副本部署下仅一个进程执行本轮，防巡检计划双生成。
  if (!(await tryAcquireSchedulerLock('inspection'))) return 0;
  running = true;
  try {
    const { rows } = await pool.query('SELECT tenant_id FROM inspection_due_plan_tenants()');
    let total = 0;
    for (const r of rows) {
      try {
        total += await runDuePlansForTenant(r.tenant_id);
      } catch (e) {
        console.error('[scheduler] tenant', r.tenant_id, 'due-plan run failed:', e);
      }
    }
    if (total > 0) console.log(`[scheduler] inspection auto-generated ${total} tasks`);
    return total;
  } catch (e) {
    console.error('[scheduler] tick failed (enumeration):', e);
    return 0;
  } finally {
    running = false;
    await releaseSchedulerLock('inspection');
  }
}

export function startInspectionScheduler(): void {
  if (timer) return; // 幂等：避免重复启动
  // 启动即跑一次，随后每 60s
  runInspectionSchedulerOnce();
  timer = setInterval(runInspectionSchedulerOnce, TICK_MS);
  console.log('[scheduler] inspection scheduler started (tick 60s)');
}

export function stopInspectionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
