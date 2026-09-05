// #938 展示层映射配置化：/api/v1/meta/labels —— 展示标签字典（平台级，公开端点）。
// 各端（FE/mp）状态/来源/业务类型/优先级中文名从 label_dict 拉取，
// 改标签零代码（UPDATE label_dict 即生效）；端点免鉴权——展示标签非敏感。
import { Router } from 'express';
import pool from '../db/pool.js';

const router = Router();

// 内存缓存 60s：字典极低频变化，挡住全端启动风暴；改字典后至多 60s 全量生效。
let cache: { at: number; data: Record<string, Record<string, string>> } | null = null;
const CACHE_MS = 60_000;

router.get('/meta/labels', async (_req, res, next) => {
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      const { rows } = await pool.query<{ scope: string; key: string; label: string }>(
        'SELECT scope, key, label FROM label_dict ORDER BY scope, sort, key',
      );
      const labels: Record<string, Record<string, string>> = {};
      for (const r of rows) {
        (labels[r.scope] ??= {})[r.key] = r.label;
      }
      cache = { at: Date.now(), data: labels };
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ ok: true, labels: cache.data });
  } catch (err) {
    next(err);
  }
});

export default router;
