/**
 * 建 / 合并定时任务的共享逻辑（Day 8）。schedule_task 工具和 /cron add 命令都走这里，
 * 保证「校验 cron + 生成名字 + 落 store」一套规则，不各写各的。
 */

import type { CronTask } from "../config.js";
import { parseCron } from "./cron-expr.js";
import type { TasksStore } from "./tasks-store.js";

export interface NewTaskInput {
  at: string;
  prompt: string;
  name?: string;
  to?: string;
}

/** 校验 cron 表达式；合法返回 null，非法返回给用户看的错误说明。 */
export function validateCron(at: string): string | null {
  try {
    parseCron(at);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** 从提示词凑一个短名（取前几个中英文/数字字符）；空了兜底 task。 */
function slugName(prompt: string): string {
  const base = (prompt.match(/[\p{L}\p{N}]+/gu) ?? []).join("").slice(0, 12);
  return base ? `task-${base}` : "task";
}

/** 名字唯一化：撞了就加 -2、-3…（在已有任务名集合里避让）。 */
function uniqueName(want: string, taken: Set<string>): string {
  if (!taken.has(want)) return want;
  for (let i = 2; ; i++) {
    const candidate = `${want}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * 建一条运行时任务并落 store。cron 非法直接抛（带人话原因），调用方接住回给用户。
 * 返回最终入库的任务（名字可能被补全 / 去重过）。
 */
export function addUserTask(
  store: TasksStore,
  input: NewTaskInput,
  existingNames: string[] = [],
): CronTask {
  const at = input.at.trim();
  const err = validateCron(at);
  if (err) {
    throw new Error(`时间格式不对（需要 5 字段 cron 表达式，如 "0 9 * * *"）：${err}`);
  }
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("任务内容（prompt）不能为空");

  const taken = new Set([...existingNames, ...store.list().map((t) => t.name)]);
  const name = uniqueName((input.name?.trim() || slugName(prompt)), taken);

  const task: CronTask = { name, at, prompt, enabled: true };
  if (input.to?.trim()) task.to = input.to.trim();
  store.upsert(task);
  return task;
}

/**
 * 合并任务表：yaml 声明的 + 运行时 store 的。同名时 store 覆盖（用户后建的为准）。
 * 调度器调度的、/cron list 列的、都用这一份，口径一致。
 */
export function mergedTasks(configTasks: CronTask[], store: TasksStore): CronTask[] {
  const byName = new Map<string, CronTask>();
  for (const t of configTasks) byName.set(t.name, t);
  for (const t of store.list()) byName.set(t.name, t);
  return [...byName.values()];
}
