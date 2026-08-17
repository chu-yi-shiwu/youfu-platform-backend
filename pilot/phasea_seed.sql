-- Phase A 验证租户 t-phasea 种子：纯 RICH 状态机 + 人员(含部门) + 服务台 + admin 账号
-- 用 superuser(postgres) 执行： sudo -u postgres psql youfu -f phasea_seed.sql
-- 不破坏既有 t-verification 试点演示数据。
-- 注意：workflow_def 必须与 src/engine/stateMachine.ts 的 RICH_WORK_ORDER_DEF 一致，
--       不得混入旧 4 态兼容路径(assigned→processing event='start' 等)，否则详情页出现重复按钮。
BEGIN;

-- 清理残留（幂等重跑安全）
DELETE FROM work_orders      WHERE tenant_id = 't-phasea';
DELETE FROM domain_event     WHERE tenant_id = 't-phasea';
DELETE FROM ticket_event     WHERE tenant_id = 't-phasea';
DELETE FROM notification     WHERE tenant_id = 't-phasea';
DELETE FROM workflow_def     WHERE tenant_id = 't-phasea';
DELETE FROM worker           WHERE tenant_id = 't-phasea';
DELETE FROM service_desk     WHERE tenant_id = 't-phasea';
DELETE FROM service_desk_agent WHERE tenant_id = 't-phasea';
DELETE FROM account_user     WHERE tenant_id = 't-phasea';
DELETE FROM system_config    WHERE tenant_id = 't-phasea';

-- 0) 租户品牌配置（顶部租户名 + 服务热线）
INSERT INTO system_config (tenant_id, key, value) VALUES
  ('t-phasea', 'brand_name', 'PhaseA 验证医院'),
  ('t-phasea', 'hotline',    '0731-85536356');

-- 1) 纯 RICH 14 态 workflow_def（与 stateMachine.ts RICH_WORK_ORDER_DEF 一致，无旧 4 态残留）
INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES (
  't-phasea', 'work_order',
  '{"initial":"draft","states":["draft","pending_accept","pending_dispatch","claim_hall","assigned","processing","paused","suspended","pending_review","review_passed","completed","closed","cancelled","evaluated"],"transitions":[{"from":"draft","to":"pending_accept","event":"submit"},{"from":"pending_accept","to":"pending_dispatch","event":"accept","allowedRoles":["admin","dispatcher","service_desk"]},{"from":"pending_dispatch","to":"assigned","event":"dispatch","allowedRoles":["admin","dispatcher","service_desk"],"requiredFields":["assignee"]},{"from":"assigned","to":"processing","event":"receive","allowedRoles":["admin","worker"]},{"from":"assigned","to":"pending_dispatch","event":"return","requiredFields":["return_reason"]},{"from":"assigned","to":"assigned","event":"forward","requiredFields":["assignee"],"allowedRoles":["admin","dispatcher","service_desk"]},{"from":"processing","to":"paused","event":"pause","sideEffects":["pause_sla"]},{"from":"paused","to":"processing","event":"resume","sideEffects":["resume_sla"]},{"from":"processing","to":"suspended","event":"suspend","requiredFields":["suspend_reason"],"sideEffects":["pause_sla"]},{"from":"suspended","to":"processing","event":"resume","sideEffects":["resume_sla"]},{"from":"processing","to":"pending_review","event":"submit_review","allowedRoles":["admin","worker"]},{"from":"pending_review","to":"review_passed","event":"approve","allowedRoles":["admin","reviewer"]},{"from":"pending_review","to":"processing","event":"reject","allowedRoles":["admin","reviewer"]},{"from":"review_passed","to":"completed","event":"complete"},{"from":"completed","to":"closed","event":"close","requiredFields":["close_reason"]},{"from":"closed","to":"evaluated","event":"satisfy","requiredFields":["satisfaction_score"]},{"from":"claim_hall","to":"assigned","event":"claim","allowedRoles":["worker","admin","dispatcher","service_desk"]},{"from":"claim_hall","to":"assigned","event":"dispatch","requiredFields":["assignee"],"allowedRoles":["admin","dispatcher","service_desk"]},{"from":"draft","to":"cancelled","event":"cancel","requiredFields":["cancel_reason"],"allowedRoles":["admin","dispatcher"]},{"from":"claim_hall","to":"cancelled","event":"cancel","requiredFields":["cancel_reason"],"allowedRoles":["admin","dispatcher"]},{"from":"pending_accept","to":"cancelled","event":"cancel","requiredFields":["cancel_reason"],"allowedRoles":["admin","dispatcher"]},{"from":"pending_dispatch","to":"cancelled","event":"cancel","requiredFields":["cancel_reason"],"allowedRoles":["admin","dispatcher"]},{"from":"assigned","to":"cancelled","event":"cancel","requiredFields":["cancel_reason"],"allowedRoles":["admin","dispatcher"]},{"from":"processing","to":"cancelled","event":"cancel","requiredFields":["cancel_reason"],"allowedRoles":["admin","dispatcher"]},{"from":"paused","to":"cancelled","event":"cancel","requiredFields":["cancel_reason"],"allowedRoles":["admin","dispatcher"]},{"from":"suspended","to":"cancelled","event":"cancel","requiredFields":["cancel_reason"],"allowedRoles":["admin","dispatcher"]},{"from":"pending_review","to":"cancelled","event":"cancel","requiredFields":["cancel_reason"],"allowedRoles":["admin","dispatcher"]}],"config":{"doneStates":["completed","closed","evaluated"],"learningTriggers":["completed","review_passed"],"autoRoutes":{"draft":{"to":"assigned","strategy":"least_load"}}}}',
  1
);

-- 2) 服务台（固定 UUID 便于引用）
INSERT INTO service_desk (id, tenant_id, name, template) VALUES
  ('aaaaaaa1-0000-0000-0000-0000000000a1', 't-phasea', '前台服务台', '维修标准模板'),
  ('bbbbbbb2-0000-0000-0000-0000000000b2', 't-phasea', '工程服务台', '维修标准模板');

-- 3) 人员（含部门维度，技能匹配派单）
INSERT INTO worker (id, tenant_id, name, skill_tags, load, active, department) VALUES
  ('W-A1', 't-phasea', '水电工-甲', ARRAY['electric','water'], 0, true, 'A'),
  ('W-B1', 't-phasea', '暖通工-乙', ARRAY['hvac'], 0, true, 'B'),
  ('W-C1', 't-phasea', '网络工-丙', ARRAY['network'], 0, true, 'C');

-- 4) admin 账号（密码 phasea888，scrypt 哈希由本地按 account.ts 同格式生成）
INSERT INTO account_user (tenant_id, username, password_hash, display_name, role, active) VALUES
  ('t-phasea', 'phasea_admin', 'scrypt$88830e5e7395da369cf45e13c2ed39e3$13caaac1fe5bbcc1944ab940a292c39cadd0f39e56ee7bf239cb8d3d361605fb5722d65cbf51054b09d78910e2adc53a3e7dbe96e2519183918376437594ef07', 'PhaseA验证管理员', 'admin', true);

COMMIT;
