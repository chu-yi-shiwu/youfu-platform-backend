// 志愿者模块（批次 B · PRD §6.5）：活动 + 报名记录（状态机 + 服务时长 + 积分）。
// 风格对齐 config.ts；V1 批次（20260911）收口：
//   ① 守卫迁移：管理/读守卫改 requirePermission（volunteer.view / volunteer.manage / volunteer.audit），
//      因需查 role_permission 表（async），守卫调用一律在 withTenantClient 闭包内 await（RLS 纪律）；
//      GET /activities 保持仅登录（mp 报名入口依赖）；
//   ② signup 新增去重守卫：同 (activity_id, user_name) 命中 → 409 DUPLICATE「您已报名过该活动，无需重复报名」；
//   ③ GET /activities 补 signup_count（COUNT 子查询，供 mp/FE 展示"已报 X / 名额 Y"）；
//   ④ serving 死状态移除：报名记录状态机四态 registered → checked_in → checked_out → approved
//      （无任何 API 可置入 serving；FE/mp 的 serving 映射键保留为只读兼容，历史脏数据展示不炸）。
// B1 统一事件总线：关键业务动作 emit domain_event（过程挖掘统一数据源）。
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { insertNotification } from '../services/notify.js';
import { csvHeader, csvRowLine, csvDateTime, type CsvField } from '../services/csvUtil.js';

import { requireModuleWrites } from '../middleware/moduleGuard.js';

const router = Router();
router.use(requireModuleWrites('volunteer', { allow: [/^\/activities\/[^/]+\/signup$/, /^\/checkin-by-code$/, /^\/records\/[^/]+\/(checkin|checkout)$/, /^\/records\/[^/]+$/] }));


// 签到开放窗口：活动开始前 2 小时；结束后的补签宽限沿用 CHECKIN_GRACE_MS。
const CHECKIN_EARLY_MS = 2 * 60 * 60 * 1000;

function newCheckinCode(): string {
  return `V${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

async function ensureCheckinCode(client: any, tenantId: string, row: any): Promise<string> {
  if (row?.checkin_code) return String(row.checkin_code);
  const code = newCheckinCode();
  await client.query(`UPDATE volunteer_activity SET checkin_code=$3 WHERE id=$1 AND tenant_id=$2`, [row.id, tenantId, code]);
  row.checkin_code = code;
  return code;
}

async function getPointsPerHour(client: any, tenantId: string): Promise<number> {
  const r = await client.query(`SELECT value FROM system_config WHERE tenant_id=$1 AND key='volunteer_points_per_hour' LIMIT 1`, [tenantId]);
  const n = Number(r.rows[0]?.value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 1;
}


function withEffectiveStatus<T extends { status?: string; end_at?: string | Date | null }>(row: T): T & { effective_status?: string } {
  if (!row) return row as any;
  const ended = row.end_at && new Date(row.end_at).getTime() < Date.now();
  return { ...row, effective_status: row.status === 'open' && ended ? 'ended' : row.status };
}

// ============ 活动 ============
const activitySchema = z.object({
  title: z.string().min(1),
  batch: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  start_at: z.string().nullable().optional(),
  end_at: z.string().nullable().optional(),
  // P0 志愿者最小修（2026-11-04）：默认 1。
  // 原默认 0 会建出「signup_count(0) >= slots(0)」的永久满员活动，发布者不填名额
  // 就等于发布了一个谁都不能报名的活动（FE 已在 V2-UX 改成默认 1，后端必须同口径）。
  slots: z.number().int().min(0).default(1),
  // E-6/V2-D（083 迁移）：三新列透出。signup_deadline 可选，若与 end_at 同给必须早于 end_at（路由内校验）。
  user_id: z.string().nullable().optional(),
  signup_deadline: z.string().nullable().optional(),
  cancel_deadline: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

// V2-UX D8（20260912）：服务端时间区间兜底校验——API 直调可绕过 mp/FE 前端校验，
// end_at ≤ start_at 一律 422 INVALID_RANGE。与 mp 前端 S1 校验同文案口径「结束时间必须晚于开始时间」。
function assertValidRange(startAt?: string | null, endAt?: string | null): void {
  if (startAt && endAt && new Date(endAt) <= new Date(startAt)) {
    throw new AppError('INVALID_RANGE', '结束时间必须晚于开始时间', 422);
  }
}

// 设计口径锁定（修复批次 X-8 审计后声明，防后人误补墙打崩 worker 报名页）：
// GET /activities **有意不挂权限墙**——登录即可读（G1 设计=全角色可报名，volunteerPerm.http.test.ts
// 用例「⑤ GET /activities 保持仅登录 → 200」已锚定）。mp worker 报名页（volunteer.js）与
// profile/workbench 志愿入口依赖此端点，worker 默认矩阵无 volunteer.view，挂墙即 403 断报名。
// 管理面（GET stats/people/records + 全部写操作）由 volunteer.view / volunteer.manage /
// volunteer.audit 三权限点管控（本文件其余路由）。
router.get('/activities', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    // V1：补 signup_count 子查询（不暴露 records 明细，仅人数），mp/FE 展示"已报 X / 名额 Y"。
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT a.id, a.title, a.batch, a.location, a.start_at, a.end_at, a.slots, a.status, a.created_at,
                  a.user_id, a.signup_deadline, a.cancel_deadline, a.description, a.checkin_code,
                  (SELECT COUNT(*)::int FROM volunteer_record vr WHERE vr.tenant_id = a.tenant_id AND vr.activity_id = a.id) AS signup_count
           FROM volunteer_activity a WHERE a.tenant_id = $1 ORDER BY a.created_at DESC`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items: items.map((x: any) => withEffectiveStatus(x)) });
  } catch (e) {
    next(e);
  }
});

