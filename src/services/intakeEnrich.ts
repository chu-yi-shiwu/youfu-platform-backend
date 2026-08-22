// 报修入口智能补全服务（DMR：最小输入 → 最全工单）
// 纯函数 + 轻量 DB 查询，供 publicReport 复用，亦可单测。
import type { PoolClient } from 'pg';

// 关键词 → 分类 hint（与租户 fault_category 名称对齐）
export const KEYWORD_CATEGORY_HINTS: Array<{ kw: string[]; hint: string }> = [
  { kw: ['空调', '制冷', '制热', '冷气', '暖气'], hint: '空调' },
  { kw: ['水', '漏', '管道', '马桶', '龙头', '排水', '堵'], hint: '水电' },
  { kw: ['网', 'wifi', 'WiFi', '电脑', '网络', '信号'], hint: '网络' },
  { kw: ['门', '锁', '窗', '玻璃'], hint: '门窗' },
  { kw: ['灯', '照明', '插座', '电', '跳闸', '断电'], hint: '照明电工' },
  { kw: ['电梯', '监控', '设备', '机器', '故障'], hint: '设备' },
];

export function matchCategoryHint(description: string): string | undefined {
  for (const rule of KEYWORD_CATEGORY_HINTS) {
    if (rule.kw.some((k) => description.includes(k))) return rule.hint;
  }
  return undefined;
}

// 故障类别推断：精确匹配租户分类名 → 关键词 hint 模糊匹配分类名
export async function resolveFaultCategory(
  client: PoolClient,
  tenantId: string,
  description: string,
): Promise<{ id: string; name: string } | null> {
  const cats = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM fault_category WHERE tenant_id = $1 AND enabled = true`,
    [tenantId],
  );
  for (const c of cats.rows) {
    if (description.includes(c.name)) return { id: c.id, name: c.name };
  }
  const hint = matchCategoryHint(description);
  if (hint) {
    const m = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM fault_category WHERE tenant_id = $1 AND enabled = true AND name ILIKE $2 LIMIT 1`,
      [tenantId, `%${hint}%`],
    );
    if (m.rowCount) return { id: m.rows[0].id, name: m.rows[0].name };
  }
  return null;
}

// 优先级推断：关键词命中紧急语义 → urgent，否则 normal
export function inferPriority(description: string): 'low' | 'normal' | 'urgent' {
  const urgentKw = ['紧急', '漏水', '断电', '停电', '冒烟', '起火', '危险', '停水', '故障', '坏了', '坏', '无法', '不能', '堵塞', '溢', '伤人', '漏电'];
  if (urgentKw.some((k) => description.includes(k))) return 'urgent';
  return 'normal';
}

// 关联资产推断：描述命中资产名/编号 → 绑定（仅在有 hint 时查，限制扫描面）
export async function resolveAsset(
  client: PoolClient,
  tenantId: string,
  description: string,
): Promise<{ id: string; name: string } | null> {
  const hint = matchCategoryHint(description);
  if (!hint) return null;
  const m = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM asset WHERE tenant_id = $1 AND (name ILIKE $2 OR pinyin ILIKE $2) LIMIT 1`,
    [tenantId, `%${hint}%`],
  );
  return m.rowCount ? { id: m.rows[0].id, name: m.rows[0].name } : null;
}
