// 管理对话端点（注册制批次一 卡3 · P0-4；智能体批次一 2026-09-07 扩角色+只读查询）
// POST /api/v1/admin/ai-chat —— Bearer JWT 鉴权（挂 authMiddleware 之后）。
// 角色门（批次一扩容）：admin/operator（全工具）+ reviewer/service_desk（仅只读查询，
// 白名单收窄在 runAdminTurn 执行层二次拦截）；worker 仍 403（移动端自有通道）。
// 安全铁律：管理操作绝不走 /public 匿名通道；本端点只产出「建议卡/结果卡」，绝不写库——
// 落库由前端拿卡调既有 API（POST /basic-data/location|reporter、POST /workers/with-account）。
// 诚实降级：AI 功能未开 / LLM 未授权 → 503（conversationAvailable 双开关，与 C 端同口径）。
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { AppError } from '../middleware/error.js';
import { conversationAvailable } from '../services/conversationAgent.js';
import { runAdminTurn } from '../services/adminAgent.js';
import { makeAdminToolExecutor } from '../services/adminAgentTools.js';

const router = Router();

const adminChatSchema = z.object({
  message: z.string().min(1).max(1000),
  // 会话 id 由前端生成并回传续聊（本端点无状态、不落库话轮，仅用于前端关联消息流）
  conversation_id: z.string().uuid().optional(),
  // 智能体批次一：页面上下文（agent 感知用户当前所在页面，回答绑定场景；只进提示词不落库）
  context: z.object({ page: z.string().max(200).optional() }).optional(),
});

// AI 助理可见角色（worker 不开放——移动端自有对话通道，最小权限）
const AI_CHAT_ROLES: readonly string[] = ['admin', 'operator', 'reviewer', 'service_desk'];

router.post('/admin/ai-chat', async (req, res, next) => {
  try {
    // 同步守卫：白名单外角色（含 worker/dispatcher）→ 403
    const role = res.locals.auth.role as string | undefined;
    if (!role || !AI_CHAT_ROLES.includes(role)) {
      throw new AppError('FORBIDDEN', 'AI 助理仅管理员/操作员/审核员/服务台可用', 403);
    }
    const b = adminChatSchema.parse(req.body);
    const tenantId = res.locals.auth.tenantId;

    // 双开关诚实降级：AI 功能未开 / LLM 未授权 → 明确告知，不假装对话
    const avail = await conversationAvailable(tenantId);
    if (!avail.ok) {
      return res.status(503).json({ ok: false, code: avail.reason, message: 'AI 功能未开启，请在系统配置中开启 AI 能力或联系平台管理员' });
    }

    const conversationId = b.conversation_id ?? crypto.randomUUID();
    const { reply, confirm_card, result_card } = await runAdminTurn(tenantId, b.message, {
      role,
      contextPage: b.context?.page,
      toolExecutor: makeAdminToolExecutor(tenantId),
    });
    return res.json({ ok: true, code: 0, conversation_id: conversationId, reply, confirm_card, result_card });
  } catch (e) {
    next(e);
  }
});

export default router;
