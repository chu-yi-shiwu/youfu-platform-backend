-- 003_seed_workers.sql
-- 目的：为派单候选池插入种子 worker，使 M1 自动派单（least_load 命中）可真实验证。
-- 设计：
--   1. 幂等：仅当目标租户下对应 id 不存在才插入（ON CONFLICT DO NOTHING + 先查后插双重保险）。
--   2. 覆盖前端 M1 已用的技能标签（electric 等），并保证 active=true、load 有梯度。
--   3. 不改已存在的 worker 数据，避免污染真实环境。
-- 运行：由 migrate.ts 按序加载（所有 NNN_*.sql），已存在的库可重复执行。

-- 租户 t-verification 的种子（验证专用；真实多租户部署时按需复制）
DO $$
DECLARE
  v_tenant text := 't-verification';
BEGIN
  -- electric 技能组：两名 active，load 不同用于验证 least_load 取最低
  IF NOT EXISTS (SELECT 1 FROM worker WHERE id = 'w-elec-001' AND tenant_id = v_tenant) THEN
    INSERT INTO worker (id, tenant_id, name, skill_tags, load, active)
    VALUES ('w-elec-001', v_tenant, '电工-甲', '{electric}', 0, true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM worker WHERE id = 'w-elec-002' AND tenant_id = v_tenant) THEN
    INSERT INTO worker (id, tenant_id, name, skill_tags, load, active)
    VALUES ('w-elec-002', v_tenant, '电工-乙', '{electric}', 3, true);
  END IF;

  -- 多技能组：覆盖 electric + plumbing，用于后续复合技能工单验证
  IF NOT EXISTS (SELECT 1 FROM worker WHERE id = 'w-multi-001' AND tenant_id = v_tenant) THEN
    INSERT INTO worker (id, tenant_id, name, skill_tags, load, active)
    VALUES ('w-multi-001', v_tenant, '综合-甲', '{electric,plumbing}', 1, true);
  END IF;

  -- 非活跃组：active=false，验证派单不会选到
  IF NOT EXISTS (SELECT 1 FROM worker WHERE id = 'w-elec-off' AND tenant_id = v_tenant) THEN
    INSERT INTO worker (id, tenant_id, name, skill_tags, load, active)
    VALUES ('w-elec-off', v_tenant, '电工-停用', '{electric}', 0, false);
  END IF;
END $$;
