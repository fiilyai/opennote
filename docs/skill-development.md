# Skill 开发指南

> 给 opennote 项目加一个新 skill 时翻这份文档。基于 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-coding-agent` v0.75 的 skills 实现。

---

## 1. Skill 是 agent 的什么

如果 tool 是 agent 的「手脚」（给能力），skill 就是 agent 的「打法手册」（给套路）。

- **tool** = 一段代码，带 JSON schema，LLM 用结构化参数直接调
- **skill** = 一段 markdown 指令（本质是 prompt），按需读进上下文。它教 LLM「碰到某类场景该怎么干」，通常是**编排已有的几个 tool**

一句话：**tool 给能力，skill 给打法。**

举例：opennote 已经有 `fetch_content` / `write` 两个 tool。一个「整理公众号文章成结构化笔记」的 skill，本身不写任何代码，只是用自然语言告诉 LLM：先用 `fetch_content` 抓正文 → 按固定模板提取标题/作者/要点 → 用 `write` 存成 `YYYY-MM-DD-标题.md`。打法被沉淀进了一个文件，下次同类任务 LLM 照着做。

---

## 2. 一个 Skill 长啥样

一个 skill 就是一个含 `SKILL.md` 的目录（或某个 skills 根目录下的裸 `.md` 文件）。

```
skills/
└── wechat-note/
    ├── SKILL.md              ← 必须叫这个名字
    ├── template.md           ← 可选：skill 用到的模板/脚本/资源
    └── extract.ts
```

`SKILL.md` 结构：

```markdown
---
name: wechat-note
description: 把微信公众号文章抓下来，按固定模板整理成结构化笔记并存档。当用户发来 mp.weixin.qq.com 链接并想存成笔记时使用。
disable-model-invocation: false
---

# 微信文章整理

碰到 mp.weixin.qq.com 链接时：

1. 用 fetch_content 抓正文
2. 按下面模板提取字段……
3. 用 write 存成 `YYYY-MM-DD-标题.md`

