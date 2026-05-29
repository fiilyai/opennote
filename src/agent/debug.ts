/**
 * Debug 基础设施：把每个 turn 发给 LLM 的 payload、LLM 返回的 assistant message、
 * 以及完整事件流 dump 到磁盘。用法见 README 的「Debug 模式」一节。
 *
 *   OPENNOTE_DEBUG=1        一键全开（payload + assistant + events）
 *   OPENNOTE_DEBUG_HTTP=1   只 dump payload + assistant
 *   OPENNOTE_DEBUG_EVENTS=1 只 dump events.jsonl
 *   OPENNOTE_DEBUG_DIR=...  自定义输出目录（默认 ~/.opennote/debug/{ISO 时间戳}/）
 */

import path from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";

import type { Agent } from "@earendil-works/pi-agent-core";

import { expandPath } from "../utils/paths.js";

/** 三个开关任一打开即视为开启 debug。 */
export function isDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.OPENNOTE_DEBUG || env.OPENNOTE_DEBUG_HTTP || env.OPENNOTE_DEBUG_EVENTS);
}

export interface DebugHooks {
  /** 传给 `new Agent({ onPayload })`，未开启 HTTP dump 时为 undefined。 */
  onPayload?: (payload: unknown) => void;
  /** agent 创建后调用，挂上 assistant / events 的订阅。 */
  attach: (agent: Agent) => void;
}

/**
 * 根据环境变量准备好 debug 钩子。未开启时返回的 attach 是 no-op、onPayload 为 undefined，
 * 调用方无需关心是否开启。
 */
export function setupDebug(env: NodeJS.ProcessEnv = process.env): DebugHooks {
  const http = !!(env.OPENNOTE_DEBUG || env.OPENNOTE_DEBUG_HTTP);
  const events = !!(env.OPENNOTE_DEBUG || env.OPENNOTE_DEBUG_EVENTS);
  if (!http && !events) return { attach: () => {} };

  const dir = prepareDebugDir(env.OPENNOTE_DEBUG_DIR);
  const dump = createDumper(dir);

  return {
    onPayload: http ? (payload) => dump("payload", payload) : undefined,
    attach(agent) {
      if (http) {
        agent.subscribe((event) => {
          // message_end 对 user / assistant / tool_result 都 fire；只 dump assistant。
          // onResponse 在 streaming 模式下只能拿到 HTTP metadata，不含 body，所以
          // 要看 LLM 实际输出得靠这个事件。
          if (event.type === "message_end" && event.message?.role === "assistant") {
            dump("assistant", event.message);
          }
        });
      }
      if (events) {
        agent.subscribe((event) => dump("event", event));
      }
    },
  };
}

/**
 * 准备 debug 输出目录。默认 ~/.opennote/debug/{ISO 时间戳}/，给本次进程独立目录。
 * 用户可以 OPENNOTE_DEBUG_DIR=自定义路径 强制走指定目录。
 */
function prepareDebugDir(override?: string): string {
  const dir = override
    ? expandPath(override)
    : path.join(
        homedir(),
        ".opennote",
        "debug",
        new Date().toISOString().replace(/[:.]/g, "-"),
      );
  mkdirSync(dir, { recursive: true });
  console.error(`[opennote-debug] writing to ${dir}`);
  return dir;
}

type DumpKind = "payload" | "assistant" | "event";

/**
 * 造一个 dump 函数，计数器是闭包私有状态（不再用模块全局）。
 *   - "payload"   → NNN-payload.json，每个 turn 发给 LLM 的完整请求
 *   - "assistant" → NNN-assistant.json，每个 turn LLM 返回的完整 assistant message
 *   - "event"     → 追加到 events.jsonl，每行一个 agent 事件
 */
function createDumper(dir: string): (kind: DumpKind, data: unknown) => void {
  let payloadCounter = 0;
  let assistantCounter = 0;
  return (kind, data) => {
    if (kind === "payload") {
      payloadCounter += 1;
      writeFileSync(
        path.join(dir, `${String(payloadCounter).padStart(3, "0")}-payload.json`),
        JSON.stringify(data, null, 2),
      );
    } else if (kind === "assistant") {
      assistantCounter += 1;
      writeFileSync(
        path.join(dir, `${String(assistantCounter).padStart(3, "0")}-assistant.json`),
        JSON.stringify(data, null, 2),
      );
    } else {
      appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(data) + "\n");
    }
  };
}