// 活动详情（P2）：含报名人数与 effective_status（open/closed/ended）。
router.get('/activities/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `SELECT a.*, (SELECT COUNT(*)::int FROM volunteer_record vr WHERE vr.tenant_id=a.tenant_id AND vr.activity_id=a.id) AS signup_count
         FROM volunteer_activity a WHERE a.id=$1 AND a.tenant_id=$2`,
        [req.params.id, tenantId],
      );
      const row = r.rows[0] ?? null;
      if (row) await ensureCheckinCode(client, tenantId, row);
      return row;
    });
    if (!item) throw new AppError('NOT_FOUND', 'activity not found', 404);
    return res.json({ ok: true, code: 0, item: withEffectiveStatus(item) });
  } catch (e) {
    next(e);
  }
});

// 报名名单导出（P2）：CSV 中文表头；管理面 volunteer.view。
router.get('/activities/:id/export', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const data = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'volunteer.view');
      const act = await client.query(`SELECT title FROM volunteer_activity WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (act.rowCount === 0) throw new AppError('NOT_FOUND', 'activity not found', 404);
      const rows = await client.query(
        `SELECT user_name, status, check_in_at, check_out_at, duration_min, points, check_in_late
         FROM volunteer_record WHERE tenant_id=$1 AND activity_id=$2 ORDER BY created_at ASC`,
        [tenantId, req.params.id],
      );
      return { title: act.rows[0].title, rows: rows.rows };
    });
    const statusCn: Record<string, string> = { registered: '已报名', checked_in: '已签到', checked_out: '已签退', approved: '已认定' };
    const fields: CsvField[] = [
      { key: 'user_name', label: '姓名' },
      { key: 'status', label: '状态', export: (r) => statusCn[r.status] || r.status },
      { key: 'check_in_at', label: '签到时间', export: (r) => csvDateTime(r.check_in_at) },
      { key: 'check_out_at', label: '签退时间', export: (r) => csvDateTime(r.check_out_at) },
      { key: 'duration_min', label: '服务时长（分钟）' },
      { key: 'points', label: '积分' },
      { key: 'check_in_late', label: '补签', export: (r) => (r.check_in_late ? '是' : '否') },
    ];
    const lines = [csvHeader(fields), ...data.rows.map((r: any) => csvRowLine(r, fields))];
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="volunteer_${req.params.id.slice(0, 8)}.csv"`);
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

router.post('/activities', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = activitySchema.parse(req.body);
    // V2-UX D8：parse 后、入库前兜底（行为等价 zod refine）
    assertValidRange(b.start_at, b.end_at);
    // E-6/V2-D：signup_deadline 业务校验——与 end_at 同给时必须早于 end_at（报名截止不能晚于活动结束）
    if (b.signup_deadline && b.end_at && new Date(b.signup_deadline) >= new Date(b.end_at)) {
      throw new AppError('INVALID_RANGE', '报名截止时间必须早于活动结束时间', 422);
    }
    const item = await withTenantClient(tenantId, async (client) => {
      // V1 守卫迁移：requirePermission 需查 role_permission 表（async），必须用闭包内 client。
      await requirePermission(res.locals.auth, client, 'volunteer.manage');
      const checkinCode = newCheckinCode();
      const r = await client.query(
        `INSERT INTO volunteer_activity (tenant_id, title, batch, location, start_at, end_at, slots, status, user_id, signup_deadline, cancel_deadline, description, checkin_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,$12) RETURNING *`,
        [tenantId, b.title, b.batch ?? null, b.location ?? null, b.start_at ?? null, b.end_at ?? null, b.slots, b.user_id ?? null, b.signup_deadline ?? null, b.cancel_deadline ?? null, b.description ?? null, checkinCode],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_activity', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 活动编辑（P1）：可改标题/批次/地点/起止/名额/报名截止/说明。
// 名额不能小于已报名人数；起止时间按现有 INVALID_RANGE 口径校验。
const activityUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  batch: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  start_at: z.string().nullable().optional(),
  end_at: z.string().nullable().optional(),
  slots: z.number().int().min(0).optional(),
  signup_deadline: z.string().nullable().optional(),
  cancel_deadline: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
});

router.put('/activities/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = activityUpdateSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'volunteer.manage');
      const cur = await client.query(`SELECT * FROM volunteer_activity WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'activity not found', 404);
      const old = cur.rows[0];
      const startAt = b.start_at !== undefined ? b.start_at : old.start_at;
      const endAt = b.end_at !== undefined ? b.end_at : old.end_at;
      assertValidRange(startAt ?? undefined, endAt ?? undefined);
      if (b.slots !== undefined) {
        const cnt = await client.query(`SELECT count(*)::int n FROM volunteer_record WHERE tenant_id=$1 AND activity_id=$2`, [tenantId, req.params.id]);
        if (b.slots < (cnt.rows[0]?.n ?? 0)) {
          throw new AppError('SLOTS_TOO_SMALL', `名额不能小于已报名人数（当前 ${cnt.rows[0]?.n ?? 0}）`, 409);
        }
      }
      const sets: string[] = [];
      const params: unknown[] = [req.params.id, tenantId];
      const put = (col: string, v: unknown) => { params.push(v); sets.push(`${col}=$${params.length}`); };
      for (const key of ['title', 'batch', 'location', 'start_at', 'end_at', 'slots', 'signup_deadline', 'cancel_deadline', 'description', 'user_id'] as const) {
        if (b[key] !== undefined) put(key, b[key]);
      }
      if (sets.length === 0) return old;
      const notifyKeys = ['title', 'start_at', 'end_at', 'location', 'slots', 'cancel_deadline'] as const;
      const changed = notifyKeys.some((k) => b[k] !== undefined && String(b[k] ?? '') !== String((old as any)[k] ?? ''));
      const r = await client.query(
        `UPDATE volunteer_activity SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        params,
      );
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_activity', entityId: req.params.id, type: 'update', actor: 'config_role' });
      const row = r.rows[0];
      // 变更通知（P2 增强）：只通知已报名且能映射到 worker 档案的人，站内信，不触发微信。
      if (changed) {
        const names = (await client.query(
          `SELECT DISTINCT user_name FROM volunteer_record WHERE tenant_id=$1 AND activity_id=$2`,
          [tenantId, req.params.id],
        )).rows.map((x: any) => String(x.user_name)).filter(Boolean);
        if (names.length) {
          const workers = await client.query(
            `SELECT id FROM worker WHERE tenant_id=$1 AND name = ANY($2::text[])`,
            [tenantId, names],
          );
          for (const w of workers.rows) {
            await insertNotification(client, {
              tenantId,
              recipient: String(w.id),
              recipientKind: 'worker',
              type: 'volunteer_activity_update',
              workOrderId: req.params.id,
              title: '志愿活动变更通知',
              body: `${row.title} 已更新，请查看最新时间/地点/名额。`,
              payload: { activity_id: row.id, entity_type: 'volunteer_activity', page: `/pages/worker/volunteer-detail/volunteer-detail?id=${row.id}` },
              channel: 'in_app',
            });
          }
        }
      }
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 活动删除（P1）：无报名记录才允许硬删；有记录返回 409，避免误删历史。
router.delete('/activities/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const result = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'volunteer.manage');
      const cur = await client.query(`SELECT id FROM volunteer_activity WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'activity not found', 404);
      const cnt = await client.query(`SELECT count(*)::int n FROM volunteer_record WHERE tenant_id=$1 AND activity_id=$2`, [tenantId, req.params.id]);
      if ((cnt.rows[0]?.n ?? 0) > 0) {
        throw new AppError('HAS_RECORDS', `活动已有 ${cnt.rows[0].n} 条报名记录，不能删除；请先取消报名或关闭活动`, 409);
      }
      await client.query(`DELETE FROM volunteer_activity WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_activity', entityId: req.params.id, type: 'delete', actor: 'config_role' });
      return true;
    });
    return res.json({ ok: true, code: 0, deleted: result });
  } catch (e) {
    next(e);
  }
});

// 取消报名（P1）：仅 registered 可取消；本人或 volunteer.manage 可操作。
router.delete('/records/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM volunteer_record WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'record not found', 404);
      const rec = cur.rows[0];
      const auth = res.locals.auth;
      let allowed = false;
      if (auth.role === 'worker' && auth.userId) {
        const self = await client.query(
          `SELECT 1 FROM worker WHERE tenant_id=$1 AND (account_id=$2 OR id=$2) AND name=$3 LIMIT 1`,
          [tenantId, auth.userId, rec.user_name],
        );
        allowed = (self.rowCount ?? 0) > 0;
      }
      if (!allowed) await requirePermission(auth, client, 'volunteer.manage');
      if (rec.status !== 'registered') {
        throw new AppError('BAD_STATE', '只能取消「已报名」状态的记录；已签到/签退记录不能取消', 409);
      }
      const act = await client.query(
        `SELECT cancel_deadline FROM volunteer_activity WHERE id=$1 AND tenant_id=$2`,
        [rec.activity_id, tenantId],
      );
      const cd = act.rows[0]?.cancel_deadline;
      if (cd && Date.now() > new Date(cd).getTime()) {
        throw new AppError('CANCEL_CLOSED', '已过取消报名截止时间，无法取消', 409);
      }
      await client.query(`DELETE FROM volunteer_record WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: req.params.id, type: 'cancel_signup', actor: auth.role ?? 'user' });
      return rec;
    });
    return res.json({ ok: true, code: 0, deleted: 1, item });
  } catch (e) {
    next(e);
  }
});

