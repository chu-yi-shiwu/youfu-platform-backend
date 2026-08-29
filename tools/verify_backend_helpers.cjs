// tools/verify_backend_helpers.cjs
// 后端纯函数 + 报修 schema 契约单测（不依赖 DB / 网络）。
// 运行方式见同目录说明：先 tsc 编出 .be_compiled，再 node 本文件。
const path = require('path');
// 编译产物放项目外临时目录（避免被 package.json type:module 当作 ESM）；可用 BE_COMPILED 覆盖
const base = process.env.BE_COMPILED ? path.resolve(process.env.BE_COMPILED) : path.resolve(__dirname, '.be_compiled');
const { inferPriority } = require(path.join(base, 'services/intakeEnrich.js'));
const { maskPhone, normalizeLocation } = require(path.join(base, 'services/llm.js'));
const { reportSchema } = require(path.join(base, 'routes/publicReportSchema.js'));

let failed = false;
function assert(c, m) {
  if (!c) { console.error('❌ FAIL:', m); failed = true; }
  else console.log('✅ PASS:', m);
}

// —— inferPriority（前端优先级覆盖的对照基准）——
assert(inferPriority('5楼水管爆裂漏水很急') === 'urgent', 'inferPriority 漏水很急=urgent');
assert(inferPriority('例行保养一下空调') === 'low', 'inferPriority 例行保养=low');
assert(inferPriority('走廊灯不亮') === 'normal', 'inferPriority 普通=normal');

// —— maskPhone（送第三方 LLM 前脱敏，隐私硬护栏）——
assert(maskPhone('联系13800138000明天修') === '联系***明天修', 'maskPhone 手机号脱敏');
assert(maskPhone('无电话描述') === '无电话描述', 'maskPhone 无手机号不变');

// —— normalizeLocation（位置否定词兜底，与前端 LOC_NEG 对齐）——
assert(normalizeLocation('未提及') === null, 'normalizeLocation 未提及→null');
assert(normalizeLocation('用户没说') === null, 'normalizeLocation 用户没说→null');
assert(normalizeLocation('3楼201房') === '3楼201房', 'normalizeLocation 真实位置保留');
assert(normalizeLocation('   ') === null, 'normalizeLocation 空白→null');

// —— reportSchema 新字段（🔴 修复点：priority / category_name 透传契约）——
const ok = reportSchema.parse({
  org: 't-verification', consent: true,
  priority: 'urgent', category_name: '电梯/设备',
  description: '走廊灯不亮需要维修',
});
assert(ok.priority === 'urgent' && ok.category_name === '电梯/设备', 'reportSchema 解析 priority+category_name 通过');

let threw = false;
try { reportSchema.parse({ org: 't-verification', consent: true, priority: 'super', description: '走廊灯不亮需要维修' }); }
catch (e) { threw = true; }
assert(threw, 'reportSchema 非法 priority 被拒');

let threw2 = false;
try { reportSchema.parse({ org: 't-verification', consent: true, category_name: 'x'.repeat(61), description: '走廊灯不亮需要维修' }); }
catch (e) { threw2 = true; }
assert(threw2, 'reportSchema 超长 category_name 被拒');

let threw3 = false;
try { reportSchema.parse({ org: 't-verification', consent: false, description: '走廊灯不亮需要维修' }); }
catch (e) { threw3 = true; }
assert(threw3, 'reportSchema consent=false 被拒（合规硬护栏）');

// —— reportSchema 手机号校验（🔴 修复点：须为大陆 11 位 1[3-9] 开头）——
let phoneBad = false;
try { reportSchema.parse({ org: 't-verification', consent: true, phone: '12345678901', description: '走廊灯不亮需要维修' }); }
catch (e) { phoneBad = true; }
assert(phoneBad, 'reportSchema 非法手机号(12开头)被拒');
let phoneOk = true;
try { reportSchema.parse({ org: 't-verification', consent: true, phone: '13800138000', description: '走廊灯不亮需要维修' }); }
catch (e) { phoneOk = false; }
assert(phoneOk, 'reportSchema 合法手机号(138...)通过');

console.log('\n=== 后端纯函数/契约单测结论：优先级/分类透传契约、脱敏与否定兜底生效 ===');
process.exit(failed ? 1 : 0);
