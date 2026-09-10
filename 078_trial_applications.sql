-- 078_trial_applications.sql —— 八件增量 BE-1/BE-2：试用申请表（公开提交 → 平台审批开通）。
-- 流向：mp/web 公开提交 pending → 平台管理员 approve（复用 POST /platform/tenants 开通逻辑，
--       以 pending 态落库 tenant_registry，tenant_id 回填本表）/ reject（记原因）。
-- 诚实边界：同表随审批跨「待审/平台级」与「已开通租户回执」两态，属平台级表，不启用 RLS；
--       仅经服务端端点访问（公开提交有 phone/IP 双限频，审批仅 platformAdminAuth）。
-- DDL 须以属主(postgres)执行：pssql "$DATABASE_URL_POSTGRES" -f 078_trial_applications.sql；幂等。

CREATE TABLE IF NOT EXISTS trial_applications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_name     text NOT NULL,
  contact_name text NOT NULL,
  phone        text NOT NULL,
  category     text NOT NULL DEFAULT 'other'
               CHECK (category IN ('hospital', 'property', 'school', 'municipal', 'other')),
  note         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  ip           text,                        -- 提交来源 IP（限频审计用）
  tenant_id    text,                        -- 批准后生成的租户
  reviewed_by  text,                        -- 审批人（platform_admin username）
  reviewed_at  timestamptz,
  reject_reason text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trial_apps_status ON trial_applications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trial_apps_phone  ON trial_applications (phone, created_at DESC);

-- 运行时角色授权（属主为 postgres，youfu_app 仅运行时读写）
GRANT SELECT, INSERT, UPDATE, DELETE ON trial_applications TO youfu_app;
