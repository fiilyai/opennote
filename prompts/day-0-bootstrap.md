# Day 0 项目骨架搭建 Prompt

> 用法：把本文从「任务」起到末尾整段贴给 Claude Code / Cursor / Codex 等 coding agent。它能照着搭出 opennote Day 0 的完整骨架，跑通 `pnpm install && pnpm dev` 进入对话 REPL。
>
> 这份 prompt 是「10 天学会 AI Agent 开发」教程项目的配套资产。

---

## 任务

在一个空目录里搭出一个叫 `opennote` 的 AI agent CLI 项目（npm 包）。

它最终要做的事：用微信收链接，本地织笔记，攒够素材自动出专题文章。Day 0 只搭骨架 + 跑通对话，业务逻辑（tools / skills / extensions）从 Day 1 起再加。

---

## 架构约束（**严格遵守**）

1. **独立 npm 包**，包名 `@fiilyai/opennote`，发布形态：`pnpm install -g @fiilyai/opennote` → 命令 `opennote`
2. **Pi 作 SDK 嵌入**，不 fork pi 源码，不 wrap pi CLI。装 4 个 Pi 包当依赖
3. **opennote 是唯一对外入口**，读者用 `opennote COMMAND [option]` 风格（参考 `git`、`gh`）
4. **配置走 yaml**（`opennote.yaml`），不走 .env / 命令行参数
5. **ESM only**（`"type": "module"`），不出 CJS
6. **pnpm 管理依赖**（不用 npm / yarn）
7. **CLI 库用 commander**（不用 yargs / cac）
8. **入口跟逻辑分离**：`bin/opennote.ts` 是 thin launcher，`src/cli.ts` 是 commander 派发，`src/commands/*.ts` 是各子命令实现

---

## 依赖清单

```json
{
  "dependencies": {
    "@earendil-works/pi-agent-core": "0.75.5",
    "@earendil-works/pi-ai": "0.75.5",
    "@earendil-works/pi-coding-agent": "0.75.5",
    "@earendil-works/pi-tui": "0.75.5",
    "commander": "^14.0.0",
    "yaml": "^2.6.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  },
  "engines": { "node": ">=20" }
}
```

`pi-coding-agent` 和 `pi-tui` Day 0 暂未直接使用，先装上，给 Day 5+ 复用 CLI / TUI 资产做准备（OpenClaw 同款做法）。

---

## 目录结构（最终态）

```
opennote/
├── README.md                   ← 给最终用户看，产品页风格
├── package.json                ← bin: { opennote: ./dist/bin/opennote.js }
├── tsconfig.json               ← ESM NodeNext + outDir dist
├── .gitignore                  ← node_modules / dist / .env / content/ / opennote.local.yaml
├── opennote.yaml               ← 默认配置（可含测试 key + 警示注释）
├── bin/
│   └── opennote.ts             ← #!/usr/bin/env node，调用 src/cli.ts
├── src/
│   ├── cli.ts                  ← commander 入口，注册 chat（默认）+ --version/--help
│   ├── config.ts               ← 加载 opennote.yaml + zod 校验
│   ├── agent/
│   │   └── create.ts           ← createOpennoteAgent(config) → Pi Agent
│   └── commands/
│       └── chat.ts             ← interactive REPL（readline + agent.subscribe 流式渲染）
└── assets/                     ← 教程公号二维码等
```

---

## yaml schema（`src/config.ts`）

```typescript
{
  agent: {
    model: string,             // "provider:model" 或裸 modelId（搭配 baseUrl）
    systemPrompt: string,
    apiKey?: string,           // 直接写值
    apiKeyEnv?: string,        // 从 env var 读
    baseUrl?: string,          // 填了就走自定义 OpenAI 兼容端点
    api?: "openai-completions" | "openai-responses" | "anthropic-messages",
    headers?: Record<string, string>,  // 自定义 HTTP headers（如 User-Agent）
  },
  paths: { notes, proposals, state },  // 默认 ~/.opennote/*
  skills: string[],
  extensions: string[],
  weixin: { enabled: boolean },
}
```

查找顺序：
1. `opennote --config <path>` 显式
2. `./opennote.yaml`（项目级）
3. `~/.opennote/opennote.yaml`（用户级）
4. 都没有 → 内置默认

字段全可选；缺失就用 default。`~/` 要展开成 `homedir()`。

---

## Pi SDK 关键 API（已实测）

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, getProviders } from "@earendil-works/pi-ai";
import type { KnownProvider, Model } from "@earendil-works/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "...",
    model: getModel(provider, modelName),
  },
  getApiKey: (provider) => apiKey,           // 注入 key
  onPayload: process.env.DEBUG ? log : undefined,
  onResponse: process.env.DEBUG ? log : undefined,
});

