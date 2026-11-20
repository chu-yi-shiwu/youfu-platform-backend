// 平台运维写闭环的两个根因修复（2026-11-14 深度探针）
//
// 1) POST /platform/apps 实测 400「缺少必填字段（app_secret）」：
//    052 建表 app_secret NOT NULL，但代码只写 secret_hash（明文不落库）⇒ 功能整体不可用。
//    修复：119 解除 NOT NULL（不删列，删列仍走 pending-migrations/108 人工流程）。
//
// 2) GET /platform/tenants 的 llm_enabled 永远 false：
//    tenant_settings 有 RLS，平台用应用连接无租户 GUC ⇒ LEFT JOIN 拿不到行。
//    修复：120 提供 SECURITY DEFINER 的 platform_tenant_llm() 只暴露聚合列，路由改用它。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('119 · open_api_app.app_secret 可空', () => {
  const sql = read('119_open_api_app_secret_nullable.sql');
  it('解除 NOT NULL（幂等）', () => {
    expect(sql).toMatch(/ALTER TABLE open_api_app ALTER COLUMN app_secret DROP NOT NULL/);
  });
  it('列已删除的环境跳过（主站兼容）', () => {
    expect(sql).toMatch(/information_schema\.columns/);
    expect(sql).toMatch(/IF EXISTS/);
    expect(sql).toMatch(/RAISE NOTICE/);
  });
  it('不删除列（保留人工删列窗口）', () => {
    expect(sql).not.toMatch(/DROP COLUMN/i);
  });
});

describe('120 · 平台读取 LLM 授权', () => {
  const sql = read('120_platform_tenant_llm.sql');
  it('函数为 SECURITY DEFINER 且固定 search_path', () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public/);
  });
  it('只授执行权给应用角色', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.platform_tenant_llm\(\) FROM PUBLIC/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.platform_tenant_llm\(\) TO youfu_app/);
  });
  it('平台租户列表使用函数而不是直连 RLS 表', () => {
    const src = readFileSync(join(ROOT, 'src', 'routes', 'platform.ts'), 'utf8');
    expect(src).toContain('LEFT JOIN platform_tenant_llm() llm');
    expect(src).not.toContain('LEFT JOIN tenant_settings ts');
  });
});
