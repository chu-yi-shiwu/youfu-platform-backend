-- 107_ugc_contribution.sql —— 053c 的可自动执行版本（UGC 模板贡献二期）。
--
-- 背景：053c_ugc_contribution.sql 因文件名不匹配迁移正则，历史上从未被自动执行，
--   而 templateMarket / templateContributions 已在查询 source / contributor_tenant。
-- 本迁移只做加法（ADD COLUMN IF NOT EXISTS），可重复执行，不删除任何数据/列。

ALTER TABLE platform_template ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'official'
  CHECK (source IN ('official','ugc'));
ALTER TABLE platform_template ADD COLUMN IF NOT EXISTS contributor_tenant text;
