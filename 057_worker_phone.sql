-- 057: worker 表增加 phone 列（短信通知投递目标，可空）
-- 幂等：ADD COLUMN IF NOT EXISTS，可安全重复执行
-- 应用约束：必须以数据库属主(postgres)身份执行（youfu_app 为非属主、受 RLS 约束，无 ALTER 权限）
-- 数据来源：由运营在后台录入 worker 手机号；未录入时短信渠道诚实 stub（delivered=false），绝不误发
ALTER TABLE worker ADD COLUMN IF NOT EXISTS phone TEXT;

COMMENT ON COLUMN worker.phone IS '手机号，用于短信通知投递；可空，未录入时短信渠道诚实 stub（delivered=false）';
