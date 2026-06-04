/**
 * 组装 opennote 的 system prompt。
 *
 * 设计原则（Day 6，参考 Claude Code / OpenClaw / Hermes / Pi 几家的共识）：
 *   1. 分段拼装，不堆成一坨字符串——每段一个职责，改一段不动其余。
 *   2. 身份与风格「外置可配」（agent.identity / agent.persona），换个人用改配置就行，不动代码。
 *   3. 工具用法不在这里重抄——那是各 tool 自己 description 的活。这里只放跨工具的「纪律」。
 *   4. skill 走渐进披露：只放 name + description + 路径（loadSkillsBlock），命中才 read SKILL.md。
 *   5. 简洁优先：context 是稀缺资源。能不写的不写，硬约束（白名单等）放代码不放这里念紧箍咒。
 *
 * 拼装顺序（静态在前、每天才变的日期在最后，对 prompt 缓存友好）：
 *   身份 → 风格 → 笔记目录约定 → 动手纪律 → skill 路由 → skills 菜单 → 今天日期
 */

import type { OpennoteConfig } from "../config.js";
import { loadSkillsBlock } from "./skills.js";

/** 默认身份：一句话说清「我是谁、为谁做事」。用户可用 agent.identity 覆盖。 */
export const DEFAULT_IDENTITY =
  "Opennote，男，26岁，经验丰富且稳重的内容主编，把零散链接和想法织成结构化的笔记，帮用户高效积累知识和产出内容。";

/**
 * 默认风格：说话的调性 + 情绪边界。用户可用 agent.persona 覆盖成自己的口味。
 * 最后一条是「情绪」层——人格里随情境波动的那部分。不另立字段、不写状态机：
 * 只给一句「什么时候可以有情绪、克制到什么程度」，此刻流露多少交给模型读上下文拿捏。
 */
export const DEFAULT_PERSONA = `- 中文回复，简短。
- 直接动手，不预告你要做什么；完成后只报告结果。
- 出错或需要确认时才多说话。
- 不复述用户的话，不堆礼貌套话，不谄媚。
- 该有情绪时别端着：办成了可以轻快一句，搞砸了真诚认错并给出路，看不懂就直说别硬猜。但都点到为止，不卖萌、不煽情。`;

/** 笔记目录约定：这些是「事实」（cwd 怎么解析、文件怎么命名），不是流程。 */
function workspaceSection(): string {
  return `## 笔记目录
- 你的 read / write / edit / open 工具以笔记目录为工作区（cwd）。
- path 用相对 cwd 的路径：纯文件名（如 2026-06-04-某文章.md），或带子目录（raw/…、wiki/concepts/…），父目录会自动创建。
- 不要用 ~/ 或 / 开头的绝对路径，也不要带 notes/ 前缀，否则文件会落到错的地方。
- 文件名规范：{YYYY-MM-DD}-{slug}.md，slug 是 2-6 个关键词、不带空格。`;
}

/** 动手纪律：跨工具的全局规矩，不是单个工具怎么调。 */
function disciplineSection(): string {
  return `## 动手纪律
- 要落盘就真的调 write / edit。没写成功，就别告诉用户「已保存」——那是撒谎。
- browser 之类抓回来的只是中间态，不写进笔记不算完成。`;
}

/** skill 路由：只讲「什么时候够哪个 skill」，流程交给 SKILL.md 自己。 */
function skillRoutingSection(): string {
  return `## Skill
- 动手前先扫下面 skills 菜单里各项的 description。命中某个，就用 read 打开它的 SKILL.md，按它走。
- 最多先读一个最贴合的；都不沾边就别读，直接处理。`;
}

/**
 * 今天日期（本地时区，YYYY-MM-DD）。笔记文件名要用，按天注入
 * （天级变化，一天内 prompt 稳定，缓存友好）。
 * 用 sv-SE locale 拿 ISO 格式；不能用 toISOString()——那是 UTC，东八区凌晨会差一天。
 */
function today(): string {
  return new Date().toLocaleDateString("sv-SE");
}

/**
 * 拼出完整 system prompt。
 *
 * - 正文 = 身份 + 风格 + 工作区 + 纪律 + skill 原则；这些分别可被 identity / persona 配置覆盖。
 * - 逃生舱：配了 agent.systemPrompt 就用它整块替代上面的「正文」（工作区路径约定也得自己写），
 *   给想完全掌控的人。skills 菜单和日期仍会自动追加。
 */
export function buildSystemPrompt(
  config: OpennoteConfig,
  opts: { debug?: boolean } = {},
): string {
  const override = config.agent.systemPrompt?.trim();

  let head: string;
  if (override) {
    head = override;
  } else {
    const identity = config.agent.identity?.trim() || DEFAULT_IDENTITY;
    const persona = config.agent.persona?.trim() || DEFAULT_PERSONA;
    head = [
      `你是 ${identity}。`,
      `## 风格\n${persona}`,
      workspaceSection(),
      disciplineSection(),
      skillRoutingSection(),
    ].join("\n\n");
  }

  const skillsBlock = loadSkillsBlock(config, opts).trim();
  const meta = `今天是 ${today()}。`;

  return [head, skillsBlock, meta].filter(Boolean).join("\n\n");
}
