// 5MB 并发上传测试（公网 nginx + Express + 后端 5MB 业务上限）
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   /opt/node16/bin/node pilot-upload-5mb-e2e.mjs
//
// 可选：
//   PILOT_API_BASE=https://youfu.banerz.cn/pilot/api/v1
//   PILOT_TENANT=zixing-hospital
//   UPLOAD_DIR=/opt/youfu/pilot/uploads
//   PERF_UPLOAD_CONCURRENCY=5
//   PERF_UPLOAD_BYTES=5138022   # 4.9MB
import { unlinkSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';

const TENANT = process.env.PILOT_TENANT || 'zixing-hospital';
// 默认打本机后端，隔离应用/磁盘性能与公网带宽；
// 公网单张上传作为网络探针单独测量（见 PUBLIC_API）。
const API = (process.env.PILOT_API_BASE || 'http://127.0.0.1:4101/api/v1').replace(/\/+$/, '');
const PUBLIC_API = (process.env.PILOT_PUBLIC_BASE || 'https://youfu.banerz.cn/pilot/api/v1').replace(/\/+$/, '');
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/opt/youfu/pilot/uploads';
const CONCURRENCY = Math.max(1, Number(process.env.PERF_UPLOAD_CONCURRENCY || 5));
const BYTES = Math.max(1024, Number(process.env.PERF_UPLOAD_BYTES || Math.floor(4.9 * 1024 * 1024)));
const RUN = process.env.PERF_RUN_ID || `u${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const files = [];

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const started = process.hrtime.bigint();
    const req = mod.request(u, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed, ms });
      });
    });
    req.on('error', (e) => reject(Object.assign(e, { ms: Number(process.hrtime.bigint() - started) / 1e6 })));
    if (data) req.write(data);
    req.end();
  });
}

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
function summarize(rows) {
  const ok = rows.filter((r) => r.status >= 200 && r.status < 300);
  const lat = ok.map((r) => r.ms);
  return {
    total: rows.length,
    ok: ok.length,
    error_rate: rows.length ? Number((((rows.length - ok.length) / rows.length) * 100).toFixed(2)) : 0,
    p50: Number(percentile(lat, 50).toFixed(1)),
    p95: Number(percentile(lat, 95).toFixed(1)),
    p99: Number(percentile(lat, 99).toFixed(1)),
    max: Number((lat.length ? Math.max(...lat) : 0).toFixed(1)),
    statuses: rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {}),
  };
}

async function upload(index, bytes, apiBase = API) {
  const base64 = crypto.randomBytes(bytes).toString('base64');
  const r = await request('POST', `${apiBase}/public/upload?org=${TENANT}`, {
    filename: `perf-5mb-${RUN}-${index}.jpg`,
    contentType: 'image/jpeg',
    base64,
  });
  if (r.status === 201 && r.body?.url) files.push(r.body.url);
  return r;
}

async function main() {
  console.log(`[upload5mb] start concurrency=${CONCURRENCY} bytes=${BYTES}`);
  const rows = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => upload(i, BYTES)));
  const summary = summarize(rows);
  console.log('[upload5mb] summary', JSON.stringify(summary));
  assert(summary.ok === CONCURRENCY, `上传成功数 ${summary.ok}/${CONCURRENCY}`);
  assert(summary.p95 < 10000, `上传 p95 ${summary.p95}ms 超过 10000ms`);

  // 5MB+1 必须由后端业务上限拒绝（不是 nginx 413）
  const over = await upload('over', 5 * 1024 * 1024 + 1);
  console.log('[upload5mb] over-limit', over.status, over.body?.code, over.body?.message);
  assert(over.status === 413, `5MB+1 应 413，实际 ${over.status}`);
  assert(over.body?.code === 'TOO_LARGE', `5MB+1 错误码应为 TOO_LARGE，实际 ${over.body?.code}`);

  // 公网单张探针：区分“应用/磁盘”与“ECS 公网带宽”
  let publicProbe = null;
  if (PUBLIC_API !== API) {
    const r = await upload('public-probe', BYTES, PUBLIC_API);
    publicProbe = summarize([r]);
    console.log('[upload5mb] public single', JSON.stringify(publicProbe));
    assert(r.status === 201, `公网单张上传应 201，实际 ${r.status}`);
    if (publicProbe.p50 > 15000) {
      console.warn(`[upload5mb] WARN 公网单张 ${BYTES}B 延迟 ${publicProbe.p50}ms，疑似 ECS 公网带宽瓶颈`);
    }
  }

  console.log(`[upload5mb] PASS run=${RUN} files=${files.length}`);
}

main()
  .then(async () => {
    for (const url of files) {
      const p = path.join(UPLOAD_DIR, url.replace(/^\/uploads\//, ''));
      try { unlinkSync(p); } catch { /* ignore */ }
    }
    console.log(`[upload5mb] cleanup files=${files.length}`);
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('[upload5mb] FAILED', e.message);
    for (const url of files) {
      const p = path.join(UPLOAD_DIR, url.replace(/^\/uploads\//, ''));
      try { unlinkSync(p); } catch { /* ignore */ }
    }
    process.exit(1);
  });
