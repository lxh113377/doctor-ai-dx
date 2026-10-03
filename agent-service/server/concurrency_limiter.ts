/**
 * 表达层并发闸（r96）：SDK 子进程有启动开销，**并发必须有上限 + 队列**。
 *
 * 为什么这是上线前项而不是优化项：`@tencent-ai/agent-sdk` 的 `createSession` 会拉起
 * CodeBuddy CLI 子进程。放任并发的后果不是「慢一点」，而是每个请求各起一个进程
 * 把机器拖垮，最终表现为**全都超时**——而超时又会触发降级，于是系统在高负载时
 * 反而更稳（都走 fallback），形成一种「越忙看起来越正常」的假象。
 *
 * 策略：固定并发上限（默认 2，可 env 覆盖）+ FIFO 队列 + 队列上限。
 * 队列满时**立即失败并给出可归因错误码**，而不是无限排队——
 * 排队无上限等于把超时推给用户，且内存里堆积的请求永远等不到。
 */

/** 同时最多跑多少个表达层任务。取 2 是因为 CLI 子进程本身吃内存，而医生场景是低并发高要求。 */
export const MAX_CONCURRENT = Math.max(1, Number(process.env.AGENT_MAX_CONCURRENCY || 2));
/** 队列上限：超出即拒（fail-fast），避免请求在内存里无限堆积。 */
export const MAX_QUEUE = Math.max(0, Number(process.env.AGENT_MAX_QUEUE || 16));

export type LimiterStats = {
  running: number;
  queued: number;
  max_concurrent: number;
  max_queue: number;
  /** 累计被拒次数（被拒是运维要看的信号，不是可以忽略的噪声） */
  rejected: number;
  /** 累计完成数 */
  completed: number;
};

export class QueueFullError extends Error {
  readonly code = "queue-full";
  constructor(detail: string) {
    super(detail);
    this.name = "QueueFullError";
  }
}

type Job<T> = () => Promise<T>;

export function createLimiter(maxConcurrent = MAX_CONCURRENT, maxQueue = MAX_QUEUE) {
  let running = 0;
  const waiting: Array<{ job: Job<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const stats: LimiterStats = { running: 0, queued: 0, max_concurrent: maxConcurrent, max_queue: maxQueue, rejected: 0, completed: 0 };

  const pump = (): void => {
    while (running < maxConcurrent && waiting.length > 0) {
      const item = waiting.shift()!;
      running += 1;
      stats.running = running;
      stats.queued = waiting.length;
      item
        .job()
        .then(
          (v) => {
            stats.completed += 1;
            item.resolve(v);
          },
          (e) => item.reject(e),
        )
        .finally(() => {
          running -= 1;
          stats.running = running;
          pump();
        });
    }
  };

  const run = <T>(job: Job<T>): Promise<T> => {
    if (running < maxConcurrent && waiting.length === 0) {
      // 快路径：直接执行，避免为一个请求凭空造一个 Promise 链
      running += 1;
      stats.running = running;
      return job()
        .then((v) => {
          stats.completed += 1;
          return v;
        })
        .finally(() => {
          running -= 1;
          stats.running = running;
          pump();
        });
    }
    if (waiting.length >= maxQueue) {
      stats.rejected += 1;
      return Promise.reject(new QueueFullError(`表达层队列已满（${maxQueue}），请稍后重试`));
    }
    return new Promise<T>((resolve, reject) => {
      waiting.push({ job: job as Job<unknown>, resolve: resolve as (v: unknown) => void, reject });
      stats.queued = waiting.length;
      pump();
    });
  };

  return { run, stats, get queued() { return waiting.length; }, get running() { return running; } };
}

/** 进程级单例：编排层与探针共用同一个闸，才能在 /status 里如实看到排队情况。 */
export const limiter = createLimiter();
