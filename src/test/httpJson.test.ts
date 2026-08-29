// httpJson 单元测试（vitest）——验证 DRY 复用路径：
// 1) httpsPostJson 经 extraHeaders 正确透传 Authorization 等自定义头（R16-001 修复后 llm/embedding 走此路径）；
// 2) 响应体超过 MAX_RESPONSE_BYTES(1MB) 时主动 reject（护栏不失效）；
// 不依赖外网，起本地 HTTP 服务自验。
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { httpsPostJson, MAX_RESPONSE_BYTES } from '../services/httpJson.js';

let server: http.Server | null = null;
afterEach(() => {
  if (server) { server.close(); server = null; }
});

function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, cap: any) => void): Promise<{ base: string; cap: any }> {
  return new Promise((resolve) => {
    const cap: any = {};
    const s = http.createServer((req, res) => handler(req, res, cap));
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as any).port as number;
      server = s;
      resolve({ base: `http://127.0.0.1:${port}`, cap });
    });
  });
}

describe('httpJson.httpsPostJson', () => {
  it('透传 extraHeaders（Authorization）并返回解析后的 JSON', async () => {
    const { base, cap } = await listen((req, res, captured) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        captured.headers = req.headers;
        captured.body = body;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, echo: JSON.parse(body).n }));
      });
    });
    const r = await httpsPostJson(base + '/x', { n: 42 }, 3000, { Authorization: 'Bearer sk-test' });
    expect(r.ok).toBe(true);
    expect(r.echo).toBe(42);
    expect(cap.headers?.authorization).toBe('Bearer sk-test');
    expect(JSON.parse(cap.body).n).toBe(42);
  });

  it('响应体超过 1MB 时 reject（防内存撑爆）', async () => {
    const { base } = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{ "big": "' + 'x'.repeat(MAX_RESPONSE_BYTES + 10) + '" }');
    });
    await expect(httpsPostJson(base, {}, 3000)).rejects.toThrow(/MAX_RESPONSE_BYTES/);
  });

  it('5xx 视为网关故障 reject', async () => {
    const { base } = await listen((_req, res) => {
      res.statusCode = 503;
      res.end('down');
    });
    await expect(httpsPostJson(base, {}, 3000)).rejects.toThrow(/gateway http 503/);
  });
});
