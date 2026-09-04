// workerWithAccount.test.ts —— 注册制批次一 卡2（P0-3）：POST /workers/with-account 回归。
// 覆盖：成功建档+绑 account_id、重名 409、工号撞车 409、中途失败无残留（回滚）、operator 放行。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const calls: { sql: string; params: unknown[] }[] = [];
const txLog: string[] = [];
let scripted: { match: RegExp; rows: any[]; rowCount?: number; throwError?: Error }[] = [];

vi.mock('../db/pool.js', () => ({
  default: {},
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    txLog.push('BEGIN');
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        for (const s of scripted) {
          if (s.match.test(sql)) {
            if (s.throwError) throw s.throwError;
            return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
          }
        }
        return { rows: [], rowCount: 0 };
      },
    };
    try {
      const out = await fn(client);
      txLog.push('COMMIT');
      return out;
    } catch (e) {
      txLog.push('ROLLBACK');
      throw e;
    }
  },
}));

import express from 'express';
import type { Server } from 'node:http';
import workerRouter from '../routes/worker.js';
import { errorMiddleware } from '../middleware/error.js';

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.locals.auth = { tenantId: 't1', role: 'admin', authMode: 'dev', userId: 'u1', requestId: 'test' };
  next();
});
app.use(workerRouter);
app.use(errorMiddleware);

let server: Server;
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls.length = 0;
  txLog.length = 0;
  scripted = [];
});

function successScript() {
  return [
    { match: /SELECT 1 FROM account_user/, rows: [] },
    { match: /SELECT 1 FROM worker WHERE tenant_id=\$1 AND id=\$2/, rows: [] },
    { match: /SELECT count\(\*\) FROM worker/, rows: [{ n: 2 }] },
    {
      match: /INSERT INTO account_user/,
      rows: [{ id: 'acc-uuid-1', username: 'zhangsan', display_name: '张三', role: 'worker' }],
    },
    {
      match: /INSERT INTO worker /,
      rows: [{ id: 'W0003', tenant_id: 't1', name: '张三', phone: '13800001234', account_id: 'acc-uuid-1' }],
    },
  ];
}

function post(body: unknown, role = 'admin') {
  // 角色动态注入：operator 用例需要换 role
  const mw = (_req: any, res: any, next: any) => {
    res.locals.auth = { tenantId: 't1', role, authMode: 'dev', userId: 'u1' };
    next();
  };
  const a = express();
  a.use(express.json());
  a.use(mw);
  a.use(workerRouter);
  a.use(errorMiddleware);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const s = a.listen(0, async () => {
      const port = (s.address() as { port: number }).port;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/workers/with-account`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const body2 = await r.json().catch(() => ({}));
        s.close(() => resolve({ status: r.status, body: body2 }));
      } catch (e) {
        s.close(() => reject(e));
      }
    });
  });
}

const VALID = { username: 'zhangsan', display_name: '张三', phone: '13800001234', skill_tags: ['electric'] };

describe('POST /workers/with-account（一键入驻）', () => {
  it('成功建档：worker 绑 account_id，一次性密码透出，单事务提交', async () => {
    scripted = successScript();
    const { status, body } = await post(VALID);
    expect(status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.item.account_id).toBe('acc-uuid-1');
    expect(body.account.role).toBe('worker');
    expect(body.account.username).toBe('zhangsan');
    expect(typeof body.one_time_password).toBe('string');
    expect(body.one_time_password.length).toBeGreaterThanOrEqual(12);
    // worker INSERT 直写 phone 列（057）且带 account_id
    const wIns = calls.find((c) => c.sql.includes('INSERT INTO worker'))!;
    expect(wIns.sql).toContain('phone');
    expect(wIns.sql).toContain('account_id');
    expect(wIns.params).toContain('acc-uuid-1');
    expect(wIns.params).toContain('13800001234');
    // 账号 role=worker、scrypt 哈希入库（不存明文）
    const aIns = calls.find((c) => c.sql.includes('INSERT INTO account_user'))!;
    expect(aIns.params[2]).toMatch(/^scrypt\$/);
    expect(aIns.params[2]).not.toContain(body.one_time_password);
    expect(txLog).toEqual(['BEGIN', 'COMMIT']);
  });

  it('未指定 worker_id 时自动生成 W+4位序号', async () => {
    scripted = successScript();
    const { status, body } = await post({ ...VALID, username: 'lisi', display_name: '李四', phone: undefined });
    expect(status).toBe(201);
    expect(body.item.id).toBe('W0003'); // count=2 → 序号 3
  });

  it('重名：租户内用户名已存在 → 409，且不 INSERT worker', async () => {
    scripted = [
      { match: /SELECT 1 FROM account_user/, rows: [{ '?column?': 1 }] },
      ...successScript().slice(1),
    ];
    const { status, body } = await post(VALID);
    expect(status).toBe(409);
    expect(body.message).toBe('该租户下用户名已存在');
    expect(calls.some((c) => c.sql.includes('INSERT INTO worker'))).toBe(false);
  });

  it('工号撞车：指定 worker_id 已存在 → 409', async () => {
    scripted = [
      { match: /SELECT 1 FROM account_user/, rows: [] },
      { match: /SELECT 1 FROM worker WHERE tenant_id=\$1 AND id=\$2/, rows: [{ '?column?': 1 }] },
    ];
    const { status, body } = await post({ ...VALID, worker_id: 'W0001' });
    expect(status).toBe(409);
    expect(body.message).toBe('该工号已存在');
  });

  it('中途失败无残留：worker INSERT 抛错 → 整体回滚，无 COMMIT', async () => {
    scripted = [
      { match: /SELECT 1 FROM account_user/, rows: [] },
      { match: /SELECT 1 FROM worker WHERE tenant_id=\$1 AND id=\$2/, rows: [] },
      { match: /count\(\*\)::int/, rows: [{ n: 0 }] },
      { match: /INSERT INTO account_user/, rows: [{ id: 'acc-uuid-2', username: 'wangwu', display_name: '王五', role: 'worker' }] },
      { match: /INSERT INTO worker /, rows: [], throwError: new Error('worker insert failed') },
    ];
    const { status } = await post({ username: 'wangwu', display_name: '王五' });
    expect(status).toBe(500);
    expect(txLog).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('operator 铸 worker 放行（canAssignRole 恒真，统一口径）', async () => {
    scripted = successScript();
    const { status, body } = await post(VALID, 'operator');
    expect(status).toBe(201);
    expect(body.item.name).toBe('张三');
  });

  it('参数校验：短用户名 / 非法手机号 → 422', async () => {
    const r1 = await post({ username: 'z', display_name: '张三' });
    expect(r1.status).toBe(422);
    const r2 = await post({ username: 'zhangsan', display_name: '张三', phone: '123' });
    expect(r2.status).toBe(422);
  });
});
