// basicDataSchema.test.ts —— M0-1/M0-2 修复回归断言。
// D1：TYPES 声明不变式（每类型 columns 含 updated_at → 配合迁移 068 保证 SET 不 500；
//     若未来某表确实无该列，此处会让「条件 SET」路径也被静态门禁+本测试双双拦截）。
// D11：sla_policy 时限 0 < x ≤ 8760（单位小时），越界 422 details[].path。
import { describe, it, expect } from 'vitest';
import type { ZodObject } from 'zod';
import { TYPES } from '../routes/basicData.js';

describe('basicData TYPES 声明不变式（D1 回归防线）', () => {
  it('每个类型的 columns 都包含 updated_at（迁移 068 后 5 表皆应具备）', () => {
    const entries = Object.entries(TYPES);
    expect(entries.length).toBeGreaterThanOrEqual(9);
    for (const [key, def] of entries) {
      expect(def.columns, `${key}.columns`).toContain('updated_at');
      expect(def.columns, `${key}.columns`).toContain('created_at');
    }
  });

  it('insertCols 必须是 columns 的子集（防 SET/INSERT 拼出未声明列）', () => {
    for (const [key, def] of Object.entries(TYPES)) {
      for (const c of def.insertCols) {
        expect(def.columns, `${key}: insertCol ${c}`).toContain(c);
      }
    }
  });
});

describe('sla_policy schema 时限校验（D11 回归）', () => {
  const schema = TYPES.sla_policy.schema as ZodObject<any>;

  it('合法值通过：0.5 / 1 / 24 / 8760', () => {
    for (const v of [0.5, 1, 24, 8760]) {
      const r = schema.safeParse({ name: 'p', response_hours: v, complete_hours: v });
      expect(r.success, `value=${v}`).toBe(true);
    }
  });

  it('未提供时限仍通过（optional 保持）', () => {
    expect(schema.safeParse({ name: 'p' }).success).toBe(true);
  });

  it('0 / 负数 / 8761 / 100000 拒绝', () => {
    for (const v of [0, -1, 8761, 100000]) {
      const r = schema.safeParse({ name: 'p', response_hours: v });
      expect(r.success, `response_hours=${v}`).toBe(false);
      if (!r.success) {
        // 契约：ZodError → errorMiddleware 422 { details: [{ path, msg }] }
        expect(r.error.issues[0].path).toContain('response_hours');
      }
    }
  });

  it('partial 更新路径（PUT .partial()）同样受界约束', () => {
    const partial = schema.partial();
    expect(partial.safeParse({ complete_hours: 0 }).success).toBe(false);
    expect(partial.safeParse({ complete_hours: 8760 }).success).toBe(true);
  });
});
