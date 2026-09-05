// upload.http.test.ts —— 公网媒体进出双通道 HTTP 测试（#931 批次，承接 #930 审计建议）。
// 背景：upload.ts（POST /api/v1/upload base64 落盘）与 uploads.ts（GET /uploads/:t/:f 受控读取）
// 是报修照片/语音（PII，含声纹）唯一的进出通道，此前 vitest 仅覆盖两个纯函数助手，
// 两条路由本身 HTTP 层为 0。R19-005 曾因零鉴权静态托管出过"持 URL 即下载"隐私事故——
// 本文件把双通道鉴权契约钉死成回归护栏。
// 模式复用 publicReport.http.test.ts：vi.mock 池，真 handler + 真 errorMiddleware；
// JWT 用真实 signJwt/verifyJwt（不打桩 auth 层，测真契约）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// UPLOAD_ROOT 在模块加载时捕获 process.env.UPLOAD_DIR，必须先于 import 设定。
// vi.hoisted 先于所有 import 执行，且不能引用模块级变量——用 process.cwd() 自包含拼路径。
const TMP_ROOT = vi.hoisted(() => {
  const dir = `${process.cwd()}/.tmp-upload-http-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  process.env.UPLOAD_DIR = dir;
  return dir;
});

// ---- 依赖打桩：仅 db/pool（uploads.ts 通道 B 的 view_token 查库）----
const FILE_JPG = '123e4567-e89b-12d3-a456-426614174000.jpg';
const fakeClient = {
  query: vi.fn(async (text: unknown, params?: unknown[]) => {
    const sql = String(text);
    if (sql.includes("ext->>'public_view_token'")) {
      const token = params?.[0] as string;
      if (token === 'tok-dbboom') throw new Error('db boom (drill)');
      if (token === 'tok-hit') {
        return { rows: [{ att: [{ url: `/uploads/t-verification/${FILE_JPG}` }] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 } as any;
  }) as any,
};
vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn(fakeClient),
  assertSafeTenantId: (t: string) => t,
}));

import uploadRouter, { isValidTenantDirName } from '../routes/upload.js';
import uploadsRouter from '../routes/uploads.js';
import { signJwt } from '../middleware/auth.js';
import { errorMiddleware } from '../middleware/error.js';

const FILE_M4A = '123e4567-e89b-12d3-a456-42661417400a.m4a';
const JPG_BODY = Buffer.from('fake-jpeg-bytes-931');
const SECRET = 'test-jwt-secret-931';

const app = express();
app.use(express.json({ limit: '20mb' })); // 放宽以便触发路由自身的 MAX_BYTES 门（而非 json limit 抢先 413）
let authTenant: string | null = null; // 每用例注入 res.locals.auth；null = 未登录
app.use((_req, res, next) => {
  if (authTenant) res.locals.auth = { tenantId: authTenant, role: 'worker', userId: 'u-931', requestId: 'req-931', authMode: 'dev' };
  next();
});
app.use('/api/v1', uploadRouter);
app.use('/uploads', uploadsRouter);
app.use(errorMiddleware);

let server: Server;
let base = '';
beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  fs.mkdirSync(path.join(TMP_ROOT, 't-verification'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, 't-other'), { recursive: true });
  fs.writeFileSync(path.join(TMP_ROOT, 't-verification', FILE_JPG), JPG_BODY);
  fs.writeFileSync(path.join(TMP_ROOT, 't-verification', FILE_M4A), Buffer.from('fake-audio'));
  fs.writeFileSync(path.join(TMP_ROOT, 't-other', FILE_JPG), Buffer.from('other-tenant'));
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(TMP_ROOT, { recursive: true, force: true }); // 测试目录仅数个文件，低于沙箱批量删除阈值
});
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers });
const dashCookie = (tid: string) => `youfu_dash=${signJwt({ tid, sub: 'u-931' }, SECRET)}`;

describe('POST /api/v1/upload（base64 上传落盘）', () => {
  it('①未登录（res.locals.auth 缺失）→ 401 NO_TENANT', async () => {
    authTenant = null;
    const r = await post('/api/v1/upload', { base64: Buffer.from('x').toString('base64'), filename: 'a.jpg' });
    expect(r.status).toBe(401);
    const j = (await r.json()) as any;
    expect(j.code).toBe('NO_TENANT');
  });

  it('②租户名含路径分隔符 → 400 BAD_TENANT（#735 纵深防御兜底）', async () => {
    authTenant = 'a/b';
    const r = await post('/api/v1/upload', { base64: Buffer.from('x').toString('base64'), filename: 'a.jpg' });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.code).toBe('BAD_TENANT');
    expect(isValidTenantDirName('..')).toBe(false);
  });

  it('③缺 base64 → 400 BAD_PARAM', async () => {
    authTenant = 't-verification';
    const r = await post('/api/v1/upload', { filename: 'a.jpg' });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.code).toBe('BAD_PARAM');
  });

  it('④解码后 0 字节 → 413 TOO_LARGE（truthy base64 但空内容；空串本身走 ③ BAD_PARAM）', async () => {
    authTenant = 't-verification';
    const r = await post('/api/v1/upload', { base64: '====', filename: 'a.jpg' });
    expect(r.status).toBe(413);
    const j = (await r.json()) as any;
    expect(j.code).toBe('TOO_LARGE');
  });

  it('⑤超 5MB → 413 TOO_LARGE', async () => {
    authTenant = 't-verification';
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 65);
    const r = await post('/api/v1/upload', { base64: big.toString('base64'), filename: 'a.jpg' });
    expect(r.status).toBe(413);
    const j = (await r.json()) as any;
    expect(j.code).toBe('TOO_LARGE');
  });

  it('⑥扩展名不在白名单 → 400 BAD_EXT', async () => {
    authTenant = 't-verification';
    const r = await post('/api/v1/upload', { base64: Buffer.from('x').toString('base64'), filename: 'evil.exe' });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.code).toBe('BAD_EXT');
  });

  it('⑦无 filename 时从 contentType 推导扩展（image/png → .png）', async () => {
    authTenant = 't-verification';
    const body = Buffer.from('fake-png');
    const r = await post('/api/v1/upload', { base64: body.toString('base64'), contentType: 'image/png' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.ok).toBe(true);
    expect(j.url).toMatch(/^\/uploads\/t-verification\/[0-9a-f-]+\.png$/);
    expect(fs.existsSync(path.join(TMP_ROOT, 't-verification', path.basename(j.url)))).toBe(true);
  });

  it('⑧无 filename 且未知 contentType → 推导 bin → 400 BAD_EXT', async () => {
    authTenant = 't-verification';
    const r = await post('/api/v1/upload', { base64: Buffer.from('x').toString('base64'), contentType: 'application/x-unknown' });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.code).toBe('BAD_EXT');
  });

  it('⑨happy 路径：jpg 落盘 + url 形态 + size 一致 + 字节级无损 + 租户目录隔离', async () => {
    authTenant = 't-verification';
    const r = await post('/api/v1/upload', { base64: JPG_BODY.toString('base64'), filename: 'IMG_0001.JPG' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.url).toMatch(/^\/uploads\/t-verification\/[0-9a-f-]{36}\.jpg$/);
    expect(j.size).toBe(JPG_BODY.length);
    const saved = path.join(TMP_ROOT, 't-verification', path.basename(j.url));
    expect(fs.existsSync(saved)).toBe(true);
    expect(fs.readFileSync(saved).equals(JPG_BODY)).toBe(true); // DMR：媒体无损耗流转
    // 大写扩展名归一化为小写
    expect(path.basename(j.url).endsWith('.jpg')).toBe(true);
    // 租户隔离：另一租户目录不含本租户文件
    expect(fs.readdirSync(path.join(TMP_ROOT, 't-other')).every((f) => !f.includes(path.basename(j.url)))).toBe(true);
  });
});

describe('GET /uploads/:tenant/:file（受控读取，双通道鉴权）', () => {
  it('⑩路径穿越（%2F 变体）→ 400 BAD_PATH', async () => {
    const r = await get('/uploads/t-verification/' + encodeURIComponent('../x.png'));
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.code).toBe('BAD_PATH');
  });

  it('⑪非白名单扩展名 → 400 BAD_PATH', async () => {
    const r = await get('/uploads/t-verification/123e4567-e89b-12d3-a456-426614174000.sh');
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.code).toBe('BAD_PATH');
  });

  it('⑫路径合法但文件不存在 → 404 NO_FILE', async () => {
    const r = await get('/uploads/t-verification/ffffffff-ffff-ffff-ffff-ffffffffffff.jpg');
    expect(r.status).toBe(404);
    const j = (await r.json()) as any;
    expect(j.code).toBe('NO_FILE');
  });

  it('⑬无 cookie 无 token → 401 UPLOAD_AUTH（R19-005 主契约：持 URL ≠ 可下载）', async () => {
    const r = await get(`/uploads/t-verification/${FILE_JPG}`);
    expect(r.status).toBe(401);
    const j = (await r.json()) as any;
    expect(j.code).toBe('UPLOAD_AUTH');
  });

  it('⑭通道 A：本租户 cookie JWT → 200 + 正确 MIME + 安全响应头 + 内容无损', async () => {
    const r = await get(`/uploads/t-verification/${FILE_JPG}`, { cookie: dashCookie('t-verification') });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('content-disposition')).toBe(`inline; filename="${FILE_JPG}"`);
    expect(Buffer.from(await r.arrayBuffer()).equals(JPG_BODY)).toBe(true);
  });

  it('⑮通道 A 跨租户拒：t-other 的令牌读 t-verification 文件 → 401', async () => {
    const r = await get(`/uploads/t-verification/${FILE_JPG}`, { cookie: dashCookie('t-other') });
    expect(r.status).toBe(401);
    const j = (await r.json()) as any;
    expect(j.code).toBe('UPLOAD_AUTH');
  });

  it('⑯通道 A：畸形 cookie 值 → 401（verifyJwt 返回 null 不放行）', async () => {
    const r = await get(`/uploads/t-verification/${FILE_JPG}`, { cookie: 'youfu_dash=not-a-jwt' });
    expect(r.status).toBe(401);
  });

  it('⑰通道 B：view_token 命中工单附件 → 200（公开"我的报修"链路）', async () => {
    const r = await get(`/uploads/t-verification/${FILE_JPG}?token=tok-hit`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
  });

  it('⑱通道 B：token 存在但附件不含该文件 → 401 fail-closed', async () => {
    const r = await get(`/uploads/t-verification/${FILE_JPG}?token=tok-miss`);
    expect(r.status).toBe(401);
    const j = (await r.json()) as any;
    expect(j.code).toBe('UPLOAD_AUTH');
  });

  it('⑲通道 B：查库抛异常 → 401 fail-closed（绝不 fail-open）', async () => {
    const r = await get(`/uploads/t-verification/${FILE_JPG}?token=tok-dbboom`);
    expect(r.status).toBe(401);
    const j = (await r.json()) as any;
    expect(j.code).toBe('UPLOAD_AUTH');
  });

  it('⑳MIME 映射：语音 m4a → audio/mp4（D1 语音通道）', async () => {
    const r = await get(`/uploads/t-verification/${FILE_M4A}`, { cookie: dashCookie('t-verification') });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/mp4');
  });
});
