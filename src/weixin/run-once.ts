/**
 * 用 opennote 自己的 agent loop 跑一条消息，取回最终回复。
 * 等价于 Pi extension 的 sendUserMessage + 观察输出（见 docs/weixin-ilink-integration.md §2.4）。
 *
 * agent.prompt() 返回 void，回复要靠订阅事件拿：累积最后一条 assistant 消息的文字。
 * MVP 串行——一条处理完再拉下一条，天然避并发。
 */

import type { Agent } from "@earendil-works/pi-agent-core";

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

export async function runAgentOnce(agent: Agent, text: string): Promise<string> {
  let reply = "";
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "message_end") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (event as any).message;
      if (msg?.role === "assistant") {
        const t = extractAssistantText(msg);
        if (t.trim()) reply = t; // 留最后一条 assistant 文字 = 用户可见回复
      }
    }
  });
  try {
    await agent.prompt(text);
  } finally {
    unsubscribe();
  }
  return reply.trim();
}
