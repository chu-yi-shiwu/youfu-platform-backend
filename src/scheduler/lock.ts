// 跨进程调度互斥（R25-001 修复）：进程内 setInterval 调度器在多副本部署下会重复触发，
// 导致巡检计划双生成 / 模板效果双回写 / 模型重复全量重训。
// 用 PG 会话级 advisory lock 保证同一调度器全局仅一个进程执行本轮；
// 单进程部署或无可用 PG（单测）时优雅降级为放行，不改变既有单进程语义。
//
// R31-F4（2026-08-31 全维度审查修复）：会话级 advisory lock 必须在同一连接上取/放。
// 原实现用 pool.query 取/放——池化下两次调用可能落在不同连接：unlock 落在无锁连接上
// 静默失败，或锁被某个空闲池连接长期持有（泄漏）。多副本扩容后防重目标将落空。
// 修复：acquire 时从池中取专用连接并在其上取锁，连接驻留本模块直到 release 时
// 在同一连接上 unlock 后归还池；任何异常仍降级为放行（单进程语义不变）。
import type { PoolClient } from 'pg';
import pool from '../db/pool.js';

/** 每个调度器固定一个 int8 锁键（避免字符串哈希的 64-bit 越界/类型问题）。 */
const LOCK_KEYS: Record<string, number> = {
  inspection: 1,
  'template-effects': 2,
  'model-train': 3,
  sla: 4, // 拆雷三件套②：SLA 定时扫描（2026-08-31）
};

/** 已取得锁的专用连接（name → client）。锁生命周期 = 连接驻留期，保证取/放同连接。 */
const heldClients = new Map<string, PoolClient>();

/**
 * 尝试获取调度器会话锁。成功返回 true；被其他进程持有返回 false；
 * 无可用 PG / 任何异常时返回 true（放行，单进程语义不变，绝不因锁不可用而停摆）。
 */
export async function tryAcquireSchedulerLock(name: string): Promise<boolean> {
  const key = LOCK_KEYS[name];
  if (key === undefined) return true; // 未知调度器：不放行额外约束
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key],
    );
    if (rows[0]?.locked) {
      // 防御：同名调度器重复 acquire（正常不会发生——未取到锁的轮次提前 return），
      // 先归还旧连接再换新，避免连接泄漏。
      const prev = heldClients.get(name);
      if (prev && prev !== client) {
        try {
          await prev.query('SELECT pg_advisory_unlock($1)', [key]);
        } catch {
          /* ignore */
        }
        try {
          prev.release();
        } catch {
          /* ignore */
        }
      }
      heldClients.set(name, client); // 锁与连接绑定：持有期间连接不归还池
      return true;
    }
    client.release();
    return false;
  } catch {
    // 无可用 PG / 任何异常：放行（单进程语义不变，绝不因锁不可用而停摆）
    try {
      client?.release();
    } catch {
      /* ignore */
    }
    return true;
  }
}

/** 释放调度器会话锁：在取得锁的同一连接上 unlock 后归还池（R31-F4）。 */
export async function releaseSchedulerLock(name: string): Promise<void> {
  const client = heldClients.get(name);
  if (!client) return; // 未持有（含降级路径 / 未知调度器）：无事可做
  heldClients.delete(name);
  const key = LOCK_KEYS[name];
  try {
    if (key !== undefined) await client.query('SELECT pg_advisory_unlock($1)', [key]);
  } catch {
    /* ignore：连接归还池后 PG 会话结束会自动回收锁 */
  } finally {
    try {
      client.release();
    } catch {
      /* ignore */
    }
  }
}
