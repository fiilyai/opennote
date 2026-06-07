/**
 * 极简异步互斥锁：把并发的 run() 排成一条队，前一个 settle 了才轮到下一个。
 *
 * 用处（Day 8）：定时调度器的 tick 和 /cron run 手动触发，跑的是同一个 cron agent。
 * 两个 agent.prompt() 同时跑会互踩 state.messages，用它串起来就各跑各的。
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // 不管前一个成功还是失败，都接着排队（catch 掉，免得一个失败堵死整条队）。
    const result = this.tail.then(
      () => fn(),
      () => fn(),
    );
    this.tail = result.catch(() => {});
    return result;
  }
}
