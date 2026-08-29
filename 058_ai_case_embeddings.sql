-- 058_ai_case_embeddings.sql —— K2 向量 RAG 数据底座（tenant 隔离，无 pgvector）
-- ───────────────────────────────────────────────────────────────────────────
-- 为什么不用 pgvector：
--   ECS PG 15.19 未安装 vector 扩展；装扩展需 OS 包 + PG 重启 = 服务器级变更，
--   触发硬护栏，故否决。改用 real[] 浮点数组 + Node 端余弦相似度：零服务器变更、
--   合规、tenant 隔离，契合优服家铁律。
-- 用途：
--   把「租户自身已完成 / 关闭的工单与业务流」嵌入为向量，供 /ai/similar 在持有
--   domestic embedding API key 时做语义检索（隐私/隔离增益：只检索本机构自己的
--   历史单，不外泄、不跨租户）。无 key 时本表为空、关键词兜底路径完全不变。
-- RLS 惯例：
--   本表 tenant_id 隔离，无显式 RLS，靠 withTenantClient 应用层过滤；跨应用写入
--   走 SECURITY DEFINER 函数 upsert_case_embedding（GRANT youfu_app）。
-- 幂等：CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE FUNCTION + 索引 IF NOT EXISTS。
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_case_embeddings (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  ref_type    text NOT NULL DEFAULT 'work_order',   -- 'work_order' | 'business_flow_task'
  ref_id      text NOT NULL DEFAULT '',
  category    text NOT NULL DEFAULT '',
  priority    text NOT NULL DEFAULT '',
  source_text text NOT NULL DEFAULT '',              -- 用于关键词兜底 / 结果展示
  embedding   real[] NOT NULL,                       -- 向量（无 pgvector，JS 端余弦）
  model       text NOT NULL DEFAULT '',              -- 嵌入模型标识，如 zhipu-embedding-3
  vec_dims    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_case_embed_tenant ON ai_case_embeddings (tenant_id, ref_type);
CREATE INDEX IF NOT EXISTS idx_ai_case_embed_updated ON ai_case_embeddings (tenant_id, updated_at);

-- 按 (tenant_id, ref_type, ref_id) 幂等 upsert；供背景预热 / 单条落库复用
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_case_embed_ref ON ai_case_embeddings (tenant_id, ref_type, ref_id);

-- 写入 / 更新向量（SECURITY DEFINER 绕 RLS；只插本表，不触碰其他租户数据）
CREATE OR REPLACE FUNCTION upsert_case_embedding(
  p_tenant_id text, p_ref_type text, p_ref_id text,
  p_category text, p_priority text, p_source_text text,
  p_embedding real[], p_model text, p_vec_dims integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO ai_case_embeddings (tenant_id, ref_type, ref_id, category, priority, source_text, embedding, model, vec_dims, updated_at)
  VALUES (p_tenant_id, p_ref_type, p_ref_id, p_category, p_priority, p_source_text, p_embedding, p_model, p_vec_dims, now())
  ON CONFLICT (tenant_id, ref_type, ref_id) DO UPDATE SET
    category    = EXCLUDED.category,
    priority    = EXCLUDED.priority,
    source_text = EXCLUDED.source_text,
    embedding   = EXCLUDED.embedding,
    model       = EXCLUDED.model,
    vec_dims    = EXCLUDED.vec_dims,
    updated_at  = now();
END;
$$;
GRANT EXECUTE ON FUNCTION upsert_case_embedding(text, text, text, text, text, text, real[], text, integer) TO youfu_app;

-- 显式授予 youfu_app 表级权限（即便 pg_default_acl 已自动授予，这里显式声明更稳妥/可移植）：
-- /ai/similar 与 warmUpTenantEmbeddings 以 youfu_app 身份直读 ai_case_embeddings（不走 SECURITY DEFINER 函数）。
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_case_embeddings TO youfu_app;
GRANT USAGE, SELECT ON SEQUENCE ai_case_embeddings_id_seq TO youfu_app;
