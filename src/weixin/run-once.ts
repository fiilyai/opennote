/**
 * 用 opennote 自己的 agent loop 跑一条消息，取回最终回复 + ctx 用量。
 *
 * Day 7 起改成「有状态会话」：不再每条 reset()（那会失忆），而是把对应 session 的
 * messages 载入共享 agent → prompt → 自动压缩 → 存回 session。每个 from 的对话连续，
 * 又不会无限膨胀（接近上限自动压成「标题 + 文件路径」级摘要，见 session/compaction.ts）。
 *
 * 保留 Day 5 的两道健壮性保障（源自「发第二个链接 serve 卡死」事故）：
 *   1. 看门狗超时：agent.prompt() 没内建超时，模型 HTTP 一旦 stall 就永不返回。到点 abort。
 *   2. 错误捞回：模型出错（限流等）时 agent 发一条正文空、错误在 errorMessage 的消息，
 *      捞出来回给用户，别静默吞掉（否则看着像卡死）。
 */

import type { Agent } from "@earendil-works/pi-agent-core";

import {
  getCtxUsage,
  maybeCompact,
  type CompactionDeps,
  type CompactionOutcome,
  type CtxUsage,
} from "../session/compaction.js";
import type { Session } from "../session/store.js";

/**
 * 单条消息处理上限。一次完整 ingest（抓取 + 抽取 + 写多个 wiki 页）是重活，
 * 慢模型下几轮累计容易破 3 分钟，给到 5 分钟留足余量；真卡死才靠它兜底。
 */
const DEFAULT_TIMEOUT_MS = 300_000;

export interface RunSessionDeps {
  /** 压缩依赖（model / apiKey / headers）。 */
  compaction: CompactionDeps;
  /** 单条消息处理超时；到点中断在途调用。默认 180s。 */
  timeoutMs?: number;
  /** 外部中断信号（serve 收到 Ctrl-C）；触发时一并中断在途 agent 运行。 */
  abortSignal?: AbortSignal;
  /** 进度日志：打印 agent 处理过程中的工具调用，方便排查卡在哪一步。 */
  log?: (msg: string) => void;
  /** 进度回执：处理较久的关键节点（如抓取完成）主动给用户报一句，别让他干等。 */
  onProgress?: (msg: string) => void;
}

export interface RunSessionResult {
  /** 给用户看的回复（可能为空 = 无回复）。 */
  reply: string;
  /** 处理完后的 ctx 用量。 */
  ctx: CtxUsage;
  /** 本轮是否触发了压缩。 */
  compacted: CompactionOutcome | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAssistantText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

function timeoutReply(timeoutMs: number): string {
  return `处理超时（超过 ${Math.round(timeoutMs / 1000)}s 已中断），可稍后重发。`;
}

/** 把模型层错误翻译成给用户看的人话。最常见的是限流（429）。 */
function formatModelError(raw: string): string {
  const msg = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
  if (/rate.?limit|usage limit|quota|\b429\b/i.test(raw)) {
    return `模型限流了（额度用尽 / 429）。稍后再试。\n原始信息：${msg}`;
  }
  return `模型调用出错：${msg}`;
}

/**
 * 在一个会话上跑一条消息。载入 session.messages → prompt → 压缩 → 存回 session。
 */
export async function runAgentOnce(
  agent: Agent,
  session: Session,
  text: string,
  deps: RunSessionDeps,
): Promise<RunSessionResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 载入该用户的对话历史（接着上次聊，不失忆）。
  agent.state.messages = session.messages;

  let reply = "";
  let errorMessage = "";
  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  let progressSent = false;
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      // 打印每次工具调用，超时时一看日志就知道卡在哪一步。
      deps.log?.(`[weixin]   ⚙ ${elapsed()} 调用 ${event.toolName}`);
    } else if (event.type === "tool_execution_end") {
      deps.log?.(`[weixin]   ✓ ${elapsed()} ${event.toolName} 完成`);
      // 抓取完成是 ingest 里耗时的转折点：之后还要抽正文 + 写多个 wiki 页（慢模型下要等）。
      // 主动报一句，让用户知道在进行，不是卡死。整条消息只报一次。
      if (!progressSent && event.toolName === "browser") {
        progressSent = true;
        deps.onProgress?.("已抓到网页内容，正在整理成笔记，稍等…");
      }
    } else if (event.type === "message_end") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (event as any).message;
      if (msg?.role === "assistant") {
        if (msg.errorMessage) errorMessage = String(msg.errorMessage);
        const t = extractAssistantText(msg);
        if (t.trim()) reply = t;
      }
    }
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, timeoutMs);
  const onExternalAbort = () => agent.abort();
  deps.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    await agent.prompt(text);
  } catch (err) {
    if (!timedOut) {
      // 非超时的真异常：仍要把会话存回（已经追加了这轮的部分消息），再抛人话回复。
      reply = reply || (err instanceof Error ? err.message : String(err));
    }
  } finally {
    clearTimeout(timer);
    deps.abortSignal?.removeEventListener("abort", onExternalAbort);
    unsubscribe();
  }

  // 决定回复文本：超时 / 错误 / 正常。
  let finalReply: string;
  if (timedOut) {
    finalReply = reply.trim() || timeoutReply(timeoutMs);
  } else if (reply.trim()) {
    finalReply = reply.trim();
  } else if (errorMessage) {
    finalReply = formatModelError(errorMessage);
  } else {
    finalReply = "";
  }

  // 这轮加完了，看要不要压缩（失败不抛，保持历史不动）。
  let compacted: CompactionOutcome | null = null;
  try {
    compacted = await maybeCompact(agent, deps.compaction);
  } catch {
    compacted = null;
  }

  // 存回会话。
  session.messages = agent.state.messages;
  session.updatedAt = Date.now();

  const ctx = getCtxUsage(agent.state.messages, deps.compaction.model);
  return { reply: finalReply, ctx, compacted };
}
