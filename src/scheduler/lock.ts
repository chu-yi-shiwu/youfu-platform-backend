// 跨进程调度互斥（R25-001 修复）：进程内 setInterval 调度器在多副本部署下会重复触发，
// 导致巡检计划双生成 / 模板效果双回写 / 模型重复全量重训。
// 用 PG 会话级 advisory lock 保证同一调度器全局仅一个进程执行本轮；
// 单进程部署或无可用 PG（单测）时优雅降级为放行，不改变既有单进程语义。
import pool from '../db/pool.js';

/** 每个调度器固定一个 int8 锁键（避免字符串哈希的 64-bit 越界/类型问题）。 */
const LOCK_KEYS: Record<string, number> = {
  inspection: 1,
  'template-effects': 2,
  'model-train': 3,
};

/**
 * 尝试获取调度器会话锁。成功返回 true；被其他进程持有返回 false；
 * 无可用 PG / 任何异常时返回 true（放行，单进程语义不变，绝不因锁不可用而停摆）。
 */
export async function tryAcquireSchedulerLock(name: string): Promise<boolean> {
  const key = LOCK_KEYS[name];
  if (key === undefined) return true; // 未知调度器：不放行额外约束
  try {
    const { rows } = await pool.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key],
    );
    return rows[0]?.locked ?? true;
  } catch {
    return true;
  }
}

/** 释放调度器会话锁（会话结束 PG 也会自动回收，此处显式释放降低占用窗口）。 */
export async function releaseSchedulerLock(name: string): Promise<void> {
  const key = LOCK_KEYS[name];
  if (key === undefined) return;
  try {
    await pool.query('SELECT pg_advisory_unlock($1)', [key]);
  } catch {
    /* ignore */
  }
}
