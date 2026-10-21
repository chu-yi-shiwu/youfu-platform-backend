// 派单「需求解析器」——把「业务对象 → 派单需求(Need)」这一步从具体业务里抽出来。
//
// 为什么有这个文件：
//   此前技能维度是**工单专属且写死**的：workOrder.ts 直接把 body.skill_tags 塞给派单引擎，
//   而前端从不传 ⇒ 恒空 ⇒ dispatch.ts:87-90 的 match.skill_tags 恒不命中、
//   workOrder.ts:160 的 pickWorker 兜底时技能完全不参与。
//   修法不应该是"在工单路由里多查一次 fault_category"——那样每来一种可派单实体
//   （巡检、保养、…）就得再写死一次，派单引擎也要跟着认识新概念。
//
// 抽象：
//   业务实体 + payload ──NEED_RESOLVER_REGISTRY[entityType]──▶ Need ──▶ dispatch engine
//                            （可插拔扩展点）                      （纯函数，一行不动）
//
// 两条边界，改动时必须守住：
//   ① Need 的字段名一个都不改。dispatch.ts:17-18 已写明字段名与 DB jsonb、前端表单、
//      路由层保持 snake_case 一致以防隐性契约错位；dispatch_rule.match_json / strategy_json
//      的**存量数据**就用 skill_tags，改名会让客户已配好的规则全部失配（不可逆）。
//      ⇒ "通用"体现在来源可插拔，不体现在换字段名。
//   ② 优先级 = 注册表数组顺序，第一条"说了话"的生效。显式 [] 表示"明确无技能要求"，
//      必须能压住派生——否则配了分类技能的租户规则会大面积落空，且完全静默。
//
// 可配置 vs 可插拔，各管一段（与 DISPATCH_STRATEGY_REGISTRY 同一套惯例）：
//   · 「哪个故障分类需要什么技能」= 运营在分类维护页配 fault_category.skill_tags，不发版；
//   · 「从哪儿派生技能」= 代码往注册表注册一个 resolver。
import type { Need } from '../dispatch.js';

export type { Need };

/** 解析入参：业务实体的原始上下文（不含任何工单专属语义之外的字段）。 */
export interface NeedResolveInput {
  tenantId: string;
  /** 实体类型，决定用哪条解析器链（'work_order' / 将来的 'inspection' …）。 */
  entityType: string;
  business_type?: string;
  priority?: string | null;
  /** 调用方显式指定的技能要求；null/undefined = 没说，[] = 明确无要求。 */
  skill_tags?: string[] | null;
  /** 目录/故障分类码（work_orders.catalog，001_init.sql 起就有）。 */
  catalog?: string | null;
}

/** 最小查询接口（duck typing）：PoolClient / PGlite / fake 都能塞进来。 */
export interface NeedLookupClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * 解析器：返回 undefined = "这一条没话说"，交给链上下一个。
 * 返回 { skill_tags: [...] }（含空数组）= "这一条说了话"，链到此为止。
 */
export type NeedResolver = (
  input: NeedResolveInput,
  client: NeedLookupClient,
) => Promise<Partial<Need> | null | undefined>;

/** ① 显式直通：调用方明确传了就以它为准（尊重明确意图，派生不得覆盖）。 */
export const explicitSkillTagsResolver: NeedResolver = async (input) =>
  input.skill_tags == null ? undefined : { skill_tags: input.skill_tags };

/** jsonb 防御性解析：NULL / 非数组 / 含非字符串元素一律降级，不让脏数据炸派单。 */
function parseSkillTags(raw: unknown): string[] | undefined {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(v)) return undefined;
  const tags = v.filter((t): t is string => typeof t === 'string' && t.length > 0);
  return tags.length > 0 ? tags : undefined;
}

/** ② 目录派生：故障分类上配了什么技能，这张单就要什么技能（运营可配，用户零感知）。 */
export const catalogSkillTagsResolver: NeedResolver = async (input, client) => {
  const catalog = input.catalog;
  if (!catalog) return undefined;
  const r = await client.query(
    `SELECT skill_tags FROM fault_category
      WHERE tenant_id = $1 AND code = $2 AND enabled = true
      LIMIT 1`,
    [input.tenantId, catalog],
  );
  const tags = parseSkillTags(r.rows[0]?.skill_tags);
  return tags ? { skill_tags: tags } : undefined;
};

/**
 * 解析器注册表：实体类型 → 解析器链（数组顺序即优先级）。
 * 新增一种可派单实体 = 在这里加一个键，dispatch.ts / dispatch_rule / 模型层一行不改。
 */
export const NEED_RESOLVER_REGISTRY: Record<string, NeedResolver[]> = {
  work_order: [explicitSkillTagsResolver, catalogSkillTagsResolver],
};

/**
 * 解析派单需求。**实派与影子都必须走这个函数**——此前两侧各造各的 need
 * （workOrder.ts:123 带 skill_tags、k2Shadow.ts:217 不带），靠测试看守潜在分叉；
 * 收敛到同一入口后，分叉在结构上不再可能。
 */
export async function resolveNeed(
  input: NeedResolveInput,
  client: NeedLookupClient,
): Promise<Need> {
  const need: Need = {
    business_type: input.business_type,
    priority: input.priority ?? undefined,
  };
  const chain = NEED_RESOLVER_REGISTRY[input.entityType] ?? [];
  for (const resolve of chain) {
    try {
      const got = await resolve(input, client);
      if (got && got.skill_tags !== undefined) {
        need.skill_tags = got.skill_tags;
        break;
      }
    } catch (e) {
      // 单个解析器故障不得拖挂建单：降级为"这一条没话说"，并留痕（E3 不静默失败）。
      console.warn(
        `[dispatch.needResolver] resolver failed on ${input.entityType} ` +
          `(tenant=${input.tenantId}): ${(e as Error)?.message ?? e}`,
      );
    }
  }
  return need;
}
