-- 100_shadow_auto_tune_kind.sql —— 影子表 kind CHECK 扩容 'auto_tune_dispatch'（双口径改造）
-- ───────────────────────────────────────────────────────────────────────────
-- 背景（2026-10-22 双口径改造）：影子回放此前的 dispatch 口径测的是「人工派单可预测性」
--   （历史相似单的人工 assignee 多数票 vs 本单实际派单结果），而 AUTO_TUNE 上线要回答的
--   是「按当前生效 dispatch_rule（经 AUTO_TUNE 写回后的规则）派单 vs 现网实际派单差多少」。
--   两个问题曾被同一个 0.5 阈值绑在一起，判据与验收目标错位。本迁移为新口径
--   'auto_tune_dispatch' 放行 kind 值：
--     · predicted = 对某工单按当前生效 dispatch_rule 集合（写回权重 + 模型评分）算出应派工人；
--     · actual    = 该单现网实际派单结果（沿用既有 resolveDispatchShadow 回填路径）；
--     · 时间窗切分：统计/达标判定只计入「规则版本生成时间之后创建」的影子行
--       （被预测的单若参与过该轮规则生成，则不计入——同一批数据又当教材又当考卷，
--        分数必虚高）。窗口过滤在查询层按 kind 施加，本迁移只管放行。
--   ⚠️ 既有 'category'/'dispatch' 行的 kind 值**一律不动**：改 kind 会让按 kind 聚合的
--     历史数据断链，零收益纯风险。新口径是纯增量（并行新增一条写入路径）。
--
-- 幂等写法与 063 同款（DROP CONSTRAINT IF EXISTS + ADD）：未改过 → DROP 静默跳过、
--   ADD 建立三值 CHECK；已改过 → DROP 旧 CHECK 后重建同一定义。重复执行安全，
--   且满足 scripts/releaseGate.ts 迁移幂等静态检查白名单。
-- 执行契约：postgres 属主，psql -v ON_ERROR_STOP=1 -f 100_...sql。
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE ai_shadow_suggestions
  DROP CONSTRAINT IF EXISTS ai_shadow_suggestions_kind_check;

ALTER TABLE ai_shadow_suggestions
  ADD CONSTRAINT ai_shadow_suggestions_kind_check
    CHECK (kind = ANY (ARRAY['category'::text, 'dispatch'::text, 'auto_tune_dispatch'::text]));
