// 数据飞轮断链 2 修复：全量训练真 cron 调度（G3 模式，对齐 inspectionScheduler）。
// 部署为后端进程内 setInterval（单进程部署无重复触发）；每 60s 检查是否到 03:00 低峰窗口，
// 命中则枚举「有完成态工单」的租户（SECURITY DEFINER model_train_tenants() 绕过 RLS 只读枚举），
// 逐租户 trainFromDb 重训模型（AUTO_TUNE 保持受控：仅写 model_state，不写回 dispatch_rule）。
import pool from '../db/pool.js';
import { trainFromDb } from '../services/modelTrainer.js';
import { tryAcquireSchedulerLock, releaseSchedulerLock } from './lock.js';

const TICK_MS = 60_000;
const TRAIN_HOUR = 3; // 每日 03:00 低峰
let timer: ReturnType<typeof setInterval> | null = null;
let lastRunDate = '';

/** 本地日期字符串 YYYY-MM-DD（与 getHours 同口径，避免 UTC/本地错位导致同日重训或漏训）。 */
export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shouldRunNow(): boolean {
  const now = new Date();
  // 窗口放宽到整个 03 点小时：命中且今日未跑过即触发，避免仅 minute===0 那分钟错过则当日漏训
  return now.getHours() === TRAIN_HOUR && lastRunDate !== localDateStr(now);
}

/** 单次全量训练：枚举有数据的租户 → 逐租户重训（单租户失败不影响其他）。返回训练租户数。 */
export async function runModelTrainOnce(): Promise<number> {
  // R25-001：跨进程互斥，多副本部署下仅一个进程执行整轮全量重训，防重复训练。
  if (!(await tryAcquireSchedulerLock('model-train'))) return 0;
  try {
    let tenants: { tenant_id: string }[] = [];
    try {
      const { rows } = await pool.query('SELECT tenant_id FROM model_train_tenants()');
      tenants = rows;
    } catch (e) {
      console.error('[model-train] tenant enumeration failed:', e);
      return 0;
    }
    let trained = 0;
    for (const t of tenants) {
      const client = await pool.connect();
      try {
        // 纵深防御：直连 client 默认角色非 youfu_app、RLS 不生效，隔离原本全靠 trainFromDb 显式 tenant_id。
        // 此处显式开启事务 + SET LOCAL GUC + SET LOCAL ROLE youfu_app，让 RLS 兜底，即便未来某查询漏写 tenant_id 也不会跨租户。
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.tenant_id = '${t.tenant_id.replace(/'/g, "''")}'`);
        await client.query('SET LOCAL ROLE youfu_app');
        await trainFromDb(client, t.tenant_id);
        await client.query('COMMIT');
        trained += 1;
        console.log(`[model-train] ${t.tenant_id} trained`);
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        console.error('[model-train] tenant', t.tenant_id, 'train failed:', e);
      } finally {
        client.release();
      }
    }
    if (trained > 0) console.log(`[model-train] full train done for ${trained} tenants`);
    return trained;
  } finally {
    await releaseSchedulerLock('model-train');
  }
}

export function startModelTrainScheduler(): void {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      if (shouldRunNow()) {
        lastRunDate = localDateStr(new Date());
        await runModelTrainOnce();
      }
    } catch (e) {
      console.error('[model-train] tick failed:', e);
    }
  }, TICK_MS);
  console.log(`[model-train] scheduler started (daily ${TRAIN_HOUR}:00)`);
}
