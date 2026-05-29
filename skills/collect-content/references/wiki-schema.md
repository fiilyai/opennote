# Wiki Schema

collect-content 建页时的详细格式和命名规则。建 概念/实体/synthesis 页或更新索引前读这份。

## 命名与 slug

- slug：2-6 个关键词，中文直接用，英文小写连字符，不带空格。例：`时间管理`、`pomodoro-technique`、`andrej-karpathy`。
- 文件名：
  - `raw/{YYYY-MM-DD}-{slug}.md` —— 带日期，因为同一来源有时间属性
  - `wiki/{summaries,concepts,entities,syntheses}/{slug}.md` —— 不带日期，wiki 页是活的、跨时间维护
- 页面标题（wikilink 用的名字）= 人类可读的标题，不是 slug。`[[时间管理]]` 而不是 `[[shi-jian-guan-li]]`。一个概念**只能有一页**，换名字前先查 index。

## raw 原文页

抓到的内容原样存，只在最顶上加三行来源头，正文不动：

```markdown
<!-- source: <URL> -->
<!-- collected: <YYYY-MM-DD> -->
<!-- title: <原标题> -->

<fetch_content 抓回来的完整 markdown 正文，原样保留>
```

存进去就不再改。要修订认识去改 wiki 页。

## concept 概念页

一页只讲一个概念/框架/方法。

```markdown
---
title: <概念名>
type: concept
tags: [<标签>]
updated: <YYYY-MM-DD>
---

# <概念名>

> <一句话定义，是什么>

## 说明

<2-5 段，讲清楚它是什么、解决什么问题、关键机制。可引 [[相关概念]] 和 [[实体]]。>

## 相关

- [[<相关概念或实体>]] — <关系一句话>

## 分歧

<不同来源说法冲突时记在这；没有就省略整节。>
- <来源 A 说…，来源 B 说…>

## 来源

- [[<摘要页标题>]]（<YYYY-MM-DD>）— <这个源贡献了什么>
```

## entity 实体页

人 / 工具 / 组织 / 产品。结构同 concept，把「说明」换成实体侧重点：

```markdown
---
title: <实体名>
type: entity
kind: person | tool | org | product
tags: [<标签>]
updated: <YYYY-MM-DD>
---

# <实体名>

> <一句话：是谁/什么，为什么相关>

## 简介

<它是什么、做什么、和你关注的主题什么关系。可 [[链接]]。>

## 相关

- [[<相关页>]] — <关系>

## 来源

- [[<摘要页标题>]]（<YYYY-MM-DD>）— <贡献了什么>
```

## synthesis 综合页（collect 阶段一般不建）

跨多页的横向分析（如「番茄工作法 vs 时间块」对比）。通常在用户提问/回顾时生成，ingest 阶段不主动建。结构：

```markdown
---
title: <综合主题>
type: synthesis
tags: [<标签>]
updated: <YYYY-MM-DD>
---

# <综合主题>

<横向论述，大量 [[链接]] 到被综合的概念/实体页。>

## 涉及

- [[…]]
- [[…]]
```

## index.md 全库索引

按类型列出所有页，新建页就加一行。保持机器可扫的简单格式：

```markdown
# Index

## Summaries
- [[<标题>]] — <YYYY-MM-DD>

## Concepts
- [[<标题>]]

## Entities
- [[<标题>]]

## Syntheses
- [[<标题>]]
```

更新页（不是新建）不必动 index，除非标题变了。

## log.md ingest 流水

每次 ingest 在文件末尾**追加**一行（用 edit/read 拿到现有内容再 write，或直接 append 风格）：

```markdown
- <YYYY-MM-DD HH:mm> 收 <源标题/URL> → raw/<…>.md；新建 [[A]] [[B]]，更新 [[C]]
```

log 是流水账，只增不改，方便回看「这周收了啥」。
