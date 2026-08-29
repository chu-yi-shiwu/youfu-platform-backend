-- 处置建议知识库（UOne 历史训练集预灌 + 优服家自身已完成单增量）
CREATE TABLE IF NOT EXISTS uone_knowledge (
  id        bigserial PRIMARY KEY,
  desc_text text NOT NULL DEFAULT '',
  title     text NOT NULL DEFAULT '',
  category  text NOT NULL DEFAULT '',
  priority  text NOT NULL DEFAULT '',
  location  text NOT NULL DEFAULT '',
  source    text NOT NULL DEFAULT 'uone'
);
CREATE INDEX IF NOT EXISTS idx_uone_knowledge_category ON uone_knowledge (category);
CREATE INDEX IF NOT EXISTS idx_uone_knowledge_desc ON uone_knowledge (desc_text);
