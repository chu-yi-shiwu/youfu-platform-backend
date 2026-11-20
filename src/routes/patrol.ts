// 二阶段 #12 巡更（最小完整版）：点位配置 + 任务逐点签到
// 语义对齐 CYCLE_CHECK_DEF（scheduled→checked/missed→closed）但按任务聚合实现：
//   pending →(checkin 逐点) in_progress →(全部签完) done；漏签由任务操作 miss 标记 missed。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import type { AuthLocals } from '../middleware/auth.js';
import { resolveWorkerIds } from '../repo/workerIdentity.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { createAlert } from './emergency.js';

import { requireModuleWrites } from '../middleware/moduleGuard.js';

const router = Router();
router.use(requireModuleWrites('patrol', { allow: [/^\/tasks\/[^/]+\/(checkin|miss)$/] }));


// ============ 巡更点（配置端） ============
// 写操作（POST/PUT/DELETE）需 requirePermission('patrol.manage')；读取维持已认证即放。
const pointSchema = z.object({
  name: z.string().min(1),
  location: z.string().optional(),
  seq: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

router.get('/points', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client.query('SELECT * FROM patrol_point WHERE tenant_id=$1 ORDER BY seq ASC, created_at ASC', [tenantId])
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) { next(e); }
});

router.post('/points', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'patrol.manage');
      const b = pointSchema.parse(req.body);
      // 12 位（≈2.8e14 组合）租户内唯一，碰撞概率可忽略；迁移 118 对历史点位回填 8 位。
      const code = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
      const r = await client.query(
        `INSERT INTO patrol_point (tenant_id, name, location, seq, enabled, checkin_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [tenantId, b.name, b.location ?? null, b.seq ?? 0, b.enabled ?? true, code],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'patrol_point', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

router.put('/points/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'patrol.manage');
      const b = pointSchema.partial().parse(req.body);
      const sets: string[] = [];
      const params: unknown[] = [tenantId, req.params.id];
      if (b.name !== undefined) { params.push(b.name); sets.push(`name = $${params.length}`); }
      if (b.location !== undefined) { params.push(b.location); sets.push(`location = $${params.length}`); }
      if (b.seq !== undefined) { params.push(b.seq); sets.push(`seq = $${params.length}`); }
      if (b.enabled !== undefined) { params.push(b.enabled); sets.push(`enabled = $${params.length}`); }
      if (!sets.length) throw new AppError('BAD_REQUEST', 'no fields to update', 400);
      params.push(new Date().toISOString());
      sets.push('updated_at = $' + params.length);
      return client.query(
        `UPDATE patrol_point SET ${sets.join(', ')} WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        params,
      ).then((r) => {
        if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'patrol point not found', 404);
        return r.rows[0];
      });
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

router.delete('/points/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const r = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'patrol.manage');
      return client.query('DELETE FROM patrol_point WHERE tenant_id=$1 AND id=$2 RETURNING id', [tenantId, req.params.id]);
    });
    if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'patrol point not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) { next(e); }
});

// ============ 巡更任务 ============
const taskSchema = z.object({
  title: z.string().min(1),
  assignee: z.string().optional(),
  point_ids: z.array(z.string().uuid()).min(1),
  note: z.string().optional(),
});

