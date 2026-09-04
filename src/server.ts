// 入口：express 装配中间件与路由，监听 PORT（默认 4001，避开 80/443）。
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { authMiddleware, refreshAuthMode, verifyJwt, AUTH_MODE } from './middleware/auth.js';
import { apiGuardMiddleware } from './middleware/apiGuard.js';// RV-001：未知 /api 路径先 404 再鉴权
import { errorMiddleware } from './middleware/error.js';
import publicReportRouter from './routes/publicReport.js';// P1 需求侧：public 免登录报修（挂 auth 之前）
import publicAiChatRouter from './routes/publicAiChat.js';// L3 对话管家：public 免登录 AI 对话（挂 auth 之前，R36）
import wechatRouter from './routes/wechat.js';// ③ 微信 JSSDK 公开签名端点（挂 auth 之前）
import workOrderRouter from './routes/workOrder.js';
import webhookRouter from './webhook/routes.js';
import authRouter from './routes/auth.js';
import configRouter from './routes/config.js';
import templateContributionsRouter from './routes/templateContributions.js';// UGC 模板贡献（租户侧）
import inspectionRouter from './routes/inspection.js';
import { flushWechatDeliveries } from './services/notify.js'; // R31-Q1：响应后补投递 deferred wechat
import patrolRouter from './routes/patrol.js';
import emergencyRouter from './routes/emergency.js';
import transportRouter from './routes/transport.js';
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
import faultCategoryRouter from './routes/faultCategory.js';
import accountsRouter from './routes/accounts.js';
import tenantInfoRouter from './routes/tenantInfo.js';
import workflowDefRouter from './routes/workflowDef.js';
import businessFlowRouter from './routes/businessFlow.js';
import aiPreviewRouter from './routes/aiPreview.js';
import basicDataRouter from './routes/basicData.js';
import adminAiChatRouter from './routes/adminAiChat.js';// 注册制批次一 卡3：管理对话（authed，admin/operator）
import llmUsageRouter from './routes/llmUsage.js';
import equipmentRouter from './routes/equipment.js';
import uploadRouter from './routes/upload.js';// B0 文件上传（H5 拍照落库）
import uploadsRouter from './routes/uploads.js';// R19-005 鉴权上传文件路由（替代零鉴权静态托管）
import platformRouter from './routes/platform.js';// 城市级平台层（E_min）
import templateMarketRouter from './routes/templateMarket.js';// E2 模板市场（官方模板库/应用/效果）
import openApiRouter from './routes/openApi.js';// E0_open 开放 API（app_key 认证）
import { startInspectionScheduler } from './scheduler/inspectionScheduler.js';// G3 真 cron 调度
import { startSlaScheduler } from './scheduler/slaScheduler.js';// 拆雷三件套②：SLA 定时扫描+升级通知
import { startTemplateEffectsScheduler } from './scheduler/templateEffectScheduler.js';// E2 效果回写 cron
import { startModelTrainScheduler } from './scheduler/modelTrainScheduler.js';// 数据飞轮：每日 03:00 全量重训

// 试点/生产：用 ENV_FILE 指定环境文件（默认 .env，production 下默认 .env.pilot），
// 同一份代码可同时跑 dev / pilot，无需改代码。
const envFile =
  process.env.ENV_FILE ?? (process.env.NODE_ENV === 'production' ? '.env.pilot' : '.env');
dotenv.config({ path: envFile });
refreshAuthMode();

// S-1 启动期断言：prod 模式必须配置 JWT_SECRET，否则拒绝启动（避免以不安全默认密钥跑生产）。
if (AUTH_MODE === 'prod' && !process.env.JWT_SECRET) {
  console.error('[fatal] AUTH_MODE=prod 但 JWT_SECRET 未配置，拒绝启动（生产中缺失密钥将导致全量 500/fail-closed）。');
  process.exit(1);
}

// S-1b 启动期断言：生产环境（NODE_ENV=production）严禁以 dev 鉴权模式启动。
// dev 模式 X-Tenant-Id / X-Role 头由客户端任意指定且 role 默认 admin——一旦误留 dev，任意人可越权任意租户。
// 与 S-1 互补：S-1 防"prod 无密钥"，本行防"生产却跑 dev"（代码默认 AUTH_MODE='dev'）。
if (process.env.NODE_ENV === 'production' && AUTH_MODE !== 'prod') {
  console.error('[fatal] NODE_ENV=production 但 AUTH_MODE!==prod，拒绝启动（dev 模式公开可越权，禁止用于生产）。');
  process.exit(1);
}

