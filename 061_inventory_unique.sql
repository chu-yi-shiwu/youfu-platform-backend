-- 061_inventory_unique.sql —— R23-001 修复配套：为库存台账补唯一约束，支撑入库 upsert 原子化。
-- 解决并发首存入库竞态：SELECT ... FOR UPDATE 不会锁「不存在的行」，两个并发首存会对同一
-- (tenant_id, material_id, warehouse) 各 INSERT 一条 → 重复台账行 / 库存翻倍（静默数据损坏）。
-- 配套代码见 src/routes/material.ts 的 /inventory/in（改为 ON CONFLICT DO UPDATE upsert）。
--
-- 部署契约（铁律）：DDL 必须以数据库属主(postgres) 身份执行，youfu_app 无权 ALTER：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 061_inventory_unique.sql
-- （正常 migrate 脚本以 youfu_app 运行时本文件会因权限失败并跳过，属预期；须用 postgres 手动应用。）
--
-- ⚠ 前置检查：若 live 已存在 (tenant_id, material_id, warehouse) 重复行，ADD UNIQUE 会失败。
--   须先去重（保留每组合并后的一条，qty 求和）再执行。可选去重语句（仅当确有重复时执行）：
--   DELETE FROM inventory a
--   USING inventory b
--   WHERE a.id < b.id
--     AND a.tenant_id = b.tenant_id AND a.material_id = b.material_id AND a.warehouse = b.warehouse;

ALTER TABLE inventory
  ADD CONSTRAINT uq_inventory_tenant_mat_wh UNIQUE (tenant_id, material_id, warehouse);
