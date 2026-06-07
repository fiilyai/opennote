/**
 * 定时任务的运行状态（Day 8）。落在 ~/.opennote/cron/state.json。
 *
 * 只记一件事：每个任务上次跑在哪一分钟。调度器每分钟 tick，靠它做两件事：
 *   1. 防重复——同一分钟内多次 tick（定时器抖动）不重复触发。
 *   2. 留痕——/cron list 能显示「上次跑于」。
 *
 * 不做「补跑」：serve 没开的时段错过的任务就错过了，不在重启时追跑
 * （日报这种错过一次无所谓，补跑反而可能半夜炸出一堆消息）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface RunRecord {
  /** 上次实际触发的时刻（毫秒）。 */
  lastRunMs: number;
  /** 上次结果摘要（成功 / 错误信息），给 /cron list 显示。 */
  lastStatus?: string;
}

const DEFAULT_FILE = join(homedir(), ".opennote", "cron", "state.json");

export class CronStateStore {
  private readonly file: string;
  private state: Record<string, RunRecord>;

  constructor(file: string = DEFAULT_FILE) {
    this.file = file;
    this.state = this.load();
  }

  private load(): Record<string, RunRecord> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, RunRecord>;
    } catch {
      return {}; // 坏文件当空，别让它挡住调度
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf8");
    } catch {
      // 写盘失败不致命：防重复仍靠内存里的 state 兜着
    }
  }

  getLastRun(name: string): number {
    return this.state[name]?.lastRunMs ?? 0;
  }

  getLastStatus(name: string): string | undefined {
    return this.state[name]?.lastStatus;
  }

  markRun(name: string, atMs: number, status?: string): void {
    this.state[name] = { lastRunMs: atMs, lastStatus: status };
    this.persist();
  }
}
