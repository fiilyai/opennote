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
 * Day 3：加 bash —— skill 从此能带可执行脚本干活
 * Day 4：fetch_content 拆成通用 browser tool（只拿渲染后 HTML）+ skill 里的
 *        extract.mjs 脚本（抽正文转 markdown）。职责单一、可复用，HTML 不进上下文。
 * Day 5+：挂 extensions（weixin / cron / 等）
 */

import { mkdirSync } from "node:fs";

import { Agent } from "@earendil-works/pi-agent-core";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
} from "@earendil-works/pi-coding-agent";

import type { OpennoteConfig } from "../config.js";
import { createBrowserTool } from "../tools/browser.js";
import { createOpenTool } from "../tools/open.js";
import { createScheduleTools } from "../tools/schedule.js";
import { ensureWikiScaffold } from "../notes/scaffold.js";
import { expandPath } from "../utils/paths.js";
import { resolveModel, makeApiKeyResolver } from "./model.js";
import { setupDebug, isDebugEnabled } from "./debug.js";
import { buildSystemPrompt } from "./system-prompt.js";

export function createOpennoteAgent(config: OpennoteConfig): Agent {
  const debug = setupDebug();

  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(config, { debug: isDebugEnabled() }),
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
  //   browser —— 通用 CDP 浏览器原语，URL → 渲染后 HTML（Day 4 从 fetch_content 拆出）。
  //   bash    —— Day 3 加，复用 pi-coding-agent 自带实现（同 read/write/edit）。
  //              让 skill 能带「可执行脚本」（parse-bilibili 调 API、wiki-ingest 抽正文）。
  // 都以笔记目录为 cwd。
  agent.state.tools = [
    createBrowserTool(notesDir),
    createOpenTool(notesDir),
    createReadTool(notesDir),
    createWriteTool(notesDir),
    createEditTool(notesDir),
    createBashTool(notesDir),
    // Day 8：让 agent 听懂排程意图、自己把定时任务建起来（schedule/cancel/list_tasks）。
    // 任务落到运行时 store，不碰 opennote.yaml；list 合并展示 yaml 声明的任务。
    ...createScheduleTools({ configTasks: () => config.cron }),
  ];

  return agent;
}
