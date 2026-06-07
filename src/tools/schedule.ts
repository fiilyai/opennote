/**
 * 定时任务工具（Day 8）：让 agent 听懂「每天9点给我推个AI日报」这类意图，自己把任务建起来。
 *
 * 行业通行做法（ChatGPT Tasks / 各家助手的提醒）：给模型一个「建任务」工具，自然语言的
 * 时间由模型翻成 cron 表达式填进来，代码负责校验 + 落盘 + 回执。建完即生效（调度器每 tick
 * 重读任务表），随时能 /cron off 关掉。
 *
 * 任务落到运行时 store（~/.opennote/cron/tasks.json），不碰版本控制的 opennote.yaml。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";

import type { CronTask } from "../config.js";
import { addUserTask, mergedTasks } from "../automation/manage.js";
import { TasksStore } from "../automation/tasks-store.js";

const scheduleSchema = Type.Object({
  at: Type.String({
    description:
      "5 字段 cron 表达式（分 时 日 月 周），按本地时区。把用户说的自然语言时间翻成它：" +
      '“每天早上9点”→"0 9 * * *"；“每隔30分钟”→"*/30 * * * *"；' +
      '“每周一上午10点”→"0 10 * * 1"；“每个工作日18点”→"0 18 * * 1-5"。',
  }),
  prompt: Type.String({
    description: "到点要让 agent 做什么（驱动它的提示词）。如「扫一下最近的 AI 热点，挑几条推给我」。",
  }),
  name: Type.Optional(
    Type.String({ description: "可选，任务短名（英文/拼音皆可）。不给会自动起一个。" }),
  ),
  to: Type.Optional(
    Type.String({ description: "可选，结果推给谁（ilink_user_id）。不给默认推给当前用户。" }),
  ),
});

export type ScheduleInput = Static<typeof scheduleSchema>;

const cancelSchema = Type.Object({
  name: Type.String({ description: "要取消的任务名（先用 list_tasks 看有哪些）。" }),
});

const listSchema = Type.Object({});

/** 把任务表渲染成给模型看的清单。 */
function renderTasks(tasks: CronTask[]): string {
  if (tasks.length === 0) return "（当前没有定时任务）";
  return tasks
    .map((t) => {
      const flag = t.enabled === false ? "[停用]" : "[启用]";
      return `- ${t.name} ${flag} ｜ ${t.at} ｜ ${t.prompt}${t.to ? ` ｜→ ${t.to}` : ""}`;
    })
    .join("\n");
}

/**
 * 造定时任务相关的工具。
 * @param configTasks 读 yaml 里声明的任务（用于 list_tasks 合并展示），默认空。
 */
export function createScheduleTools(opts: {
  configTasks?: () => CronTask[];
  store?: TasksStore;
} = {}): AgentTool<typeof scheduleSchema | typeof cancelSchema | typeof listSchema>[] {
  const store = opts.store ?? new TasksStore();
  const configTasks = opts.configTasks ?? (() => []);

  const schedule: AgentTool<typeof scheduleSchema> = {
    name: "schedule_task",
    label: "建定时任务",
    description:
      "建一个定时任务：到点自动起一轮干活、把结果推给用户。" +
      "当用户表达「定时 / 每天 / 每隔…/ 到点提醒我 / 自动帮我…」这类排程意图时用它。" +
      "你负责把自然语言时间翻成 cron 表达式（at）。建完即生效，随后可用 /cron 查看、/cron off 关闭。",
    parameters: scheduleSchema,
    async execute(_id, input, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      try {
        const task = addUserTask(store, input, configTasks().map((t) => t.name));
        const toNote = task.to ? `推给 ${task.to}` : "推给当前用户";
        return {
          content: [
            {
              type: "text",
              text:
                `已建任务「${task.name}」：${task.at}（cron，本地时区），${toNote}。\n` +
                `到点执行：${task.prompt}\n` +
                `（建完即生效；/cron 查看全部，/cron off ${task.name} 可关闭，/cron run ${task.name} 立刻试跑）`,
            },
          ],
          details: { task },
        };
      } catch (err) {
        // 把校验失败如实回给模型，让它问清楚 / 改了再试，别假装建成功。
        return {
          content: [{ type: "text", text: `建任务失败：${err instanceof Error ? err.message : err}` }],
          details: { ok: false },
        };
      }
    },
  };

  const cancel: AgentTool<typeof cancelSchema> = {
    name: "cancel_task",
    label: "取消定时任务",
    description: "取消（删除）一个运行时建的定时任务。yaml 里声明的任务删不了，只能去配置文件改或 /cron off。",
    parameters: cancelSchema,
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const removed = store.remove(name);
      if (removed) {
        return { content: [{ type: "text", text: `已取消任务「${name}」。` }], details: { removed: true } };
      }
      const inConfig = configTasks().some((t) => t.name === name);
      const text = inConfig
        ? `「${name}」是配置文件里声明的任务，删不了；可以 /cron off ${name} 停用，或去 opennote.yaml 删。`
        : `没有叫「${name}」的运行时任务。用 list_tasks 看有哪些。`;
      return { content: [{ type: "text", text }], details: { removed: false } };
    },
  };

  const list: AgentTool<typeof listSchema> = {
    name: "list_tasks",
    label: "列出定时任务",
    description: "列出当前所有定时任务（含 yaml 声明的和运行时建的）。",
    parameters: listSchema,
    async execute(_id, _input, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const tasks = mergedTasks(configTasks(), store);
      return { content: [{ type: "text", text: renderTasks(tasks) }], details: { count: tasks.length } };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [schedule, cancel, list] as any;
}
