-- 073_label_dict.sql —— #938 展示层映射配置化（B 正档：进字典表）。
-- 平台级（无租户）展示标签字典：各端（FE/mp/H5）状态/来源/业务类型/优先级中文名
-- 由硬编码升级为配置驱动——改标签零代码（UPDATE label_dict 即生效）。
-- 平台表先例（050/052）：平台侧元数据不经 RLS，直接 GRANT SELECT 控权。
-- 全部 IF NOT EXISTS / ON CONFLICT DO NOTHING 幂等；DDL 须 superuser 执行：
--   sudo -u postgres psql -d youfu -f 073_label_dict.sql

CREATE TABLE IF NOT EXISTS label_dict (
  id         serial PRIMARY KEY,
  scope      text NOT NULL,                 -- 标签域：wo_status / source / business_type / priority
  key        text NOT NULL,                 -- 枚举值（draft / wechat / inspection_task ...）
  label      text NOT NULL,                 -- 中文展示名
  sort       int NOT NULL DEFAULT 0,        -- 展示排序（下拉选项等场景）
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_label_dict_scope_key ON label_dict (scope, key);
CREATE INDEX IF NOT EXISTS idx_label_dict_scope ON label_dict (scope, sort);
-- 平台级只读字典：各端仅读（写走 superuser/运维通道，杜绝租户篡改全局标签）
GRANT SELECT ON label_dict TO youfu_app;
GRANT USAGE, SELECT ON SEQUENCE label_dict_id_seq TO youfu_app;

-- ============ 种子数据（与 FE/mp 现有硬编码逐值对齐，迁移零观感变化） ============
-- ① 工单状态（搬自 FE templates.ts STATUS_LABEL_FALLBACK 全集 19 条）
INSERT INTO label_dict (scope, key, label, sort) VALUES
  ('wo_status', 'draft',            '草稿',     10),
  ('wo_status', 'created',          '已建单',   20),
  ('wo_status', 'pending_accept',   '待受理',   30),
  ('wo_status', 'pending_dispatch', '待派单',   40),
  ('wo_status', 'assigned',         '已派单',   50),
  ('wo_status', 'claim_hall',       '抢单大厅', 60),
  ('wo_status', 'processing',       '处理中',   70),
  ('wo_status', 'paused',           '暂停中',   80),
  ('wo_status', 'suspended',        '已挂起',   90),
  ('wo_status', 'pending_review',   '待审核',   100),
  ('wo_status', 'review_passed',    '审核通过', 110),
  ('wo_status', 'transporting',     '运送中',   120),
  ('wo_status', 'accompanying',     '陪护中',   130),
  ('wo_status', 'auditing',         '待审核',   140),
  ('wo_status', 'review',           '复核中',   150),
  ('wo_status', 'completed',        '已完成',   160),
  ('wo_status', 'closed',           '已关闭',   170),
  ('wo_status', 'cancelled',        '已撤销',   180),
  ('wo_status', 'evaluated',        '已评价',   190)
ON CONFLICT (scope, key) DO NOTHING;

-- ② 来源（Dashboard SOURCE_LABEL）
INSERT INTO label_dict (scope, key, label, sort) VALUES
  ('source', 'wechat',  '微信', 10),
  ('source', 'backend', '后台', 20),
  ('source', 'phone',   '电话', 30)
ON CONFLICT (scope, key) DO NOTHING;

-- ③ 业务类型（mp 工作台三源归一化：work_order / inspection_task / transport_task）
INSERT INTO label_dict (scope, key, label, sort) VALUES
  ('business_type', 'work_order',      '工单',     10),
  ('business_type', 'inspection_task', '巡检任务', 20),
  ('business_type', 'transport_task',  '运送任务', 30)
ON CONFLICT (scope, key) DO NOTHING;

-- ④ 优先级
INSERT INTO label_dict (scope, key, label, sort) VALUES
  ('priority', 'normal',   '普通', 10),
  ('priority', 'urgent',   '加急', 20),
  ('priority', 'critical', '危急', 30),
  ('priority', 'low',      '低',   40)
ON CONFLICT (scope, key) DO NOTHING;
