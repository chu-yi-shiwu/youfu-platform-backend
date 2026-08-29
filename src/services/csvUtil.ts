// 共享 CSV 工具（R18 DRY 抽取）：被 asset/material/basicData/equipment/feedback 等模块复用。
// parseCsv：标准 RFC4180 风格解析（支持双引号转义、CRLF/LF）。
// csvEscape：单元格转义（含逗号/引号/换行时加引号并把内部引号翻倍），null/undefined 输出空串。

/** 解析 CSV 文本为二维字符串数组（首行为表头，空行过滤）。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

/**
 * CSV 单元格转义：含逗号/引号/换行则加引号并把内部引号翻倍；null/undefined → 空串。
 * 对象/数组（如 jsonb 列 default_fields）经 JSON.stringify 序列化，避免 String({}) 变成 "[object Object]" 损坏数据。
 */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // R5-001 CSV 公式注入防护：以 = + - @ 开头的单元格在 Excel 中会被当公式执行（如 =cmd|...|calc），
  // 前置单引号 neutral（Excel 将单引号开头的单元格视为纯文本）。
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
