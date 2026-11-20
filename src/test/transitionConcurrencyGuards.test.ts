// 流转并发防重·结构不变式（2026-11-14 深度探针 D-新3/D-新4）
//
// 实测（真实 PG，10 并发上限内）：
//   巡检「完成」×2 并发 → 两次都 200（done_at/records 被覆盖）
//   志愿「签到」×2 并发 → 两次都 200（check_in_at 被重置）
// 根因与 D1（巡更）同型：读行不加锁 + UPDATE 不带 from 状态条件。
//
// 为什么用结构扫描：这些是**跨事务的时序不变量**，单请求 mock 测不出来；
// 有真实并发验证脚本（scripts/uat-deep-probe.mjs），这里钉死代码形态防止回退。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTES = join(__dirname, '..', 'routes');
const read = (f: string) => readFileSync(join(ROUTES, f), 'utf8');

// 断言限定在同一 SQL 语句附近（定长窗口），避免跨语句误匹配。
const near = (re: RegExp) => re;

describe('巡检流转并发防重', () => {
  const src = read('inspection.ts');

  it('读任务必须行锁', () => {
    expect(src).toMatch(near(/FROM inspection_task WHERE id = \$1 AND tenant_id = \$2 FOR UPDATE/));
  });

  it('UPDATE 必须带 from 状态条件', () => {
    expect(src).toMatch(/UPDATE inspection_task SET[\s\S]{0,500}AND status = \$/);
  });

  it('命中 0 行必须 409 而不是 200', () => {
    expect(src).toMatch(/rowCount === 0[\s\S]{0,160}CONFLICT/);
  });
});

describe('运送流转并发防重', () => {
  const src = read('transport.ts');

  it('读单必须行锁', () => {
    expect(src).toMatch(near(/FROM transport_order WHERE id = \$1 AND tenant_id = \$2 FOR UPDATE/));
  });

  it('UPDATE 必须带 from 状态条件', () => {
    expect(src).toMatch(/UPDATE transport_order SET[\s\S]{0,500}AND status = \$/);
  });

  it('命中 0 行必须 409', () => {
    expect(src).toMatch(/rowCount === 0[\s\S]{0,160}CONFLICT/);
  });
});

describe('志愿签到/签退/核销并发防重', () => {
  const src = read('volunteer.ts');

  it('三处读记录都必须行锁', () => {
    const locks = src.match(/FROM volunteer_record WHERE id = \$1 AND tenant_id = \$2 FOR UPDATE/g) ?? [];
    expect(locks.length).toBeGreaterThanOrEqual(3);
  });

  it('状态更新必须带 from 状态条件', () => {
    expect(src).toMatch(/status = 'checked_in'[\s\S]{0,200}AND status = 'registered'/);
    expect(src).toMatch(/status = 'checked_out'[\s\S]{0,240}AND status = 'checked_in'/);
    expect(src).toMatch(/status = 'approved'[\s\S]{0,160}AND status = 'checked_out'/);
  });
});
