/**
 * 对话上下文压缩（Day 7）。
 *
 * opennote 用裸 Agent（只有 state.messages），不走 pi-coding-agent 的 SessionTree，
 * 所以 Pi 的 compact()/prepareCompaction() 用不了（它们吃 SessionTreeEntry[]）。
 * 但底层这几个直接吃 AgentMessage[] 的能用，我们自己拼压缩流程：
 *   - estimateContextTokens(messages)  当前用量
 *   - shouldCompact(tokens, window, …)  够不够阈值
 *   - generateSummary(messages, …)      调 LLM 生成摘要（带 customInstructions）
 *
 * 压得比主流狠：主流留段落摘要，是因为对话历史是它们唯一的记忆。opennote 不一样——
 * 整理过的内容全文都落在笔记库文件里，所以早期对话压成「做了什么 + 文件路径」就够，
 * 细节之后 read 文件取回。见 customInstructions。
 *
 * 策略：直接重写 agent.state.messages（持久化压缩），不用 transformContext
 * （那只裁发给 LLM 的副本、不改 state，会每轮重算、ctx 显示不准、会话恢复存的是全量）。
 */

import {
  estimateTokens,
  generateSummary,
  shouldCompact,
  type Agent,
  type AgentMessage,
  type CompactionSettings,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

// generateSummary 等 Pi API 都用 Model<any>；resolveModel 返回的也是按 provider narrow 的联合。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

/** opennote 的压缩设置：压得狠——保留的近期窗口小，早期全部碾成清单。 */
export const OPENNOTE_COMPACTION: CompactionSettings = {
  enabled: true,
  reserveTokens: 2_000, // 给摘要 prompt + 输出预留
  keepRecentTokens: 3_000, // 压缩后只留最近这点原文，其余压成摘要
};

/** 让 LLM 把早期对话碾到极致：标题/关键词 + 文件路径，丢掉一切中间过程。 */
const COMPACTION_INSTRUCTIONS = `把这段对话压成极简清单，越短越好。规则：
- 每个已完成的任务只留一行：做了什么（标题或关键词）+ 产出的文件路径（如 raw/2026-06-04-xxx.md）。
- 凡是能用文件路径指代的，绝不复述内容——细节之后可以 read 那个文件取回。
- 丢掉所有中间过程、工具输出、推理、寒暄。
- 只保留用户尚未完成的请求和待办事项的原话。`;

const SUMMARY_PREFIX = "之前的对话已压缩为摘要：\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

export interface CtxUsage {
  /** 估算的上下文 token 数。 */
  tokens: number;
  /** 模型上下文窗口。 */
  window: number;
  /** 占窗口百分比（0-100）。 */
  percent: number;
}

/**
 * 按消息内容估算 token 总数（逐条 estimateTokens 累加）。
 *
 * 不用 Pi 的 estimateContextTokens——它优先读「上一次 provider 返回的 usage」，而压缩
 * 改写了历史后，保留段里最后那条 assistant 消息仍带着压缩前的旧 usage，会让压缩后的
 * 估算停在压缩前的数（显示像没压）。逐条估算虽不如 provider usage 精确，但对压缩
 * 即时可见、前后可比，是这里要的。
 */
function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

/** 算当前上下文用量。 */
export function getCtxUsage(messages: AgentMessage[], model: AnyModel): CtxUsage {
  const tokens = estimateMessagesTokens(messages);
  const window = model.contextWindow || 128_000;
  return { tokens, window, percent: (tokens / window) * 100 };
}

/** token 数 → 紧凑显示：78500 → "78.5k"。 */
function fmtTokens(n: number): string {
  return n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
}

/** 一行 ctx 用量，给每条回复带上：`ctx 78.5k 61.33%`。 */
export function formatCtx(u: CtxUsage): string {
  return `ctx ${fmtTokens(u.tokens)} ${u.percent.toFixed(2)}%`;
}

/**
 * 找压缩切点：从尾部累加到 keepRecentTokens，再把切点前移到最近的 user 边界，
 * 保证「保留段」从一个完整 turn（user 开头）起，不切断 assistant/toolResult 配对。
 * 返回保留段的起始下标；<=0 表示没东西可压。
 */
function findCutIndex(messages: AgentMessage[], keepRecentTokens: number): number {
  let acc = 0;
  let i = messages.length;
  while (i > 0) {
    acc += estimateTokens(messages[i - 1]!);
    i -= 1;
    if (acc >= keepRecentTokens) break;
  }
  // 前移到 user 边界
  while (i > 0 && messages[i]!.role !== "user") i -= 1;
  return i;
}

export interface CompactionDeps {
  model: AnyModel;
  apiKey: string;
  headers?: Record<string, string>;
  settings?: CompactionSettings;
  signal?: AbortSignal;
}

export interface CompactionOutcome {
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * 实际压缩：切分 → 摘要早期 → 用 [摘要, ...近期] 替换 state.messages。
 * 没东西可压（cut<=0）或摘要失败时返回 null（保持原对话不动，绝不丢消息）。
 */
async function doCompact(
  agent: Agent,
  deps: CompactionDeps,
  instructions: string,
): Promise<CompactionOutcome | null> {
  const settings = deps.settings ?? OPENNOTE_COMPACTION;
  const messages = agent.state.messages;
  const before = estimateMessagesTokens(messages);

  const cut = findCutIndex(messages, settings.keepRecentTokens);
  if (cut <= 0) return null; // 全在 keepRecent 窗口内，没法压

  const early = messages.slice(0, cut);
  const recent = messages.slice(cut);

  const result = await generateSummary(
    early,
    deps.model,
    settings.reserveTokens,
    deps.apiKey,
    deps.headers,
    deps.signal,
    instructions,
  );
  if (!result.ok) return null; // 摘要失败：宁可不压，也不丢历史

  const summaryMessage: AgentMessage = {
    role: "user",
    content: `${SUMMARY_PREFIX}${result.value}${SUMMARY_SUFFIX}`,
    timestamp: Date.now(),
  };

  agent.state.messages = [summaryMessage, ...recent];
  const after = estimateMessagesTokens(agent.state.messages);
  return { tokensBefore: before, tokensAfter: after };
}

/**
 * 自动压缩：到阈值才压（用于每轮处理后）。
 * 没到阈值、没东西可压、或摘要失败时返回 null。
 */
export async function maybeCompact(
  agent: Agent,
  deps: CompactionDeps,
): Promise<CompactionOutcome | null> {
  const settings = deps.settings ?? OPENNOTE_COMPACTION;
  const tokens = estimateMessagesTokens(agent.state.messages);
  if (!shouldCompact(tokens, deps.model.contextWindow || 128_000, settings)) {
    return null;
  }
  return doCompact(agent, deps, COMPACTION_INSTRUCTIONS);
}

/**
 * 手动压缩：不看阈值，用户主动 /compact 时强制压。
 * extraInstructions 是用户给的侧重点（追加到默认压缩指令后）。
 */
export async function forceCompact(
  agent: Agent,
  deps: CompactionDeps,
  extraInstructions?: string,
): Promise<CompactionOutcome | null> {
  const instructions = extraInstructions?.trim()
    ? `${COMPACTION_INSTRUCTIONS}\n\n用户额外要求：${extraInstructions.trim()}`
    : COMPACTION_INSTRUCTIONS;
  return doCompact(agent, deps, instructions);
}
