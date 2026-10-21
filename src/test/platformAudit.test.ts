/**
 * platformAudit.test.ts —— 平台审计写入收敛为单一事实源
 *
 * 背景（回码实证，非线上故障）：
 * `INSERT INTO platform_audit (...) VALUES ($1..$5)` 在 7 个路由文件里**逐字重复 8 次**
 * （accounts.ts:51 / invite.ts:60 / platform.ts:40 / platformWorkflow.ts:41 /
 *   templateContributions.ts:56 / templateMarket.ts:22 / workflowDef.ts:46,328），
 * 且每个文件各自包一份同名 `audit()` 函数——实现完全相同，只有 console.warn 前缀不同。
 *
 * 为什么这算"该模块化却写死"：
 *   平台审计是**一条 append-only 的证据链**（表只 GRANT SELECT/INSERT）。
 *   证据链的价值建立在"每一条都长一样"上——8 处各自实现意味着任何一处漏改字段、
 *   序列化方式不同、或 catch 里静默吞异常，都会造成**审计断链且无人知晓**。
 *   （platform.ts:47-49 的注释记录了它曾 `catch {}` 静默吞异常，是审查修复才补的 warn；
 *    其余 6 处是否都已补，此前无机器看守。）
 *
 * 本测试锁四件事：
 *   A 行为对齐：共享函数与各处旧实现逐字等价（不改行为，只收敛）；
 *   B 失败不阻断：写审计失败必须 warn 留痕，**不得抛**（审计是旁路，不能拖垮主流程）；
 *   C 参数契约：payload 序列化、null 归一与旧实现一致；
 *   D 接入守卫：7 个文件都改为调用共享函数（防止"抽了但没人用"）。
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src');

function makeFakePool(shouldThrow = false) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (shouldThrow) throw new Error('db down');
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

describe('A. 行为对齐：与 7 处旧实现逐字等价', () => {
  const load = () => import('../repo/platformAudit.js');

  it('A1 SQL 与列顺序一致', async () => {
    const { recordPlatformAudit } = await load();
    const pool = makeFakePool();
    await recordPlatformAudit(pool, {
      actor: 'u1',
      action: 'tenant.create',
      resource: 'tenant',
      targetTenant: 't1',
      payload: { a: 1 },
    });
    expect(pool.calls[0].sql).toMatch(
      /INSERT INTO platform_audit \(actor, action, resource, target_tenant, payload\) VALUES \(\$1,\$2,\$3,\$4,\$5\)/,
    );
  });

  it('A2 payload 序列化：对象 → JSON 字符串', async () => {
    const { recordPlatformAudit } = await load();
    const pool = makeFakePool();
    await recordPlatformAudit(pool, { actor: 'u1', action: 'a', payload: { a: 1 } });
    expect(pool.calls[0].params[4]).toBe('{"a":1}');
  });

  it('A3 缺省归一：resource/targetTenant/payload 未传 → null（不是 undefined）', async () => {
    const { recordPlatformAudit } = await load();
    const pool = makeFakePool();
    await recordPlatformAudit(pool, { actor: 'u1', action: 'a' });
    expect(pool.calls[0].params[2]).toBeNull();
    expect(pool.calls[0].params[3]).toBeNull();
    expect(pool.calls[0].params[4]).toBeNull();
  });

  it('A4 显式 null 也保持 null（不退化成字符串 "null"）', async () => {
    const { recordPlatformAudit } = await load();
    const pool = makeFakePool();
    await recordPlatformAudit(pool, { actor: 'u1', action: 'a', payload: null });
    expect(pool.calls[0].params[4]).toBeNull();
  });

  it('A5 payload 为 0 / false / 空串 也要如实写入（不被 falsy 判定吃掉）', async () => {
    const { recordPlatformAudit } = await load();
    const pool = makeFakePool();
    await recordPlatformAudit(pool, { actor: 'u1', action: 'a', payload: 0 });
    expect(pool.calls[0].params[4]).toBe('0');
  });
});

describe('B. 失败契约：旁路不得拖垮主流程，但必须留痕', () => {
  const load = () => import('../repo/platformAudit.js');

  it('B1 写入抛错 ⇒ 不向外抛（审计失败绝不阻断业务）', async () => {
    const { recordPlatformAudit } = await load();
    const pool = makeFakePool(true);
    await expect(
      recordPlatformAudit(pool, { actor: 'u1', action: 'a' }),
    ).resolves.toBeUndefined();
  });

  it('B2 写入抛错 ⇒ 必须 warn 留痕（不得静默吞——这是证据链）', async () => {
    const { recordPlatformAudit } = await load();
    const pool = makeFakePool(true);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await recordPlatformAudit(pool, { actor: 'u1', action: 'tenant.create' });
    expect(spy).toHaveBeenCalled();
    // warn 的第二参是对象，String(obj) 会变成 "[object Object]" ⇒ 必须序列化后再找
    const blob = JSON.stringify(spy.mock.calls[0]);
    expect(blob).toContain('db down');
    spy.mockRestore();
  });

  it('B3 序列化本身抛错（循环引用）⇒ 同样不阻断、同样留痕', async () => {
    const { recordPlatformAudit } = await load();
    const pool = makeFakePool();
    const cyclic: any = {};
    cyclic.self = cyclic;
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      recordPlatformAudit(pool, { actor: 'u1', action: 'a', payload: cyclic }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('C. 接入守卫：抽了必须有人用（防"造了个没人调的函数"）', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const FILES = [
    'routes/accounts.ts',
    'routes/invite.ts',
    'routes/platform.ts',
    'routes/platformWorkflow.ts',
    'routes/templateContributions.ts',
    'routes/templateMarket.ts',
    'routes/workflowDef.ts',
  ];

  // workflowDef 保留一处内联（自批豁免的 fail-closed 留痕，契约与共享函数相反），
  // 由 C9 单独验证其理由在案，故此处按"至多一处内联"放行。
  const INLINE_ALLOWED = new Set(['routes/workflowDef.ts']);

  for (const f of FILES) {
    it(`C· ${f} 已改为调用共享函数`, () => {
      const src = read(f);
      expect(src).toMatch(/platformAudit/);
      const inlineCount = (src.match(/INSERT INTO platform_audit/g) ?? []).length;
      expect(inlineCount).toBeLessThanOrEqual(INLINE_ALLOWED.has(f) ? 1 : 0);
    });
  }

  it('C8 全仓 INSERT 只剩共享模块 + 一处有据的 fail-closed 例外', () => {
    // 只扫源码目录，排除 src/test（测试自身含该字符串，不能算进来）
    const out = execSync(
      'grep -rn "INSERT INTO platform_audit" src/repo src/routes src/services src/engine src/middleware src/scheduler src/webhook --include=*.ts || true',
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    const lines = out
      .split('\n')
      .filter((l: string) => l.includes('INSERT INTO platform_audit'))
      // 排除注释行（模块头注释里复述了这句 SQL，不算实现）
      .filter((l: string) => !/:\d+:\s*(\*|\/\/)/.test(l));
    // 允许两处：共享模块本体 + workflowDef 的自批豁免留痕（后者契约相反，见其注释）。
    // 第三处出现即视为"又有人复制了一份"，必须回到共享模块。
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.some((l: string) => l.includes('repo/platformAudit.ts'))).toBe(true);
  });

  it('C9 fail-closed 例外必须写明理由（不许悄悄保留内联实现）', () => {
    const src = read('routes/workflowDef.ts');
    // 自批留痕那段必须同时具备：fail-closed 说明 + 不走共享函数的理由
    expect(src).toMatch(/fail-closed/);
    expect(src).toMatch(/刻意\*\*不走\*\* recordPlatformAudit/);
  });
});
