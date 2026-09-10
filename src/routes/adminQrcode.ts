// admin 贴码端点（八件增量 BE-2）：GET /api/v1/admin/mp-qrcode?loc=&env=
// 与既有公开 GET /public/mp-qrcode（publicReport.ts，path 白名单报修首页）的差异：
//   - 本端点 org 取自登录租户上下文（auth.tenantId）——机构级贴码，admin 无法指定别家 org；
//   - 权限门：authMiddleware + requireRole('admin')；
//   - mpConfigured false → 503 MP_002（诚实：未配置不假装能出码）。
// 返回 image/png 二进制（genMpCode 同链路）；scene 32 字符硬限口径与公开端点一致。
import { Router } from 'express';
import { requireRole, type AuthLocals } from '../middleware/auth.js';
import { genMpCode, mpConfigured } from '../services/wechatMp.js';

const router = Router();

router.get('/admin/mp-qrcode', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals | undefined;
    if (!auth) return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing auth' });
    if (!requireRole(auth, 'admin')) {
      return res.status(403).json({ ok: false, code: 'FORBID_001', message: 'admin only' });
    }
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
