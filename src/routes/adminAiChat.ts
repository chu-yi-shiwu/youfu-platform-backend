// 管理对话端点（注册制批次一 卡3 · P0-4）
// POST /api/v1/admin/ai-chat —— Bearer JWT 鉴权（挂 authMiddleware 之后）+ requireConfigRole（仅 admin/operator）。
// 安全铁律：管理操作绝不走 /public 匿名通道；本端点只产出「建议卡」，绝不写库——
// 落库由前端拿卡调既有 API（POST /basic-data/location|reporter、POST /workers/with-account）。
// 诚实降级：AI 功能未开 / LLM 未授权 → 503（conversationAvailable 双开关，与 C 端同口径）。
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { requireConfigRole } from '../middleware/role.js';
import { conversationAvailable } from '../services/conversationAgent.js';
import { runAdminTurn } from '../services/adminAgent.js';

const router = Router();

const adminChatSchema = z.object({
  message: z.string().min(1).max(1000),
  // 会话 id 由前端生成并回传续聊（本端点无状态、不落库话轮，仅用于前端关联消息流）
  conversation_id: z.string().uuid().optional(),
});

router.post('/admin/ai-chat', async (req, res, next) => {
  try {
    requireConfigRole(req, res); // 同步守卫：非 admin/operator → 403
    const b = adminChatSchema.parse(req.body);
    const tenantId = res.locals.auth.tenantId;

    // 双开关诚实降级：AI 功能未开 / LLM 未授权 → 明确告知，不假装对话
    const avail = await conversationAvailable(tenantId);
    if (!avail.ok) {
      return res.status(503).json({ ok: false, code: avail.reason, message: 'AI 功能未开启，请在系统配置中开启 AI 能力或联系平台管理员' });
    }

    const conversationId = b.conversation_id ?? crypto.randomUUID();
    const { reply, confirm_card } = await runAdminTurn(tenantId, b.message);
    return res.json({ ok: true, code: 0, conversation_id: conversationId, reply, confirm_card });
  } catch (e) {
    next(e);
  }
});

export default router;
