# opennote

> 用微信收链接，本地织笔记，攒够素材自动出专题文章。
> 一个真能跑的 AI agent，底座是 [Pi](https://github.com/earendil-works/pi)（OpenClaw 同款）。

---

## 一分钟跑通

需要 Node.js 20+ 和 pnpm。

- 没装 Node.js：去 [nodejs.org](https://nodejs.org/) 下个 LTS 版（一路 Next），或者 `brew install node`（macOS）
- 没装 pnpm：装好 Node.js 后跑 `npm install -g pnpm`，或参考 [pnpm.io/installation](https://pnpm.io/installation)

然后：

```bash
git clone <repo-url> opennote
cd opennote
pnpm install
pnpm dev
```

回车，直接进入对话：

```
opennote v0.0.1
model:  kimi-for-coding
config: ./opennote.yaml
输入消息开始对话，输入 /exit 或 quit 退出。

> 你好，介绍一下你自己
你好，我是 opennote，一个帮你快速记录、整理和回顾想法的 AI 笔记助手。

>
```

仓库默认接的是 KIMI Coding 端点，**内置一个公开测试 key**，你不配任何东西就能跑。

> ⚠️ 测试 key 是公共资源，请勿滥用 / 勿用于生产。
> 自己实际使用时，请去 [kimi.com](https://www.kimi.com/) 申请一个自己的 key，
> 编辑 `opennote.yaml` 里的 `agent.apiKey` 字段换上。

---

## 自定义

所有配置都在项目根的 `opennote.yaml`，字段都带中文注释。

最常改的三件事：

**换 model / provider**

```yaml
agent:
  model: anthropic:claude-sonnet-4-20250514   # 或 openai:gpt-5 / google:gemini-2.5-pro / deepseek:deepseek-chat
  # 删掉 baseUrl / headers 两段，让 pi-ai 走内置 provider
```

**换 API key**

```yaml
agent:
  apiKey: "sk-你自己的-key"          # 或：
  apiKeyEnv: ANTHROPIC_API_KEY      # 从环境变量读
```

**换 system prompt**

```yaml
agent:
  systemPrompt: |
    你是 ...
```

完整字段说明在 `opennote.yaml` 文件内。

---

## 命令

opennote 走 `opennote COMMAND [option]` 风格。Day 0 只有 `chat`，后面逐天加。

| 命令 | 作用 | 上线 |
|---|---|---|
| `opennote chat`（默认）| 进对话 | Day 0 |
| `opennote run "<prompt>"` | 单次执行，stdout 出结果 | Day 8 |
| `opennote serve` | 起微信长轮询，让 agent 在微信里收发 | Day 5 |
| `opennote login` | 微信扫码登录 | Day 5 |
| `opennote tidy` | 整理今天的笔记（cron 用） | Day 8 |
| `opennote --version` | 版本号 | Day 0 |
| `opennote --help` | 命令帮助 | Day 0 |

---

## 配套教程

这是「**10 天学会 AI Agent 开发**」系列教程的配套代码仓库。

从 Day 0（你看到的这版）开始，每天加一块，到 Day 10 完整跑通：微信收链接 → 本地织笔记 → 出专题 → 发到外部。

每篇文章首发微信公众号，扫码关注：

<img src="./assets/wechat.jpg" alt="公众号二维码" width="200">

代码用 git tag 标记每天结束时的完整状态：

```bash
git checkout day-3              # 切到 Day 3 结束时的代码
git diff day-2 day-3 -- src/    # 看 Day 2 → Day 3 改了什么
```

11 个 tag（`day-0` 到 `day-10`），打上不动，方便 diff 阅读。

---

## 进阶（开发者）

```bash
pnpm typecheck     # 跑 tsc 类型检查
pnpm build         # 编译到 dist/
pnpm chat          # 跟 pnpm dev 一样
```

### Debug 模式

LLM 选错 tool / 写错路径 / 凭空编造结果？开 debug 看实际发生了什么。

```bash
# 一键全开（推荐用这个）
OPENNOTE_DEBUG=1 pnpm dev

# 或者按需开任一
OPENNOTE_DEBUG_HTTP=1 pnpm dev      # 只 dump LLM 请求 / 回复
OPENNOTE_DEBUG_EVENTS=1 pnpm dev    # 只 dump agent 事件流

# 自定义输出目录（默认 ~/.opennote/debug/{ISO 时间戳}/）
OPENNOTE_DEBUG_DIR=./debug-2026-05-28 pnpm dev
```

输出文件（每个 turn 一对，按编号配对阅读）：

| 文件 | 内容 |
|---|---|
| `NNN-payload.json` | 这一轮**发给 LLM 的完整请求**：systemPrompt + messages + 所有 tool 的 description / schema |
| `NNN-assistant.json` | 这一轮 LLM **返回的 assistant message**：text + 它决定要调的 tool 名字 + 实参 |
| `events.jsonl`（仅 EVENTS 开时）| 所有 agent 事件原样追加，一行一条。包含 tool 执行细节、流式 chunk 等 |

诊断流程：

- LLM 没调你期望的 tool → 看 `NNN-payload.json` 里那个 tool 的 description，写得清不清楚
- LLM 调了 tool 但参数偏 → 看 `NNN-assistant.json` 里 `arguments`，对照 systemPrompt 的约定
- 想知道 tool 实际收到啥参数 / 返回啥 → grep `events.jsonl` 里 `tool_execution_start` / `tool_execution_end`
- 想看 LLM 思考过程（如果模型支持）→ `NNN-assistant.json` 里有 `thinking` content block

代码结构：

```
opennote/
├── bin/opennote.ts        ← CLI 入口（launcher）
├── src/
│   ├── cli.ts             ← commander 派发子命令
│   ├── config.ts          ← opennote.yaml 加载 + 校验
│   ├── agent/create.ts    ← 把配置组装成 Pi Agent
│   └── commands/chat.ts   ← interactive REPL
├── opennote.yaml          ← 配置（含测试 key，可改 / 可换）
└── README.md
```

依赖的 4 个 Pi 包都是 SDK 嵌入用：

- `@earendil-works/pi-agent-core`：Agent runtime、tool loop、事件流
- `@earendil-works/pi-ai`：30+ provider 的 LLM 抽象
- `@earendil-works/pi-coding-agent`：CLI / TUI 资产复用
- `@earendil-works/pi-tui`：TUI 库（Day 0 暂未启用）

---

## License

MIT
