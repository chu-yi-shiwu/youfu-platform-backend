// 单资产直线折旧（2026-11-17）：统计接口与资产详情共用同一套口径，禁止两处各算一套。
export interface DepreciationSource {
  price?: unknown;
  purchase_date?: unknown;
  useful_life_months?: unknown;
  status?: string | null;
}

export interface AssetDepreciation {
  method: 'straight_line';
  months_used: number;
  monthly: number;
  accumulated: number;
  net: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 仅当资产同时具备 购置金额 / 购置日期 / 折旧年限 时返回结果；
 * 缺任一字段返回 null，避免把“未配置”误算成 0 净值。
 * 已处置资产不计提（处置价值以 residual_value 留痕为准）。
 */
export function computeAssetDepreciation(row: DepreciationSource, asOf: Date = new Date()): AssetDepreciation | null {
  if (row.status === 'disposed') return null;
  if (row.price === null || row.price === undefined || row.price === '') return null;
  if (!row.purchase_date) return null;
  const life = Number(row.useful_life_months);
  const price = Number(row.price);
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(life) || life <= 0) return null;
  const pd = new Date(String(row.purchase_date));
  if (Number.isNaN(pd.getTime())) return null;

  let months = (asOf.getFullYear() - pd.getFullYear()) * 12 + (asOf.getMonth() - pd.getMonth());
  if (asOf.getDate() < pd.getDate()) months -= 1;
  months = Math.max(0, months);

  const monthly = price / life;
  const accumulated = Math.min(price, monthly * months);
  return {
    method: 'straight_line',
    months_used: months,
    monthly: round2(monthly),
    accumulated: round2(accumulated),
    net: round2(price - accumulated),
  };
}