// P1：活动关闭/重开端点（审查报告 20260908 P1 项）。status 仅 open|closed 双态；
// 关闭后 signup 端点既有守卫（status!=='open' → 409"活动已关闭"）自然生效，无需重复校验。
// 幂等：对同值重放直接 UPDATE 成功（不 409，管理端按钮可重复点）。
router.put('/activities/:id/status', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ status: z.enum(['open', 'closed']) }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      // V1 守卫迁移：闭包内权限判定（role_permission 表查询）。
      await requirePermission(res.locals.auth, client, 'volunteer.manage');
      const r = await client.query(
        `UPDATE volunteer_activity SET status = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id, title, status`,
        [req.params.id, tenantId, b.status],
      );
      if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'activity not found', 404);
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'volunteer_activity',
        entityId: req.params.id,
        type: b.status === 'closed' ? 'close' : 'reopen',
        actor: 'config_role',
      });
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.get('/activities/:id/records', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      // V1：报名明细属管理面数据，收口 volunteer.view（原仅登录）。
      await requirePermission(res.locals.auth, client, 'volunteer.view');
      return client
        .query(
          `SELECT id, activity_id, user_id, user_name, status, check_in_at, check_out_at, duration_min, points, check_in_late, created_at
           FROM volunteer_record WHERE tenant_id = $1 AND activity_id = $2 ORDER BY created_at ASC`,
          [tenantId, req.params.id],
        )
        .then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 报名（普通用户即可，仅登录；V1 新增去重守卫）
router.post('/activities/:id/signup', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ user_name: z.string().min(1).optional() }).parse(req.body);
    const auth = res.locals.auth;
    if (!auth.userId) throw new AppError('UNAUTHORIZED', '登录后才能报名', 401);
    const item = await withTenantClient(tenantId, async (client) => {
      const acc = await client.query(
        `SELECT display_name, username FROM account_user WHERE id=$1 AND tenant_id=$2 AND active=true`,
        [auth.userId, tenantId],
      );
      if (acc.rowCount === 0) throw new AppError('UNAUTHORIZED', '账号不存在或已停用', 401);
      const userName = (b.user_name ?? '').trim() || acc.rows[0].display_name || acc.rows[0].username;
      const act = await client.query(
        // P0 志愿者最小修（2026-11-04）：signup_deadline 是 083 迁移已有的列，
        // 但报名路径从未校验它 —— 发布者配置的「报名截止」形同虚设，过了截止仍可报名。
        `SELECT id, status, slots, end_at, signup_deadline FROM volunteer_activity WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, tenantId],
      );
      if (act.rowCount === 0) throw new AppError('NOT_FOUND', 'activity not found', 404);
      // ⚠️ 逐字契约：小程序按子串「已关闭」分流（worker/volunteer.js handleSignupError）；改动须同步两端页面 + volunteerGuard.http.test.ts ①/⑫
      if (act.rows[0].status !== 'open') throw new AppError('BAD_STATE', '活动已关闭，无法报名', 409);
      // V2-UX F6/D5（20260912）：end_at 过期守卫——置于 status 检查之后、去重之前。
      // D5 顺序成文：status 优先于 end_at（closed 活动对外永远提示"已截止"，与 V1 口径一致；
      // 即使 end_at 同时已过，也只提示"已关闭"），后续守卫（去重/名额）在其之后。
      // end_at 为 null 放行（S7 存量兼容：历史活动从未填过结束时间，不得一刀切误杀）。
      const endAt = act.rows[0].end_at;
      if (endAt !== null && endAt !== undefined && new Date(endAt) < new Date()) {
        // ⚠️ 逐字契约：小程序按子串「已结束」分流；改动须同步两端页面 + volunteerGuard.http.test.ts ⑪
        throw new AppError('ACTIVITY_ENDED', '该活动已结束，无法报名', 409);
      }
      // P0 志愿者最小修（2026-11-04）：报名截止时间校验。
      // 顺序：status → end_at → signup_deadline（截止时间通常早于活动结束，二者都过则分别提示）。
      // null/undefined 放行（S7 存量兼容：历史活动未填截止时间，不得一刀切误杀）。
      // 文案含「已截止」——小程序 handleSignupError 按该子串分流到「该活动已截止报名」。
      const signupDeadline = act.rows[0].signup_deadline;
      if (signupDeadline !== null && signupDeadline !== undefined && new Date(signupDeadline) < new Date()) {
        throw new AppError('SIGNUP_CLOSED', '报名已截止，无法报名', 409);
      }
      // 黑名单（增强）：与报名同事务校验，避免被并发绕过。
      const black = await client.query(
        `SELECT 1 FROM volunteer_blacklist WHERE tenant_id=$1 AND (user_id=$2 OR (user_id IS NULL AND user_name=$3)) LIMIT 1`,
        [tenantId, auth.userId, userName],
      );
      if ((black.rowCount ?? 0) > 0) {
        throw new AppError('BLACKLISTED', '您已被列入志愿者黑名单，无法报名', 403);
      }
      // V1 去重守卫（置于状态检查之后：closed 活动对外永远提示"已截止"，口径唯一；
      // 已报名者优先收"已报名"语义——比"名额已满"更准确）。判重键 user_name 文本为 V1 接受项（V2 挂 user_id 列）。
      const dup = await client.query(
        `SELECT id FROM volunteer_record WHERE tenant_id = $1 AND activity_id = $2 AND (user_id = $3 OR (user_id IS NULL AND user_name = $4)) LIMIT 1`,
        [tenantId, req.params.id, auth.userId, userName],
      );
      if (dup.rowCount && dup.rowCount > 0) {
        // ⚠️ 逐字契约：小程序按子串「已报名过」分流；改动须同步两端页面 + volunteerGuard.http.test.ts ⑧
        throw new AppError('DUPLICATE', '您已报名过该活动，无需重复报名', 409);
      }
      const cnt = await client.query(
        `SELECT count(*)::int AS n FROM volunteer_record WHERE activity_id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      // ⚠️ 逐字契约：小程序按子串「名额已满」分流；改动须同步两端页面 + volunteerGuard.http.test.ts ②/③
      if (cnt.rows[0].n >= act.rows[0].slots) throw new AppError('BAD_STATE', '报名名额已满', 409);
      const r = await client.query(
        `INSERT INTO volunteer_record (tenant_id, activity_id, user_id, user_name, status) VALUES ($1,$2,$3,$4,'registered') RETURNING *`,
        [tenantId, req.params.id, auth.userId, userName],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'signup', actor: 'user' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 签退时长/积分计算（纯函数便于单测）：时长向下取整到分钟，积分 = floor(分钟/60)
export function computeCheckout(checkInAt: string | Date, checkOutAt: string | Date, pointsPerHour = 1): { duration_min: number; points: number } {
  const ms = new Date(checkOutAt).getTime() - new Date(checkInAt).getTime();
  const durationMin = ms > 0 ? Math.floor(ms / 60000) : 0;
  const rate = Number.isFinite(pointsPerHour) && pointsPerHour >= 0 ? pointsPerHour : 1;
  return { duration_min: durationMin, points: Math.floor((durationMin / 60) * rate) };
}

// D-2 补签宽限期（P3-4，初一拍板"过期 3 天内可补签"2026-09-12）：
// 以活动 end_at（自然过期时刻）起算，≤3 天允许补签但留痕 check_in_late=true；>3 天 409 拒。
export const CHECKIN_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

// 志愿者自助执行守卫（2026-11-13）：
// 报名记录按 user_name 归属；工人本人应能对自己的报名做「签退」，
// 管理员/运营仍走 volunteer.audit。
// 2026-11-14 收紧：签到不再走本守卫——本人只能扫码签到（/checkin-by-code），
// 本守卫仅服务 /records/:id/checkout，避免「点按钮直接签到」绕过在场校验。
// 归属判定 = 当前登录账号关联的 worker.name 与 record.user_name 完全一致；
// 不满足再走 volunteer.audit（自定义角色仍可按权限点放行）。
async function assertVolunteerExec(
  client: any,
  auth: { tenantId: string; role?: string; userId?: string },
  recordUserName: string,
  recordUserId?: string | null,
): Promise<void> {
  if (auth.role === 'worker' && auth.userId) {
    // 新记录优先用稳定 account_user.id；旧记录才回退 worker.name 匹配。
    if (recordUserId && recordUserId === auth.userId) return;
    const self = await client.query(
      `SELECT 1 FROM worker WHERE tenant_id=$1 AND (account_id=$2 OR id=$2) AND name=$3 LIMIT 1`,
      [auth.tenantId, auth.userId, recordUserName],
    );
    if ((self.rowCount ?? 0) > 0) return;
  }
  await requirePermission(auth as any, client, 'volunteer.audit');
}

// GET /volunteer/my-records —— 当前登录工人的报名记录（mp 自助签到/签退数据源）。
// 只按本人 worker.name 查，不暴露他人记录；无工人档案返回空数组（operator/admin 常态）。
router.get('/my-records', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const items = await withTenantClient(auth.tenantId, async (client) => {
      if (!auth.userId) return [];
      const w = await client.query(
        `SELECT name FROM worker WHERE tenant_id=$1 AND (account_id=$2 OR id=$2) LIMIT 1`,
        [auth.tenantId, auth.userId],
      );
      const name = w.rows[0]?.name ?? null;
      const r = await client.query(
        `SELECT r.id, r.activity_id, r.user_id, r.user_name, r.status, r.check_in_at, r.check_out_at,
                r.duration_min, r.points, r.check_in_late,
                a.title, a.start_at, a.end_at, a.location, a.status AS activity_status
           FROM volunteer_record r
           JOIN volunteer_activity a ON a.id = r.activity_id AND a.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1
            AND (r.user_id = $2 OR (r.user_id IS NULL AND $3::text IS NOT NULL AND r.user_name = $3))
          ORDER BY a.start_at DESC NULLS LAST, r.created_at DESC`,
        [auth.tenantId, auth.userId, name],
      );
      return r.rows;
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 积分规则（增强）：默认 1 分/小时；租户可配置 0~100。
router.get('/points-rule', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const points = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'volunteer.view');
      return getPointsPerHour(client, tenantId);
    });
    return res.json({ ok: true, code: 0, points_per_hour: points });
  } catch (e) { next(e); }
});

router.put('/points-rule', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ points_per_hour: z.number().min(0).max(100) }).parse(req.body);
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'volunteer.manage');
      await client.query(
        `INSERT INTO system_config (tenant_id,key,value,updated_at,updated_by)
         VALUES ($1,'volunteer_points_per_hour',$2,now(),$3)
         ON CONFLICT (tenant_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
        [tenantId, String(b.points_per_hour), res.locals.auth.username ?? null],
      );
    });
    return res.json({ ok: true, code: 0, points_per_hour: b.points_per_hour });
  } catch (e) { next(e); }
});

// 黑名单（增强）：按姓名；报名时命中 → 403 BLACKLISTED。
router.get('/blacklist', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'volunteer.view');
      return client.query(`SELECT id,user_id,user_name,reason,created_at FROM volunteer_blacklist WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]).then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) { next(e); }
});

