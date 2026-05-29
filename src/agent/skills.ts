/**
 * 加载 skills 并拼进 system prompt（渐进式加载：只放 name + description + 路径，
 * 正文等 LLM 用 read 工具按需读）。skill 开发指南见 docs/skill-development.md。
 */

import path from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

import { loadSkills, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

import type { OpennoteConfig } from "../config.js";
import { expandPath, findPackageRoot } from "../utils/paths.js";

/**
 * 收集要扫描的 skill 目录（按优先级，同名先到的赢）：
 *   1. 包自带的 skills/          —— opennote 内置 skill，放最前避免被静默顶掉
 *   2. ~/.opennote/skills/       —— opennote 用户级 skill
 *   3. {cwd}/.agents/skills/     —— Agent Skills 标准的跨客户端「项目级」约定目录
 *   4. ~/.agents/skills/         —— 跨客户端「用户级」，仅当 config.globalAgentSkills=true
 *   5. config.skills 里的显式路径
 *
 * 第 3、4 条是 agentskills.io 的 .agents/skills/ 跨客户端约定。但用户全局
 * ~/.agents/skills/ 默认不扫——它会把整台机器的跨客户端 skill 全继承进菜单，无关
 * skill 会污染选择（默认关，globalAgentSkills 开启）。项目级随仓库走、有作用域，常开。
 */
function skillDirs(config: OpennoteConfig): string[] {
  const candidates = [
    path.join(findPackageRoot(), "skills"),
    path.join(homedir(), ".opennote", "skills"),
    path.join(process.cwd(), ".agents", "skills"),
    ...(config.globalAgentSkills ? [path.join(homedir(), ".agents", "skills")] : []),
    ...config.skills.map(expandPath),
  ];
  // 过滤掉不存在的路径，否则 loadSkills 会对每个缺失路径产出一条 warning。
  return candidates.filter((p) => existsSync(p));
}

/**
 * 在 config.agent.systemPrompt 后面拼上 skills 菜单（`<available_skills>` 段）。
 * 这段只在 read 工具可用时由 Pi 生效，opennote 已注册 read，天然满足。
 */
export function composeSystemPrompt(
  config: OpennoteConfig,
  opts: { debug?: boolean } = {},
): string {
  const { skills, diagnostics } = loadSkills({
    cwd: process.cwd(),
    agentDir: path.join(homedir(), ".opennote"),
    skillPaths: skillDirs(config),
    // opennote 自己管目录，不扫 pi-coding-agent 的默认位置（.config/skills 等）。
    includeDefaults: false,
  });

  if (opts.debug) {
    console.error(
      `[opennote-debug] loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ") || "(none)"}`,
    );
    for (const d of diagnostics) {
      console.error(`[opennote-debug] skill diagnostic [${d.type}] ${d.path}: ${d.message}`);
    }
  }

  return config.agent.systemPrompt + formatSkillsForPrompt(skills);
}
