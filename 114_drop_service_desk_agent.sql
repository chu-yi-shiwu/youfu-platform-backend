-- 114_drop_service_desk_agent.sql —— 服务台坐席表彻底退场。
--
-- 背景：坐席业务已于 2026-10-28 下线，112 删除 service_desk 主表时只能 CASCADE 掉
--       外键，坐席空表本身仍留在库里。空表不会再被读写，但保留会误导后续开发
--       以为坐席模型仍存在。
--
-- 执行：sudo -u postgres psql -d <db> -v ON_ERROR_STOP=1 -f 114_drop_service_desk_agent.sql

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = 'service_desk_agent'
  ) THEN
    DROP TABLE service_desk_agent CASCADE;
  END IF;
END $$;
