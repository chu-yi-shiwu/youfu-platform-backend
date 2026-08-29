// SEC-735 回归测试：锁定本轮审查修复的 2 处安全缺陷，防止回退。
import { describe, it, expect } from 'vitest';
import { extractCreds, safeEqualHex } from '../middleware/openApiAuth.js';
import * as authMod from '../middleware/auth.js';
import { isValidTenantDirName } from '../routes/upload.js';
import { isPerTenantSummaryAllowed } from '../routes/openApi.js';
import { filterTransportExtraCols } from '../routes/transport.js';
import { assertSafeTenantId } from '../db/pool.js';
import { buildDataSetClauses } from '../engine/transition.js';

// 最小 Request mock：extractCreds 仅依赖 req.header(name)
function mockReq(headers: Record<string, string>) {
  return { header: (n: string) => headers[n] } as any;
}

describe('SEC-735-LATENT openApiAuth Bearer 解析（secret 含冒号）', () => {
  it('仅切首个冒号，secret 中的冒号被完整保留', () => {
    const header = 'Bearer ' + 'mykey' + ':' + 'sec:ret:with:colons';
    const creds = extractCreds(mockReq({ Authorization: header }));
    expect(creds).not.toBeNull();
    expect(creds!.key).toBe('mykey');
    expect(creds!.secret).toBe('sec:ret:with:colons');
  });
  it('X-App-Key / X-App-Secret 头仍可用', () => {
    const creds = extractCreds(mockReq({ 'X-App-Key': 'k', 'X-App-Secret': 's' }));
    expect(creds).toEqual({ key: 'k', secret: 's' });
  });
  it('Bearer key:（secret 为空）→ 返回 null，不再恒 AUTH_004', () => {
    const creds = extractCreds(mockReq({ Authorization: 'Bearer key:' }));
    expect(creds).toBeNull();
  });
  it('无凭据 → 返回 null', () => {
    expect(extractCreds(mockReq({}))).toBeNull();
  });
});

describe('SEC-735-MEDIUM 上传租户目录名校验（防路径穿越）', () => {
  it('合法租户 slug 通过', () => {
    expect(isValidTenantDirName('t-verification')).toBe(true);
    expect(isValidTenantDirName('tenant_1')).toBe(true);
    expect(isValidTenantDirName('org-abc123')).toBe(true);
  });
  it('含路径分隔符或上级引用 → 拒绝', () => {
    expect(isValidTenantDirName('../..')).toBe(false);
    expect(isValidTenantDirName('a/b')).toBe(false);
    expect(isValidTenantDirName('a\\b')).toBe(false);
    expect(isValidTenantDirName('..a')).toBe(false);
    expect(isValidTenantDirName('a/../b')).toBe(false);
  });
  it('空值 / 非字符串 → 拒绝', () => {
    expect(isValidTenantDirName('')).toBe(false);
  });
});

// F-A1（三轮 QA 第一轮）：开放 API 按 tenant_id 下钻单租户聚合的 scope 闸门。
// 防「任意持有 summary:read 的 app 越权读取其他租户聚合数据」的横向越权。
describe('F-A1 开放 API 单租户聚合 scope 闸门', () => {
  it('无 tenant_id（全量聚合）→ 默认允许', () => {
    expect(isPerTenantSummaryAllowed(['summary:read'])).toBe(true);
    expect(isPerTenantSummaryAllowed(['summary:read'], undefined)).toBe(true);
  });
  it('默认 summary:read 带 tenant_id → 禁止（防跨租户泄露）', () => {
    expect(isPerTenantSummaryAllowed(['summary:read'], 't-other')).toBe(false);
  });
  it('summary:read:* 带 tenant_id → 允许（平台运营 app）', () => {
    expect(isPerTenantSummaryAllowed(['summary:read', 'summary:read:*'], 't-other')).toBe(true);
  });
  it('通配 * 带 tenant_id → 允许', () => {
    expect(isPerTenantSummaryAllowed(['*'], 't-other')).toBe(true);
  });
  it('无关 scope 带 tenant_id → 禁止', () => {
    expect(isPerTenantSummaryAllowed(['something:else'], 't-other')).toBe(false);
  });
});

// F-A2（三轮 QA 第一轮）：运送 transition 列名白名单——防任意用户输入被插值进 SQL 列名位。
describe('F-A2 运送 transition 列名白名单（防列名注入）', () => {
  it('仅放行已知列名，丢弃任意用户输入列名', () => {
    const r = filterTransportExtraCols({
      depart_at: 'now()',
      carrier: 'x',
      evil: "'; DROP TABLE transport_order;--",
      status: 'hacked',
    });
    expect(r.parameterized).toEqual(['carrier']);
    expect(r.nowCols).toEqual(['depart_at']);
  });
  it('now() 字面量列与参数化列正确分流', () => {
    const r = filterTransportExtraCols({ arrive_at: 'now()', sign_at: 'now()', depart_at: '2026-01-01' });
    expect(r.nowCols.sort()).toEqual(['arrive_at', 'sign_at']);
    expect(r.parameterized).toEqual(['depart_at']);
  });
  it('空对象安全返回', () => {
    const r = filterTransportExtraCols({});
    expect(r.parameterized).toEqual([]);
    expect(r.nowCols).toEqual([]);
  });
});

