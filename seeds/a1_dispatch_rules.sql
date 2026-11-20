-- A1 #898：t-verification 真实 dispatch_rule 录入（幂等，可重复执行）
-- 口径：match_json.business_type 精确匹配工单 business_type（2026-09-03 查库实证 9 类）；
--       strategy.skill_tags 均与在岗工人 skill_tags 有真实交集（逐类核对过）。
-- repair 为通用类：不给 skill_tags → 候选=全体在岗工人 → 模型评分/least_load 兜底。
-- 回滚：DELETE FROM dispatch_rule WHERE tenant_id='t-verification' AND name IN (...9 个 name...);
INSERT INTO dispatch_rule (tenant_id, name, priority, match_json, strategy_json, enabled)
SELECT 't-verification', r.name, 100, r.match_json::jsonb, r.strategy_json::jsonb, true
FROM (VALUES
  ('暖通空调类-技能派单', '{"business_type":"hvac"}',     '{"type":"skill_match","skill_tags":["hvac"]}'),
  ('给水类-技能派单',     '{"business_type":"water"}',     '{"type":"skill_match","skill_tags":["water"]}'),
  ('排水管修类-技能派单', '{"business_type":"plumbing"}',  '{"type":"skill_match","skill_tags":["plumbing"]}'),
  ('电梯类-技能派单',     '{"business_type":"elevator"}',  '{"type":"skill_match","skill_tags":["elevator"]}'),
  ('电气类-技能派单',     '{"business_type":"electric"}',  '{"type":"skill_match","skill_tags":["electric"]}'),
  ('安防类-技能派单',     '{"business_type":"security"}',  '{"type":"skill_match","skill_tags":["security"]}'),
  ('照明类-技能派单',     '{"business_type":"lighting"}',  '{"type":"skill_match","skill_tags":["lighting"]}'),
  ('网络类-技能派单',     '{"business_type":"network"}',   '{"type":"skill_match","skill_tags":["network"]}'),
  ('综合报修类-负载均衡', '{"business_type":"repair"}',    '{"type":"load_balance"}')
) AS r(name, match_json, strategy_json)
WHERE NOT EXISTS (
  SELECT 1 FROM dispatch_rule d
  WHERE d.tenant_id = 't-verification' AND d.name = r.name
);
