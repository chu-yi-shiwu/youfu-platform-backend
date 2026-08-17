// pg 驱动对 jsonb 列在部分驱动版本下会返回字符串；统一归一化，避免各模块各自重复定义。
export function safeParseJsonb(v: any): any {
  if (v == null) return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}
