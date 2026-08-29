// routes/aiPreview.ts —— 对话发起端推断端点（规则库快路径 + DeepSeek 精排 + 置信度）
// 三层分类架构的"预览"层：用户描述 → 候选/分类/优先级/缺失字段 → 前端确认页
// 快路径：uone_classifier_rules.json（零成本 TF-IDF 关键词）
// 精排：llmInferCategory（DeepSeek，低置信时才调，成本可控）
import { Router } from 'express';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { llmConfigured, llmInferCategory, llmGenConfig, embeddingConfigured, embedText, embeddingModel, cosineSimilarity } from '../services/llm.js';
import { withTenantClient } from '../db/pool.js';
import { getAiFeaturesEnabled, setAiFeaturesEnabled } from '../repo/tenantSettings.js';
import { requireConfigRole } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 快路径规则库（46万数据训练的 TF-IDF 关键词，加载一次）
let RULES: { category: string; prior_count: number; keywords: { w: string; score: number }[] }[] = [];
// 解析路径需兼容 prod/dist 与 dev/src 布局（均位于 backend 根 data/ 下 2 级）；
// tsc 不拷贝非 TS 资源，故必须指向 backend/data/ 而非 dist/data/（旧路径 ../data 在 prod 永远 ENOENT）。
const RULE_CANDIDATES = [
  join(__dirname, '../../data/classifier_rules.json'),
  join(__dirname, '../data/classifier_rules.json'),
];
for (const p of RULE_CANDIDATES) {
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    RULES = Array.isArray(parsed.rules) ? parsed.rules : [];
    break;
  } catch {
    /* try next candidate */
  }
}
if (!RULES.length) {
  console.warn('[aiPreview] classifier rules not loaded (optional fast-path disabled, LLM fallback active)');
}

const router = Router();

// 快路径：关键词加权得分 → top3 候选 + 置信度（大小写不敏感）
function ruleMatch(desc: string) {
  const low = desc.toLowerCase();
  const scored = RULES
    .map((r) => {
      let s = 0;
      for (const k of r.keywords) {
        if (low.includes(k.w.toLowerCase())) s += k.score;
      }
      return { category: r.category, prior: r.prior_count, score: s };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (!scored.length) return null;
  const top = scored[0];
  // 置信度：得分归一化（启发式）
  const conf = Math.min(0.95, 0.45 + top.score * 0.08 + Math.log10(top.prior + 1) * 0.02);
  return { candidates: scored.map((s) => s.category), top: top.category, confidence: Math.round(conf * 100) };
}

// LLM 兜底候选：规则库高频分类 top10（无规则命中时给 LLM 约束）
// 过滤非中文名（UOne 部分分类是雪花 ID，会污染 LLM 判断——实测导致诚实 null）
function fallbackCandidates(): string[] {
  const zh = /^[\u4e00-\u9fff（）()A-Za-z0-9、，。\s·-]+$/;
  return RULES.slice()
    .sort((a, b) => b.prior_count - a.prior_count)
    .filter((r) => zh.test(r.category) && /[\u4e00-\u9fff]/.test(r.category))
    .slice(0, 10)
    .map((r) => r.category);
}

// 租户业务分类候选：从 workflow_def 的 fields options 提取（真实业务分类，LLM 据此识别）
async function tenantCategoryNames(tenantId: string): Promise<string[]> {
  try {
    return await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `SELECT def->'config'->'fields' AS fields FROM workflow_def WHERE tenant_id=$1`,
        [tenantId],
      );
      const names = new Set<string>();
      for (const row of r.rows) {
        const fields = row.fields;
        if (Array.isArray(fields)) {
          for (const f of fields) {
            if (f && Array.isArray(f.options)) f.options.forEach((o: string) => o && names.add(String(o)));
          }
        }
      }
      return Array.from(names).slice(0, 40);
    });
  } catch {
    return [];
  }
}

const previewSchema = z.object({
  description: z.string().min(1).max(500),
  entityType: z.string().optional(), // 可选：限定业务类型（如 repair），不限定则跨业务识别
});

