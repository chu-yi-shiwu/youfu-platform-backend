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

/** CSV 字段定义：label 为导出表头（中文），key 为落库列；export/parse 处理枚举、日期、名称映射。 */
export interface CsvField {
  key: string;
  label: string;
  required?: boolean;
  export?: (row: any) => unknown;
  parse?: (v: string) => unknown;
}

/** 导出表头（中文）。 */
export function csvHeader(fields: readonly CsvField[]): string {
  return fields.map((f) => f.label).join(',');
}

/** 导出一行（中文表头顺序）。 */
export function csvRowLine(row: any, fields: readonly CsvField[]): string {
  return fields.map((f) => csvEscape(f.export ? f.export(row) : row?.[f.key])).join(',');
}

/**
 * 导入表头映射：同时兼容中文 label 与英文 key（旧模板不报废）。
 * 返回 列索引 → 字段定义；未识别列忽略。
 */
export function csvHeaderMap(headers: string[], fields: readonly CsvField[]): Map<number, CsvField> {
  const map = new Map<number, CsvField>();
  headers.forEach((h, i) => {
    const head = String(h || '').trim();
    const f = fields.find((x) => x.label === head || x.key === head);
    if (f) map.set(i, f);
  });
  return map;
}

/** 导入一行：按表头映射解析；空串保持空串（由调用方决定 null/default）。 */
export function csvParseRow(row: string[], headerMap: Map<number, CsvField>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  headerMap.forEach((f, i) => {
    const raw = row[i] ?? '';
    out[f.key] = f.parse ? f.parse(String(raw)) : raw;
  });
  return out;
}

/** 日期/时间导出：只取日期（YYYY-MM-DD），避免 ISO T/Z 裸串。 */
export function csvDateOnly(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 日期时间导出：本地化 YYYY-MM-DD HH:mm:ss。 */
export function csvDateTime(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 布尔导出：是 / 否。 */
export function csvBool(v: unknown): string {
  if (v === true || v === 'true' || v === 1 || v === '1') return '是';
  if (v === false || v === 'false' || v === 0 || v === '0') return '否';
  return '';
}
