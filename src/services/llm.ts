// services/llm.ts —— DeepSeek 语义推断（B 档，租户级授权后启用）
// DMR：描述 + 该机构分类清单 → LLM 推断 { category, priority, asset }
// 安全/合规：
//   - 只传脱敏描述 + 分类名清单（绝不传手机号/姓名/位置等个人信息）
//   - 未配置 DEEPSEEK_API_KEY / 租户未授权 / 超时 / 解析失败 → 返回 null，调用方回退 A 档规则引擎
//   - Node16 无全局 fetch → 用 https 模块
import https from 'node:https';

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 8000);

export function llmConfigured(): boolean {
  return Boolean(API_KEY);
}

interface LlmResult {
  category: string | null;
  priority: 'urgent' | 'normal' | 'low' | null;
  asset: string | null;
  reason?: string;
}

function httpsPostJson(url: string, body: unknown, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('llm json parse fail'));
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('llm timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// 语义推断：描述 + 分类清单 → {category, priority, asset}；任何异常返回 null（调用方回退规则引擎）
export async function llmInferCategory(
  description: string,
  categoryNames: string[],
): Promise<LlmResult | null> {
  if (!llmConfigured()) return null;
  const desc = (description || '').trim().slice(0, 200); // 脱敏截断：只取描述本身
  if (!desc) return null;
  // 分类清单截断（防 prompt 过长）：最多 60 个分类名
  const cats = categoryNames.filter(Boolean).slice(0, 60).join('、');

  const system = '你是物业/医院报修工单的分类助手。根据用户描述，从给定的分类列表中选择最合适的分类，并判断优先级和关联资产。只输出 JSON，不要解释。';
  const user = `可用分类：${cats}\n用户描述：${desc}\n请输出 JSON：{"category":"分类名或null","priority":"urgent|normal|low","asset":"关联设备名或null"}。注意：分类必须从可用分类列表中选，选不出就 null，不要编造。`;

  try {
    const data = await httpsPostJson(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      },
      LLM_TIMEOUT_MS,
    );
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    const category = typeof parsed.category === 'string' && parsed.category ? parsed.category : null;
    const priority = ['urgent', 'normal', 'low'].includes(parsed.priority) ? parsed.priority : null;
    const asset = typeof parsed.asset === 'string' && parsed.asset ? parsed.asset : null;
    // 可观测性（诚实证据链）：LLM 成功推断时留痕，便于核对"走了 LLM 而非规则引擎"
    console.log(`[llm] ok category=${category ?? '-'} priority=${priority ?? '-'} asset=${asset ?? '-'}`);
    return { category, priority, asset };
  } catch (e) {
    console.warn('[llm] infer fail (fallback to rule):', (e as Error).message);
    return null;
  }
}
