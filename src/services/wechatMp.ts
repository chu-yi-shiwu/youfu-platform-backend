// services/wechatMp.ts —— 微信小程序身份能力（手机号授权解密）
// 初一定调 2026-08-23："授权时候就获取基本信息，不要让用户去手填"
// 合规：手机号为用户点按钮显式授权（open-type=getPhoneNumber）后经微信 code2session 解密；
//       解密结果仅用于报修人身份锚点（ext.reporter_phone），不落明文日志、不外传。
import https from 'node:https';
import { httpsGetJson, httpsPostJson } from './httpJson.js';

// 小程序凭证：订阅消息复用同一套小程序（MP_APPID/MP_SECRET），并兼容 WX_MP_APPID/WX_MP_SECRET 别名。
const MP_APPID = process.env.MP_APPID || process.env.WECHAT_MP_APPID || process.env.WX_MP_APPID || '';
const MP_SECRET = process.env.MP_APPSECRET || process.env.WECHAT_MP_APPSECRET || process.env.WX_MP_SECRET || '';

export function mpConfigured(): boolean {
  return Boolean(MP_APPID && MP_SECRET);
}

// wx.login 的 code → session_key + openid（v5.0 P0：微信 openid 绑定用）
export async function code2Session(loginCode: string): Promise<{ openid: string; sessionKey: string } | null> {
  if (!mpConfigured() || !loginCode) return null;
  try {
    const d = await httpsGetJson(
      `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(MP_APPID)}&secret=${encodeURIComponent(MP_SECRET)}&js_code=${encodeURIComponent(loginCode)}&grant_type=authorization_code`,
      8000,
    );
    if (!d || d.errcode || !d.session_key) {
      console.warn('[wechatMp] code2session fail:', d?.errcode ?? 'no session_key');
      return null;
    }
    return { openid: d.openid, sessionKey: d.session_key };
  } catch (e) {
    console.warn('[wechatMp] code2session error:', (e as Error).message);
    return null;
  }
}

// 微信 access_token 缓存（有效 7200s，缓存 7000s 防边界；避免每次请求都拉 token 触发限频）
let _tokenCache: { token: string; expiresAt: number } | null = null;

export async function getMpAccessToken(): Promise<string | null> {
  if (_tokenCache && _tokenCache.expiresAt > Date.now()) return _tokenCache.token;
  try {
    const tokenRes = await httpsGetJson(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(MP_APPID)}&secret=${encodeURIComponent(MP_SECRET)}`,
      8000,
    );
    const accessToken = tokenRes?.access_token;
    if (!accessToken) {
      console.warn('[wechatMp] get access_token fail:', tokenRes?.errcode ?? 'no token');
      return null;
    }
    _tokenCache = { token: accessToken, expiresAt: Date.now() + 7000 * 1000 };
    return accessToken;
  } catch (e) {
    console.warn('[wechatMp] get access_token error:', (e as Error).message);
    return null;
  }
}

// 解密手机号：getPhoneNumber 按钮返回的 code 换 phone_info（code 直接换，无需 session_key）
// 微信 2023 起新接口：POST /wxa/business/getuserphonenumber?access_token=xxx，body { code }
// 需先拿 access_token（小程序 access_token 用 MP_APPID/MP_SECRET）
// R30-F8：自写 https 实现收敛到 httpsPostJson（含 1MB 响应上限 + 5xx reject，catch 后仍返回 null，行为等价且更一致）。
// 注意：genMpCode 返回二进制 PNG，httpJson 仅支持 JSON，故保留自写实现。
export async function decryptPhoneCode(phoneCode: string): Promise<string | null> {
  if (!mpConfigured() || !phoneCode) return null;
  try {
    // 1) 拿小程序 access_token（带缓存）
    const accessToken = await getMpAccessToken();
    if (!accessToken) return null;
    // 2) 用 code 换手机号（POST）
    const result = await httpsPostJson(
      `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(accessToken)}`,
      { code: phoneCode },
    );
    if (result?.errcode === 0 && result?.phone_info?.phoneNumber) {
      return result.phone_info.phoneNumber;
    }
    console.warn('[wechatMp] getuserphonenumber fail:', result?.errcode ?? 'no phone');
    return null;
  } catch (e) {
    console.warn('[wechatMp] decryptPhoneCode error:', (e as Error).message);
    return null;
  }
}

// 生成带参小程序码（v0.4.0：扫码带 org/loc/role 参数；path 不计入 scene 长度限制）
// 入参：path = 小程序页面路径（可带 query，如 pages/index/index?org=xxx&loc=yyy）
// 返回：Buffer（二进制 PNG）；失败 null
export async function genMpCode(path: string, scene: string = 'qr'): Promise<Buffer | null> {
  if (!mpConfigured() || !path) return null;
  try {
    const accessToken = await getMpAccessToken();
    if (!accessToken) return null;
    const body = JSON.stringify({ scene, path, width: 430 });
    const result = await new Promise<{ buf: Buffer | null; errcode?: number; errmsg?: string }>((resolve) => {
      const u = new URL(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(accessToken)}`);
      const req = https.request(
        {
          hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 10000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            // 微信成功返回 image/png 二进制；失败返回 JSON { errcode, errmsg }
            if (res.headers['content-type']?.includes('image')) resolve({ buf });
            else {
              try {
                const j = JSON.parse(buf.toString('utf8'));
                console.warn('[wechatMp] genMpCode fail:', j.errcode, j.errmsg);
                resolve({ buf: null, errcode: j.errcode, errmsg: j.errmsg });
              } catch {
                console.warn('[wechatMp] genMpCode parse fail, raw len:', buf.length);
                resolve({ buf: null });
              }
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('genMpCode timeout')));
      req.on('error', () => resolve({ buf: null }));
      req.write(body);
      req.end();
    });
    return result.buf;
  } catch (e) {
    console.warn('[wechatMp] genMpCode error:', (e as Error).message);
    return null;
  }
}
