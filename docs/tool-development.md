# Tool 开发指南

> 给 opennote 项目加一个新 tool 时翻这份文档。基于 `@earendil-works/pi-agent-core` v0.75 的 AgentTool 接口。

---

## 1. Tool 是 agent 的什么

Tool 是 agent 的「手脚」。LLM 自己只会想，靠 tool 才能跟外部世界打交道（读文件、发 HTTP、操作浏览器、写数据库……）。

### 调用流程（agent loop 一帧一帧拆）

```
你 → agent.prompt("打开这个链接...")
   ├─ agent_start            事件
   ├─ turn_start             事件
   │
   ├─ LLM 思考               (HTTP 请求到 provider)
   │   ├─ 看 system prompt + 历史 message
   │   ├─ 看可用 tools 列表（name + description + parameters schema）
   │   └─ 决定：直接回答 OR 调一个 / 多个 tool
   │
   ├─ message_start          事件（LLM 开始输出）
   ├─ text_delta / toolCall  事件（流式片段）
   ├─ message_end            事件
   │
   ├─ tool_execution_start   事件
   ├─→ execute(toolCallId, params, signal, onUpdate, ctx)  ← 你的代码在这跑
   ├─ tool_execution_update  事件（onUpdate 触发时）
   ├─ tool_execution_end     事件
   │
   ├─ 工具结果回填到 messages
   ├─ 回到 LLM 思考（看到 tool result 后继续推理 / 调更多 tool / 收尾）
   ├─ turn_end               事件
   └─ agent_end              事件
```

**关键点**：

- LLM 看不到 tool 的源码，只看 `name + description + parameters`。这三项写得清不清楚直接决定 LLM 调不调、怎么调
- tool 是无状态的（每次 execute 是独立调用）。需要状态走闭包或 ctx
- 一个 turn 里 LLM 可能调多个 tool（按 `executionMode` 顺序 / 并行）
- tool 抛 error 时框架会自动包成 `isError: true` 的 toolResult，LLM 看到后会自己决定是否重试或换策略

---

## 2. AgentTool 接口 · 字段速查

```typescript
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> {
  // ── 必填 ──
  name: string;              // 唯一标识，LLM 调用时引用这个
  label: string;             // UI 显示用（终端里出现的 "label"）
  description: string;       // 给 LLM 看的，决定它什么时候调
  parameters: TParameters;   // typebox schema，描述参数形状
  execute: (...) => Promise<AgentToolResult<TDetails>>;

  // ── 可选 ──
  executionMode?: "sequential" | "parallel";
  prepareArguments?: (args: unknown) => Static<TParameters>;
}
```

### 字段对 LLM 决策的影响

| 字段 | LLM 看得到？ | 写不好的后果 |
|---|---|---|
| `name` | 看得到 | 名字含糊（如 `do_thing`），LLM 不知道啥时候调 |
| `description` | 看得到 | 没说清适用场景 / 边界，LLM 漏调或乱调 |
| `parameters`（含 schema 里每个字段的 `description`）| 看得到 | LLM 漏参 / 给错类型 / 给错语义 |
| `label` | 看不到 | 只是终端 UI 显示，跟 LLM 决策无关 |
| `execute` 函数体 | 看不到 | 函数逻辑跟 LLM 决策无关；只看返回的 `content` |

---

## 3. typebox schema 写法

`typebox` 是 pi 用的 schema 库（JSON Schema 兼容 + TypeScript 类型推导）。

```typescript
import { Type, type Static } from "typebox";

const openInBrowserSchema = Type.Object({
  url: Type.String({
    description: "完整的 URL，必须以 http:// 或 https:// 开头",
  }),
});

// 推导出 TS 类型给 execute 用
type OpenInBrowserInput = Static<typeof openInBrowserSchema>;
// = { url: string }
```

### 常用 schema 速查

```typescript
Type.String({ description: "..." })                 // 必填字符串
Type.Optional(Type.String())                        // 可选字符串
Type.Number({ minimum: 1, maximum: 100 })           // 带范围的数字
Type.Boolean()                                      // 布尔
Type.Array(Type.String())                           // 字符串数组
Type.Union([Type.Literal("a"), Type.Literal("b")])  // 枚举
Type.Object({ x: Type.String() })                   // 嵌套对象
```

