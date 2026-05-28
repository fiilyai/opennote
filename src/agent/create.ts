/**
 * 把 opennote 配置组装成一个 Pi Agent。
 *
 * Day 0：只配 systemPrompt + model
 * Day 1：装 5 个 tool —— fetch_content / open_path / read / write / edit
 *        其中 read/write/edit 复用 pi-coding-agent 自带的实现（Claude Code 同款）
 * Day 5+：挂 extensions（weixin / cron / 等）
 */

import path from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";

import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, getProviders } from "@earendil-works/pi-ai";
import type { KnownProvider, Model } from "@earendil-works/pi-ai";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
} from "@earendil-works/pi-coding-agent";

import type { OpennoteConfig } from "../config.js";
import { createFetchContentTool } from "../tools/fetch_content.js";
import { createOpenPathTool } from "../tools/open_path.js";

interface ParsedKnownModel {
  provider: KnownProvider;
  modelName: string;
}

function parseKnownModelSpec(spec: string): ParsedKnownModel {
  const idx = spec.indexOf(":");
  const rawProvider = idx === -1 ? "anthropic" : spec.slice(0, idx);
  const modelName = idx === -1 ? spec : spec.slice(idx + 1);

  const knownProviders = getProviders();
  if (!knownProviders.includes(rawProvider as KnownProvider)) {
    throw new Error(
      `未知 provider: "${rawProvider}"。支持的 provider: ${knownProviders.join(", ")}`,
    );
  }

  return { provider: rawProvider as KnownProvider, modelName };
}

/**
 * 自定义 OpenAI 兼容端点：用户填了 baseUrl 时，绕过 pi-ai 内置 provider 表，
 * 直接构造一个 Model 对象。
 *
 * 用于接 KIMI、本地 vLLM、自己跑的 ollama、各种第三方网关等。
 */
function buildCustomModel(
  config: OpennoteConfig,
): Model<"openai-completions"> {
  if (!config.agent.baseUrl) {
    throw new Error("buildCustomModel: baseUrl 是必填");
  }
  const api = config.agent.api ?? "openai-completions";
  if (api !== "openai-completions") {
    throw new Error(
      `Day 0 暂时只支持 openai-completions 作为自定义端点的 api，收到: ${api}`,
    );
  }
  // 用 model 字符串当 id / name。例如 "kimi-k2.6"。
  return {
    id: config.agent.model,
    name: config.agent.model,
    api: "openai-completions",
    // provider 在自定义路径下是 label，仅用于日志显示。
    // Provider = KnownProvider | string，所以任意字符串都可。
    provider: "custom",
    baseUrl: config.agent.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    // 自定义 HTTP headers。常见用途：伪装 User-Agent 以通过白名单（KIMI Coding 端点等）
    headers: config.agent.headers,
    // OpenAI 兼容端点的常见保守默认。KIMI / moonshot 也满足。
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
    },
  };
}

