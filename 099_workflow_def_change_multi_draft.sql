-- 099_workflow_def_change_multi_draft.sql —— 同一业务流允许多份在途草稿（只串行审批）
--
-- 【原状】080 建 workflow_def_change 时给了表级 UNIQUE (tenant_id, entity_type)，
--   语义是「同一业务流同时只能存在一行变更」。它把两件事绑死了：
--     · 审批必须串行（同一时刻只能一份待审）——这条要守住；
--     · 草稿互相排斥（两人同时改流程，后一个直接 409）——这条是误伤。
--   放开后：多人可各存多份草稿；同一时刻仍只有一份待审（安全底线不动）。
--
-- 【为什么用 DO 块动态找约束名】
--   080 写的是表级 UNIQUE，PG 自动生成的约束名（workflow_def_change_tenant_id_entity_type_key）
--   在不同环境可能带后缀/不一致；写死名字 DROP 会漏 ⇒ 旧约束还在 ⇒ 多草稿照样 409
--   （改了等于没改，而且静默）。故按「conkey 恰为 tenant_id+entity_type 的唯一约束」动态识别并 DROP。
--
-- 【连带代码改动（必须同版本发布，否则会静默丢数据）】
--   · deleteWorkflowDefChange 改为按 id 精确删（原按 tenant+entity 删全部 ⇒ 会删掉别人的草稿）；
--   · submitWorkflowDefChange 支持指定 change_id（多草稿时必须显式选一份提交）；
--   · getWorkflowDefChange 排序确定化（submitted 优先，其次最新 draft）。
--
-- 【回滚】
--   CREATE UNIQUE INDEX CONCURRENTLY ux_wfd_change_all ON workflow_def_change (tenant_id, entity_type);
--   （必须先清理多余 draft 行，否则建约束失败）
--
-- 幂等可重跑；DDL 须 superuser 执行：
--   sudo -u postgres psql -d youfu -f 099_workflow_def_change_multi_draft.sql

DO $$
DECLARE
  con record;
  cols text;
BEGIN
  FOR con IN
    SELECT c.conname, c.conrelid, c.conkey
    FROM pg_constraint c
    WHERE c.conrelid = 'workflow_def_change'::regclass AND c.contype = 'u'
  LOOP
    SELECT string_agg(a.attname, ',' ORDER BY a.attname)
      INTO cols
    FROM unnest(con.conkey) AS k(attnum)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum;

    -- 只删「恰好约束 (tenant_id, entity_type) 两列」的表级唯一（即 080 建的那一道）
    IF cols = 'entity_type,tenant_id' THEN
      EXECUTE format('ALTER TABLE workflow_def_change DROP CONSTRAINT %I', con.conname);
      RAISE NOTICE '已 DROP 表级唯一约束 %（080）', con.conname;
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_wfd_change_pending
  ON workflow_def_change (tenant_id, entity_type)
  WHERE status = 'submitted';
