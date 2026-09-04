-- 071_settlement_acceptance.sql —— 注册制批次三（本注册制最后一批 · 唯一建表批次）
-- 卡4 结算三凭证：完工凭证(work_acceptance) / 结算单(settlement) / 结算明细(settlement_item)。
--
-- 背景（D1=A 已拍板：第一阶段只记账）：
--   - settlement 表预留 paid_at / payment_ref 两列，**不写任何支付/收款端点**；
--     支付字段预留，接微信支付待 D1 后续拍板。
--   - work_acceptance 记录完工后的验收动作（合格→closed / 不合格→退回 processing），
--     拍照 URL / 语音 URL 以 jsonb 数组落 media。
--   - settlement_item 以 UNIQUE(work_order_id) 实现「一单终身一结算」：
--     工单一旦进入任何结算单（含草稿）即被占用；草稿删除（CASCADE）后释放可再入新单。
--   - work_order_id 对齐 work_orders.id（001_init.sql:25 text 业务号，非 uuid）——
--     live 真验修复：uuid 类型会对 text 主键产生 22P02/操作符不存在错误。
--
-- 幂等：全部 IF NOT EXISTS / DROP POLICY IF EXISTS，可重复执行。
-- 部署契约：以 postgres 身份执行（与 060/070 一致）：
--   sudo -u postgres psql youfu -v ON_ERROR_STOP=1 -f 071_settlement_acceptance.sql

-- 1) work_acceptance —— 完工验收凭证（一单可多次验收：reject 后返工再完工可再验）
CREATE TABLE IF NOT EXISTS work_acceptance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  work_order_id  text NOT NULL,  -- 对齐 work_orders.id（text 业务号，非 uuid）
  result         text NOT NULL CHECK (result IN ('pass', 'reject')),
  note           text,
  media          jsonb NOT NULL DEFAULT '[]',  -- 拍照 URL / 语音 URL 数组
  accepted_by    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_acceptance_tenant_order ON work_acceptance (tenant_id, work_order_id);

-- 2) settlement —— 结算单表头（draft → confirmed；confirmed 后不可修改）
CREATE TABLE IF NOT EXISTS settlement (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  settlement_no  text NOT NULL,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  total          numeric(12, 2) NOT NULL DEFAULT 0,
  item_count     int NOT NULL DEFAULT 0,
  note           text,
  confirmed_by   text,
  confirmed_at   timestamptz,
  paid_at        timestamptz,                 -- 支付字段预留，接微信支付待 D1 后续拍板（第一阶段只记账，不写支付端点）
  payment_ref    text,                        -- 支付字段预留，接微信支付待 D1 后续拍板（第一阶段只记账，不写支付端点）
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, settlement_no)
);
CREATE INDEX IF NOT EXISTS idx_settlement_tenant_status ON settlement (tenant_id, status);

-- 3) settlement_item —— 结算明细（UNIQUE(work_order_id) = 一单终身一结算）
CREATE TABLE IF NOT EXISTS settlement_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  settlement_id   uuid NOT NULL REFERENCES settlement(id) ON DELETE CASCADE,
  work_order_id   text NOT NULL,  -- 对齐 work_orders.id（text 业务号，非 uuid）；settlement_id 仍为 uuid FK
  category_code   text,
  category_name   text,
  price           numeric(12, 2) NOT NULL DEFAULT 0,
  qty             numeric(12, 2) NOT NULL DEFAULT 1,
  amount          numeric(12, 2) NOT NULL DEFAULT 0,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_order_id)
);
CREATE INDEX IF NOT EXISTS idx_settlement_item_settlement ON settlement_item (settlement_id);

-- 4) RLS 租户隔离（060 同款策略，youfu_app 身份生效）
ALTER TABLE work_acceptance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_acceptance_tenant_isolation ON work_acceptance;
CREATE POLICY work_acceptance_tenant_isolation ON work_acceptance
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE settlement ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS settlement_tenant_isolation ON settlement;
CREATE POLICY settlement_tenant_isolation ON settlement
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE settlement_item ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS settlement_item_tenant_isolation ON settlement_item;
CREATE POLICY settlement_item_tenant_isolation ON settlement_item
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
