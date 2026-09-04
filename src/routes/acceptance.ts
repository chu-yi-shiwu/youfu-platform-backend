// 验收路由（注册制批次三 卡4 · P0-2）：专用验收端点，与 transition 同挂载前缀（/api/v1）同鉴权（JWT）。
//   POST /api/v1/open/work_order/:id/acceptance
// 角色：admin/operator/reviewer。业务逻辑在 src/services/acceptance.ts（可 mock 单测）。
// 响应：{ ok:true, code:0, acceptance_id, status }
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { applyAcceptance } from '../services/acceptance.js';

const router = Router();

// zod body：结果二选一；备注 ≤500；媒体 URL 数组 ≤9（拍照/语音上传后的 URL）。
const acceptanceSchema = z.object({
  result: z.enum(['pass', 'reject']),
  note: z.string().max(500).optional(),
  media: z.array(z.string().min(1).max(500)).max(9).optional(),
});

router.post('/open/work_order/:id/acceptance', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const role = res.locals.auth.role;
    const username = res.locals.auth.username;
    const body = acceptanceSchema.parse(req.body);
    const outcome = await withTenantClient(tenantId, (client) =>
      applyAcceptance(client, tenantId, req.params.id, {
        result: body.result,
        note: body.note,
        media: body.media,
        actor: username ?? role ?? 'system',
        role,
      }),
    );
    return res.json({ ok: true, code: 0, acceptance_id: outcome.acceptanceId, status: outcome.status });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return next(new AppError('BAD_REQUEST', `invalid acceptance body: ${e.issues.map((i) => i.message).join(';')}`, 400));
    }
    next(e);
  }
});

export default router;
