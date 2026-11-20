// 案例向量嵌入的有界后台队列（2026-11-15 主站压测根因）
//
// 问题：ticket.ts 在建单后 fire-and-forget 调用 embedText。主站配置了 EMBEDDING_API_KEY，
//   高并发建单时 100+ 个外部 embedding 请求同时挂起，拖慢事件循环与出站连接，
//   表现为建单 p95 从 ~240ms 升到 3s+，并连带影响同期的流转请求。
//   且原逻辑只判断「全局是否配置 key」，没有遵守租户 ai_features_enabled 开关。
//
// 根因修复：
//   1) 租户级 AI 开关关闭 ⇒ 不产生任何嵌入任务（默认关闭，fail-safe）。
//   2) 全局有界队列：最多 2 个并发、队列上限 200；超限丢弃并告警，绝不无限堆积。
//   3) 嵌入仍在后台执行，不阻塞建单响应；失败只告警，不影响业务。
export type EmbeddingTask = () => Promise<void>;

const MAX_ACTIVE = 2;
const MAX_QUEUE = 200;

let active = 0;
const queue: EmbeddingTask[] = [];

export function enqueueEmbedding(task: EmbeddingTask): boolean {
  if (queue.length >= MAX_QUEUE) {
    console.warn('[embedding-queue] queue full, dropping task (max=%d)', MAX_QUEUE);
    return false;
  }
  queue.push(task);
  pump();
  return true;
}

function pump(): void {
  while (active < MAX_ACTIVE && queue.length > 0) {
    const task = queue.shift() as EmbeddingTask;
    active += 1;
    Promise.resolve()
      .then(task)
      .catch((e) => console.warn('[embedding-queue] task failed:', (e as Error)?.message ?? e))
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

export function embeddingQueueStats(): { active: number; queued: number; maxActive: number; maxQueue: number } {
  return { active, queued: queue.length, maxActive: MAX_ACTIVE, maxQueue: MAX_QUEUE };
}
