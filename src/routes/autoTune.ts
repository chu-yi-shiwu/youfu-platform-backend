// ④ 自动改流程开关路由：GET 读取当前状态，PUT 翻转并持久化。
// 走 RLS 租户上下文（res.locals.auth.tenantId），与所有业务路由一致。
// 安全：环境变量 MODEL_AUTO_TUNE=false 时服务端全局熔断，界面 PUT 被拒（409），fail-safe。
import { Router } from 'express';
import { z } from 'zod';
import { getAutoTune, setAutoTuneWithClient } from '../repo/tenantSettings.js';
import { requirePermission } from '../middleware/role.js';
import { withTenantClient } from '../db/pool.js';

const router = Router();

const bodySchema = z.object({ enabled: z.boolean() });

// 读取开关状态 + 透出环境变量覆盖情况（便于前端区分"租户已开 / 全局熔断 / 全局强制开"）。
router.get('/auto-tune', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const state = await getAutoTune(tenantId);
    const env = process.env.MODEL_AUTO_TUNE ?? null; // 'true' | 'false' | null
    const effective =
      env === 'false' ? false : env === 'true' ? true : state.enabled;
    return res.json({
      ok: true,
      code: 0,
      enabled: state.enabled,
      effective,
      envOverride: env,
      updatedAt: state.updatedAt,
    });
  } catch (e) {
    next(e);
  }
});

// 翻转并持久化开关（optimize.tune：高危，仅 admin 默认可开）。
router.put('/auto-tune', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { enabled } = bodySchema.parse(req.body);
    // 全局熔断保护：env=false 时禁止界面开启（避免运维紧急关停后被界面误开）。
    if (process.env.MODEL_AUTO_TUNE === 'false') {
      return res.status(409).json({
        ok: false,
        code: 'KILL_SWITCH',
        message: '服务端已全局关闭自动改流程(MODEL_AUTO_TUNE=false)，界面开关暂不可用',
      });
    }
    const state = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'optimize.tune');
      return setAutoTuneWithClient(client, tenantId, enabled);
    });
    return res.json({ ok: true, code: 0, enabled: state.enabled, updatedAt: state.updatedAt });
  } catch (e) {
    next(e);
  }
});

export default router;
