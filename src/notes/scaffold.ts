/**
 * LLM Wiki 笔记库的目录骨架初始化（方法论源自 Andrej Karpathy 的 "LLM Wiki"）。
 * wiki-ingest skill 往这套结构里织笔记，详见该 skill 的 references/wiki-schema.md。
 */

import path from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const WIKI_SUBDIRS = ["raw", "wiki/summaries", "wiki/concepts", "wiki/entities", "wiki/syntheses"];

/**
 * 幂等地初始化骨架：目录用 recursive mkdir；三个种子文件只在不存在时写，绝不覆盖
 * 用户内容。让 wiki-ingest 首次 ingest 不会读到 index.md not-found 而卡住，
 * 笔记库本身也自描述、可在 Obsidian 等工具里打开。
 */
export function ensureWikiScaffold(notesDir: string): void {
  for (const sub of WIKI_SUBDIRS) {
    mkdirSync(path.join(notesDir, sub), { recursive: true });
  }

  const seeds: Record<string, string> = {
    "wiki/README.md": WIKI_README,
    "wiki/index.md": WIKI_INDEX,
    "wiki/log.md": "# Log\n",
  };
  for (const [rel, content] of Object.entries(seeds)) {
    const file = path.join(notesDir, rel);
    if (!existsSync(file)) writeFileSync(file, content);
  }
}

const WIKI_README = `# opennote 知识库

这是 opennote 用 LLM Wiki 模式维护的本地知识库（方法论源自 Andrej Karpathy 的 "LLM Wiki"）。
把 LLM 当编译器：\`raw/\` 是源代码（存进去不再改），\`wiki/\` 是编译产物（由 agent 写和维护）。

## 结构

- \`raw/\`            — 不可变原文，一个来源一个文件，存进去不再修改
- \`wiki/summaries/\` — 摘要页，一个来源一页
- \`wiki/concepts/\`  — 概念 / 框架页，一个概念一页
- \`wiki/entities/\`  — 实体页（人 / 工具 / 组织 / 产品）
- \`wiki/syntheses/\` — 跨页综合分析（提问 / 回顾时生成）
- \`index.md\`        — 全库索引
- \`log.md\`          — 收集流水

页与页之间用 \`[[wikilink]]\` 互连，与 Obsidian vault 兼容，可直接用 Obsidian 打开本目录。
`;

const WIKI_INDEX = `# Index

## Summaries

## Concepts

## Entities

## Syntheses
`;
