/**
 * 会话斜杠命令（Day 7）。通道无关：chat 和微信 serve 都接同一套。
 * 对标 Claude Code 的 /compact、Gemini 的 /compress + /chat。
 *
 * 只操作传入的 agent（假定调用方已把对应会话的历史载入 agent.state.messages）。
 * 会话的载入/存回/持久化由调用方负责——chat 是单会话直接用 agent，微信按 from swap。
 */

import type { Agent } from "@earendil-works/pi-agent-core";

import {
  forceCompact,
  formatCtx,
  getCtxUsage,
  type CompactionDeps,
} from "./compaction.js";

function fmtK(n: number): string {
  return `${(n / 1_000).toFixed(1)}k`;
}

const HELP = `可用命令：
/compact [侧重点]  立刻压缩当前对话（可选侧重点，如 /compact 保留链接）
/clear            清空当前对话，开始新一轮
/ctx              看当前上下文用量`;

/**
 * 处理斜杠命令。返回回复文本表示已处理；返回 null 表示不是命令，照常喂 agent。
 */
export async function handleSessionCommand(
  body: string,
  agent: Agent,
  compaction: CompactionDeps,
): Promise<string | null> {
  const trimmed = body.trim();
  if (!trimmed.startsWith("/")) return null;

  const space = trimmed.search(/\s/);
  const cmd = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();

  switch (cmd) {
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
