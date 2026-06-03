/**
 * 路由 seam：一条微信消息决定交给哪个 agent。
 *
 * MVP：永远返回那唯一一个 agent。
 * 未来：按 from（联系人）/ 命令前缀（/note /ask）查注册表 → 不同 agent
 *       （各自 notesDir / persona / model）。一个微信号"绑多个 agent"就是往这里加。
 * 详见 docs/weixin-ilink-integration.md §2.5。
 */

import type { Agent } from "@earendil-works/pi-agent-core";

export type ResolveAgent = (from: string) => Agent | undefined;

/** MVP：单 agent。 */
export function singleAgentRouter(agent: Agent): ResolveAgent {
  return () => agent;
}
