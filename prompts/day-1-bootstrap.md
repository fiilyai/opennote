# Day 1 给 agent 装上 tool 的 Prompt

> 用法：把本文从「任务」起到末尾整段贴给 Claude Code / Cursor / Codex 等 coding agent。它能在 Day 0 骨架基础上加完 Day 1 的 5 个工具。
>
> 前置条件：Day 0 骨架已就绪（参考 `prompts/day-0-bootstrap.md`），`pnpm dev` 能跑通对话。
>
> 这份 prompt 是「10 天学会 AI Agent 开发」教程项目的配套资产。

---

## 任务

在 Day 0 的对话 REPL 之上，给 agent 装第一批 tool，让它从「只会聊天」升级到「能抓网页 + 能写笔记」。

Day 1 完成形态：跟 agent 说一句「把 https://... 整理成笔记存到 today.md」，agent 自动抓内容、整理、落盘到 `~/.opennote/notes/today.md`。

---

## 架构约束（在 Day 0 8 条之外补充）

9. **tool 一文件一个**，放在 `src/tools/{snake_name}.ts`，导出 `createXxxTool(opts?): AgentTool<schema>` 工厂函数
10. **tool 在 `src/agent/create.ts` 集中注册**，写到 `agent.state.tools = [...]`（注意是 `state.tools`，不是 `agent.tools`）
11. **`typebox` 必须加成 direct dep**。它是 pi-agent-core 的 transitive，但 pnpm 不 hoist 到顶层 node_modules，自己代码 import 会找不到
12. **tool 抛错走 throw**，不要把错误塞进返回的 `content` —— 框架会自动包成 `isError: true` 的 toolResult
13. **每个新 tool 都要有端到端测试**，放在 `scripts/test-day{N}-*.ts`，跑 `pnpm tsx scripts/...` 验证
14. **能用 Pi 自带 tool 不要重写**，pi-coding-agent 已经实现了 Claude Code 同款 read/write/edit/grep/find/ls/bash 七件套

---

## 文档前置

加任何 tool 之前先读 `docs/tool-development.md`。那里有：

- agent loop 调 tool 的事件序列
- `AgentTool` 接口必填 / 可选字段
- `typebox` schema 写法 + 必给每个字段 `description`
- `execute(toolCallId, params, signal?, onUpdate?, ctx?)` 函数签名
- `AgentToolResult.content` vs `details` 的区分
- signal 中断协议、错误处理范式
- 常见坑清单

---

## 依赖追加

```bash
pnpm add open typebox@1.1.38 chrome-launcher chrome-remote-interface @mozilla/readability jsdom turndown
pnpm add -D @types/jsdom @types/turndown @types/chrome-remote-interface
```

为什么这些：

- `open`：跨平台 `xdg-open` / `start` / `open` 统一，给 `open_path` 用
- `typebox`：Pi 的 schema 库，写 tool parameters 用
- `chrome-launcher`：发现并启动用户系统装的 Chrome / Edge / Brave / Chromium 系列浏览器
- `chrome-remote-interface`：CDP 客户端，连上 chrome 的 debug 端口
- `@mozilla/readability` + `jsdom`：从乱七八糟的 HTML 里提正文
- `turndown`：HTML → markdown

---

## Day 1 注册的 5 个 tool 总览

| Tool | 来源 | 干啥 |
|---|---|---|
| `fetch_content` | **自写** | URL → markdown 正文。调起系统 Chrome（用户看到窗口）+ CDP 抓渲染后 HTML + readability + turndown |
| `open_path` | **自写** | 系统默认应用打开：URL → 浏览器、文件路径 → 默认 viewer |
| `read` | **Pi 自带** | `createReadTool(cwd)`，读文件（含分页、image 支持） |
| `write` | **Pi 自带** | `createWriteTool(cwd)`，写文件，自动 mkdir |
| `edit` | **Pi 自带** | `createEditTool(cwd)`，批量精确字符串替换 |

cwd 选笔记目录 `~/.opennote/notes`：相对路径 LLM 写 "today.md" 就落到 `~/.opennote/notes/today.md`。

