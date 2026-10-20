/**
 * 099_workflow_def_change_multi_draft.sql —— PGlite 真跑验证
 *
 * 【为什么补这份】
 *   放开「每租户每业务流只能一份在途变更」是个**结构性**改动，有三条静默失败路径：
 *     · 只建部分唯一索引、忘了 DROP 080 的表级 UNIQUE ⇒ 旧约束还在 ⇒ 多草稿照样 409（改了等于没改）；
 *     · 约束名写死 DROP ⇒ 不同环境名字不同 ⇒ 漏删（同上）；
 *     · 只放开约束、不改 deleteWorkflowDefChange ⇒ approve 时把**别人的草稿一起删掉**（丢数据且无痕）。
 *   这三条读代码都看不出来，只有真跑真库。
 *
 * 【验证口径】真建库 → 真跑 080 建表段 + 099 → 真插行 → 真调用被测函数。
 */
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { deleteWorkflowDefChange, getWorkflowDefChange } from '../engine/workflowDefChange.js';

const ROOT = join(__dirname, '..', '..');
const SQL_080 = readFileSync(join(ROOT, '080_workflow_def_change.sql'), 'utf8');
const SQL_099 = readFileSync(join(ROOT, '099_workflow_def_change_multi_draft.sql'), 'utf8');

/** 截取 080 的建表段（PGlite 不认 GRANT / RLS 策略 / DO 块，只取 CREATE TABLE 那一整段）。 */
function ddl080(): string {
  const start = SQL_080.indexOf('CREATE TABLE IF NOT EXISTS workflow_def_change');
  const end = SQL_080.indexOf('\n);', start);
  if (start < 0 || end < 0) throw new Error('080 迁移结构变了：截取建表段失败，请同步本测试');
  return SQL_080.slice(start, end + 3);
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ddl080());
  return db;
}

async function insertChange(db: PGlite, status: 'draft' | 'submitted', note: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO workflow_def_change (tenant_id, entity_type, def, note, status, base_version)
     VALUES ('T1', 'work_order', '{"states":["draft"],"initial":"draft","transitions":[]}'::jsonb, $1, $2, 1)
     RETURNING id`,
    [note, status],
  );
  return Number(r.rows[0].id);
}

describe('099 多份在途草稿：放开草稿、只串行审批', () => {
  it('放开前：同一业务流第二份变更直接撞 UNIQUE（证明旧约束确实存在过）', async () => {
    const db = await freshDb();
    await insertChange(db, 'draft', '甲');
    await expect(insertChange(db, 'draft', '乙')).rejects.toThrow();
  });

  it('跑完 099：同一业务流可并存多份草稿（甲乙各存各的）', async () => {
    const db = await freshDb();
    await db.exec(SQL_099);
    await insertChange(db, 'draft', '甲');
    await insertChange(db, 'draft', '乙');
    const c = await db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM workflow_def_change`);
    expect(Number(c.rows[0].c)).toBe(2);
  });

  it('安全底线不动：同时只能一份待审批（第二份 submitted 被拒）', async () => {
    const db = await freshDb();
    await db.exec(SQL_099);
    await insertChange(db, 'submitted', '甲');
    await expect(insertChange(db, 'submitted', '乙')).rejects.toThrow();
  });

  it('幂等：099 重跑一次不炸，且约束仍生效', async () => {
    const db = await freshDb();
    await db.exec(SQL_099);
    await db.exec(SQL_099);
    await insertChange(db, 'submitted', '甲');
    await expect(insertChange(db, 'submitted', '乙')).rejects.toThrow();
  });
});

describe('099 连带改动：deleteWorkflowDefChange 必须按 id 精确删', () => {
  it('approve 生效只删被生效那一行，别人的草稿必须还在（否则是静默丢数据）', async () => {
    const db = await freshDb();
    await db.exec(SQL_099);
    const keepId = await insertChange(db, 'draft', '乙（别人的草稿）');
    const doneId = await insertChange(db, 'submitted', '甲（待审这份）');

    await deleteWorkflowDefChange(db as unknown as PoolClient, 'T1', 'work_order', doneId);

    const left = await db.query<{ id: number; note: string }>(
      `SELECT id, note FROM workflow_def_change ORDER BY id`,
    );
    expect(left.rows.length).toBe(1);
    expect(Number(left.rows[0].id)).toBe(keepId);
    expect(left.rows[0].note).toContain('乙');
  });
});

describe('099 连带改动：getWorkflowDefChange 取哪一份必须有确定性', () => {
  it('submitted 优先于 draft（审批看到的一定是待审那份）', async () => {
    const db = await freshDb();
    await db.exec(SQL_099);
    await insertChange(db, 'draft', '后建的草稿');
    const submittedId = await insertChange(db, 'submitted', '待审');

    const got = await getWorkflowDefChange(db as unknown as PoolClient, 'T1', 'work_order');
    expect(got).toBeTruthy();
    expect(got!.status).toBe('submitted');
    expect(got!.id).toBe(submittedId);
  });

  it('全是草稿时取最新那份（id 最大），不是随机行', async () => {
    const db = await freshDb();
    await db.exec(SQL_099);
    await insertChange(db, 'draft', '旧草稿');
    const newest = await insertChange(db, 'draft', '新草稿');

    const got = await getWorkflowDefChange(db as unknown as PoolClient, 'T1', 'work_order');
    expect(got!.id).toBe(newest);
    expect(got!.note).toBe('新草稿');
  });
});
