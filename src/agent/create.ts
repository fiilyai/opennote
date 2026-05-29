/**
 * 把 opennote 配置组装成一个 Pi Agent。纯编排，各块逻辑拆在同目录的模块里：
 *   - model.ts     模型解析 + API key
 *   - debug.ts     debug dump（payload / assistant / events）
 *   - skills.ts    加载 skills 并拼进 system prompt
 *   - ../notes/scaffold.ts  初始化 LLM Wiki 笔记库骨架
 *
 * Day 0：systemPrompt + model
 * Day 1：装 5 个 tool —— fetch_content / open_path / read / write / edit
 *        其中 read/write/edit 复用 pi-coding-agent 自带的实现（Claude Code 同款）
 * Day 2：加载 skills + 初始化 wiki 笔记库
 * Day 5+：挂 extensions（weixin / cron / 等）
 */

import { mkdirSync } from "node:fs";

import { Agent } from "@earendil-works/pi-agent-core";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
} from "@earendil-works/pi-coding-agent";

import type { OpennoteConfig } from "../config.js";
import { createFetchContentTool } from "../tools/fetch_content.js";
import { createOpenPathTool } from "../tools/open_path.js";
import { ensureWikiScaffold } from "../notes/scaffold.js";
import { expandPath } from "../utils/paths.js";
import { resolveModel, makeApiKeyResolver } from "./model.js";
import { setupDebug, isDebugEnabled } from "./debug.js";
import { composeSystemPrompt } from "./skills.js";

export function createOpennoteAgent(config: OpennoteConfig): Agent {
  const debug = setupDebug();

  const agent = new Agent({
    initialState: {
      systemPrompt: composeSystemPrompt(config, { debug: isDebugEnabled() }),
      model: resolveModel(config),
    },
    getApiKey: makeApiKeyResolver(config),
    onPayload: debug.onPayload,
  });
  debug.attach(agent);

  // cwd = 笔记目录。pi 自带的 read/write/edit 把相对路径解析为 cwd 之下，
  // 所以 LLM 说「写到 today.md」会落到 ~/.opennote/notes/today.md。
  // 用户写绝对路径仍能跳出 cwd（Day 1 不做强制 sandbox，靠 system prompt 引导）。
  const notesDir = expandPath(config.paths?.notes ?? "~/.opennote/notes");
  mkdirSync(notesDir, { recursive: true });
  ensureWikiScaffold(notesDir);

  // 注册 tools。每加一个 tool 都加到这个数组里。设计指南见 docs/tool-development.md。
  agent.state.tools = [
    createFetchContentTool(),
    createOpenPathTool(notesDir),
    createReadTool(notesDir),
    createWriteTool(notesDir),
    createEditTool(notesDir),
  ];

  return agent;
}
