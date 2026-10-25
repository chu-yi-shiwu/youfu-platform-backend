// admin 贴码端点（八件增量 BE-2）：GET /api/v1/admin/mp-qrcode?loc=&env=
// 与既有公开 GET /public/mp-qrcode（publicReport.ts，path 白名单报修首页）的差异：
//   - 本端点 org 取自登录租户上下文（auth.tenantId）——机构级贴码，admin 无法指定别家 org；
//   - 权限门：authMiddleware + requirePermission('qrcode.generate')（默认仅 admin，租户可授予）；
//   - mpConfigured false → 503 MP_002（诚实：未配置不假装能出码）。
// 返回 image/png 二进制（genMpCode 同链路）；scene 32 字符硬限口径与公开端点一致。
import { Router } from 'express';
import { type AuthLocals } from '../middleware/auth.js';
import { requirePermission } from '../middleware/role.js';
import { withTenantClient } from '../db/pool.js';
import { genMpCode, mpConfigured } from '../services/wechatMp.js';

const router = Router();

router.get('/admin/mp-qrcode', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals | undefined;
    if (!auth) return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing auth' });
    // T8 第十七批：原 `requireRole(auth, 'admin')` 硬编码角色 ⇒ 可配置权限点 `qrcode.generate`。
    //   🔴 守卫单独一个事务：保持「401 → 403 → 缺 loc 422 → 未配置 503」的原有顺序不被改写
    //   （同批 14/15/16 的取舍）。本端点自身不写库，事务只用于取得 client 做权限查询。
    //   ⚠️ 已知差异（登记）：403 的响应 code 由 `FORBID_001` 变为 `FORBIDDEN`（requirePermission
    //   的统一口径）。已实测前端/小程序 **0 处**依赖 FORBID_001。
    await withTenantClient(auth.tenantId, async (client) => {
      await requirePermission(auth, client, 'qrcode.generate');
    });
    const loc = (req.query.loc as string || '').trim();
    if (!loc) return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '缺少 loc（位置编码）' });
    // env：小程序码指向版本，缺省 trial（与公开端点同口径；对外贴码显式传 release）
    const envRaw = String(req.query.env || '').trim();
    const env: 'trial' | 'release' | 'develop' =
      envRaw === 'release' ? 'release' : envRaw === 'develop' ? 'develop' : 'trial';
    if (!mpConfigured()) {
      return res.status(503).json({ ok: false, code: 'MP_002', message: '小程序能力未配置' });
    }
    const path = `pages/index/index?org=${auth.tenantId}&loc=${encodeURIComponent(loc)}`;
    // scene 32 字符硬限制：org 优先，装得下再带 loc（getwxacodeunlimit 不传播 path query，#942 同源教训）
    let scene = 'qr';
    const parts: string[] = [`org=${auth.tenantId}`];
    if (loc.length <= 26) parts.push(`loc=${loc}`);
    const s = parts.join('&');
    if (s.length <= 32) scene = s;
    const buf = await genMpCode(path, scene, env);
    if (!buf) {
      return res.status(502).json({ ok: false, code: 'MP_002', message: '小程序码生成失败（体验版未发布该页面或配额/限频）' });
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(buf);
  } catch (e) {
    next(e);
  }
});

export default router;
