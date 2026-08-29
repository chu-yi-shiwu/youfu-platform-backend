-- 仅插入租户品牌配置（brand_name / hotline），幂等，不清任何业务数据。
-- 执行：sudo -u postgres psql -d youfu -f seed_tenant_config.sql
INSERT INTO system_config (tenant_id, key, value)
VALUES
  ('t-verification', 'brand_name', '长沙市第四医院'),
  ('t-verification', 'hotline',    '0731-85536356'),
  ('t-phasea',       'brand_name', 'PhaseA 验证医院'),
  ('t-phasea',       'hotline',    '0731-85536356')
ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
