-- 079_tenant_registry_pending.sql —— 八件增量补丁（2026-09-10 R4 深测实锤）：
-- 生产库 tenant_registry_status_check 仍为 CHECK (status IN ('active','suspended'))，
-- 代码侧审批开通以 status='pending' 落库 → 23514 违反约束 → BAD_PARAM 400，试用审批→开通链全断。
-- 本迁移放宽 CHECK 纳入 'pending'（审批制开通待激活态）。
-- DDL 须以属主(postgres)执行；DROP+ADD 天然幂等（重跑=先删后建同义约束）。

ALTER TABLE tenant_registry DROP CONSTRAINT IF EXISTS tenant_registry_status_check;

ALTER TABLE tenant_registry ADD CONSTRAINT tenant_registry_status_check
  CHECK (status IN ('active', 'suspended', 'pending'));
