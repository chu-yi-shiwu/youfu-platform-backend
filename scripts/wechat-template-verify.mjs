// 小程序订阅消息模板核验（只读）。
// 验证 WX_MP_TEMPLATE_ID 确实存在于当前小程序，且 WX_MP_TEMPLATE_KEYS 都被模板字段覆盖。
// 用法：ENV_FILE=.env node scripts/wechat-template-verify.mjs
// 退出码：0=通过；1=配置/核验失败。不会输出 access_token / secret。
import { readFileSync, existsSync } from 'node:fs';
import https from 'node:https';

for (const f of [process.env.ENV_FILE || '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const appid = process.env.MP_APPID || process.env.WECHAT_MP_APPID || process.env.WX_MP_APPID;
const secret = process.env.MP_APPSECRET || process.env.WECHAT_MP_APPSECRET || process.env.WX_MP_SECRET;
const templateId = process.env.WX_MP_TEMPLATE_ID || '';
const keys = (process.env.WX_MP_TEMPLATE_KEYS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function getJson(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); }
      });
    }).on('error', (e) => resolve({ error: e.message }));
  });
}

const fail = (msg) => { console.error(`[FAIL] ${msg}`); process.exitCode = 1; };
const pass = (msg) => console.log(`[PASS] ${msg}`);

if (!appid || !secret) fail('MP_APPID / MP_APPSECRET 未配置');
if (!templateId) fail('WX_MP_TEMPLATE_ID 未配置');
if (process.exitCode) process.exit(1);

const tokenResp = await getJson(
  `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`,
);
if (!tokenResp.access_token) {
  fail(`获取 access_token 失败：${tokenResp.errcode ?? 'no token'} ${tokenResp.errmsg ?? ''}`);
  process.exit(1);
}
pass('access_token 获取成功');

const list = await getJson(
  `https://api.weixin.qq.com/wxaapi/newtmpl/gettemplate?access_token=${encodeURIComponent(tokenResp.access_token)}`,
);
if (list.errcode !== 0) {
  fail(`读取小程序模板列表失败：${list.errcode} ${list.errmsg ?? ''}`);
  process.exit(1);
}
const templates = list.data ?? [];
const match = templates.find((t) => t.priTmplId === templateId);
if (!match) {
  fail(`WX_MP_TEMPLATE_ID 不在当前小程序模板列表中（现有 ${templates.length} 个）`);
  process.exit(1);
}
pass(`模板存在：${match.title}`);
if (keys.length === 0) fail('WX_MP_TEMPLATE_KEYS 为空');
const missing = keys.filter((k) => !String(match.content || '').includes(`{{${k}.DATA}}`));
if (missing.length > 0) fail(`模板缺少字段：${missing.join(', ')}`);
else pass(`模板字段匹配：${keys.join(', ')}`);

process.exit(process.exitCode ?? 0);
