// 模型层（显式定义"模"）：派单自适应评分 + 在线增量学习。
//
// ModelBackend 抽象两种实现（设计总纲 N1 升级）：
//  - StatsModelBackend：内置可实现版（多维权重 EMA 在线增量学习 + 上下文 bandit UCB 选臂），纯 TS+SQL，本系统开发能力可完整交付。
//  - RemoteMLBackend：未来集成缝（HTTP 调外部 Python 重型模型），当前不实现、接口预留，满足"若不能实现则保留未来升级/接入设计"。
//
// 评分/学习拆为纯函数，model_state 的 DB 读写由 modelTrainer 负责，故本模块可脱离 PG 单测。

export interface DispatchContext {
  category: string; // business_type 或 catalog，作为模型维度
  workerId: string;
}

export interface ModelParams {
  arms: Record<string, { weight: number; pulls: number }>;
  alpha: number; // EMA 学习率
  ucbC: number; // UCB 探索系数
  version: number;
}

export interface ModelBackend {
  /** 给定上下文返回该候选的派单评分（高=更优）。新候选返回基线分以便被探索。 */
  score(ctx: DispatchContext): number;
  /** 用一次结果事件更新模型：reward>0 提升该臂权重，reward<0 降低。 */
  learn(category: string, workerId: string, reward: number): void;
  /** 导出参数（持久化到 model_state）。 */
  toParams(): ModelParams;
}

const DEFAULT_ALPHA = 0.2;
const DEFAULT_UCB = 1.5;
const BASELINE = 0.5;
const armKey = (category: string, workerId: string) => `${category}::${workerId}`;

export class StatsModelBackend implements ModelBackend {
  private static readonly MAX_ARMS = 5000; // 防御 arms 字典随运行无限膨胀（实际业务类型×工人远小于此）
  private arms: Record<string, { weight: number; pulls: number }>;
  private alpha: number;
  private ucbC: number;
  private totalPulls: number;
  readonly version: number;

  constructor(params?: Partial<ModelParams>) {
    this.arms = params?.arms ?? {};
    this.alpha = params?.alpha ?? DEFAULT_ALPHA;
    this.ucbC = params?.ucbC ?? DEFAULT_UCB;
    this.version = params?.version ?? 1;
    this.totalPulls = Object.values(this.arms).reduce((s, a) => s + a.pulls, 0);
  }

  /** 评分 = 臂权重 + UCB 探索项；未见过（新臂）强探索，优先被尝试且 > 基线。 */
  score(ctx: DispatchContext): number {
    const a = this.arms[armKey(ctx.category, ctx.workerId)];
    if (!a) return BASELINE + this.ucbC; // 未见过 → 强探索，确保被尝试
    const exploration = this.ucbC * Math.sqrt(Math.log(this.totalPulls + 1) / (a.pulls + 1));
    return a.weight + exploration;
  }

  /** EMA 增量更新：权重向 reward 靠拢。 */
  learn(category: string, workerId: string, reward: number): void {
    const key = armKey(category, workerId);
    const a = this.arms[key] ?? { weight: BASELINE, pulls: 0 };
    a.weight = a.weight + this.alpha * (reward - a.weight);
    a.pulls += 1;
    this.arms[key] = a;
    this.totalPulls += 1;
    this.evictIfNeeded();
  }

  /** 超出臂上限时丢弃 pulls 最小的臂（并列取最先插入），防止长期运行内存泄漏。 */
  private evictIfNeeded(): void {
    const keys = Object.keys(this.arms);
    if (keys.length <= StatsModelBackend.MAX_ARMS) return;
    let victim = keys[0];
    for (const k of keys) {
      if (this.arms[k].pulls < this.arms[victim].pulls) victim = k;
    }
    delete this.arms[victim];
  }

  toParams(): ModelParams {
    return { arms: this.arms, alpha: this.alpha, ucbC: this.ucbC, version: this.version };
  }

  static fromParams(p: ModelParams): StatsModelBackend {
    return new StatsModelBackend(p);
  }
}

/** 未来集成缝：重型模型经 HTTP 调外部 Python 服务；当前不实现、接口预留。 */
export class RemoteMLBackend implements ModelBackend {
  constructor(private endpoint?: string) {}
  score(_ctx: DispatchContext): number {
    throw new Error(
      'RemoteMLBackend not implemented: reserved for future Python ML service (set MODEL_BACKEND=remote to enable)',
    );
  }
  learn(_category: string, _workerId: string, _reward: number): void {
    throw new Error('RemoteMLBackend not implemented: reserved for future Python ML service');
  }
  toParams(): ModelParams {
    throw new Error('RemoteMLBackend not implemented');
  }
}

export function createModelBackend(kind: 'stats' | 'remote' = 'stats', params?: ModelParams): ModelBackend {
  if (kind === 'remote') return new RemoteMLBackend();
  return new StatsModelBackend(params);
}
