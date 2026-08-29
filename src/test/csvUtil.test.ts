import { describe, it, expect } from 'vitest';
import { parseCsv, csvEscape } from '../services/csvUtil.js';

describe('csvUtil.parseCsv', () => {
  it('解析基础 CSV（含表头与多行）', () => {
    const text = 'a,b,c\n1,2,3\n4,5,6';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('处理双引号转义与内部引号翻倍', () => {
    const text = 'name,note\n"hello ""world""","a,b"';
    expect(parseCsv(text)).toEqual([
      ['name', 'note'],
      ['hello "world"', 'a,b'],
    ]);
  });

  it('处理 CRLF 与 LF 混合换行', () => {
    const text = 'x,y\r\n1,2\n3,4';
    expect(parseCsv(text)).toEqual([
      ['x', 'y'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('过滤完全空行', () => {
    const text = 'a,b\n\n1,2\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('csvUtil.csvEscape', () => {
  it('null/undefined → 空串', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('含逗号/引号/换行 → 加引号并翻倍内部引号', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
  });

  it('普通标量原样输出', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape(123)).toBe('123');
  });

  it('对象/数组经 JSON 序列化（jsonb 列不退化成 [object Object]），并仍按 CSV 规则转义', () => {
    // {a:1} → JSON '{"a":1}' 含引号 → 外层加引号并翻倍内部引号 → '"{""a"":1}"'
    expect(csvEscape({ a: 1 })).toBe('"{""a"":1}"');
    // [1,2] → JSON '[1,2]' 含逗号 → 外层加引号 → '"[1,2]"'
    expect(csvEscape([1, 2])).toBe('"[1,2]"');
  });
});