router.get('/tasks', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { assignee, status } = req.query as Record<string, string>;
    const items = await withTenantClient(tenantId, async (client) => {
      const clauses = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        clauses.push(sql.replace(/\?/g, `$${params.length}`));
      };
      // P0-9 读侧（2026-11-07）：此前任意登录账号可拉全租户巡更任务（执行人/签到记录）。
      // 口径与巡检/工单一致：worker 只按本人档案集合收口，显式 assignee 只作提示；
      // 非 worker 需 patrol.manage（默认 admin/operator，租户可显式授予）。
      // 注意：assignee 条件必须在 status 之前拼装，保持既有非 worker 的占位符顺序
      // （assignee=$2、status=$3），既有回归已按该顺序断言。
      if (auth.role === 'worker') {
        const mine = await resolveWorkerIds(client, tenantId, auth.userId);
        if (mine.length === 0) return [];
        params.push(mine);
        clauses.push(`assignee = ANY($${params.length}::text[])`);
      } else {
        await requirePermission(auth, client, 'patrol.manage');
        if (assignee) add('assignee = ?', assignee);
      }
      if (status) add('status = ?', status);
      return client
        .query(`SELECT * FROM patrol_task WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) { next(e); }
});

router.get('/tasks/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query('SELECT * FROM patrol_task WHERE tenant_id=$1 AND id=$2', [tenantId, req.params.id]);
      if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'patrol task not found', 404);
      // P0-9 读侧：详情与 checkin/miss 同口径，worker 仅本人名下，非 worker 需 patrol.manage。
      await assertPatrolTaskActor(client, tenantId, auth, r.rows[0].assignee);
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

router.post('/tasks', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'patrol.manage');
      const b = taskSchema.parse(req.body);
      const r = await client.query(
        `INSERT INTO patrol_task (tenant_id, title, assignee, point_ids, note) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [tenantId, b.title, b.assignee ?? null, b.point_ids, b.note ?? null],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'patrol_task', entityId: row.id, type: 'create', actor: res.locals.auth.role ?? 'user' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

/**
 * 巡更任务执行面守卫（P0-9，2026-11-07）。
 * worker：必须是任务 assignee（token.sub 是 account_user.id，须反查 worker.id 集合）；
 * 非 worker：需 patrol.manage（默认 admin/operator，租户可显式授予其他角色）。
 * 未指派任务对 worker 一律 403（巡更没有抢单大厅，不能自助认领）。
 */
async function assertPatrolTaskActor(
  client: any,
  tenantId: string,
  auth: AuthLocals,
  assignee: unknown,
): Promise<void> {
  if (auth.role === 'worker') {
    const owner = assignee == null ? '' : String(assignee).trim();
    const mine = await resolveWorkerIds(client, tenantId, auth.userId);
    if (!owner || !mine.includes(owner)) {
      throw new AppError('FORBIDDEN', '仅可操作分派给本人名下的巡更任务', 403);
    }
    return;
  }
  await requirePermission(auth, client, 'patrol.manage');
}

// 逐点签到（2026-11-14 方向 B）：默认必须携带点位二维码内容 `code`（证明到点）。
//   - code：服务端在任务点位集合内按码定位，命中才允许签到；写入 via='scan'。
//   - 仅 point_id：只允许 patrol.manage（现场管理员/租户授权角色）手工补签，写入 via='manual'；
//     worker 仅传 point_id → 403 SCAN_REQUIRED，堵住「在家把点位点完」。
// pending → in_progress；全部点签完 → done。
router.post('/tasks/:id/checkin', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({
      point_id: z.string().uuid().optional(),
      code: z.string().min(1).max(64).optional(),
      note: z.string().optional(),
    }).parse(req.body);
    if (!b.point_id && !b.code) throw new AppError('BAD_REQUEST', '缺少签到码或点位', 400);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query('SELECT * FROM patrol_task WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, req.params.id]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'patrol task not found', 404);
      const t = cur.rows[0];
      // P0-9（2026-11-07）：执行面归属/权限守卫。此前任意登录账号（含无关 worker）
      // 都能给别人的巡更任务签到或标记漏签，且可塞入不属于本任务的 point_id
      // 把任务永久卡在 in_progress。口径与巡检/工单一致：
      //   worker → 必须是本人名下（resolveWorkerIds 集合）；
      //   非 worker → 需 patrol.manage（默认 admin/operator；租户可授权）。
      await assertPatrolTaskActor(client, tenantId, res.locals.auth, t.assignee);
      if (t.status === 'done' || t.status === 'missed') throw new AppError('CONFLICT', `task already ${t.status}`, 409);
      let pointId = b.point_id ?? '';
      let via: 'scan' | 'manual' = 'manual';
      if (b.code) {
        const hit = await client.query(
          `SELECT id FROM patrol_point WHERE tenant_id=$1 AND checkin_code=$2 AND id = ANY($3::uuid[]) LIMIT 1`,
          [tenantId, b.code.trim().toUpperCase(), t.point_ids],
        );
        if (hit.rowCount === 0) throw new AppError('NOT_FOUND', '签到码不属于本任务或无效', 404);
        const scanned = hit.rows[0].id as string;
        if (pointId && pointId !== scanned) throw new AppError('BAD_PARAM', '点位与签到码不匹配', 422);
        pointId = scanned;
        via = 'scan';
      } else {
        // 无扫码 → 仅管理端可手工补签
        try {
          await requirePermission(res.locals.auth, client, 'patrol.manage');
        } catch (e) {
          if ((e as { status?: number }).status === 403 && res.locals.auth.role === 'worker') {
            throw new AppError('SCAN_REQUIRED', '请扫描点位二维码签到', 403);
          }
          throw e;
        }
      }
      if (!Array.isArray(t.point_ids) || !t.point_ids.includes(pointId)) {
        throw new AppError('BAD_PARAM', 'point_id 不属于该巡更任务', 422);
      }
      const checkins = Array.isArray(t.checkins) ? t.checkins : [];
      if (checkins.some((c: { point_id: string }) => c.point_id === pointId)) {
        throw new AppError('CONFLICT', 'point already checked', 409);
      }
      checkins.push({ point_id: pointId, note: b.note ?? null, at: new Date().toISOString(), via });
      const done = (t.point_ids || []).every((pid: string) => checkins.some((c: { point_id: string }) => c.point_id === pid));
      const status = done ? 'done' : 'in_progress';
      const r = await client.query(
        `UPDATE patrol_task SET status=$3, checkins=$4::jsonb, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, req.params.id, status, JSON.stringify(checkins)],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'patrol_task', entityId: row.id, type: done ? 'complete' : 'checkin', actor: res.locals.auth.role ?? 'user' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

// 漏签/异常终止：→ missed
router.post('/tasks/:id/miss', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ note: z.string().optional() }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query('SELECT * FROM patrol_task WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, req.params.id]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'patrol task not found', 404);
      // P0-9：与 checkin 同口径的归属/权限守卫（此前任意登录账号可把别人的任务标记漏签）。
      await assertPatrolTaskActor(client, tenantId, res.locals.auth, cur.rows[0].assignee);
      if (cur.rows[0].status === 'done' || cur.rows[0].status === 'missed') throw new AppError('CONFLICT', `task already ${cur.rows[0].status}`, 409);
      const r = await client.query(
        `UPDATE patrol_task SET status='missed', note=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        [tenantId, req.params.id, b.note ?? null],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'patrol_task', entityId: row.id, type: 'miss', actor: res.locals.auth.role ?? 'user' });
      // P2 飞轮：连续漏签点位检测（同一点位在 missed 任务中 ≥2 次漏签 → 生成 L2 预警，复用 alert→convert 链）
      try {
        const missed = await client.query(
          `SELECT point_ids, checkins FROM patrol_task WHERE tenant_id=$1 AND status='missed'`,
          [tenantId],
        );
        const missCount: Record<string, number> = {};
        for (const m of missed.rows) {
          const checked = new Set((Array.isArray(m.checkins) ? m.checkins : []).map((c: { point_id: string }) => c.point_id));
          (Array.isArray(m.point_ids) ? m.point_ids : []).forEach((pid: string) => {
            if (!checked.has(pid)) missCount[pid] = (missCount[pid] || 0) + 1;
          });
        }
        const anomaly = Object.keys(missCount).filter((pid) => missCount[pid] >= 2);
        if (anomaly.length) {
          const pts = await client.query('SELECT id, name FROM patrol_point WHERE tenant_id=$1 AND id = ANY($2)', [tenantId, anomaly]);
          for (const p of pts.rows) {
            await createAlert(client, tenantId, {
              source_type: 'patrol',
              source_id: p.id,
              level: 'L2',
              title: `巡更点连续漏签：${p.name}`,
              message: `该点位已连续 ${missCount[p.id]} 次漏签，建议安排巡检/检修`,
            });
          }
        }
      } catch (e) {
        console.error('[patrol] anomaly detection failed:', e); // 不阻断 miss 主流程
      }
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

export default router;