agent.subscribe((event) => {
  if (event.type === "message_update") {
    const inner = event.assistantMessageEvent;
    if (inner?.type === "text_delta") {
      process.stdout.write(inner.delta);
    }
  }
});

await agent.prompt("你好");   // async，跑完 agent_end 才 resolve
```

事件序列：`agent_start → turn_start → message_start/end → tool_execution_* → turn_end → agent_end`。

---

## 自定义 OpenAI 兼容端点（接 KIMI、本地 vLLM 等）

`config.agent.baseUrl` 填了就构造一个自定义 `Model<"openai-completions">` 对象，绕过 `getModel`：

```typescript
function buildCustomModel(config: OpennoteConfig): Model<"openai-completions"> {
  return {
    id: config.agent.model,
    name: config.agent.model,
    api: "openai-completions",
    provider: "custom",   // label，不影响行为
    baseUrl: config.agent.baseUrl!,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    headers: config.agent.headers,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
    },
  };
}
```

---

## REPL 实现要点（`src/commands/chat.ts`）

```typescript
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });

while (true) {
  let input: string;
  try {
    input = await rl.question("\n> ");
  } catch (err) {
    if (isReadlineClosed(err)) {
      console.log("\n再见。");
      break;
    }
    throw err;
  }
  const t = input.trim();
  if (!t) continue;
  if (["/exit", "/quit", "exit", "quit", "/q"].includes(t.toLowerCase())) break;
  await agent.prompt(input);
}
```

⚠️ **必须处理 readline EOF**（stdin pipe 关闭时不抛 error 而是干净退出）。这是 stdin 管道测试时的常见坑。

---

## 已踩过的坑（写代码时避开）

1. **`getModel(provider, modelId)` 是字面量类型约束**，从字符串 spec 解析出来要 cast：
   ```typescript
   getModel(provider as KnownProvider, modelName as never)
   ```
   provider 用 `getProviders()` 校验是否合法，modelId 留给 runtime 报错。

2. **KIMI Coding 端点 (`api.kimi.com/coding/v1`) 按 User-Agent 白名单放行**。要在 yaml 加：
   ```yaml
   headers:
     User-Agent: claude-cli/1.0 (Claude Code)
   ```
   不加会返 `access_terminated_error`。

3. **`api.moonshot.ai` 跟 `api.moonshot.cn` 不一样**。`sk-kimi-` 前缀的 key 对应 `api.kimi.com/coding/v1`，不是 moonshot 主域。

4. **pi-ai 默认发 multimodal array content**（`[{type:"text", text:"..."}]`），主流 OpenAI 兼容端点（含 KIMI）都接受。不要试图改成 string content。

5. **Pi 的 stream 错误不一定 surface 成 event**——`message_end` 的 assistant content 是 `[]` + `usage` 全 0 时，通常是 auth / endpoint 端拒绝了。加 `OPENNOTE_DEBUG_HTTP=1` 看 `onPayload` / `onResponse` 钩子的实际请求/响应。

6. **`pnpm install` 会 warn `Ignored build scripts: @google/genai, esbuild, protobufjs`**。这是 pnpm 10+ 的安全默认，opennote 不依赖这些 lifecycle scripts，可忽略。

---

## scripts（`package.json`）

```json
"scripts": {
  "dev": "tsx bin/opennote.ts",
  "chat": "tsx bin/opennote.ts chat",
  "build": "tsc",
  "start": "node dist/bin/opennote.js",
  "typecheck": "tsc --noEmit"
}
```

---

## 验收标准

跑下面三步都不报错：

```bash
pnpm install
pnpm typecheck
echo /exit | pnpm dev
```

最后一步应该输出：

```
opennote v0.0.1
model:  <从 yaml 读出来>
config: <配置文件路径>
输入消息开始对话，输入 /exit 或 quit 退出。

> 
再见。
```

如果 yaml 里 model + key 都配对了（默认配 KIMI Coding 测试 key），下面这步应该流式输出 LLM 回话：

```bash
(echo '你好'; sleep 25) | pnpm dev
# > 你好
# < 你好！我是 opennote ...
```

---

## 接下来（Day 1 预告）

Day 1 要在 `src/agent/create.ts` 里通过 `agent.state.tools = [...]` 注册两个工具：

- `fetch_url(url)` —— 抓网页清洗成 markdown
- `save_note(filename, content, tags?)` —— 存到 `~/.opennote/notes/`

Day 1 不在本 prompt 范围。