// RLS 租户隔离：assertSafeTenantId 白名单——防 SET LOCAL app.tenant_id 注入（系统级铁底线）。
describe('RLS 租户隔离：assertSafeTenantId 白名单', () => {
  it('合法租户标识符通过', () => {
    expect(assertSafeTenantId('t-verification')).toBe('t-verification');
    expect(assertSafeTenantId('tenant_1')).toBe('tenant_1');
    expect(assertSafeTenantId('org.abc-123')).toBe('org.abc-123');
  });
  it('含路径分隔符/空格/引号 → 抛错（防 SET LOCAL 注入）', () => {
    expect(() => assertSafeTenantId('a/b')).toThrow();
    expect(() => assertSafeTenantId('a\\b')).toThrow();
    expect(() => assertSafeTenantId("a' OR '1'='1")).toThrow();
    expect(() => assertSafeTenantId('a b')).toThrow();
  });
  it('超长/空 → 抛错', () => {
    expect(() => assertSafeTenantId('')).toThrow();
    expect(() => assertSafeTenantId('a'.repeat(65))).toThrow();
  });
});

// F-C1（加深轮）：transitionEntity data(jsonb) 路径键注入——修 🔴 SQL 注入。
// 用户 data 的 key 完全可控，原实现把 key 字符串插值进 jsonb_set 的 '{key}' 路径，
// 含单引号的 key 即可逃逸字符串字面量执行任意 SQL。修复后路径键必须参数化为 text[]。
describe('F-C1 transitionEntity jsonb 路径键注入防护', () => {
  it('恶意 key 整体参数化，不出现在 SQL 字符串中', () => {
    const values: unknown[] = ['id', 'tid', 'target'];
    const setClauses = buildDataSetClauses(
      { "a'}); DROP TABLE business_flow_tasks;--": 'now()', normal: 'x' },
      values,
    );
    // 恶意 key 必须作为 text[] 参数整体进入 values，而非拼进 SQL
    expect(values).toContain("a'}); DROP TABLE business_flow_tasks;--");
    const sql = setClauses.join(' ');
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).toMatch(/ARRAY\[\$\d+\]::text\[\]/);
    expect(sql).not.toMatch(/\}'\)/); // 不应残留裸的闭合引号注入片段
  });
  it('普通 data 合并走 jsonb 参数化（无害）', () => {
    const values: unknown[] = ['id', 'tid', 'target'];
    const setClauses = buildDataSetClauses({ note: 'hello' }, values);
    expect(setClauses.some((s) => s.includes('data || $'))).toBe(true);
    expect(values[3]).toBe('{"note":"hello"}');
  });
  it('now() 键正确分流到 jsonb_set 参数化路径', () => {
    const values: unknown[] = ['id', 'tid', 'target'];
    const setClauses = buildDataSetClauses({ signed_at: 'now()' }, values);
    expect(setClauses.some((s) => s.includes('jsonb_set') && s.includes('ARRAY[$4]::text[]'))).toBe(true);
    expect(values[3]).toBe('signed_at');
  });
});

// ===== 第四轮加深（再三轮之一）：F-D1 / F-D2 回归 =====

describe('F-D1 openApiAuth app_secret 常量时间比较', () => {
  it('相同 hex 返回 true', () => {
    expect(safeEqualHex('abc123def456', 'abc123def456')).toBe(true);
  });
  it('内容不同返回 false', () => {
    expect(safeEqualHex('abc123def456', 'abc123def457')).toBe(false);
  });
  it('长度不同直接 false（防长度旁路）', () => {
    expect(safeEqualHex('abc', 'abcd')).toBe(false);
    expect(safeEqualHex('', 'abc')).toBe(false);
  });
});

describe('F-D2 loginRateLimit 内存上限保护（防 Map 无限增长）', () => {
  it('大量独立 IP 请求后 loginAttempts 仍受上限约束', () => {
    const prevMode = authMod.AUTH_MODE;
    authMod.__setAuthModeForTest('prod');
    authMod.__setLoginIpCapForTest(50);
    authMod.loginAttempts.clear();
    const mw = authMod.loginRateLimit(10, 60_000);
    let nextCalls = 0;
    const next = () => { nextCalls++; };
    const mkRes = () => ({ status: () => ({ json: () => {} }) }) as any;
    // 300 次请求、250 个独立 IP；若无上限保护，Map 会涨到 250 且永不回收
    for (let i = 0; i < 300; i++) {
      const ip = `10.0.0.${i % 250}`;
      const req: any = { ip, socket: { remoteAddress: ip } };
      mw(req, mkRes(), next as any);
    }
    expect(authMod.loginAttempts.size).toBeLessThanOrEqual(60); // 被上限+减半收敛
    expect(nextCalls).toBe(300); // 每 IP 仅 1–2 次，未触发单 IP 限流，全部放行
    // 还原，避免污染其它测试
    authMod.loginAttempts.clear();
    authMod.__setLoginIpCapForTest(100_000);
    authMod.__setAuthModeForTest(prevMode);
  });
});
