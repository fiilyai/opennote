/**
 * `opennote chat` — 最简对话 REPL。
 *
 * Day 0 的核心。等价于「跟 ChatGPT 聊天」，但底层是自己的 Pi Agent。
 * 没注册任何工具，所以暂时只能对话，不能干活。
 * 后面 Day 1 起开始往 agent 里塞 tools / skills。
 */

import { createInterface } from "node:readline/promises";

import { createOpennoteAgent } from "../agent/create.js";
import { loadConfig } from "../config.js";

interface ChatOptions {
  configPath?: string;
}

const EXIT_COMMANDS = new Set(["/exit", "/quit", "exit", "quit", "/q"]);

export async function runChat(options: ChatOptions = {}): Promise<void> {
  const config = loadConfig(options.configPath);
  const agent = createOpennoteAgent(config);

  printBanner(config);

  // 订阅 agent 事件，做最简流式渲染。
  // 这里用 any 处理事件 — Pi 的 event union 类型很大，Day 0 不展开。
  agent.subscribe((event: any) => {
    // DEBUG: dump 所有 event 看实际触发的类型
    if (process.env.OPENNOTE_DEBUG_EVENTS) {
      console.error(`[event] ${event.type} ${JSON.stringify(event).slice(0, 200)}`);
    }
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent;
      if (inner?.type === "text_delta" && typeof inner.delta === "string") {
        process.stdout.write(inner.delta);
      }
    } else if (event.type === "message_end") {
      if (event.message?.role === "assistant") {
        process.stdout.write("\n");
      }
    } else if (event.type === "tool_execution_start") {
      process.stdout.write(`\n[调用工具: ${event.toolName}]\n`);
    } else if (event.type === "tool_execution_end") {
      process.stdout.write(`[工具完成]\n`);
    }
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      let input: string;
      try {
        input = await rl.question("\n> ");
      } catch (err) {
        // stdin EOF（管道关闭 / Ctrl-D）= 干净退出
        if (isReadlineClosed(err)) {
          console.log("\n再见。");
          break;
        }
        throw err;
      }
      const trimmed = input.trim();
      if (!trimmed) continue;
      if (EXIT_COMMANDS.has(trimmed.toLowerCase())) {
        console.log("\n再见。");
        break;
      }
      try {
        await agent.prompt(input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n[对话出错] ${msg}`);
      }
    }
  } finally {
    rl.close();
  }
}

function isReadlineClosed(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes("closed") || (err as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE";
}

function printBanner(config: { agent: { model: string }; sourceFile?: string }): void {
  console.log("opennote v0.0.1");
  console.log(`model:  ${config.agent.model}`);
  if (config.sourceFile) {
    console.log(`config: ${config.sourceFile}`);
  } else {
    console.log("config: 内置默认（没找到 opennote.yaml）");
  }
  console.log("输入消息开始对话，输入 /exit 或 quit 退出。");
}
