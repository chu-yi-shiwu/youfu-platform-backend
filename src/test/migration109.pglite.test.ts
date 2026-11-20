// migration109.pglite.test.ts —— 109 志愿者名额默认值迁移（真 PGlite + 真 SQL）。
//
// 【为什么需要】
//   API 层 slots 默认 1 只能保护走 API 的写入；任何绕过 API 的 SQL 仍会按
//   012 的列默认值 0 建出“永久满员”的活动（报名守卫是 count >= slots）。
//   109 把数据库默认值对齐为 1，本文件钉死三件事：
//     ① 默认值真的从 0 变 1；
//     ② 可重复执行（第二遍走 NOTICE 跳过，不报错）；
//     ③ 不改存量行：已有 slots=0 的活动仍保持 0（尊重显式数据）。
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SQL = readFileSync(join(ROOT, '109_volunteer_slots_default_one.sql'), 'utf8');

async function slotsDefault(db: PGlite): Promise<string | null> {
  const r = await db.query<{ column_default: string | null }>(
    `SELECT column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'volunteer_activity'
        AND column_name = 'slots'`,
  );
  return r.rows[0]?.column_default ?? null;
}

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  // 与 012 同形的列定义（默认 0），只保留本迁移关心的列。
  await db.exec(`
    CREATE TABLE volunteer_activity (
      id serial PRIMARY KEY,
      tenant_id text NOT NULL,
      title text NOT NULL,
      slots int NOT NULL DEFAULT 0
    );
  `);
  return db;
}

describe('109 · volunteer_activity.slots 默认值对齐为 1', () => {
  it('① 默认值从 0 改为 1', async () => {
    const db = await setup();
    expect(await slotsDefault(db)).toBe('0');
    await db.exec(SQL);
    expect(await slotsDefault(db)).toBe('1');
  });

  it('② 幂等：连续执行两次不报错，默认值仍为 1', async () => {
    const db = await setup();
    await db.exec(SQL);
    await db.exec(SQL);
    expect(await slotsDefault(db)).toBe('1');
  });

  it('③ 不改存量行：已有 slots=0 的活动保持 0，新行走新默认 1', async () => {
    const db = await setup();
    await db.exec(`INSERT INTO volunteer_activity (tenant_id, title, slots) VALUES ('t1', '旧活动', 0)`);
    await db.exec(SQL);
    await db.exec(`INSERT INTO volunteer_activity (tenant_id, title) VALUES ('t1', '新活动')`);
    const r = await db.query<{ title: string; slots: number }>(
      `SELECT title, slots FROM volunteer_activity ORDER BY id`,
    );
    expect(r.rows).toEqual([
      { title: '旧活动', slots: 0 },
      { title: '新活动', slots: 1 },
    ]);
  });
});
