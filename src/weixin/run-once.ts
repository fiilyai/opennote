/**
 * 用 opennote 自己的 agent loop 跑一条消息，取回最终回复。
 * 等价于 Pi extension 的 sendUserMessage + 观察输出（见 docs/weixin-ilink-integration.md §2.4）。
 *
 * agent.prompt() 返回 void，回复要靠订阅事件拿：累积最后一条 assistant 消息的文字。
 * MVP 串行——一条处理完再拉下一条，天然避并发。
 *
 * 两条健壮性保障（都源自「发第二个链接 serve 卡死」事故）：
 *   1. 看门狗超时：agent.prompt() 没有内建超时，模型 HTTP 调用一旦 stall 就永不返回，
 *      整个 serve loop 跟着死。这里到点 agent.abort() 取消在途调用，回一句超时提示，
 *      让 loop 继续——一条卡住的消息打不死整个 bot。
 *   2. 每条消息前 reset：共享同一个 agent 实例时对话历史只增不减，第二条消息扛着第一条
 *      的全部上下文，payload 越滚越大、模型端点越容易 stall。微信「发链接→整理」本就是
 *      一条一个独立任务，reset 只清对话历史，systemPrompt / tools / model 都留着。
 *      （真正的会话记忆 + 上下文压缩是 Day 7 的正题。）
 */

import type { Agent } from "@earendil-works/pi-agent-core";

/** 单条消息处理上限。多步 ingest（抓取 + 抽取 + 几轮模型）留足余量，又不至于卡死时干等太久。 */
const DEFAULT_TIMEOUT_MS = 180_000;

export interface RunOnceOptions {
  /** 单条消息处理超时；到点中断在途调用。默认 180s。 */
  timeoutMs?: number;
  /** 外部中断信号（如 serve 收到 Ctrl-C）；触发时一并中断在途的 agent 运行。 */
  abortSignal?: AbortSignal;
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

/** 把模型层错误翻译成给微信用户看的人话。最常见的是限流（429）。 */
function formatModelError(raw: string): string {
  const msg = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
  if (/rate.?limit|usage limit|quota|\b429\b/i.test(raw)) {
    return `模型限流了（额度用尽 / 429）。换成你自己的 API key 或稍后再试。\n原始信息：${msg}`;
  }
  return `模型调用出错：${msg}`;
}

export async function runAgentOnce(
  agent: Agent,
  text: string,
  options: RunOnceOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let reply = "";
  let errorMessage = "";
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_end") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (event as any).message;
      if (msg?.role === "assistant") {
        // 模型出错（限流 / 网络等）时 agent 发一条正文为空、带 errorMessage 的 assistant 消息。
        // 必须捞出来——否则错误被当成「空回复」静默丢掉，用户那头看着就像卡死。
        if (msg.errorMessage) errorMessage = String(msg.errorMessage);
        const t = extractAssistantText(msg);
        if (t.trim()) reply = t; // 留最后一条 assistant 文字 = 用户可见回复
      }
    }
  });

  // 每条消息独立：清掉上一轮 transcript，避免共享 agent 的上下文无限增长。
  agent.reset();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort(); // 取消在途的模型 / 工具调用，让 prompt() 尽快返回
  }, timeoutMs);

  const onExternalAbort = () => agent.abort();
  options.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    await agent.prompt(text);
  } catch (err) {
    // 我们的超时触发的 abort：prompt() 可能 reject，吞掉它回一句超时提示。
    if (timedOut) return timeoutReply(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener("abort", onExternalAbort);
    unsubscribe();
  }

  // abort 后 prompt() 也可能正常 resolve（拿到中断前的部分输出）。
  if (timedOut) return reply.trim() || timeoutReply(timeoutMs);
  if (reply.trim()) return reply.trim();
  // 没有正文回复：如果是模型报错（如 429），如实回给用户，别静默吞掉。
  if (errorMessage) return formatModelError(errorMessage);
  return "";
}
