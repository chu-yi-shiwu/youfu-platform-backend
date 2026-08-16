// 入口：express 装配中间件与路由，监听 PORT（默认 4001，避开 80/443）。
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { authMiddleware, refreshAuthMode } from './middleware/auth.js';
import { errorMiddleware } from './middleware/error.js';
import workOrderRouter from './routes/workOrder.js';
import webhookRouter from './webhook/routes.js';
import authRouter from './routes/auth.js';
import configRouter from './routes/config.js';
import inspectionRouter from './routes/inspection.js';
import volunteerRouter from './routes/volunteer.js';
import feedbackRouter from './routes/feedback.js';
import monitorRouter from './routes/monitor.js';
import materialRouter from './routes/material.js';
import assetRouter from './routes/asset.js';
import serviceDeskRouter from './routes/serviceDesk.js';
import statsRouter from './routes/stats.js';
import optimizeRouter from './routes/optimize.js';
import processMiningRouter from './routes/processMining.js';
import autoTuneRouter from './routes/autoTune.js';
import workerRouter from './routes/worker.js';
import catalogRouter from './routes/catalog.js';
import accountsRouter from './routes/accounts.js';

// 试点/生产：用 ENV_FILE 指定环境文件（默认 .env，production 下默认 .env.pilot），
// 同一份代码可同时跑 dev / pilot，无需改代码。
const envFile =
  process.env.ENV_FILE ?? (process.env.NODE_ENV === 'production' ? '.env.pilot' : '.env');
dotenv.config({ path: envFile });
refreshAuthMode();

const app = express();
// 生产环境经 CLB/Nginx 反向代理，启用 trust proxy 以正确识别客户端 IP
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', true);
}
app.use(express.json());

// 健康检查（不含 DB，永远 200）
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'up' });
});

// 认证/租户（生产化①：AUTH_MODE=dev|prod，prod 强制 JWT）：仅对 /api 生效，
// 静态首页与 SPA 路由（试点模式公开可访问，无需鉴权）。
app.use('/api', authMiddleware);

// 业务路由（前缀 /api/v1，与前端/契约一致）
app.use('/api/v1', workOrderRouter);
app.use('/api/v1', webhookRouter);
app.use('/api/v1', authRouter);
app.use('/api/v1', configRouter);
app.use('/api/v1/inspection', inspectionRouter);
app.use('/api/v1/volunteer', volunteerRouter);
app.use('/api/v1/feedback', feedbackRouter);
app.use('/api/v1/monitor', monitorRouter);
app.use('/api/v1', materialRouter);
app.use('/api/v1', assetRouter);
app.use('/api/v1', serviceDeskRouter);
app.use('/api/v1', statsRouter);
app.use('/api/v1', optimizeRouter);
app.use('/api/v1', processMiningRouter);
app.use('/api/v1', autoTuneRouter);
// ② 主数据补全：人员 / 商品目录 / 账号 三类 CRUD（dev 默认 admin 可写）
app.use('/api/v1', workerRouter);
app.use('/api/v1', catalogRouter);
app.use('/api/v1', accountsRouter);

// ⑦P0 过程挖掘看板：顶层公开托管单文件 HTML（pilot 同 SPA 策略；prod 上线前应在反向代理层加鉴权）。
// 必须注册在 SERVE_STATIC 的 SPA 兜底正则之前，否则会被 index.html 兜底拦截。
app.get('/process-mining', (_req, res) => {
  const file = path.resolve(fileURLToPath(import.meta.url), '../../public/process-mining.html');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).json({ ok: false, code: 'NO_DASHBOARD', message: 'process-mining dashboard html not found' });
});

// ⑦P1 主数据管理：顶层公开托管单文件 HTML（资产/物料配置页，复用 /process-mining 同模式）。
// 同样须注册在 SERVE_STATIC 的 SPA 兜底正则之前。
app.get('/master-data', (_req, res) => {
  const file = path.resolve(fileURLToPath(import.meta.url), '../../public/master-data.html');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).json({ ok: false, code: 'NO_PAGE', message: 'master-data html not found' });
});

// ④ 流程自动优化管理（自动改流程开关）：顶层公开托管单文件 HTML（复用 /master-data 同模式）。
// 同样须注册在 SERVE_STATIC 的 SPA 兜底正则之前。
app.get('/workflow-admin', (_req, res) => {
  const file = path.resolve(fileURLToPath(import.meta.url), '../../public/workflow-admin.html');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).json({ ok: false, code: 'NO_PAGE', message: 'workflow-admin html not found' });
});

// 统一错误兜底
app.use(errorMiddleware);

// 试点/生产：单进程部署时可选托管前端 build 产物（避免额外 nginx）。
// 仅 SERVE_STATIC=1 启用；dist 默认位于 ../05_frontend/dist，可用 STATIC_DIR 覆盖。
// 绑定高端口（默认 4080）以满足"不碰 80/443"；独立子域由其上层反向代理（见 deploy/nginx-pilot.conf）负责。
if (process.env.SERVE_STATIC === '1') {
  const staticDir = process.env.STATIC_DIR
    ? path.resolve(process.env.STATIC_DIR)
    : path.resolve(fileURLToPath(import.meta.url), '../../../../05_frontend/dist');
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    // SPA 兜底：非 /api 路由回退 index.html（保证刷新/直链不 404）
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
    console.log(`[pilot] serving frontend static from ${staticDir}`);
  } else {
    console.warn(`[pilot] SERVE_STATIC=1 but dist not found at ${staticDir}; skipping static serving`);
  }
}

const PORT = Number(process.env.PORT ?? 4001);
// 容器环境必须监听 0.0.0.0，否则 CloudRun 无法路由进来
app.listen(PORT, '0.0.0.0', () => {
  console.log(`youfu-backend-m1 listening on 0.0.0.0:${PORT}`);
});
