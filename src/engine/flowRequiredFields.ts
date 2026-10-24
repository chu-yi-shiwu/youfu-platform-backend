// src/engine/flowRequiredFields.ts —— 通用业务流通道的「必填字段校验」。
//
// ─────────────────────────────────────────────────────────────────────────────
// 【⚠️ 为什么这个函数要单独占一个文件（看起来很怪，但别合并回 flowProxy.ts）】
//
//   `engine/flowProxy.ts` 的 registry 要**按值**引入 adapter：
//       import { transportAdapter } from '../routes/flowAdapters/transportAdapter.js';
//   而 adapter 又要用到"通用通道的必填校验"。
//   若这个校验放在 flowProxy.ts 里，adapter 就得**按值**反向 import flowProxy
//   ⇒ 形成运行时循环依赖 `flowProxy → transportAdapter → flowProxy`。
//
//   🔴 循环依赖的真实后果（**已实测，不是推测**）：
//     加载顺序为「先 transportAdapter、后 flowProxy」时，Node ESM 直接抛
//       `ReferenceError: Cannot access 'transportAdapter' before initialization`
//     发生在 `flowProxy.ts` 初始化 registry 那一行。
//     ⚠️ **vitest 下不炸**（它的模块执行顺序与裸 Node 不同）——这正是最危险的地方：
//        单测全绿会让人以为没问题，一上生产（tsx / node）就崩在启动阶段。
//
//   ⇒ 破环办法：把这份校验下沉到本文件，adapter 对 `flowProxy.ts` **只剩
//     `import type`（编译期擦除，不产生运行时依赖）**。
//
//   🧷 护栏：`src/test/transportAdapter.map.test.ts` 里有一条断言
//      "adapter 引用 flowProxy.js 的 import 必须是 import type"守着这个不变式。
//
// 【校验本身是从哪儿搬来的】
//   原 `routes/businessFlow.ts:177-185` 的内联块，**逐字搬出**（消息与状态码一致）。
//   收口到一处是必须的：`/flow` 走代理时，分派在 handler 开头就走了，
//   路由里那段校验**根本执行不到** ⇒ 不在 adapter 里接着做，就等于悄悄取消一道校验。
//   于是「未代理路径（businessFlow）」与「代理路径（adapter）」共用同一份实现，
//   校验语义不随路由分叉而分叉。
import { AppError } from '../middleware/error.js';
import type { WorkflowDef } from './stateMachine.js';

/**
 * 校验本次流转的 requiredFields（引用 data 内字段）。
 *
 * @param def            状态图（def 口径）
 * @param currentStatus  实体当前状态（用于定位是哪条 transition）
 * @param event          本次事件名
 * @param data           调用方传的 data（必填字段从这里取值）
 */
export function assertRequiredFields(
  def: WorkflowDef,
  currentStatus: string,
  event: string,
  data: Record<string, unknown>,
): void {
  const tr = def.transitions.find((x) => x.from === currentStatus && x.event === event);
  if (!tr) throw new AppError('BAD_STATE', `illegal transition ${currentStatus} --${event}-->`, 422);
  if (tr.requiredFields && tr.requiredFields.length) {
    const missing = tr.requiredFields.filter((f) => data[f] == null || data[f] === '');
    if (missing.length) {
      throw new AppError('BAD_REQUEST', `missing required field: ${missing.join(',')}`, 422);
    }
  }
}