**每个字段都给 `description`**。LLM 直接靠它判断要不要填、填什么。

---

## 4. execute 函数详解

### 完整签名

```typescript
async execute(
  toolCallId: string,            // 当次调用的唯一 id
  params: Static<typeof schema>, // 已经 schema-validated 过的参数
  signal?: AbortSignal,          // 用户中断 / 超时时会 abort
  onUpdate?: AgentToolUpdateCallback<TDetails>,  // 流式 partial result
  ctx?: AgentContext,            // 当前 agent 上下文（messages / tools 等）
): Promise<AgentToolResult<TDetails>>;
```

### `signal: AbortSignal` 中断协议

长任务必须处理 abort。模板：

```typescript
async execute(_id, params, signal) {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }

  // 注册一次性 listener，确保中断时拒绝 promise
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Operation aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });

    doRealWork(params).then(resolve).catch(reject);
  });
}
```

短任务（毫秒级）可以省略 signal 处理，但不是好习惯。

### `onUpdate` 流式 partial result

长任务想让 UI / 调用方提前看到进度时用。短任务可以忽略：

```typescript
async execute(_id, params, _signal, onUpdate) {
  for await (const chunk of streamingWork()) {
    onUpdate?.({ content: [{ type: "text", text: chunk }], details: {} });
  }
  return { content: [...], details: {} };
}
```

### 返回值 `AgentToolResult`

```typescript
interface AgentToolResult<TDetails> {
  content: (TextContent | ImageContent)[];  // 给 LLM 看的
  details: TDetails;                         // 给 UI / 日志用，LLM 看不到
  terminate?: boolean;                       // 强制 agent 在本 turn 后停下
}
```

- `content` 是 LLM 唯一看得到的产出。要简洁清晰，写人话
- `details` 放给 UI 或调试用的结构化数据（比如：开浏览器时的命令字符串、HTTP 工具的 response code / headers / 完整 body 长度等）
- `terminate: true` 慎用。一般不需要，让 LLM 自己决定何时停

### 错误处理

**throw，不要塞进 content**。框架会自动包成 `isError: true` 的 toolResult，LLM 看到错误描述后会决定重试 / 换策略 / 报告给用户。

```typescript
// ✅ 推荐
if (!isValidUrl(params.url)) {
  throw new Error(`Invalid URL: ${params.url}（必须以 http:// 或 https:// 开头）`);
}

// ❌ 别这么干
return {
  content: [{ type: "text", text: "ERROR: invalid url" }],
  details: {},
};
```

throw 时 message 要带具体信息（拒绝原因 / 拒绝的值）。LLM 看错误时跟人一样靠 message 判断。

---

## 5. content 数组的两种 piece

```typescript
type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
```

- 99% 工具只用 `TextContent`
- 用 `ImageContent` 的场景：截图 / OCR / 生成的图 / 等给 LLM「看」的图像内容

---

## 6. opennote 项目文件约定

```
opennote/
├── src/
│   ├── tools/
│   │   ├── open_in_browser.ts   ← 一文件一 tool
│   │   ├── save_note.ts
│   │   └── ...
│   └── agent/
│       └── create.ts            ← 集中注册：agent.tools = [createA(), createB()]
```

### 单文件结构（模板）

```typescript
// src/tools/{name}.ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";

const schema = Type.Object({
  // ...
});

export type XxxToolInput = Static<typeof schema>;
export interface XxxToolDetails { /* 给 UI / 日志的结构 */ }

export function createXxxTool(opts?: {/* 依赖注入 */}): AgentTool<typeof schema> {
  return {
    name: "xxx",
    label: "Xxx",
    description: "...",
    parameters: schema,
    async execute(_toolCallId, params, _signal) {
      // ...
      return {
        content: [{ type: "text", text: "result" }],
        details: { /* ... */ },
      };
    },
  };
}
```

### 为什么用 `createXxxTool()` 工厂函数

很多 tool 要绑外部状态（cwd / config / fs operations）。工厂函数让闭包捕获这些依赖，比纯对象更灵活。即使当下不需要参数，先把工厂模式立起来，扩展时省力。

### 注册到 agent

`src/agent/create.ts`：

```typescript
import { createOpenInBrowserTool } from "../tools/open_in_browser.js";

