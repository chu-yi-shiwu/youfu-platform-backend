// ③ 微信 JSSDK 公开端点（免登录，挂在 authMiddleware 之前）：
//   GET /api/v1/wechat/jssdk-config?url= —— 返回 wx.config 签名，供 H5 在微信内录音前注入
// 诚实降级：未配置 WECHAT_APPID/WECHAT_APPSECRET → 503（前端据此隐藏录音入口而非假装可用）。
import { Router } from 'express';
import { getJssdkConfig, wechatConfigured } from '../services/wechat.js';

const router = Router();

router.get('/jssdk-config', async (req, res, next) => {
  try {
    if (!wechatConfigured()) {
      return res.status(503).json({
        ok: false,
        code: 'WECHAT_CFG',
        message: '微信 JSSDK 未配置（请在服务端设置 WECHAT_APPID / WECHAT_APPSECRET）',
      });
    }
    const url = (req.query.url as string) || '';
    if (!url || !/^https?:\/\//.test(url)) {
      return res.status(422).json({ ok: false, code: 'BAD_URL', message: '缺少合法的 url 参数' });
    }
    const cfg = await getJssdkConfig(url);
    return res.json({ ok: true, code: 0, ...cfg });
  } catch (e) {
    next(e);
  }
});

export default router;