const app = express();
// 【M0-3 修复】生产经 Nginx 反向代理，trust proxy 固定只信最近 1 跳。
// 原 TRUST_PROXY==='1' 时设 true（信任全部跳），XFF 最左侧 IP 可被客户端伪造，
// 导致限流/审计按伪造 IP 维度失效（R1-004 观察项的根因之一）。固定 1 跳 = 仅采信
// Nginx 追加的那一跳，客户端自带的 XFF 伪造段被忽略。恒定生效，去掉环境开关以防误配漏开。
app.set('trust proxy', 1);
// B0：放宽 JSON body 上限到 10MB（base64 上传图片可能较大）；其余路由均为小 JSON，无影响。
app.use(express.json({ limit: '10mb' }));

// S-4 显式 CORS 策略：仅放行配置的来源（默认生产域名），禁用通配 *，凭据跨域拒绝。
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'https://youfu.banerz.cn')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.header('Origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Tenant-Id,X-Role,X-Request-Id,Idempotency-Key');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// A-1：看板/管理页鉴权（仅 prod）。Accept Bearer 头或登录时种下的 youfu_dash cookie（sameSite，随同域导航自动携带）。
// 底层 /api 数据本就受 JWT 保护；此处再对"页面外壳"加一层，避免未登录即可探得管理界面。
function requireDashboardAuth(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  if (AUTH_MODE !== 'prod') return next();
  const auth = req.header('Authorization');
  const bearer = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
  let token: string | null = bearer ? bearer[1] : null;
  if (!token) {
    const cookie = req.headers.cookie ?? '';
    const m = /(?:^|;\s*)youfu_dash=([^;]+)/.exec(cookie);
    token = m ? decodeURIComponent(m[1]) : null;
  }
  if (!token) return res.status(401).json({ ok: false, code: 'DASH_AUTH', message: 'unauthorized dashboard access' });
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ ok: false, code: 'AUTH_CFG', message: 'JWT_SECRET not configured' });
  if (!verifyJwt(token, secret)) return res.status(401).json({ ok: false, code: 'DASH_AUTH', message: 'invalid token' });
  return next();
}

// 健康检查（不含 DB，永远 200）
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'up' });
});

// R31-Q1：响应完成后补投递 deferred wechat 通知（insertNotification fan-out 入队的）。
// 此刻事务已提交，外部 HTTP 不再占用事务/连接；失败仅记日志，绝不阻塞响应。
app.use((req, res, next) => {
  res.on('finish', () => {
    try { flushWechatDeliveries(); } catch { /* 永不阻塞响应链 */ }
  });
  next();
});

// 城市级平台层（E_min）：挂在租户 authMiddleware 之前（G1 平台上下文独立，
// 平台管理员与租户账号两套体系互不干扰；登录公开，其余 platformAdminAuth 保护）。
app.use('/api/v1/platform', platformRouter);
app.use('/api/v1/platform', templateMarketRouter);

// E0_open 开放 API（第三方/上级平台/ISV 凭 app_key 调聚合）：独立于租户/平台 JWT，
// 走 openApiAuth（app_key+secret 双因子 + scopes + 调用审计）。
app.use('/api/v1/open-api', openApiRouter);

// P1 需求侧 public 报修（免登录，挂 auth 之前；org 显式指定机构 + 限流 + D3 硬拒）
app.use('/api/v1', publicReportRouter);
// L3 对话管家（免登录，挂 auth 之前；org 白名单 + 限流 + I4/LLM 双开关 + consent 硬拒）
app.use('/api/v1', publicAiChatRouter);
// ③ 微信 JSSDK 签名端点（免登录，挂 auth 之前；供 H5 在微信内录音前注入 wx.config）
app.use('/api/v1/wechat', wechatRouter);

// 认证/租户（生产化①：AUTH_MODE=dev|prod，prod 强制 JWT）：仅对 /api 生效，
// 静态首页与 SPA 路由（试点模式公开可访问，无需鉴权）。
// RV-001 修复：apiGuard 先于鉴权——未知 API 路径直接 JSON 404（语义正确），
// 已知路径才进入鉴权（fail-closed 401 语义只留给真实存在的受保护路径）。
app.use('/api', apiGuardMiddleware);
app.use('/api', authMiddleware);

