/**
 * 跑一条定时任务（Day 8）。
 *
 * 复用消息通道那套 runAgentOnce：把任务的提示词当成「一条用户消息」喂给 agent，
 * 白嫖它的超时兜底、错误翻译、自动压缩、会话持久化。区别只在两点：
 *   - 会话 key 用 `cron:<name>`，跟人类对话隔开，又能跨天累积
 *     （日报因此记得「昨天报过啥」，能讲增量而不是每天从零）。
 *   - 没有真人在线等，所以不发实时进度，只把最终结果推给配置的接收人。
 */

import type { Agent } from "@earendil-works/pi-agent-core";

import type { CronTask } from "../config.js";
import type { CompactionDeps, CompactionOutcome, CtxUsage } from "../session/compaction.js";
import type { SessionStore } from "../session/store.js";
import { runAgentOnce } from "../weixin/run-once.js";

export interface CronRunDeps {
  /** 跑任务用的 agent（独立实例，别跟消息通道共用，免得踩 state.messages）。 */
  agent: Agent;
  /** 会话存储（任务用 `cron:<name>` 这个 key 的会话）。 */
  sessionStore: SessionStore;
  /** 压缩依赖。 */
  compaction: CompactionDeps;
  /** 把结果推出去（微信 sendText / 终端打印 / …）。返回 false 表示没推成。 */
  push?: (to: string, text: string) => Promise<void>;
  /** 任务没配 to 时的默认接收人（一般是 allowFrom[0]）。 */
  defaultTo?: string;
  /** 单次任务超时。 */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface CronRunResult {
  reply: string;
  ctx: CtxUsage;
  compacted: CompactionOutcome | null;
  /** 推给了谁（没推成 / 没接收人则为空）。 */
  pushedTo?: string;
}

/**
 * 执行一条任务：载入 cron 会话 → 提示词驱动 agent → 存回 → 推送结果。
 * 任何阶段抛错都会冒泡给调用方（调度器负责记到 state、不让它掀翻整个循环）。
 */
export async function runCronTask(task: CronTask, deps: CronRunDeps): Promise<CronRunResult> {
  const session = deps.sessionStore.get(`cron:${task.name}`);

  const result = await runAgentOnce(deps.agent, session, task.prompt, {
    compaction: deps.compaction,
    timeoutMs: deps.timeoutMs,
    abortSignal: deps.abortSignal,
    log: deps.log,
  });
  deps.sessionStore.save(session);

  let pushedTo: string | undefined;
  const to = task.to || deps.defaultTo;
  if (result.reply && to && deps.push) {
    await deps.push(to, result.reply);
    pushedTo = to;
  }

  return { reply: result.reply, ctx: result.ctx, compacted: result.compacted, pushedTo };
}
