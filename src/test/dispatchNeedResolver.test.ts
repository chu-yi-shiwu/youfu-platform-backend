/**
 * 「派单需求解析器」测试 —— 按技能派单的通用化地基
 *
 * 【为什么有这份测试】
 *   按技能派单原来的写法是**工单专属且写死的**：`workOrder.ts:451` 把 `body.skill_tags`
 *   直接塞给派单引擎，前端从不传 ⇒ 恒空 ⇒ `match.skill_tags` 恒不命中、
 *   `pickWorker` 兜底时技能完全不参与（`dispatch.ts:87-90` / `workOrder.ts:160`）。
 *   修它的方式不应该是"在工单路由里多查一次 fault_category"——那样每来一种
 *   可派单实体（巡检、保养…）就得再写死一次。
 *
 *   本文件锁的是**抽象**：需求（Need）由「按实体类型注册的解析器链」产出，
 *   派单引擎与规则表一行不动。
 *
 * 【设计要点（鉴别力）】
 *   - 优先级 = 注册表数组顺序，第一条"说了话"的生效；显式 `[]` 是"明确无要求"，
 *     必须能压住派生（否则配了分类技能的租户规则会大面积落空，且静默）。
 *   - 通用性用"注册一个新实体类型"来证明：不碰 dispatch.ts、不碰 dispatch_rule。
 *   - 影子/实派同源：同一入参 ⇒ 同一产出（这两条路径此前各造各的 need，靠 8 条
 *     测试看守潜在分叉；收敛到同一函数后，分叉在结构上不再可能）。
 *
 * 【诚实边界】
 *   - fake client 组验证的是**合并语义**（纯逻辑，可机读）；
 *     真库组（PGlite）验证 SQL 真能跑通 + 停用分类不派生。
 *   - PGlite 无 youfu_app 角色/RLS，同项目既有约定，不建 RLS。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// 被 import 的模块尚不存在 —— 这是 TDD 的 Red 阶段，测试必须先红。
import {
  NEED_RESOLVER_REGISTRY,
  resolveNeed,
  catalogSkillTagsResolver,
  explicitSkillTagsResolver,
  type NeedResolveInput,
  type NeedLookupClient,
} from '../engine/dispatch/needResolver.js';

// ---- fake client：按 SQL 子串分流，记录调用以便断言 ----
function makeFakeClient(
  rowsByKey: Record<string, string[] | null>,
): NeedLookupClient & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes('fault_category')) {
        const code = String(params[1] ?? '');
        const tags = rowsByKey[code];
        return { rows: tags == null ? [] : [{ skill_tags: JSON.stringify(tags) }] };
      }
      return { rows: [] };
    },
  };
}

const BASE: NeedResolveInput = {
  tenantId: 't-need',
  entityType: 'work_order',
  business_type: 'repair',
  priority: 'urgent',
};

describe('A. 合并语义（优先级 = 注册表顺序）', () => {
  it('A1 调用方显式传了 skill_tags ⇒ 以显式为准，派生不覆盖', async () => {
    const c = makeFakeClient({ hvac: ['制冷'] });
    const need = await resolveNeed({ ...BASE, catalog: 'hvac', skill_tags: ['电工'] }, c);
    expect(need.skill_tags).toEqual(['电工']);
  });

  it('A2 显式空数组 = 明确"无技能要求"，压住派生（防规则静默落空）', async () => {
    const c = makeFakeClient({ hvac: ['制冷'] });
    const need = await resolveNeed({ ...BASE, catalog: 'hvac', skill_tags: [] }, c);
    expect(need.skill_tags).toEqual([]);
  });

  it('A3 未传 skill_tags 且分类配了技能 ⇒ 派生出来', async () => {
    const c = makeFakeClient({ hvac: ['制冷', '电工'] });
    const need = await resolveNeed({ ...BASE, catalog: 'hvac' }, c);
    expect(need.skill_tags).toEqual(['制冷', '电工']);
  });

  it('A4 分类没配技能 ⇒ undefined（与改动前行为完全一致，零回归）', async () => {
    const c = makeFakeClient({ hvac: [] });
    const need = await resolveNeed({ ...BASE, catalog: 'hvac' }, c);
    expect(need.skill_tags).toBeUndefined();
  });

  it('A5 没有 catalog ⇒ undefined 且不查库（不打扰无分类单）', async () => {
    const c = makeFakeClient({});
    const need = await resolveNeed({ ...BASE }, c);
    expect(need.skill_tags).toBeUndefined();
    expect(c.calls.filter((x) => x.sql.includes('fault_category')).length).toBe(0);
  });

  it('A6 分类在库里不存在 ⇒ undefined，不抛错（建单不能被派单拖挂）', async () => {
    const c = makeFakeClient({});
    const need = await resolveNeed({ ...BASE, catalog: 'not-exist' }, c);
    expect(need.skill_tags).toBeUndefined();
  });

  it('A7 business_type / priority 原样直通，不被解析器吃掉', async () => {
    const c = makeFakeClient({});
    const need = await resolveNeed({ ...BASE, catalog: 'hvac' }, c);
    expect(need.business_type).toBe('repair');
    expect(need.priority).toBe('urgent');
  });
});

describe('B. 模块化：换实体 = 注册一个解析器，引擎不动', () => {
  it('B1 未注册的实体类型 ⇒ 不抛错，退化为直通需求', async () => {
    const c = makeFakeClient({});
    const need = await resolveNeed({ ...BASE, entityType: 'inspection' }, c);
    expect(need.business_type).toBe('repair');
    expect(need.skill_tags).toBeUndefined();
  });

  it('B2 注册新实体类型后，用新解析器产出需求（dispatch.ts 一行未改）', async () => {
    const seen: NeedResolveInput[] = [];
    NEED_RESOLVER_REGISTRY.inspection = [
      async (input) => {
        seen.push(input);
        return { skill_tags: ['巡检-A'] };
      },
    ];
    try {
      const c = makeFakeClient({});
      const need = await resolveNeed({ ...BASE, entityType: 'inspection' }, c);
      expect(need.skill_tags).toEqual(['巡检-A']);
      expect(seen).toHaveLength(1);
    } finally {
      delete NEED_RESOLVER_REGISTRY.inspection;
    }
  });

  it('B3 注册表里 work_order 至少含「显式直通」与「分类派生」两个解析器', () => {
    const list = NEED_RESOLVER_REGISTRY.work_order ?? [];
    expect(list).toContain(explicitSkillTagsResolver);
    expect(list).toContain(catalogSkillTagsResolver);
    // 顺序即优先级：显式必须排在派生之前
    expect(list.indexOf(explicitSkillTagsResolver)).toBeLessThan(
      list.indexOf(catalogSkillTagsResolver),
    );
  });

  it('B4 解析器抛错不炸调用方（降级为未派生，不让建单失败）', async () => {
    NEED_RESOLVER_REGISTRY.boom = [
      async () => {
        throw new Error('resolver down');
      },
    ];
    try {
      const c = makeFakeClient({});
      const need = await resolveNeed({ ...BASE, entityType: 'boom' }, c);
      expect(need.skill_tags).toBeUndefined();
      expect(need.business_type).toBe('repair');
    } finally {
      delete NEED_RESOLVER_REGISTRY.boom;
    }
  });
});

describe('C. 影子/实派同源（收敛到同一入口后，结构上不可能分叉）', () => {
  it('C1 同一入参 ⇒ 同一产出（实派与影子共用 resolveNeed）', async () => {
    const a = await resolveNeed({ ...BASE, catalog: 'hvac' }, makeFakeClient({ hvac: ['制冷'] }));
    const b = await resolveNeed({ ...BASE, catalog: 'hvac' }, makeFakeClient({ hvac: ['制冷'] }));
    expect(a).toEqual(b);
  });

  it('C2 派生只认租户自己的分类（tenant_id 进 SQL 参数）', async () => {
    const c = makeFakeClient({ hvac: ['制冷'] });
    await resolveNeed({ ...BASE, catalog: 'hvac' }, c);
    const q = c.calls.find((x) => x.sql.includes('fault_category'));
    expect(q).toBeTruthy();
    expect(q!.params[0]).toBe('t-need');
    expect(q!.params[1]).toBe('hvac');
  });
});

// ---- 真库组：证明 SQL 真能跑，且停用分类不参与派生 ----
describe('D. PGlite 真库：分类技能真读得到', () => {
  let db: any;
  let client: NeedLookupClient;

  beforeAll(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite();
    await db.exec(`
      CREATE TABLE fault_category (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id VARCHAR(64) NOT NULL,
        code VARCHAR(64) NOT NULL,
        name VARCHAR(128) NOT NULL,
        sort INT NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        skill_tags JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // 刻意插一条**同 code、不同租户、不同技能**的行：
    // 若 SQL 漏掉 tenant_id 过滤，LIMIT 1 会先撞上 t-need 这条 ⇒ D4 必红（不留侥幸空间）。
    await db.query(
      `INSERT INTO fault_category (tenant_id, code, name, enabled, skill_tags) VALUES
       ($1,'hvac','空调',true,$2::jsonb),
       ($1,'plumb','水暖',true,NULL),
       ($1,'old','停用分类',false,$3::jsonb),
       ($4,'hvac','别的租户空调',true,$5::jsonb)`,
      [
        't-need',
        JSON.stringify(['制冷']),
        JSON.stringify(['旧技能']),
        't-other',
        JSON.stringify(['别的技能']),
      ],
    );
    client = {
      async query(sql: string, params: unknown[] = []) {
        const r = await db.query(sql, params as any[]);
        return { rows: r.rows ?? [] };
      },
    };
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('D1 分类配了技能 ⇒ 真库读得到并派生', async () => {
    const need = await resolveNeed({ ...BASE, catalog: 'hvac' }, client);
    expect(need.skill_tags).toEqual(['制冷']);
  });

  it('D2 分类 skill_tags 为 NULL ⇒ 不派生（零回归）', async () => {
    const need = await resolveNeed({ ...BASE, catalog: 'plumb' }, client);
    expect(need.skill_tags).toBeUndefined();
  });

  it('D3 停用分类不参与派生（与 intakeOptions 的 enabled=true 口径一致）', async () => {
    const need = await resolveNeed({ ...BASE, catalog: 'old' }, client);
    expect(need.skill_tags).toBeUndefined();
  });

  it('D4 跨租户隔离：同名分类各读各的（t-other 不得拿到 t-need 的技能）', async () => {
    const mine = await resolveNeed({ ...BASE, tenantId: 't-need', catalog: 'hvac' }, client);
    const other = await resolveNeed({ ...BASE, tenantId: 't-other', catalog: 'hvac' }, client);
    expect(mine.skill_tags).toEqual(['制冷']);
    expect(other.skill_tags).toEqual(['别的技能']);
  });
});