router.post('/blacklist', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ user_name: z.string().min(1), user_id: z.string().uuid().optional(), reason: z.string().optional() }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'volunteer.manage');
      let userId = b.user_id ?? null;
      if (!userId) {
        const u = await client.query(
          `SELECT account_id FROM worker WHERE tenant_id=$1 AND name=$2 AND account_id IS NOT NULL
            GROUP BY account_id HAVING count(*) = 1 LIMIT 1`,
          [tenantId, b.user_name],
        );
        userId = u.rows[0]?.account_id ?? null;
      }
      const r = await client.query(
        `INSERT INTO volunteer_blacklist (tenant_id,user_id,user_name,reason)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id,user_name) DO UPDATE SET user_id=COALESCE(EXCLUDED.user_id,volunteer_blacklist.user_id), reason=EXCLUDED.reason
         RETURNING id,user_id,user_name,reason,created_at`,
        [tenantId, userId, b.user_name, b.reason ?? null],
      );
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_blacklist', entityId: r.rows[0].id, type: 'add', actor: 'config_role' });
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

router.delete('/blacklist/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const deleted = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'volunteer.manage');
      const r = await client.query(`DELETE FROM volunteer_blacklist WHERE id=$1 AND tenant_id=$2 RETURNING id`, [req.params.id, tenantId]);
      if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'blacklist entry not found', 404);
      return true;
    });
    return res.json({ ok: true, code: 0, deleted });
  } catch (e) { next(e); }
});