---

## Tool 1：`fetch_content`

### 设计

- 名字：`fetch_content`
- 参数：`url: string`
- 返回 markdown 包装好的 text，details 带 title / finalUrl / wordCount

### 实现要点

```typescript
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { launch as launchChrome, type LaunchedChrome } from "chrome-launcher";
import CDP from "chrome-remote-interface";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

let cachedChrome: LaunchedChrome | undefined;
async function getChrome() {
  if (cachedChrome) return cachedChrome;
  cachedChrome = await launchChrome({
    chromeFlags: ["--new-window"],
    startingUrl: "about:blank",
  });
  return cachedChrome;
}

export function createFetchContentTool(): AgentTool<typeof schema> {
  return {
    name: "fetch_content",
    label: "抓取网页内容",
    description: "...（说清楚：用系统 Chrome + CDP；适用静态正文页；局限说清）",
    parameters: schema,
    async execute(_id, { url }, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");
      if (!/^https?:\/\//i.test(url)) throw new Error(`Invalid URL: ${url}`);

      const chrome = await getChrome();
      // 每次抓取新开 tab，避免污染上一次的页面
      const target = await CDP.New({ port: chrome.port, url: "about:blank" });
      const client = await CDP({ port: chrome.port, target: target.id });
      try {
        await client.Page.enable();
        await Promise.all([
          client.Page.navigate({ url }),
          client.Page.loadEventFired(),
        ]);
        await new Promise((r) => setTimeout(r, 1500)); // SPA 渲染缓冲

        const r = await client.Runtime.evaluate({
          expression:
            "({ html: document.documentElement.outerHTML, finalUrl: location.href })",
          returnByValue: true,
        });
        const { html, finalUrl } = r.result.value;

        const dom = new JSDOM(html, { url: finalUrl });
        const article = new Readability(dom.window.document).parse();
        if (!article?.content) throw new Error(`提取正文失败：${url}`);

        const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
        const markdown = td.turndown(article.content);

        return {
          content: [{ type: "text", text: `# ${article.title}\n\n${markdown}\n\n来源：${finalUrl}` }],
          details: { title: article.title, finalUrl, wordCount: article.textContent.length },
        };
      } finally {
        await client.close();
        // 不调 CDP.Close({ port, id: target.id })，让 tab 留着给用户看
      }
    },
  };
}
```

### 关键决策

- **进程内缓存 chrome 实例**：第一次 fetch 启动 chrome，后续复用同一个 chrome 进程，只新开 tab。否则每次抓都启动新 chrome 太重
- **不杀 chrome**：fetch 完关掉 CDP 连接，但 chrome 窗口留着。用户看完手动关
- **JSDOM 必须传 url 选项**：否则 Readability 处理相对链接时会出错
- **加 1.5s 渲染缓冲**：navigate + loadEventFired 完成后 SPA 可能还在 JS 渲染，等一下

---

## Tool 2：`open_path`

### 设计

- 名字：`open_path`
- 参数：`target: string`（URL 或文件路径，支持 `~` 展开）
- 自动判断：`http://...` → 浏览器；本地路径 → 默认 app

### 实现要点

```typescript
import open from "open";

const isUrl = /^https?:\/\//i.test(target);
if (!isUrl) {
  const expanded = expandTilde(target);
  if (!existsSync(expanded)) throw new Error(`File not found: ${target}`);
  await open(expanded);
} else {
  await open(target);
}
```

不返回正文。要拿 URL 内容用 `fetch_content`，要读本地文件用 `read`。

---

## Tool 3-5：Pi 三件套（直接 import + 注册，零实现成本）

```typescript
import {
  createReadTool,
  createWriteTool,
  createEditTool,
} from "@earendil-works/pi-coding-agent";

const notesDir = expandPath(config.paths?.notes ?? "~/.opennote/notes");
mkdirSync(notesDir, { recursive: true });

agent.state.tools = [
  createFetchContentTool(),
  createOpenPathTool(),
  createReadTool(notesDir),
  createWriteTool(notesDir),
  createEditTool(notesDir),
];
```

