// 微信公众号 JSSDK 助手（③ 微信真录音所需）。
// 仅服务端持有 appId/appSecret，绝不下发前端；提供：
//   - access_token / jsapi_ticket 缓存（进程内，提前 5 分钟过期）
//   - getJssdkConfig(url)：wx.config 签名（sha1）
//   - downloadMedia(mediaId)：从微信服务器下载原始录音（amr），无损耗
// 诚实降级：未配置 WECHAT_APPID/WECHAT_APPSECRET 时 wechatConfigured()=false，
//   调用方据此返回 503，绝不假装可用。
// 注意：Node16 无全局 fetch，统一用 https 模块。
import https from 'node:https';
import crypto from 'node:crypto';

const APPID = process.env.WECHAT_APPID || '';
const SECRET = process.env.WECHAT_APPSECRET || '';

interface Cached { value: string; expireAt: number; }

let tokenCache: Cached | null = null;
let ticketCache: Cached | null = null;

function httpsGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('wechat json parse fail: ' + body.slice(0, 200)));
          }
        });
      })
      .on('error', reject);
  });
}

function httpsGetBuffer(url: string): Promise<{ buf: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const ct = (res.headers['content-type'] || 'audio/amr') as string;
          resolve({ buf: Buffer.concat(chunks), contentType: ct });
        });
      })
      .on('error', reject);
  });
}

export function wechatConfigured(): boolean {
  return Boolean(APPID && SECRET);
}

export async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expireAt > Date.now()) return tokenCache.value;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`;
  const data = await httpsGetJson(url);
  if (data.errcode) throw new Error(`wechat token err ${data.errcode} ${data.errmsg}`);
  tokenCache = { value: data.access_token, expireAt: Date.now() + (Number(data.expires_in) - 300) * 1000 };
  return data.access_token;
}

export async function getJsapiTicket(accessToken: string): Promise<string> {
  if (ticketCache && ticketCache.expireAt > Date.now()) return ticketCache.value;
  const url = `https://api.weixin.qq.com/cgi-bin/ticket/getticket?access_token=${accessToken}&type=jsapi`;
  const data = await httpsGetJson(url);
  if (data.errcode) throw new Error(`wechat ticket err ${data.errcode} ${data.errmsg}`);
  ticketCache = { value: data.ticket, expireAt: Date.now() + (Number(data.expires_in) - 300) * 1000 };
  return data.ticket;
}

// wx.config 所需签名：sha1(jsapi_ticket=..&noncestr=..&timestamp=..&url=..)
export async function getJssdkConfig(url: string) {
  const accessToken = await getAccessToken();
  const ticket = await getJsapiTicket(accessToken);
  const nonceStr = crypto.randomBytes(8).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  const raw = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  const signature = crypto.createHash('sha1').update(raw).digest('hex');
  return { appId: APPID, timestamp, nonceStr, signature };
}

// 从微信服务器下载录音原始文件（amr）。mediaId 即前端 wx.uploadVoice 返回的 serverId。
// 微信侧 media 有效期 3 天；过期下载会返回 JSON 错误，调用方 best-effort 处理。
export async function downloadMedia(mediaId: string): Promise<{ buf: Buffer; contentType: string }> {
  const accessToken = await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/media/get?access_token=${accessToken}&media_id=${encodeURIComponent(mediaId)}`;
  const { buf, contentType } = await httpsGetBuffer(url);
  if (contentType.includes('application/json')) {
    try {
      const j = JSON.parse(buf.toString('utf8'));
      throw new Error(`wechat media err ${j.errcode} ${j.errmsg}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('wechat media err')) throw e;
    }
  }
  return { buf, contentType };
}
