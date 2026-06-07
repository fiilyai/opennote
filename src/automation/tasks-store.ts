/**
 * 运行时任务存储（Day 8）。落在 ~/.opennote/cron/tasks.json。
 *
 * 跟 opennote.yaml 里的 `cron:` 分两层：
 *   - yaml = 版本控制的「声明式」任务（跟仓库走、要过 sanitize 安全闸）。
 *   - 这个 store = 用户运行时随口建的任务（schedule_task 工具 / /cron add 命令写进来）。
 * 调度器把两层**合并**调度。这样「你说一句就建任务」不会去改被 git 跟踪的配置文件。
 *
 * 关键设计：每次 list() 都**重新读盘**，不缓存。因为建任务的工具（在消息通道的 agent 里）
 * 和调度器（另一个循环 / 另一个 agent）是不同实例，靠同一个文件保持一致——工具写完，
 * 调度器下一 tick 读盘就看见，不重启即生效。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CronTask } from "../config.js";

const DEFAULT_FILE = join(homedir(), ".opennote", "cron", "tasks.json");

export class TasksStore {
  private readonly file: string;

  constructor(file: string = DEFAULT_FILE) {
    this.file = file;
  }

  /** 当前所有运行时任务（每次读盘，拿最新）。 */
  list(): CronTask[] {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(data) ? (data as CronTask[]) : [];
    } catch {
      return []; // 坏文件当空，别挡住调度
    }
  }

  get(name: string): CronTask | undefined {
    return this.list().find((t) => t.name === name);
  }

  /** 新增或按 name 覆盖一条任务，写回磁盘。 */
  upsert(task: CronTask): void {
    const tasks = this.list().filter((t) => t.name !== task.name);
    tasks.push(task);
    this.persist(tasks);
  }

  /** 删一条任务；返回是否真的删掉了。 */
  remove(name: string): boolean {
    const tasks = this.list();
    const next = tasks.filter((t) => t.name !== name);
    if (next.length === tasks.length) return false;
    this.persist(next);
    return true;
  }

  /** 改某条任务的启用状态；返回是否找到。 */
  setEnabled(name: string, enabled: boolean): boolean {
    const tasks = this.list();
    const task = tasks.find((t) => t.name === name);
    if (!task) return false;
    task.enabled = enabled;
    this.persist(tasks);
    return true;
  }

  private persist(tasks: CronTask[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(tasks, null, 2), "utf8");
  }
}