// 扫码签到（增强）：二维码内容 = checkin_code；本人报名记录命中后签到。
router.post('/checkin-by-code', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ code: z.string().min(1) }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const w = await client.query(`SELECT id,name FROM worker WHERE tenant_id=$1 AND (account_id=$2 OR id=$2) LIMIT 1`, [tenantId, res.locals.auth.userId]);
      if (w.rowCount === 0) throw new AppError('NOT_FOUND', 'worker not found', 404);
      const act = await client.query(`SELECT * FROM volunteer_activity WHERE tenant_id=$1 AND checkin_code=$2 AND status='open' LIMIT 1`, [tenantId, b.code.trim().toUpperCase()]);
      if (act.rowCount === 0) throw new AppError('NOT_FOUND', '签到码无效或活动已关闭', 404);
      const activity = act.rows[0];
      const rec = await client.query(`SELECT * FROM volunteer_record WHERE tenant_id=$1 AND activity_id=$2 AND user_name=$3 LIMIT 1`, [tenantId, activity.id, w.rows[0].name]);
      if (rec.rowCount === 0) throw new AppError('NOT_FOUND', '未找到本人报名记录', 404);
      const record = rec.rows[0];
      if (record.status !== 'registered') throw new AppError('BAD_STATE', '只能对已报名的记录签到', 409);
      if (activity.start_at && Date.now() < new Date(activity.start_at).getTime() - CHECKIN_EARLY_MS) {
        throw new AppError('CHECKIN_NOT_OPEN', '签到尚未开放（活动开始前 2 小时开放）', 409);
      }
      let late = false;
      if (activity.end_at) {
        const overdue = Date.now() - new Date(activity.end_at).getTime();
        if (overdue > CHECKIN_GRACE_MS) throw new AppError('CHECKIN_EXPIRED', '活动已结束超过 3 天，无法补签', 409);
        late = overdue > 0;
      }
      const r = await client.query(
        `UPDATE volunteer_record SET status='checked_in', check_in_at=now(), check_in_late=$3 WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [record.id, tenantId, late],
      );
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: record.id, type: 'checkin', actor: res.locals.auth.role ?? 'user' });
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

// 签到（管理端/现场核销）：仅 volunteer.audit。
// 2026-11-14 漏洞修复（根因）：此前本端点对「报名本人」直接放行，
// 与 /checkin-by-code（扫码，证明在场）构成两条自助签到路径——
// 志愿者在家点按钮即可签到，绕过二维码在场校验。
// 现收紧为「本人自助只能扫码签到」，本端点仅保留给持 volunteer.audit 的现场人员
// （PC 管理端 / 小程序管理端代签）；worker 调用返回 403 SCAN_REQUIRED。
router.post('/records/:id/checkin', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM volunteer_record WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'record not found', 404);
      try {
        await requirePermission(res.locals.auth, client, 'volunteer.audit');
      } catch (e) {
        // worker（报名本人）统一转成可操作提示：请扫码，避免把英文 permission denied 直接抛给志愿者；
        // 其他角色保持原 403，便于管理端排障。
        if ((e as { status?: number }).status === 403 && res.locals.auth.role === 'worker') {
          throw new AppError('SCAN_REQUIRED', '请使用小程序扫描活动签到码签到', 403);
        }
        throw e;
      }
      // V1 serving 死状态移除：状态机仅认 registered（serving 无任何 API 可置入，历史脏数据走数据卫生清洗）。
      if (cur.rows[0].status !== 'registered') {
        throw new AppError('BAD_STATE', '只能对已报名的记录签到', 409);
      }
      // D-2 补签守卫（P3-4）：查活动 end_at，过期 ≤3 天 → 补签留痕（check_in_late=true）；>3 天 → 409。
      // end_at=null 放行（对齐 signup S7 存量兼容口径：历史活动从未填过结束时间，不误杀）。
      // 活动行缺失（历史脏数据，表无 FK）防御性沿用既有"不新增拦截"原则放行（late=false），不扩大破坏面。
      const act = await client.query(
        `SELECT start_at, end_at FROM volunteer_activity WHERE id = $1 AND tenant_id = $2`,
        [cur.rows[0].activity_id, tenantId],
      );
      // 签到开放窗口（P2）：活动开始前 2 小时开放；避免提前数天签到导致时长/积分失真。
      // start_at=null 放行（历史活动兼容）；活动行缺失沿用“不新增拦截”原则。
      const startAt = act.rows.length > 0 ? act.rows[0].start_at : null;
      if (startAt !== null && startAt !== undefined) {
        if (Date.now() < new Date(startAt).getTime() - CHECKIN_EARLY_MS) {
          throw new AppError('CHECKIN_NOT_OPEN', '签到尚未开放（活动开始前 2 小时开放）', 409);
        }
      }
      let checkInLate = false;
      // rows 兜底空数组（部分 harness/脏环境 rowCount 与 rows 可能不一致，读列前先验行存在）
      const endAt = act.rows.length > 0 ? act.rows[0].end_at : null;
      if (endAt !== null && endAt !== undefined) {
        const overdueMs = Date.now() - new Date(endAt).getTime();
        if (overdueMs > 0) {
          if (overdueMs > CHECKIN_GRACE_MS) {
            throw new AppError('CHECKIN_EXPIRED', '活动已结束超过 3 天，无法补签', 409);
          }
          checkInLate = true;
        }
      }
      const r = await client.query(
        `UPDATE volunteer_record SET status = 'checked_in', check_in_at = now(), check_in_late = $3 WHERE id = $1 AND tenant_id = $2 AND status = 'registered' RETURNING *`,
        [req.params.id, tenantId, checkInLate],
      );
      if (r.rowCount === 0) throw new AppError('CONFLICT', 'record status changed concurrently, please refresh', 409);
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'checkin', actor: 'config_role' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/records/:id/checkout', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM volunteer_record WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'record not found', 404);
      await assertVolunteerExec(client, res.locals.auth, cur.rows[0].user_name, cur.rows[0].user_id);
      const rec = cur.rows[0];
      if (!rec.check_in_at) throw new AppError('BAD_STATE', 'must check in before checkout', 409);
      if (rec.status !== 'checked_in') throw new AppError('BAD_STATE', '仅 checked_in 状态可签退', 409);
      const { duration_min, points } = computeCheckout(rec.check_in_at, new Date(), await getPointsPerHour(client, tenantId));
      const r = await client.query(
        `UPDATE volunteer_record SET status = 'checked_out', check_out_at = now(), duration_min = $3, points = $4 WHERE id = $1 AND tenant_id = $2 AND status = 'checked_in' RETURNING *`,
        [req.params.id, tenantId, duration_min, points],
      );
      if (r.rowCount === 0) throw new AppError('CONFLICT', 'record status changed concurrently, please refresh', 409);
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'checkout', actor: 'config_role' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/records/:id/approve', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      // V1 守卫迁移：volunteer.audit（闭包内）。
      await requirePermission(res.locals.auth, client, 'volunteer.audit');
      const cur = await client.query(`SELECT * FROM volunteer_record WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'record not found', 404);
      if (cur.rows[0].status !== 'checked_out') {
        throw new AppError('BAD_STATE', '只能对已签退的记录审批（先完成签到/签退）', 409);
      }
      const r = await client.query(
        `UPDATE volunteer_record SET status = 'approved' WHERE id = $1 AND tenant_id = $2 AND status = 'checked_out' RETURNING *`,
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0) throw new AppError('CONFLICT', 'record status changed concurrently, please refresh', 409);
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'approve', actor: 'config_role' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// P1：志愿者人员档案维度（审查报告 P2 项提级）。只读聚合：按 user_name 归并全部报名记录，
// 产出报名数/审批数/累计时长/累计积分/最近动态——人员级视图，activity 级明细不动、零 DDL。
// V1：守卫迁移 → volunteer.view（闭包内）。
router.get('/people', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'volunteer.view');
      return client
        .query(
          `SELECT user_name,
                  COUNT(*)::int AS signup_count,
                  COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_count,
                  COALESCE(SUM(duration_min), 0)::int AS total_duration_min,
                  COALESCE(SUM(points), 0)::int AS total_points,
                  MAX(created_at) AS last_activity_at
           FROM volunteer_record WHERE tenant_id = $1
           GROUP BY user_name ORDER BY total_points DESC, user_name ASC`,
          [tenantId],
        )
        .then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 统计总览（P2 增强）：全局统计 + 每个活动的报名/签到/签退/认定/时长/积分。