export function createOpennoteAgent(config: OpennoteConfig): Agent {
  let model: Model<"openai-completions"> | ReturnType<typeof getModel>;
  if (config.agent.baseUrl) {
    model = buildCustomModel(config);
  } else {
    const { provider, modelName } = parseKnownModelSpec(config.agent.model);
    // modelId 在 pi-ai 里是按 provider narrow 的字面量类型。从字符串配置
    // 解析出来时无法静态收缩，所以这里 cast；运行时由 getModel 自己校验。
    model = getModel(provider, modelName as never);
  }

  // 调试模式见 README 的「Debug 模式」一节。
  // OPENNOTE_DEBUG=1 一键开启所有 dump（payload + assistant 解析后内容 + events）
  // 或者按需开 OPENNOTE_DEBUG_HTTP / OPENNOTE_DEBUG_EVENTS 任一
  const debug = !!(
    process.env.OPENNOTE_DEBUG ||
    process.env.OPENNOTE_DEBUG_HTTP ||
    process.env.OPENNOTE_DEBUG_EVENTS
  );
  const debugHttp = !!(process.env.OPENNOTE_DEBUG || process.env.OPENNOTE_DEBUG_HTTP);
  const debugEvents = !!(process.env.OPENNOTE_DEBUG || process.env.OPENNOTE_DEBUG_EVENTS);
  const debugDir = debug ? prepareDebugDir(process.env.OPENNOTE_DEBUG_DIR) : undefined;

  const agent = new Agent({
    initialState: {
      systemPrompt: config.agent.systemPrompt,
      model,
    },
    getApiKey: makeApiKeyResolver(config),
    onPayload: debugHttp
      ? (payload: unknown) => {
          dumpDebug(debugDir!, "payload", payload);
        }
      : undefined,
    // onResponse 在 streaming 模式下只能拿到 HTTP metadata（status + headers），
    // 不含 body。要看 LLM 实际输出，监听 message_end 事件（见下面 subscribe）。
  });

  if (debugHttp) {
    agent.subscribe((event) => {
      // message_end 对 user / assistant / tool_result 都 fire；只 dump assistant
      if (event.type === "message_end" && event.message?.role === "assistant") {
        dumpDebug(debugDir!, "assistant", event.message);
      }
    });
  }
  if (debugEvents) {
    agent.subscribe((event) => {
      dumpDebug(debugDir!, "event", event);
    });
  }

  // cwd = 笔记目录。pi 自带的 read/write/edit 把相对路径解析为 cwd 之下，
  // 所以 LLM 说「写到 today.md」会落到 ~/.opennote/notes/today.md。
  // 用户写绝对路径仍能跳出 cwd（Day 1 不做强制 sandbox，靠 system prompt 引导）。
  const notesDir = expandPath(config.paths?.notes ?? "~/.opennote/notes");
  mkdirSync(notesDir, { recursive: true });

  // 注册 tools。每加一个 tool 都加到这个数组里。
  // tool 设计指南见 docs/tool-development.md。
  agent.state.tools = [
    createFetchContentTool(),
    createOpenPathTool(notesDir),
    createReadTool(notesDir),
    createWriteTool(notesDir),
    createEditTool(notesDir),
  ];

  return agent;
}

function expandPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * 准备 debug 输出目录。
 * 默认 ~/.opennote/debug/{ISO 时间戳}/，给本次进程独立目录。
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

let payloadCounter = 0;
let assistantCounter = 0;

/**
 * dump 一条 debug 数据。kind 决定文件格式：
 *   - "payload"   → NNN-payload.json，每个 turn 发给 LLM 的完整请求
 *   - "assistant" → NNN-assistant.json，每个 turn LLM 返回的完整 assistant message
 *                    （text + tool calls 解析后的形态）
 *   - "event"     → 追加到 events.jsonl，每行一个 agent 事件
 */
function dumpDebug(
  dir: string,
  kind: "payload" | "assistant" | "event",
  data: unknown,
): void {
  if (kind === "payload") {
    payloadCounter += 1;
    const file = path.join(
      dir,
      `${String(payloadCounter).padStart(3, "0")}-payload.json`,
    );
    writeFileSync(file, JSON.stringify(data, null, 2));
  } else if (kind === "assistant") {
    assistantCounter += 1;
    const file = path.join(
      dir,
      `${String(assistantCounter).padStart(3, "0")}-assistant.json`,
    );
    writeFileSync(file, JSON.stringify(data, null, 2));
  } else {
    const file = path.join(dir, "events.jsonl");
    appendFileSync(file, JSON.stringify(data) + "\n");
  }
}

/**
 * 决定 Pi 怎么拿 API key：
 *   1. config.agent.apiKey 直接写值（优先级最高）
 *   2. config.agent.apiKeyEnv 指定一个环境变量名 → 从 process.env 读
 *   3. 都没配 → 返回 undefined，让 Pi 走自己的默认 env 行为
 *      （pi-ai 会自动找 ANTHROPIC_API_KEY / MOONSHOT_API_KEY / OPENAI_API_KEY 等）
 */
function makeApiKeyResolver(config: OpennoteConfig) {
  return (_provider: string): string | undefined => {
    if (config.agent.apiKey) return config.agent.apiKey;
    if (config.agent.apiKeyEnv) return process.env[config.agent.apiKeyEnv];
    return undefined;
  };
}
