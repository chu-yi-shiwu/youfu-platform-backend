-- 063: optimization_feedback.status CHECK 约束补 'no_match'
-- 根因（2026-08-29 主轮加深测试轮3发现）：applyDispatchOptimizations 在 dispatch_rule 无匹配行时
-- 写 status='no_match'（optimizer.ts:143），但 CHECK 只允许 pending/applied/dismissed → 22P02
-- → 整个 completed 流转事务 aborted 回滚 → 工单永远无法完成（接口却谎报 200 completed）。
-- 执行契约：postgres 属主，sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 063_...
ALTER TABLE optimization_feedback DROP CONSTRAINT optimization_feedback_status_check;
ALTER TABLE optimization_feedback ADD CONSTRAINT optimization_feedback_status_check
  CHECK (status = ANY (ARRAY['pending'::text, 'applied'::text, 'dismissed'::text, 'no_match'::text]));
