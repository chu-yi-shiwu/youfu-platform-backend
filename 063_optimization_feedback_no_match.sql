-- 063: optimization_feedback.status CHECK 约束补 'no_match'
-- 根因（2026-08-29 主轮加深测试轮3发现）：applyDispatchOptimizations 在 dispatch_rule 无匹配行时
-- 写 status='no_match'（optimizer.ts:143），但 CHECK 只允许 pending/applied/dismissed → 22P02
-- → 整个 completed 流转事务 aborted 回滚 → 工单永远无法完成（接口却谎报 200 completed）。
--
-- 【M0-3 幂等化改写（2026-09-02）】原为一次性 DROP+ADD（DROP 无 IF EXISTS），重复执行报 42704 中断迁移链。
--   改为 DROP CONSTRAINT IF EXISTS + ADD 的标准幂等写法：
--   - 未改过 → DROP 静默跳过，ADD 建立四值 CHECK；
--   - 已改过 → DROP 旧四值 CHECK 后重建同一定义，最终状态一致，重复执行安全。
--   该写法同时满足 scripts/releaseGate.ts 迁移幂等静态检查白名单（DROP CONSTRAINT IF EXISTS）。
--
-- 执行契约：postgres 属主，sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 063_...

ALTER TABLE optimization_feedback
  DROP CONSTRAINT IF EXISTS optimization_feedback_status_check;

ALTER TABLE optimization_feedback
  ADD CONSTRAINT optimization_feedback_status_check
    CHECK (status = ANY (ARRAY['pending'::text, 'applied'::text, 'dismissed'::text, 'no_match'::text]));
