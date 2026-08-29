// §12.3 派单智能推荐（DMR 可解释呈现）
// 确定性评分：技能匹配 60 + 负载归一 40，不依赖 UCB/dispatch_rule（冷启动也有区分度）。
// 诚实口径：无 worker 级满意度数据 → 不编造满意度；技能匹配 = 分类名/码与 skill_tags 子串包含（≥2 字符）。
export interface RecommendWorker {
  id: string;
  name: string;
  skill_tags: unknown;
  load: number;
}

export interface RecommendItem {
  worker_id: string;
  name: string;
  score: number;
  reason: string;
  load: number;
  skill_tags: unknown[];
}

const norm = (s: string) => s.toLowerCase().trim();

// 通用词黑名单：这类标签人人可能有（维修/维护/处理…），不算特征命中，防止分类名被通用词稀释
const GENERIC_TAGS = new Set(['维修', '维护', '处理', '保养', '服务', '修理', 'repair', 'maintain', 'fix', 'service']);

/** 共享前缀长度（同源词根判定：plumber/plumbing → 'plumb' 5 字符） */
export function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** 技能匹配：子串 或 同根前缀（≥4 字符）；通用词不构成特征命中 */
export function hasSkill(categoryName: string, tags: unknown): boolean {
  if (!categoryName || !Array.isArray(tags)) return false;
  const n = norm(categoryName);
  if (n.length < 2) return false;
  return tags.some((t) => {
    const tag = norm(String(t));
    if (tag.length < 2) return false;
    if (GENERIC_TAGS.has(tag) && n !== tag) return false; // 通用词仅当分类名即该词时算命中
    return n.includes(tag) || tag.includes(n) || commonPrefixLen(n, tag) >= 4;
  });
}

/** 综合评分排序：技能命中 60 + 负载归一 40；返回带可解释理由的推荐列表 */
export function buildRecommend(workers: RecommendWorker[], categoryName: string, limit = 5): RecommendItem[] {
  if (!workers.length) return [];
  const maxLoad = Math.max(1, ...workers.map((w) => Number(w.load) || 0));
  return workers
    .map((w) => {
      const load = Number(w.load) || 0;
      const matched = hasSkill(categoryName, w.skill_tags);
      const score = Math.round((matched ? 60 : 0) + 40 * (1 - load / maxLoad));
      const reason = matched
        ? `技能匹配（${categoryName}）· 当前负载 ${load}`
        : `负载最低梯队 · 技能未命中「${categoryName}」`;
      return { worker_id: w.id, name: w.name, score, reason, load, skill_tags: Array.isArray(w.skill_tags) ? w.skill_tags : [] };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