// 业务路由（前缀 /api/v1，与前端/契约一致）
app.use('/api/v1', workOrderRouter);
app.use('/api/v1', webhookRouter);
app.use('/api/v1', authRouter);
app.use('/api/v1', configRouter);
app.use('/api/v1', templateContributionsRouter); // UGC 模板贡献（租户侧，requireConfigRole）
app.use('/api/v1/inspection', inspectionRouter);
app.use('/api/v1/patrol', patrolRouter);
// P2 第二刀：应急预案库 + 预警中心 / 运送轨迹
app.use('/api/v1/emergency', emergencyRouter);
app.use('/api/v1/transport', transportRouter);
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
app.use('/api/v1', faultCategoryRouter);
app.use('/api/v1', accountsRouter);
app.use('/api/v1', tenantInfoRouter);
app.use('/api/v1/workflow-defs', workflowDefRouter);
app.use('/api/v1', basicDataRouter);
app.use('/api/v1', adminAiChatRouter);// 管理对话：POST /admin/ai-chat（Bearer JWT + admin/operator）
app.use('/api/v1', equipmentRouter);// P4 设备管理（设备 / 设备类型 / 设备厂商，主数据 CRUD，对齐 UOne C 族）
app.use('/api/v1/flow', businessFlowRouter);
app.use('/api/v1/ai', aiPreviewRouter);
app.use('/api/v1/llm', llmUsageRouter);
// B0 文件上传（H5 拍照落库）：挂在 /api/v1，自动过 authMiddleware 获得租户隔离。
app.use('/api/v1', uploadRouter);

// R19-005：以鉴权路由取代零鉴权 express.static（详见 routes/uploads.ts）。
// 须注册在 SPA 兜底正则之前，否则 /uploads/* 会被 index.html 兜底吞掉；URL 形态保持不变。
app.use('/uploads', uploadsRouter);

// ⑦P0 过程挖掘看板：顶层公开托管单文件 HTML（pilot 同 SPA 策略；prod 上线前应在反向代理层加鉴权）。
// 必须注册在 SERVE_STATIC 的 SPA 兜底正则之前，否则会被 index.html 兜底拦截。
app.get('/process-mining', requireDashboardAuth, (_req, res) => {
  const file = path.resolve(fileURLToPath(import.meta.url), '../../public/process-mining.html');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).json({ ok: false, code: 'NO_DASHBOARD', message: 'process-mining dashboard html not found' });
});

// ⑦P1 主数据管理：顶层公开托管单文件 HTML（资产/物料配置页，复用 /process-mining 同模式）。
// 同样须注册在 SERVE_STATIC 的 SPA 兜底正则之前。
app.get('/master-data', requireDashboardAuth, (_req, res) => {
  const file = path.resolve(fileURLToPath(import.meta.url), '../../public/master-data.html');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).json({ ok: false, code: 'NO_PAGE', message: 'master-data html not found' });
});

// ④ 流程自动优化管理（自动改流程开关）：顶层公开托管单文件 HTML（复用 /master-data 同模式）。
// 同样须注册在 SERVE_STATIC 的 SPA 兜底正则之前。
app.get('/workflow-admin', requireDashboardAuth, (_req, res) => {
  const file = path.resolve(fileURLToPath(import.meta.url), '../../public/workflow-admin.html');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).json({ ok: false, code: 'NO_PAGE', message: 'workflow-admin html not found' });
});

// RV-001 配套：/api 终端兜底——已知区域内但未命中任何路由（如带合法 token 深路径打错）
// 统一 JSON 404，取代 Express 默认 HTML 404，保持全 API 错误形态一致。
// 位置：所有 /api 路由之后、errorMiddleware 之前；仅匹配 /api/*，不影响 SPA/静态托管。
app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'not found' });
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
  // G3 真 cron：后端进程内定时扫描到期巡检计划并自动生成实例（单进程部署，无重复触发）。
  startInspectionScheduler();
  // 拆雷三件套②（2026-08-31）：SLA 每 60s 扫描超时工单 → 升级 + 通知（与 /sla/scan 同一实现）。
  startSlaScheduler();
  // E2 效果回写 cron：每 60s 扫描到期（≥7 天）未回写的模板应用，自动拉取 after 指标并评分。
  startTemplateEffectsScheduler();
  // 数据飞轮：每日 03:00 低峰全量重训（model_state 持续更新，AUTO_TUNE 受控不写回）。
  startModelTrainScheduler();
});