模板见 ./template.md（相对路径按本文件所在目录解析）
```

### Frontmatter 字段

| 字段 | 必填 | 约束 |
|---|---|---|
| `name` | 否（缺省取父目录名）| 小写 `a-z` / `0-9` / `-`，≤64 字符，不能首尾带 `-`、不能连续 `--`，**且必须和父目录名一致** |
| `description` | **是** | ≤1024 字符。**空了这个 skill 直接被丢弃，不报错只是不加载** |
| `disable-model-invocation` | 否 | `true` = 不进系统提示的菜单，只能用 `/skill:name` 手动调 |

> 校验逻辑在 `pi-agent-core/dist/harness/skills.js` 的 `validateName` / `validateDescription`。name 和父目录不一致会出 warning 诊断（仍会加载），但 description 缺失是硬失败。

### 正文（body）

`---` 之后的全部内容就是给 LLM 看的操作手册。写法跟写 prompt 一样：聚焦、给清楚步骤、能给模板就给模板。正文里的**相对路径按 SKILL.md 所在目录解析**，所以一个 skill 可以捎带脚本、模板、示例文件，让 LLM 用 bash/read 去取。

---

## 3. 发现与加载规则

### 扫描目录的规则（`loadSkillsFromDir`）

- 目录里有 `SKILL.md` → 当成一个 skill 根，**不再往下递归**（避免把子目录的资源误当 skill）
- 没有 `SKILL.md` → 加载该目录下直接的 `.md` 子文件（每个当一个 skill），并递归子目录继续找 `SKILL.md`
- 认 `.gitignore` / `.ignore` / `.fdignore`，命中的跳过
- 跳过 `node_modules` 和点开头的文件/目录

### 默认扫描的位置（`loadSkills` 的 `includeDefaults`）

| 来源 | 路径 | source 标记 |
|---|---|---|
| user 级 | `{agentDir}/skills` | `user` |
| project 级 | `{cwd}/.<config-dir>/skills` | `project` |
| 显式指定 | 传入的 `skillPaths`（文件或目录均可）| `path` |

### 同名冲突

按加载顺序，**先到的赢**，后面同名的被跳过并产出一条 `collision` 诊断。符号链接会被 canonicalize 去重（同一个真实文件不会重复加载）。

### API 速查

```typescript
// pi-coding-agent 层（应用常用）
import { loadSkills, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const { skills, diagnostics } = loadSkills({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  skillPaths: ["./skills"],   // 额外的显式路径
  includeDefaults: true,      // 是否扫上面那两个默认位置
});

const skillsSection = formatSkillsForPrompt(skills);  // 拼进 system prompt
```

---

## 4. 核心设计 · 渐进式加载（progressive disclosure）

这是 skills 机制最值得理解的一点：**skill 正文不进上下文**。

进 system prompt 的只有每个 skill 的 `name + description + 文件路径`，由 `formatSkillsForPrompt` 拼成：

```
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory ...

<available_skills>
  <skill>
    <name>wechat-note</name>
    <description>把微信公众号文章抓下来……</description>
    <location>/abs/path/skills/wechat-note/SKILL.md</location>
  </skill>
</available_skills>
```

LLM 看到的是一张**菜单**（名字 + 描述 + 在哪），任务匹配上了，才用 `read` 工具把那个文件的正文拉进来照做。

这样设计的好处：再多 skill，上下文成本也只是「一行描述 × N」，正文按需才加载。代价是 **description 必须写得让 LLM 能判断「这事归不归我管」**——它就是 skill 的「门面」，地位等同 tool 的 description。

> **硬依赖**：这段菜单**只在 read 工具可用时才追加**（源码里 `hasRead && skills.length > 0` 才拼）。没有 read 工具 = skills 根本不出现在提示里。opennote Day 1 已注册 read，这条天然满足。

---

## 5. 两条调用路径

### 路径 A · 模型自主调用（autonomous）

1. LLM 读系统提示里菜单中的 description
2. 判断当前任务匹配某个 skill
3. 调 `read` 工具读它的 `location`
4. 正文进上下文，LLM 照着执行（期间可能调多个 tool、跑脚本）

`disable-model-invocation: true` 的 skill 不进菜单，这条路走不到。

### 路径 B · 显式 `/skill:name args`（手动）

用户直接敲 `/skill:wechat-note https://mp.weixin.qq.com/s/xxx`。

`_expandSkillCommand` 把这条命令**就地展开**成一个 skill 块再喂给 LLM：

```
<skill name="wechat-note" location="/abs/path/SKILL.md">
References are relative to /abs/path/skills/wechat-note.

（SKILL.md 正文，已去掉 frontmatter）
</skill>

https://mp.weixin.qq.com/s/xxx   ← 跟在后面的 args
```

这条路**不依赖菜单**，所以 `disable-model-invocation: true` 的 skill 也能用 `/skill:` 强制调起。命令名未知时原样透传，不报错。

> 对应实现：`parseSkillBlock`（解析 skill 块）和 `_expandSkillCommand`（展开命令），都在 `pi-coding-agent/dist/core/agent-session.js`。

---

## 6. 两层实现的分工

Pi 把 skills 分在两个包里，职责不同：

| 层 | 文件 | 负责 |
|---|---|---|
| 底层（harness）| `pi-agent-core/.../harness/skills.js` | 平台无关的加载（走 `ExecutionEnv` 抽象文件系统）、`loadSkills` / `loadSourcedSkills` / `formatSkillInvocation`。来源（source）原样透传，不做解释 |
| 应用层 | `pi-coding-agent/.../core/skills.js` | 直接用 Node `fs`，给出 `loadSkills({cwd, agentDir, skillPaths, includeDefaults})` 和 `formatSkillsForPrompt`，处理 user/project/path 三种 source 和冲突去重 |

opennote 走 SDK 嵌入，用应用层那套就够。

---

## 7. 接进 opennote（Day 2 实现）

实现在 `src/agent/create.ts` 的 `withSkills(config, debug)`，在 `new Agent(...)` 之前算好 system prompt：

```typescript
import { loadSkills, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const { skills, diagnostics } = loadSkills({
  cwd: process.cwd(),
  agentDir: path.join(homedir(), ".opennote"),
  skillPaths,              // 见下面的 5 个位置，已过滤掉不存在的
  includeDefaults: false,  // opennote 自己管目录，不扫 pi-coding-agent 的默认位置
});

const systemPrompt = config.agent.systemPrompt + formatSkillsForPrompt(skills);
```

### 扫描的位置（同名先到的赢）

| 优先级 | 路径 | 用途 |
|---|---|---|
| 1 | `{包根}/skills` | opennote 内置 skill，放最前避免被静默顶掉 |
| 2 | `~/.opennote/skills` | opennote 用户级 skill |
| 3 | `{cwd}/.agents/skills` | Agent Skills 标准跨客户端「项目级」约定目录 |
| 4 | `~/.agents/skills` | 跨客户端「用户级」，**仅当 `globalAgentSkills: true`** |
| 5 | `config.skills` 里的路径 | `opennote.yaml` 显式指定 |

第 3、4 条让别家合规客户端（Claude 等）装在 `.agents/skills/` 的 skill 也能被 opennote 直接发现。

> **第 4 条默认关闭。** 用户全局 `~/.agents/skills/` 会把整台机器装的跨客户端 skill 全继承进菜单，无关 skill 会污染选择（一个真实事故：问「有哪些 skills」命中了别家 agent 的 `ljg-skill-map`，opennote 套不上它的工具链，卡在长推理里吐不出答案）。opennote 是专注的笔记 agent，默认只扫自己的目录；想要最大跨客户端互通，在 `opennote.yaml` 设 `globalAgentSkills: true`。项目级 `{cwd}/.agents/skills`（第 3 条）随仓库走、有作用域，保持常开。详见第 8 节。

### 两个工程细节

- **找包根**：`tsconfig` 是 `rootDir: "."` + `outDir: "./dist"`，dev（tsx 跑 `.ts`）和 build（`dist/...`）下模块到包根的层级不同，所以用「从 `import.meta.url` 向上找 `package.json`」定位，而不是写死相对层数。
- **过滤不存在的路径**：`loadSkills` 对每个不存在的 `skillPath` 会产出一条 warning 诊断，所以传进去前先用 `existsSync` 过滤，避免刷屏。

### 注意点

- read 工具必须在已注册的工具里（Day 1 已满足），否则菜单不会出现
- skill 正文里如果让 LLM 写文件，path 约定要和 Day 1 的 cwd 工作空间对齐（只写文件名、落到 `~/.opennote/notes/`）
- `description` 是 skill 能不能被选中的命门，写的时候明确「什么场景用我」，而不是「我是干啥的」
- debug 模式（`OPENNOTE_DEBUG=1`）会打印加载了几个 skill、各自的 name，以及所有诊断

---

## 8. 与 Agent Skills 标准的兼容性

skills 是一套有正式 spec 的行业标准：[agentskills.io](https://agentskills.io/specification)（即 Anthropic 的 SKILL.md 格式被独立成的跨客户端规范）。opennote 没自己写加载器，直接用 Pi 的 `loadSkills`，而 Pi 这套就是照 spec 实现的——所以**格式层面是「白嫖」来的完全兼容**：别家合规客户端写的 skill，丢进上面任一目录就能跑。

逐条对照：

| spec 要求 | opennote（经 Pi）| 状态 |
|---|---|---|
| skill = 含 `SKILL.md` 的目录 + 可选 `scripts/` `references/` `assets/` | 一致 | ✅ |
| `name`：≤64、小写 `a-z0-9-`、不首尾连字符、不连续 `--`、须等于父目录名 | 校验规则逐条一致 | ✅ |
| `description`：≤1024、非空，空则跳过 | 一致 | ✅ |
| 宽松校验：name 不匹配只 warn 仍加载；description 缺失才跳过；YAML 解析失败跳过 | 一致 | ✅ |
| 渐进式三层（catalog → body → resources） | `formatSkillsForPrompt` 的 `<available_skills>` 跟 spec 示例几乎逐字相同 | ✅ |
| 激活：文件读取式 / 用户显式命令 | read 工具 + `/skill:name`，正是 spec 推荐的两种 | ✅ |
| 跨客户端目录约定 `.agents/skills/` | 扫 `{cwd}/.agents/skills`（常开）+ `~/.agents/skills`（`globalAgentSkills` 开关，默认关）| ✅ |

### 已知的不完全之处（都不影响格式兼容）

1. **可选字段只认两个**。spec 的可选 frontmatter 有 `license` / `compatibility` / `metadata` / `allowed-tools`，Pi 全部忽略（只读 `name` / `description`，外加非 spec 的 `disable-model-invocation`）。忽略不影响加载（本就可选），但 `allowed-tools`（限制 skill 能用哪些工具）**不会被强制执行**——该字段 spec 自己也标了「Experimental，各家支持不一」。

2. **几条健壮性建议未实现**（spec 里都是 SHOULD 级，非强制）：
   - 坏 YAML 的「加引号重试」回退——Pi 解析失败直接跳过
   - skill 内容在上下文压缩时豁免裁剪——未验证 Pi 是否保护
   - 不信任的项目 skill 做信任门控——opennote 暂未做（`.agents/skills/` 来自 cwd，理论上随启动目录注入；属于后续要补的安全项）

---

## 9. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| skill 没加载 | `description` 为空 | frontmatter 补上 description（硬失败，静默丢弃）|
| 出 name 不匹配 warning | `name` 和父目录名不一致 | 改 frontmatter 的 name 或改目录名，二者对齐 |
| 菜单里没有 skill | read 工具没注册 | 确认工具列表里有 read |
| LLM 从不主动调某 skill | description 没说清适用场景 | 重写 description，写清触发条件 |
| `/skill:xxx` 没反应 | skill 名拼错 / 未加载 | 命令名未知会原样透传，核对 name |
| 想让某 skill 只能手动调 | —— | frontmatter 加 `disable-model-invocation: true` |
