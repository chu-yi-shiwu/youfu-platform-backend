// 二阶段 #12 巡更（最小完整版）：点位配置 + 任务逐点签到
// 语义对齐 CYCLE_CHECK_DEF（scheduled→checked/missed→closed）但按任务聚合实现：
//   pending →(checkin 逐点) in_progress →(全部签完) done；漏签由任务操作 miss 标记 missed。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { createAlert } from './emergency.js';

const router = Router();

// ============ 巡更点（配置端） ============
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
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = pointSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO patrol_point (tenant_id, name, location, seq, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [tenantId, b.name, b.location ?? null, b.seq ?? 0, b.enabled ?? true],
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
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
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
    const item = await withTenantClient(tenantId, (client) =>
      client.query(
        `UPDATE patrol_point SET ${sets.join(', ')} WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        params,
      ).then((r) => {
        if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'patrol point not found', 404);
        return r.rows[0];
      }),
    );
    return res.json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

router.delete('/points/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const r = await withTenantClient(tenantId, (client) =>
      client.query('DELETE FROM patrol_point WHERE tenant_id=$1 AND id=$2 RETURNING id', [tenantId, req.params.id]),
    );
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
    const tenantId = res.locals.auth.tenantId;
    const { assignee, status } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => { params.push(v); clauses.push(sql.replace(/\?/g, `$${params.length}`)); };
    if (assignee) add('assignee = ?', assignee);
    if (status) add('status = ?', status);
    const items = await withTenantClient(tenantId, (client) =>
      client.query(`SELECT * FROM patrol_task WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) { next(e); }
});

router.get('/tasks/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, (client) =>
      client.query('SELECT * FROM patrol_task WHERE tenant_id=$1 AND id=$2', [tenantId, req.params.id])
        .then((r) => {
          if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'patrol task not found', 404);
          return r.rows[0];
        }),
    );
    return res.json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

router.post('/tasks', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = taskSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
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

// 逐点签到：pending → in_progress；全部点签完 → done（签到记录 JSON 追加）
router.post('/tasks/:id/checkin', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ point_id: z.string().uuid(), note: z.string().optional() }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query('SELECT * FROM patrol_task WHERE tenant_id=$1 AND id=$2', [tenantId, req.params.id]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'patrol task not found', 404);
      const t = cur.rows[0];
      if (t.status === 'done' || t.status === 'missed') throw new AppError('CONFLICT', `task already ${t.status}`, 409);
      const checkins = Array.isArray(t.checkins) ? t.checkins : [];
      if (checkins.some((c: { point_id: string }) => c.point_id === b.point_id)) {
        throw new AppError('CONFLICT', 'point already checked', 409);
      }
      checkins.push({ point_id: b.point_id, note: b.note ?? null, at: new Date().toISOString() });
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
      const cur = await client.query('SELECT * FROM patrol_task WHERE tenant_id=$1 AND id=$2', [tenantId, req.params.id]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'patrol task not found', 404);
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