export function createOpennoteAgent(config) {
  const agent = new Agent({/* ... */});
  agent.tools = [
    createOpenInBrowserTool(),
    // createSaveNoteTool(config),
    // ...
  ];
  return agent;
}
```

---

## 7. 调试 tool

### 环境变量

```bash
# 看所有 agent 事件
OPENNOTE_DEBUG_EVENTS=1 pnpm dev

# 看 LLM 实际收到的请求 / 返回（含 tool 描述）
OPENNOTE_DEBUG_HTTP=1 pnpm dev
```

### 不走 agent 的单元级测试

直接 import + 调 execute，跳过 LLM。验证 tool 函数本身：

```typescript
// scripts/test-open-browser.ts
import { createOpenInBrowserTool } from "../src/tools/open_in_browser.js";

const tool = createOpenInBrowserTool();
const result = await tool.execute(
  "test-call-1",
  { url: "https://example.com" },
);
console.log(result);
```

### 端到端测试（不走 readline）

```typescript
import { loadConfig } from "../src/config.js";
import { createOpennoteAgent } from "../src/agent/create.js";

const agent = createOpennoteAgent(await loadConfig());
agent.subscribe((event) => {
  if (event.type === "tool_execution_start") {
    console.log(`[调 tool] ${event.toolName}`);
  }
});
await agent.prompt("打开 https://example.com");
```

---

## 8. 示例：从零写一个 tool

完整的 `open_in_browser`：

```typescript
// src/tools/open_in_browser.ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import open from "open";

const schema = Type.Object({
  url: Type.String({
    description: "要打开的 URL，必须以 http:// 或 https:// 开头",
  }),
});

export type OpenInBrowserInput = Static<typeof schema>;
export interface OpenInBrowserDetails {
  url: string;
  platform: NodeJS.Platform;
}

export function createOpenInBrowserTool(): AgentTool<typeof schema> {
  return {
    name: "open_in_browser",
    label: "打开浏览器",
    description:
      "在用户系统的默认浏览器里打开一个 URL。适合让用户视觉上 review 一个链接的内容。" +
      "不抓取页面内容、不返回正文；只是触发浏览器打开。",
    parameters: schema,
    async execute(_toolCallId, { url }, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`Invalid URL: ${url}（必须以 http:// 或 https:// 开头）`);
      }
      await open(url);
      return {
        content: [{ type: "text", text: `已在系统默认浏览器打开 ${url}` }],
        details: { url, platform: process.platform },
      };
    },
  };
}
```

---

## 9. 常见坑

| 坑 | 现象 | 怎么避 |
|---|---|---|
| `description` 写不清 | LLM 不调 / 乱调 / 在不该调的地方调 | 写清「适用场景 + 不适用边界」；用 [[opennote-style]] 的接地气类比 |
| schema 字段缺 `description` | LLM 漏参 / 类型搞错 | 每个 schema 字段都写一句 description |
| `execute` 没 `await signal` | 用户中断时 tool 还在跑 | 长任务必须注册 abort listener |
| throw 的 error message 没信息 | LLM 不知道错在哪 / 重试不了 | message 带具体值 + 拒绝原因 |
| `content` 写太多内容 | token 消耗大 / LLM 抓不住重点 | 短而精；大块结构化数据放 `details` |
| 工厂函数没 export | 别处 import 不到 | `export function createXxxTool(...)` |
| 注册时漏到 `agent.tools` 数组 | LLM 收不到 tool list / 不知道这工具存在 | `src/agent/create.ts` 集中维护 |
| `executionMode` 不设 vs 设 sequential | 同 turn 多个 tool 并发跑出 race | 写文件 / 改环境的 tool 设 `sequential` |

---

## 10. 关联

- Pi 自家 AgentTool API 完整源码：`node_modules/@earendil-works/pi-agent-core/dist/types.d.ts`
- 现成 tool 示例（更复杂的，含 signal / streaming / 自定义 UI）：`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/` 下的 `ls` / `find` / `grep` / `bash` / `edit`
- 写作调性：[../content/opennote-writing-style-v0.3.md](../content/opennote-writing-style-v0.3.md)（如果你的 tool description 要让中文读者也看得懂）

---

> 这份文档跟着 opennote 演化。每加一个 tool 发现新规则 / 新坑 → 更新这里。
