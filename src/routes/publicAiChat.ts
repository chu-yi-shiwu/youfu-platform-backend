// L3 对话管家公开路由（R36 · 挂 authMiddleware 之前，同 publicReport 口径）
// 端点：
//   POST /api/v1/public/ai-chat          —— 发起/续对话（org + message [+ conversation_id] [+ consent]）
//   GET  /api/v1/public/ai-chat/:id      —— 拉取会话话轮（刷新 UI 用）
// 安全：loginRateLimit 限流；org 白名单（tenant_registry active）；I4/LLM 双开关诚实降级；
//       会话数据 RLS 租户隔离（066）；建单写操作 consent 硬拒在 agent 工具内执行。
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import pool, { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { loginRateLimit } from '../middleware/auth.js';
import { createConversation, getConversation, listTurns } from '../repo/aiConversation.js';
import { runAgentTurn, conversationAvailable } from '../services/conversationAgent.js';

const router = Router();

const chatSchema = z.object({
  org: z.string().min(1).max(64),
  message: z.string().min(1).max(1000),
  conversation_id: z.string().uuid().optional(),
  // consent：用户在 UI 上显式勾选「同意 AI 代我创建工单」才为 true；缺省/false 一律拒（DMR 铁律）
  consent: z.boolean().optional(),
  // reporter_anon：前端匿名会话标识（localStorage 随机串），用于「我的对话」找回；不采集身份明文
  reporter_anon: z.string().max(64).optional(),
});

router.post('/public/ai-chat', loginRateLimit(30), async (req, res, next) => {
  try {
    const b = chatSchema.parse(req.body);
    const tr = await pool.query(`SELECT tenant_id, name FROM tenant_registry WHERE tenant_id = $1 AND status = 'active'`, [b.org]);
    if (tr.rowCount === 0) return res.status(404).json({ ok: false, code: 'ORG_404', message: '机构不存在或未启用' });
    const tenantId = b.org;
    const tenantName = tr.rows[0].name || tenantId;

    // 双开关诚实降级：AI 功能未开 / LLM 未授权 → 明确告知，不假装对话
    const avail = await conversationAvailable(tenantId);
    if (!avail.ok) {
      return res.status(503).json({ ok: false, code: avail.reason, message: 'AI 对话助手未开启，请使用报修表单提交' });
    }

    // 会话归属：带 conversation_id 则校验存在；否则新建（reporter_anon 绑定）
    let conversationId = b.conversation_id;
    if (conversationId) {
      const conv = await withTenantClient(tenantId, (client) => getConversation(client, tenantId, conversationId!));
      if (!conv) throw new AppError('NOT_FOUND', '会话不存在或已过期', 404);
      if (conv.reporter_anon && b.reporter_anon && conv.reporter_anon !== b.reporter_anon) {
        throw new AppError('FORBIDDEN', '会话归属校验失败', 403);
      }
    } else {
      const conv = await withTenantClient(tenantId, (client) =>
        createConversation(client, tenantId, { reporterAnon: b.reporter_anon ?? crypto.randomUUID() }),
      );
      conversationId = conv.id;
    }

    const result = await runAgentTurn({
      tenantId,
      tenantName,
      conversationId: conversationId!,
      userText: b.message,
      consent: b.consent === true,
    });

    return res.json({
      ok: true,
      code: 0,
      conversation_id: conversationId,
      reply: result.assistantText,
      tool_trace: result.toolTrace, // 前端折叠卡渲染工具调用过程（防幻觉可审计）
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '参数不完整或格式有误' });
    }
    next(e);
  }
});

router.get('/public/ai-chat/:id', loginRateLimit(30), async (req, res, next) => {
  try {
    const org = (req.query.org as string) || '';
    if (!org) return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '缺少机构' });
    const tenantId = org;
    const conv = await withTenantClient(tenantId, (client) => getConversation(client, tenantId, req.params.id));
    if (!conv) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '会话不存在' });
    const turns = await withTenantClient(tenantId, (client) => listTurns(client, tenantId, req.params.id));
    return res.json({ ok: true, code: 0, conversation_id: conv.id, status: conv.status, items: turns });
  } catch (e) { next(e); }
});

export default router;
