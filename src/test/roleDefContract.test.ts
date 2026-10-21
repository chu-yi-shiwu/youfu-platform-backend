// roleDefContract.test.ts —— 角色可配置地基的护栏测试（零 DB 依赖，解析迁移文本）。
//
// 【为什么写这个测试】
//   地基根因：角色被 DB CHECK 锁死为 6 个枚举（007:14 → 046:24,33 → 070:20,45），
//   导致单位无法自建岗位，只能由开发者往枚举里加（AL-002 补 reviewer/service_desk，
//   见 src/middleware/role.ts:8-10）。090_role_def.sql 是地基返工第一步。
//   本测试锁死「角色必须可配置」这条设计约束，防止后续迁移把它改回枚举锁死。
//
// 诚实边界：本测试只做静态契约校验（解析 SQL 文本）。
//   真实行为（可重复执行、RLS 生效、内置 code 被拒、自建角色成功）
//   已由本机 youfu_roletest 库实测通过，不在此重复。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const sql = readFileSync(path.join(root, '090_role_def.sql'), 'utf8');

describe('090_role_def —— 角色可配置地基契约', () => {
  it('role_def 表含 tenant_id（列入闸门 RLS 扫描范围，不得漏）', () => {
    expect(/CREATE TABLE IF NOT EXISTS role_def[\s\S]*?tenant_id\s+text\s+NOT NULL/i.test(sql)).toBe(true);
  });

  it('role_def 启用 RLS 且有租户隔离 policy（否则闸门新增红）', () => {
    expect(/ALTER TABLE role_def ENABLE ROW LEVEL SECURITY/i.test(sql)).toBe(true);
    expect(/CREATE POLICY[\s\S]*?ON role_def[\s\S]*?app_tenant_id\(\)/i.test(sql)).toBe(true);
  });

  it('放宽枚举 CHECK 的 DO 块用 to_regclass 防御（表不存在时不得整体失败）', () => {
    // 本机残缺库实测复现：用 ::regclass 会抛「关系不存在」导致迁移整体失败。
    expect(sql).toContain('to_regclass(');
    expect(sql).not.toMatch(/'account_user'::regclass/);
    expect(sql).not.toMatch(/'role_permission'::regclass/);
  });

  it('code 有形状约束与内置角色保留约束（防租户覆盖内置语义）', () => {
    expect(/role_def_code_format/i.test(sql)).toBe(true);
    expect(/role_def_code_reserved/i.test(sql)).toBe(true);
    // 内置 6 角色必须全部在保留名单内
    for (const code of ['admin', 'operator', 'dispatcher', 'worker', 'reviewer', 'service_desk']) {
      expect(sql).toContain(`'${code}'`);
    }
  });

  it('全程幂等（可被重复执行）', () => {
    expect(/CREATE TABLE IF NOT EXISTS/i.test(sql)).toBe(true);
    expect(/DROP POLICY IF EXISTS/i.test(sql)).toBe(true);
    expect(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/i.test(sql)).toBe(true);
  });
});
