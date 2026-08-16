#!/usr/bin/env node
// register-webhook.mjs —— 部署期注册外部 Webhook 订阅（零依赖，不改应用代码）。
//
// 用途：把试点/生产环境的外部接收方地址写入 webhook_subscription 表（经 API，受租户 RLS 隔离）。
// 注册后，优服家工单事件（create/assign/transition/sla_escalated）会自动推送到该地址。
//
// 鉴权：
//  - dev 模式（AUTH_MODE=dev，默认）：--token 留空即使用 "dev"（后端放行任何 Bearer dev）。
//  - prod 模式（AUTH_MODE=prod）：必须传入真实 JWT，如 --token "eyJ..."。
//
// 用法：
//  node scripts/register-webhook.mjs --url https://hooks.example.com/youfu \
//       [--events create,assign,transition,sla_escalated] \
//       [--secret <pinned>] [--tenant t-verification] [--token dev] \
//       [--base http://127.0.0.1:4001] [--probe]
//
// 注意：secret 仅在创建时由接口返回一次，请妥善保存（用于校验 X-Youfu-Signature）。

function parseArgs(argv) {
  const out = { events: '*', token: 'dev', tenant: 't-verification', base: 'http://127.0.0.1:4001', probe: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--url': out.url = argv[++i]; break;
      case '--events': out.events = argv[++i]; break;
      case '--secret': out.secret = argv[++i]; break;
      case '--token': out.token = argv[++i]; break;
      case '--tenant': out.tenant = argv[++i]; break;
      case '--base': out.base = argv[++i]; break;
      case '--probe': out.probe = true; break;
      case '--help': case '-h':
        console.log('node scripts/register-webhook.mjs --url <callback> [--events create,assign,...] [--secret <pinned>] [--tenant t-verification] [--token dev] [--base http://127.0.0.1:4001] [--probe]');
        process.exit(0);
      default:
        console.error(`未知参数: ${a}`); process.exit(2);
    }
  }
  return out;
}

function fail(msg, code = 1) {
  console.error(`[register-webhook] ${msg}`);
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.url) fail('缺少必填参数 --url <外部回调地址>');

  const events = args.events === '*' ? ['*'] : args.events.split(',').map((s) => s.trim()).filter(Boolean);
  const body = { url: args.url, events };
  if (args.secret) body.secret = args.secret;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${args.token}`,
    'X-Tenant-Id': args.tenant,
  };

  console.log(`== 注册 Webhook 订阅 ==`);
  console.log(`   目标租户 : ${args.tenant}`);
  console.log(`   API 基址 : ${args.base}`);
  console.log(`   回调地址 : ${args.url}`);
  console.log(`   订阅事件 : ${JSON.stringify(events)}`);
  console.log(`   鉴权令牌 : ${args.token === 'dev' ? 'dev (开发模式)' : '<已提供 JWT>'}`);

  let resp;
  try {
    resp = await fetch(`${args.base.replace(/\/$/, '')}/api/v1/webhooks/subscriptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    fail(`无法连接后端 (${args.base})：${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await resp.text();
  if (!resp.ok) {
    fail(`注册失败 HTTP ${resp.status}：${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail(`返回非 JSON：${text}`);
  }

  console.log('');
  console.log('== 注册成功 ==');
  console.log(`   订阅 ID : ${data.id}`);
  console.log(`   状态     : ${data.active ? 'active' : 'inactive'}`);
  console.log(`   事件     : ${JSON.stringify(data.events)}`);
  console.log('');
  console.log('   ⚠️ 以下 secret 仅返回一次，请立即保存（用于校验 X-Youfu-Signature）：');
  console.log(`   SECRET   : ${data.secret}`);
  console.log('');

  if (args.probe) {
    console.log('== 探针（/webhooks/test）==');
    try {
      const p = await fetch(`${args.base.replace(/\/$/, '')}/api/v1/webhooks/test`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: args.url, secret: data.secret }),
      });
      const pt = await p.text();
      console.log(`   HTTP ${p.status}：${pt}`);
    } catch (e) {
      console.error(`   探针请求异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log('提示：可访问 GET /api/v1/webhooks/subscriptions 查看本租户订阅（不泄露 secret），GET /api/v1/webhooks/deliveries 排查投递。');
}

main();