// POST /ai/preview
router.post('/preview', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = previewSchema.parse(req.body);
    const desc = b.description.trim();

    // ① 快路径（零成本）
    const rule = ruleMatch(desc);

    // ② 优先级：LLM 精排优先（候选=租户真实业务分类）→ 规则库高置信兜底 → null
    let result = null;
    const tenantCats = await tenantCategoryNames(tenantId);
    const llmCats = tenantCats.length ? tenantCats : fallbackCandidates();
    if (llmConfigured()) {
      const llm = await llmInferCategory(desc, llmCats);
      if (llm && llm.category) {
        result = {
          category: llm.category,
          candidates: rule ? rule.candidates : [],
          priority: llm.priority || null,
          asset: llm.asset || null,
          confidence: 62,
          method: 'llm',
        };
      }
    }
    if (!result && rule && rule.confidence >= 75) {
      result = { category: rule.top, candidates: rule.candidates, priority: null, confidence: rule.confidence, method: 'rule' };
    }

    if (!result) {
      return res.json({ ok: true, code: 0, result: null, message: '无法识别，请人工选择分类' });
    }
    // 数据管线：推理留痕（喂飞轮——重训数据源）
    try {
      await withTenantClient(tenantId, async (client) => {
        await client.query(
          `INSERT INTO ai_inference_log (tenant_id, description, category, priority, confidence, method, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [tenantId, desc, result.category || '', result.priority || '', result.confidence || 0, result.method || '', res.locals.auth.userId || res.locals.auth.username || ''],
        );
      });
    } catch (e) { console.warn('[aiPreview] inference log fail:', (e as Error).message); /* 日志失败不影响主流程 */ }
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

// 处置建议检索：/ai/similar { description?, category? } → top3 相似案例
// 知识源：uone_knowledge（UOne 10 万条历史，离线预灌）+ 租户自身已完成单（增量）
const similarSchema = z.object({
  description: z.string().max(500).optional(),
  category: z.string().max(100).optional(),
  entityType: z.string().optional(),
});

// 相似案例项（K2 在原有字段上附加 score；前端按契约只读 title/desc/category/priority/source）
interface SimilarItem { title: string; desc: string; category: string; priority: string; source: string; knowledgeId?: number; score?: number; }

// K2 背景预热：把本机构尚未向量化且未在向量库中的历史单补嵌入（best-effort，不阻塞响应）。
// 覆盖两类数据源：① work_orders（报修工单，试点主数据）；② business_flow_tasks（业务流任务）。
async function warmUpTenantEmbeddings(tenantId: string): Promise<void> {
  // 1) 报修工单 work_orders
  const wo = await withTenantClient(tenantId, async (client) => {
    const r = await client.query(
      `SELECT id, title, description, business_type, catalog, fault_type, location, priority
       FROM work_orders
       WHERE tenant_id=$1
         AND NOT EXISTS (
           SELECT 1 FROM ai_case_embeddings e
           WHERE e.tenant_id=$1 AND e.ref_type='work_order' AND e.ref_id=work_orders.id::text
         )
       ORDER BY updated_at DESC LIMIT 20`,
      [tenantId],
    );
    return r.rows;
  });
  for (const row of wo) {
    const text = [row.title, row.description, row.business_type, row.catalog, row.fault_type, row.location]
      .filter(Boolean).join(' ').slice(0, 8000);
    if (!text.trim()) continue;
    const vec = await embedText(text, tenantId);
    if (!vec) break; // key 失效 / 限流 → 停止本批，下次再来
    await withTenantClient(tenantId, async (client) => {
      await client.query(
        `SELECT upsert_case_embedding($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId, 'work_order', String(row.id), row.business_type || row.catalog || '', row.priority || '', text, vec, embeddingModel(), vec.length],
      );
    });
  }
  // 2) 业务流任务 business_flow_tasks（原有逻辑）
  const bft = await withTenantClient(tenantId, async (client) => {
    const r = await client.query(
      `SELECT bft.id, bft.title, COALESCE(bft.data->>'desc','') AS d, bft.entity_type
       FROM business_flow_tasks bft
       WHERE bft.tenant_id=$1 AND bft.status IN ('completed','closed')
         AND NOT EXISTS (
           SELECT 1 FROM ai_case_embeddings e
           WHERE e.tenant_id=$1 AND e.ref_type='business_flow_task' AND e.ref_id=bft.id::text
         )
       ORDER BY bft.updated_at DESC LIMIT 20`,
      [tenantId],
    );
    return r.rows;
  });
  for (const row of bft) {
    const text = [row.entity_type, row.title, row.d].filter(Boolean).join(' ').slice(0, 8000);
    if (!text.trim()) continue;
    const vec = await embedText(text, tenantId);
    if (!vec) break;
    await withTenantClient(tenantId, async (client) => {
      await client.query(
        `SELECT upsert_case_embedding($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId, 'business_flow_task', String(row.id), row.entity_type || '', '', text, vec, embeddingModel(), vec.length],
      );
    });
  }
}

// 合并向量结果与关键词结果：向量优先，按 (source|desc) 去重，截前 3
function mergeSimilar(vector: SimilarItem[], kw: SimilarItem[]): SimilarItem[] {
  const seen = new Set<string>();
  const out: SimilarItem[] = [];
  for (const it of [...vector, ...kw]) {
    const key = (it.source + '|' + (it.desc || it.title || '').slice(0, 40)).replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// 处置建议检索：/ai/similar { description?, category? } → top3 相似案例
// K2（有 embedding key）：语义检索租户自身历史单（隐私/隔离增益）→ 关键词兜底（无 key 时路径不变）
router.post('/similar', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    // I4 灰度总开关：关时诚实降级为空（前端显示「AI 建议未开启」），绝不偷偷启用新 AI 行为
    const aiOn = await getAiFeaturesEnabled(tenantId);
    if (!aiOn) {
      return res.json({ ok: true, code: 0, items: [], vectorEnabled: false, aiDisabled: true });
    }
    const b = similarSchema.parse(req.body);
    const desc = (b.description || '').trim().slice(0, 200);
    const category = (b.category || '').trim().slice(0, 100);

    // K2 向量检索（有 key 时）：嵌入查询 → 租户自身历史单 JS 余弦 top-k
    const vectorItems: SimilarItem[] = [];
    if (embeddingConfigured() && (desc || category)) {
      const queryText = [category, desc].filter(Boolean).join(' ： ');
      const qvec = await embedText(queryText, tenantId);
      if (qvec) {
        // 背景预热：本机构已完成单尚未向量化的，异步补嵌入（best-effort，不阻塞响应）
        warmUpTenantEmbeddings(tenantId).catch((e) => console.warn('[similar] warmup fail:', (e as Error).message));
        const rows = await withTenantClient(tenantId, async (client) => {
          // 规模化护栏：向量底座无 pgvector，相似度在 Node 端对全量 real[] 计算；
          // 若不设上限，租户案例累积到数千行后每次 /ai/similar 都会全表拉入内存 + 全量余弦 O(n)，
          // 内存/CPU 随数据线性膨胀。按 updated_at 取最近 300 条（索引 idx_ai_case_embed_updated 覆盖），
          // 试点期数据量远小于 300，行为完全不变；规模期避免单次请求吃满内存。
          const r = await client.query(
            `SELECT ref_id, ref_type, category, priority, source_text, embedding
             FROM ai_case_embeddings WHERE tenant_id=$1
             ORDER BY updated_at DESC LIMIT 300`,
            [tenantId],
          );
          return r.rows;
        });
        rows
          .map((row) => ({
            title: (row.source_text || '').slice(0, 60),
            desc: row.source_text || '',
            category: row.category || '',
            priority: row.priority || '',
            source: '本机构(语义)',
            score: cosineSimilarity(qvec, (row.embedding as number[]) || []),
          }))
          .filter((x) => (x.score || 0) > 0.3)
          .sort((a, b) => (b.score || 0) - (a.score || 0))
          .slice(0, 3)
          .forEach((x) => vectorItems.push(x));
      }
    }

    // 关键词 / 知识库层（I2，无 key 时仍走这条，路径完全不变）
    const kwItems = await withTenantClient(tenantId, async (client) => {
      const out: SimilarItem[] = [];
      if (category) {
        const r = await client.query(
          `SELECT id, desc_text, title, category, priority FROM uone_knowledge
           WHERE category != '' AND (category ILIKE '%' || $1 || '%' OR $1 ILIKE '%' || category || '%')
           ORDER BY id DESC LIMIT 3`,
          [category],
        );
        r.rows.forEach((row) => out.push({ title: row.title, desc: row.desc_text, category: row.category, priority: row.priority, source: '知识库', knowledgeId: row.id }));
      }
      if (out.length < 3 && desc) {
        const words = desc.match(/[\u4e00-\u9fff]{2,4}/g) || [];
        const key = words.slice(0, 3).join('%');
        if (key) {
          const r = await client.query(
            `SELECT id, desc_text, title, category, priority FROM uone_knowledge
             WHERE desc_text ILIKE '%' || $1 || '%' ORDER BY id DESC LIMIT 2`,
            [key],
          );
          r.rows.forEach((row) => out.push({ title: row.title, desc: row.desc_text, category: row.category, priority: row.priority, source: '知识库', knowledgeId: row.id }));
        }
      }
      if (out.length < 3) {
        const r = await client.query(
          `SELECT title, COALESCE(data->>'desc', '') AS d, entity_type FROM business_flow_tasks
           WHERE tenant_id=$1 AND status IN ('completed','closed') ORDER BY updated_at DESC LIMIT 2`,
          [tenantId],
        );
        r.rows.forEach((row) => out.push({ title: row.title, desc: row.d, category: row.entity_type, priority: '', source: '本机构' }));
      }
      return out;
    });

    const merged = mergeSimilar(vectorItems, kwItems).slice(0, 3);
    return res.json({ ok: true, code: 0, items: merged, vectorEnabled: embeddingConfigured() });
  } catch (e) {
    next(e);
  }
});

export default router;

// AI 反馈闭环（治本）：POST /ai/feedback { action, target_type?, target_id?, payload? }
// 采纳/忽略/处理 → 真实落库 ai_feedback → 数据回流喂飞轮（模数共振闭环）
const feedbackSchema = z.object({
  action: z.enum(['adopt', 'ignore', 'resolve']),
  target_type: z.string().max(40).optional(),
  target_id: z.string().max(80).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

router.post('/feedback', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const actor = res.locals.auth.userId || res.locals.auth.username || 'unknown';
    const b = feedbackSchema.parse(req.body);
    await withTenantClient(tenantId, async (client) => {
      await client.query(
        `INSERT INTO ai_feedback (tenant_id, action, target_type, target_id, payload, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, b.action, b.target_type || 'suggestion', b.target_id || '', JSON.stringify(b.payload || {}), actor],
      );
    });
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// 智能体健康（C1）：GET /ai/agent-stats → 反馈闭环统计 + 待复核 + LLM 状态（全部真实数据）
router.get('/agent-stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const data = await withTenantClient(tenantId, async (client) => {
      // ① 反馈闭环统计
      const fb = await client.query(
        `SELECT action, count(*)::int AS c FROM ai_feedback WHERE tenant_id=$1 GROUP BY action`,
        [tenantId],
      );
      const counts = { adopt: 0, ignore: 0, resolve: 0 };
      fb.rows.forEach((r: any) => { const k = r.action as 'adopt'|'ignore'|'resolve'; counts[k] = r.c; });
      const total = counts.adopt + counts.ignore;
      // ② 待复核：分类缺失的单（时间格式 SQL 端统一，避免 JS Date toString 混乱）
      const rev = await client.query(
        `SELECT id, title, order_no, to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
         FROM work_orders
         WHERE tenant_id=$1 AND (catalog IS NULL OR catalog='') ORDER BY created_at DESC LIMIT 5`,
        [tenantId],
      );
      const revCount = await client.query(
        `SELECT count(*)::int AS c FROM work_orders WHERE tenant_id=$1 AND (catalog IS NULL OR catalog='')`,
        [tenantId],
      );
      return {
        feedback: counts,
        adoptRate: total > 0 ? Math.round((counts.adopt / total) * 100) : null,
        feedbackTotal: total,
        review: { count: revCount.rows[0].c, items: rev.rows.map((r) => ({ id: r.id, title: r.title, orderNo: r.order_no, time: r.created_at || '' })) },
        llmEnabled: llmConfigured(),
      };
    });
    return res.json({ ok: true, code: 0, data });
  } catch (e) {
    next(e);
  }
});