router.get('/stats/overview', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const data = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'volunteer.view');
      const stats = (await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'registered')::int AS registered_count,
           COUNT(*) FILTER (WHERE status IN ('checked_in','checked_out','approved'))::int AS served_count,
           COALESCE(SUM(duration_min), 0)::int AS total_duration_min,
           COALESCE(SUM(points), 0)::int AS total_points
         FROM volunteer_record WHERE tenant_id=$1`,
        [tenantId],
      )).rows[0];
      const activities = (await client.query(
        `SELECT a.id, a.title, a.status, a.slots, a.start_at, a.end_at,
                COUNT(r.id)::int AS signup_count,
                COUNT(r.id) FILTER (WHERE r.status='checked_in')::int AS checked_in_count,
                COUNT(r.id) FILTER (WHERE r.status='checked_out')::int AS checked_out_count,
                COUNT(r.id) FILTER (WHERE r.status='approved')::int AS approved_count,
                COALESCE(SUM(r.duration_min),0)::int AS total_duration_min,
                COALESCE(SUM(r.points),0)::int AS total_points
         FROM volunteer_activity a
         LEFT JOIN volunteer_record r ON r.activity_id=a.id AND r.tenant_id=a.tenant_id
         WHERE a.tenant_id=$1
         GROUP BY a.id
         ORDER BY a.start_at DESC NULLS LAST, a.created_at DESC`,
        [tenantId],
      )).rows;
      return { stats, activities };
    });
    return res.json({ ok: true, code: 0, ...data });
  } catch (e) {
    next(e);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, async (client) => {
      // V1：守卫迁移 → volunteer.view（闭包内）。
      await requirePermission(res.locals.auth, client, 'volunteer.view');
      return client
        .query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'registered') AS registered_count,
             -- V1 四态口径：serving 死状态已移除，不再参与 served_count 统计
             COUNT(*) FILTER (WHERE status IN ('checked_in','checked_out','approved')) AS served_count,
             COALESCE(SUM(duration_min), 0) AS total_duration_min,
             COALESCE(SUM(points), 0) AS total_points
           FROM volunteer_record WHERE tenant_id = $1`,
          [tenantId],
        )
        .then((r) => r.rows[0]);
    });
    return res.json({ ok: true, code: 0, stats });
  } catch (e) {
    next(e);
  }
});

export default router;
