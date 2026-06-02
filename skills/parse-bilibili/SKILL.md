---
name: parse-bilibili
description: 抓取 B 站（bilibili）视频内容并转成文字。当用户发来 bilibili 链接（bilibili.com/video/BV… 或 b23.tv 短链）并想收藏、整理、记笔记、做总结、收集、存起来时使用。它取视频标题、UP主、简介，并把口播音频用语音识别转成中文文字，供整理或织入知识库。English triggers — bilibili video, transcribe bilibili.
---

# 抓取 B 站视频内容

B 站视频的口播不在网页正文里，字幕又要登录才拿得到，所以 `fetch_content` 抓不到正文。本 skill 用一个脚本把「B 站链接 → 中文文字」打通：取元信息 + 把音频用语音识别转写。

> 下面命令里的 `<skill>` 指本 SKILL.md 所在目录（skills 菜单里有它的绝对路径）。脚本在 `<skill>/scripts/fetch-bilibili.mjs`。

## 流程

0. **先确认 key 配好了**（转写依赖硅基流动 key）：

   ```bash
   node <skill>/scripts/fetch-bilibili.mjs --check-key
   ```

   - 输出「已配置」就直接进第 1 步。
   - 输出「未配置」（或第 1 步脚本以 `NO_API_KEY` 退出码 3 报错）：**向用户要 key**，告诉他「把硅基流动 key（sk- 开头）发给我，我来配；没有就去 https://cloud.siliconflow.cn/ 申请」。**用户把 key 发来后，你运行**：

     ```bash
     node <skill>/scripts/fetch-bilibili.mjs --set-key <用户发来的 sk-...>
     ```

     脚本会把 key 写进 `<skill>/.env`（已 gitignore，不进仓库），之后就不用再配了。配好再回到第 1 步。**别把 key 明文回显给用户，也别瞎编转写内容。**

1. **抓取并存原文（raw）**。一次运行脚本，用 shell 重定向把输出**直接落到 `raw/`**，不要用 `write` 工具重打：

   ```bash
   node <skill>/scripts/fetch-bilibili.mjs "<bilibili 链接>" | tee raw/<YYYY-MM-DD>-<BV号>.md
   ```

   - `tee` 同时把内容打到 stdout，你能在上下文里看到、供下一步用；raw 文件由 shell 写入，**模型不用把上万字转写当参数重新生成**。
   - 脚本纯 Node（view API 取元信息 → WBI 取纯音频 → 硅基 SenseVoice 转写），不依赖 yt-dlp / lux / ffmpeg。
   - **raw 是不可变原文，保持 ASR 原样**（codeex/cloud 等先别动），符合 collect-content「raw 存源、之后不改」。

   > ⚡ 性能铁律：**已经在 stdout 或磁盘上的大段内容，落盘/搬运一律用 bash（`>`、`tee`、`cp`），绝不用 `write` 工具。** `write` 会让模型把整段内容当参数重新生成——几千字的转写要吐上万 token、卡好几分钟。`write` 只用来写你**新写的、短的**内容（摘要页、概念页）。

2. **写 wiki 页时顺手校正专名**。SenseVoice 中文优先，英文专名常听错（Codex→codeex、Claude→cloud、Opus→ops、ChatGPT→chGPT、AI→A正、hooks→ho）。摘要页/概念页本就是**压缩提炼、输出很短**，在写这些页时结合标题与简介把专名写对即可——**不要为了"清洗"把整段转写重写一遍**（那又会触发上万 token 的慢生成）。

3. **织入知识库**。按 `collect-content` 流程：raw 已在第 1 步存好 → 写摘要页 → 抽概念/实体页并用 `[[wikilink]]` 互连 → 更新索引/流水。本 skill 负责「拿到 B 站文字 + 存 raw」，wiki 织入交给 collect-content。

## 边界

- **超长视频**：音频 >50MB（约 >1 小时）超过硅基单文件上限，脚本会报错。如实告诉用户暂不支持，别硬来（切片是后续计划）。
- **大会员 / 付费 / 特殊视频**：可能取不到音频流，脚本会报错，如实转达。
- **脚本报错**：把 stderr 原样告诉用户，**不要编造转写内容**。
