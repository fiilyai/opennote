/**
 * 会话斜杠命令（Day 7）。通道无关：chat 和微信 serve 都接同一套。
 * 对标 Claude Code 的 /compact、Gemini 的 /compress + /chat。
 *
 * 只操作传入的 agent（假定调用方已把对应会话的历史载入 agent.state.messages）。
 * 会话的载入/存回/持久化由调用方负责——chat 是单会话直接用 agent，微信按 from swap。
 */

import type { Agent } from "@earendil-works/pi-agent-core";

import type { CronTask } from "../config.js";
import type { CronStateStore } from "../automation/store.js";
import {
  forceCompact,
  formatCtx,
  getCtxUsage,
  type CompactionDeps,
} from "./compaction.js";

function fmtK(n: number): string {
  return `${(n / 1_000).toFixed(1)}k`;
}

/** /cron 命令的依赖（由 automation/setup.ts 装好注入）。不传 = 该通道没开定时任务。 */
export interface CronCommandDeps {
  /** 当前任务表（合并 yaml 声明 + 运行时建的）。 */
  list: () => CronTask[];
  stateStore: CronStateStore;
  /** 立刻跑一条任务（fire-and-forget，跑完自动推送）。返回是否找到该任务。 */
  trigger: (name: string) => boolean;
  /** 新建一条运行时任务（落 store）。 */
  add: (input: { name?: string; at: string; prompt: string; to?: string }) => {
    ok: boolean;
    task?: CronTask;
    error?: string;
  };
  /** 删一条运行时任务；config 声明的删不了。 */
  remove: (name: string) => "removed" | "config" | "missing";
  /** 改启用状态；返回任务来自哪（config 仅运行时生效 / store 持久化 / 没找到）。 */
  setEnabled: (name: string, enabled: boolean) => "config" | "store" | "missing";
}

const HELP = `可用命令：
/compact [侧重点]  立刻压缩当前对话（可选侧重点，如 /compact 保留链接）
/clear            清空当前对话，开始新一轮
/ctx              看当前上下文用量
/cron             管理定时任务（/cron 看用法）`;

const CRON_HELP = `定时任务命令：
/cron                       列出所有任务
/cron run <名字>             立刻跑一次（跑完把结果推给你）
/cron add <名字> <分 时 日 月 周> <要干啥>
                            新建任务，如：/cron add 日报 0 9 * * * 扫AI热点推给我
/cron rm <名字>              删掉运行时建的任务
/cron on|off <名字>          启用 / 停用
也可以直接跟我说「每天早上9点给我推个AI日报」，我会自动建。`;

/** ms → 本地可读时间；0 表示还没跑过。 */
function fmtTime(ms: number): string {
  if (!ms) return "从未";
  return new Date(ms).toLocaleString("sv-SE");
}

/** 处理 /cron 子命令。 */
function handleCron(arg: string, deps: CronCommandDeps | undefined): string {
  if (!deps) return "这个通道没开定时任务（serve 起来才有调度）。";

  const space = arg.search(/\s/);
  const sub = (space === -1 ? arg : arg.slice(0, space)).toLowerCase();
  const name = space === -1 ? "" : arg.slice(space + 1).trim();

  if (sub === "" || sub === "list") {
    const tasks = deps.list();
    if (tasks.length === 0) return "还没有定时任务。跟我说「每天9点推个AI日报」或用 /cron add 新建。";
    const lines = tasks.map((t) => {
      const flag = t.enabled === false ? "✗ 停用" : "✓ 启用";
      const last = fmtTime(deps.stateStore.getLastRun(t.name));
      const status = deps.stateStore.getLastStatus(t.name);
      return `• ${t.name}  [${t.at}]  ${flag}\n  上次：${last}${status ? `（${status}）` : ""}`;
    });
    return `定时任务（${tasks.length}）：\n${lines.join("\n")}`;
  }

  if (sub === "run") {
    if (!name) return "用法：/cron run <名字>";
    return deps.trigger(name)
      ? `已触发「${name}」，跑完把结果推给你。`
      : `没有叫「${name}」的任务。发 /cron 看有哪些。`;
  }

  if (sub === "add") {
    // 格式：<名字> <分 时 日 月 周>(5字段) <要干啥>
    const t = name.split(/\s+/);
    if (t.length < 7) {
      return "用法：/cron add <名字> <分 时 日 月 周> <要干啥>\n例：/cron add 日报 0 9 * * * 扫AI热点推给我";
    }
    const taskName = t[0]!;
    const at = t.slice(1, 6).join(" ");
    const prompt = t.slice(6).join(" ");
    const r = deps.add({ name: taskName, at, prompt });
    return r.ok && r.task
      ? `已建任务「${r.task.name}」：${r.task.at}，到点执行：${r.task.prompt}\n（/cron off ${r.task.name} 可停用，/cron run ${r.task.name} 立刻试跑）`
      : `建任务失败：${r.error}`;
  }

  if (sub === "rm" || sub === "remove" || sub === "cancel" || sub === "del") {
    if (!name) return `用法：/cron ${sub} <名字>`;
    const r = deps.remove(name);
    if (r === "removed") return `已删掉任务「${name}」。`;
    if (r === "config") return `「${name}」是配置文件里声明的，删不了；可 /cron off ${name} 停用，或去 opennote.yaml 删。`;
    return `没有叫「${name}」的运行时任务。发 /cron 看有哪些。`;
  }

  if (sub === "on" || sub === "off") {
    if (!name) return `用法：/cron ${sub} <名字>`;
    const r = deps.setEnabled(name, sub === "on");
    if (r === "missing") return `没有叫「${name}」的任务。发 /cron 看有哪些。`;
    const note = r === "config" ? "（配置声明的，重启后回到配置设定）" : "";
    return `已${sub === "on" ? "启用" : "停用"}「${name}」。${note}`;
  }

  return CRON_HELP;
}

/**
 * 处理斜杠命令。返回回复文本表示已处理；返回 null 表示不是命令，照常喂 agent。
 */
export async function handleSessionCommand(
  body: string,
  agent: Agent,
  compaction: CompactionDeps,
  cron?: CronCommandDeps,
): Promise<string | null> {
  const trimmed = body.trim();
  if (!trimmed.startsWith("/")) return null;

  const space = trimmed.search(/\s/);
  const cmd = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();

  switch (cmd) {
    case "/cron": {
      return handleCron(arg, cron);
    }
    case "/clear": {
      agent.state.messages = [];
      return "已清空当前对话，开始新一轮。";
    }
    case "/compact": {
      const outcome = await forceCompact(agent, compaction, arg || undefined);
      const ctx = formatCtx(getCtxUsage(agent.state.messages, compaction.model));
      if (!outcome) return `当前对话还短，无需压缩。${ctx}`;
      return `已压缩 ${fmtK(outcome.tokensBefore)} → ${fmtK(outcome.tokensAfter)}。${ctx}`;
    }
    case "/ctx":
    case "/context": {
      return formatCtx(getCtxUsage(agent.state.messages, compaction.model));
    }
    case "/help": {
      return HELP;
    }
    default:
      return `未知命令 ${cmd}。发 /help 看可用命令。`;
  }
}