### Pi 三件套的设计哲学（直接抄自 Claude Code）

| Tool | Schema | 关键 |
|---|---|---|
| read | `{ path, offset?, limit? }` | 返回行号 + 内容，支持分页大文件 |
| write | `{ path, content }` | 覆盖写，自动 mkdir |
| edit | `{ path, edits: [{ oldText, newText }] }` | **批量原子编辑**，oldText 必须在文件里唯一存在，否则报错 |

description 全是英文。KIMI 这种 bilingual 模型理解没问题，**不要包一层把 description 翻成中文**（除非测试发现 LLM 选错 tool）。

---

## 测试

### 端到端测试 (`scripts/test-day1-e2e.ts`)

```typescript
const agent = createOpennoteAgent(await loadConfig());
agent.subscribe((event) => {
  if (event.type === "tool_execution_start") {
    console.log(`[event] ${event.toolName} args=${JSON.stringify(event.args)}`);
  }
});

const prompt =
  `请抓取这个链接的内容：${TEST_URL}\n` +
  `然后整理成一篇 markdown 笔记，保存到 today-test.md。`;
await agent.prompt(prompt);
```

预期：

```
[event] fetch_content args={"url":"..."}
[event] write args={"path":"today-test.md","content":"..."}
~/.opennote/notes/today-test.md 实际落地，几 KB 大小
```

测试 URL 建议用 WeChat 公号文章（普通 fetch 也能拿到正文，验证基础流水线）。

### 单元测试（可选）

```typescript
const tool = createFetchContentTool();
const result = await tool.execute("test-id", { url: "https://example.com" });
console.log(result);
```

---

## 已踩过的坑

1. **`agent.tools` 不存在**：tool 列表在 `agent.state.tools`，不是 `agent.tools`。直接赋值会报 `Property 'tools' does not exist on type 'Agent'`

2. **`typebox` 没 hoist**：pi-agent-core 把 typebox 当依赖，但 pnpm 不 hoist 到顶层，得 `pnpm add typebox@1.1.38` 加成 direct dep

3. **chrome-launcher 启动是新的 chrome 实例**：不是用户当前打开的 chrome，而是 chrome-launcher 用 `--user-data-dir=临时目录` 拉一个新实例。意味着用户的 X / 小红书登录态拿不到（要登录的站要单独想方案）

4. **Page.loadEventFired 完不代表 JS 渲染好**：SPA 站点 load 完之后还在异步注入内容。所以加 1.5s 缓冲（hack 但管用）

5. **JSDOM 不传 url 会让 Readability 处理相对链接出错**：`new JSDOM(html, { url: finalUrl })` 把 url 显式传进去

6. **WeChat 公号普通 fetch 就能拿全文**：之前以为要伪装 MicroMessenger UA，实测不用。WeChat 给浏览器返回的 HTML 里 `#js_content` 直接 inline 中文正文（实测 2.9MB / 1947 字 / 25 张图）

7. **`tool_execution_start` 事件直接带 `args`**：想看 LLM 实际传给 tool 的参数，监听这个事件的 `event.args` 就行，不用从 `message_update` 里挖

8. **Pi tool description 都是英文**：KIMI 等 bilingual 模型理解没问题，不要手痒去翻译

---

## 验收标准

```bash
pnpm typecheck                              # 不报错
pnpm tsx scripts/test-day1-e2e.ts           # 通过：fetch_content + write 都被调用，文件落地
```

测试期间可见：

- Chrome 窗口弹出加载测试 URL
- 终端流式输出 LLM 整理过程
- `~/.opennote/notes/{你指定的文件名}` 实际生成，有完整 markdown 内容

---

## 接下来（Day 2 预告）

Day 2 重点：从「单次抓」到「批量整理」。可能方向：

- 加 `list_notes` / `search_notes` 让 agent 翻历史笔记
- 加 `parse_youtube` / `parse_bilibili` 等专项抓取 tool（视频字幕）
- 引入 skill / system prompt 模板系统

Day 2 不在本 prompt 范围。
