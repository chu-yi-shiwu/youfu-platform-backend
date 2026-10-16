-- 094_workflow_auto_rule.sql —— 地基④：自动审核规则（租户可配，**默认关闭**）
-- ───────────────────────────────────────────────────────────────────────────
-- 用户原意（src/engine/stateMachine.ts:22 原文引述）：
--   「审核员不是单独一个人，是一个权限属性，它可以加给谁一个审核权限，或者配置自动审核规则。」
-- 前半句（审核 = 可叠加权限属性）已由地基第二步的 allowedPerms 落地；
-- 本迁移落地后半句：**自动审核规则**。
--
-- 【🔴 红线：引擎绝不自动推进到终态】（stateMachine.ts:5-6 原文明令）
--   completed / escalated 必须由显式事件驱动；P6 验收只报自动派单率，不自动闭环。
--   故本机制设三道闸，缺一不可：
--     ① DB CHECK：event 只允许 approve / reject 两个审核动作
--        —— 直接把 acceptance_pass（completed→closed，closed 是终态）挡在库外；
--     ② 应用层：保存时按本租户 workflow_def 解析该边的 to_state，
--        命中 TERMINAL_STATES（closed/cancelled/evaluated）→ 422 拒绝保存；
--     ③ 默认值：enabled 默认 false —— 建了不启用就永不自动，杜绝"建即生效"的误伤。
--   ⇒ 自动审核只能把单从"待审核"推到"审核通过/打回"这类**中间态**，
--     绝不可能把单自动关掉、自动撤销、自动评价。
--
-- 【零破坏边界】
--   - 纯新增表，不改任何既有表 / 不改任何既有行；
--   - 代码侧执行器惰性触发：本表为空（或未应用）→ 零自动行为，与改造前逐字等价；
--   - 所有自动推进都写 ticket_event（actor='system:auto'）留痕，可审计、可追溯。
--
-- 幂等：全 IF NOT EXISTS / DROP ... IF EXISTS，可重复执行。
-- 执行：须属主 sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 094_workflow_auto_rule.sql
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_auto_rule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  entity_type text NOT NULL DEFAULT 'work_order',
  from_state  text NOT NULL,                       -- 触发态：进入该态时评估（如 pending_review）
  event       text NOT NULL,                       -- 自动执行的事件（如 approve）
  -- 匹配条件（jsonb，缺省 {} = 无条件命中）。维度严格对应 work_orders 真实列，
  -- 见 engine/autoRules.ts 的取数边界说明（本表无金额列，故不设金额条件）：
  --   priority_in  string[] 优先级白名单（未给 = 不限）
  --   categories   string[] 工单类型白名单（catalog；未给 = 不限）
  --   no_exception boolean  true = 要求 ext.has_exception 为假才命中
  conditions  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 🔴 默认关闭：建规则不等于启用，启用是显式动作（防"配了就自动跑"误伤存量）
  enabled     boolean NOT NULL DEFAULT false,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- ① 事件白名单：只允许审核类动作自动化，终态动作（close/cancel/satisfy/acceptance_pass）一律不可自动
  CONSTRAINT workflow_auto_rule_event_whitelist CHECK (event IN ('approve', 'reject')),
  -- 形状约束（与 role_def 同口径）：防空格/大写混入状态名/事件名
  CONSTRAINT workflow_auto_rule_state_format CHECK (from_state ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT workflow_auto_rule_event_format CHECK (event ~ '^[a-z][a-z0-9_]{0,31}$')
);

-- 同一租户同一实体类型同一触发态同一事件，只允许一条规则（避免多条规则互相打架）
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_auto_rule ON workflow_auto_rule (tenant_id, entity_type, from_state, event);
CREATE INDEX IF NOT EXISTS idx_workflow_auto_rule_lookup ON workflow_auto_rule (tenant_id, entity_type, from_state, enabled);

ALTER TABLE workflow_auto_rule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_auto_rule_tenant_isolation ON workflow_auto_rule;
CREATE POLICY workflow_auto_rule_tenant_isolation ON workflow_auto_rule
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_auto_rule TO youfu_app;

-- ============ 自证：表结构与红线约束已就位 ============
\echo '--- 094 自证①：列与默认值（enabled 必须默认 false）---'
SELECT column_name, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'workflow_auto_rule'
ORDER BY ordinal_position;

\echo '--- 094 自证②：事件白名单约束（只 approve / reject）---'
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conrelid = to_regclass('workflow_auto_rule')
  AND contype = 'c';

\echo '--- 094 自证③：RLS 已启用（未启用 = 租户数据串租户，属事故）---'
SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'workflow_auto_rule';