// 配置向导（H1）：POST /ai/gen-config { requirement } → LLM 生成业务配置草稿
const genConfigSchema = z.object({ requirement: z.string().min(2).max(300) });
router.post('/gen-config', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    // I4 灰度总开关：关时诚实降级（返回 draft:null + aiDisabled），绝不偷跑 AI 生成
    const aiOn = await getAiFeaturesEnabled(tenantId);
    if (!aiOn) {
      return res.json({ ok: true, code: 0, draft: null, aiDisabled: true, message: 'AI 配置生成未开启' });
    }
    const b = genConfigSchema.parse(req.body);
    const draft = await llmGenConfig(b.requirement);
    if (!draft) {
      return res.json({ ok: true, code: 0, draft: null, message: '生成失败或未配置 LLM——请稍后重试' });
    }
    return res.json({ ok: true, code: 0, draft });
  } catch (e) {
    next(e);
  }
});

// I4 灰度总开关管理：GET /ai/features（读当前开关）→ 仅 admin/operator
// PUT /ai/features { enabled }（翻转开关，落库 tenant_settings.settings.ai_features_enabled）
router.get('/features', async (req, res, next) => {
  try {
    requireConfigRole(req, res); // 守卫：仅 admin/operator
    const tenantId = res.locals.auth.tenantId;
    const enabled = await getAiFeaturesEnabled(tenantId);
    return res.json({ ok: true, code: 0, enabled });
  } catch (e) {
    next(e);
  }
});

router.put('/features', async (req, res, next) => {
  try {
    requireConfigRole(req, res); // 守卫：仅 admin/operator
    const tenantId = res.locals.auth.tenantId;
    const s = z.object({ enabled: z.boolean() }).parse(req.body);
    const enabled = await setAiFeaturesEnabled(tenantId, s.enabled);
    return res.json({ ok: true, code: 0, enabled });
  } catch (e) {
    next(e);
  }
});
