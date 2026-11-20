-- 112_drop_service_desk.sql —— 服务台退场：部门模型接管归属。
--
-- 前提：110/111 已应用，新后端已经把需求写 department_id；历史工单已回填默认部门。
-- 本迁移会：
--   1) 收紧 work_orders.department_id NOT NULL（部门必填）；
--   2) 删除旧 work_orders.service_desk / work_orders.department 文本列；
--   3) 删除 worker.department 旧文本列；
--   4) 删除 service_desk 主数据表；
--   5) 删除 system_config.ticket_require_service_desk；
--   6) 删除 servicedesk.manage 权限覆盖行。
--
-- 执行：sudo -u postgres psql -d <db> -v ON_ERROR_STOP=1 -f 112_drop_service_desk.sql

-- 1) 部门必填（111 已回填默认部门；若仍有空值，这里会失败而不是静默放行）
--    用 DO 块做条件收紧：列已是 NOT NULL 时跳过，迁移可重复执行。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'work_orders'
      AND column_name = 'department_id'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE work_orders ALTER COLUMN department_id SET NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN work_orders.department_id IS '责任部门（必填；dept.id）';

-- 2) 旧服务台/旧部门文本列
ALTER TABLE work_orders DROP COLUMN IF EXISTS service_desk;
ALTER TABLE work_orders DROP COLUMN IF EXISTS department;

-- 3) 人员旧部门文本列（新列是 department_id）
ALTER TABLE worker DROP COLUMN IF EXISTS department;

-- 4) 服务台主数据表
DROP TABLE IF EXISTS service_desk CASCADE;

-- 5) 建单必须指定服务台的旧开关
DELETE FROM system_config WHERE key = 'ticket_require_service_desk';

-- 6) 权限覆盖行（默认矩阵在代码里，迁移只清租户覆盖）
DELETE FROM role_permission WHERE perm = 'servicedesk.manage';
