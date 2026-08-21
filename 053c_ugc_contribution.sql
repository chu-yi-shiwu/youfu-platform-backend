-- 053c_ugc_contribution.sql —— UGC 模板贡献二期：租户→平台轮（V3 双轮另一半）。
-- platform_template 加 source（official 官方 / ugc 租户贡献）+ contributor_tenant（贡献租户）。
-- 幂等；须 superuser 执行：sudo -u postgres psql -d youfu -f 053c_ugc_contribution.sql

ALTER TABLE platform_template ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'official'
  CHECK (source IN ('official','ugc'));
ALTER TABLE platform_template ADD COLUMN IF NOT EXISTS contributor_tenant text;
