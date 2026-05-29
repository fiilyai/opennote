/**
 * opennote.yaml 配置加载。
 *
 * 查找顺序：
 *   1. --config <path> 显式指定
 *   2. ./opennote.yaml（项目级）
 *   3. ~/.opennote/opennote.yaml（用户级）
 *   4. 全部缺失 → 用内置默认（不报错）
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { expandPath } from "./utils/paths.js";
import { z } from "zod";

const DEFAULT_MODEL = "anthropic:claude-sonnet-4-20250514";

const DEFAULT_SYSTEM_PROMPT = `你是 opennote，一个帮人把零散链接织成结构化笔记的 agent。
- 收到链接时，先理解内容类型，再按合适的方式整理成笔记。
- 直接动手，不解释你要做什么；完成后只报告结果。
- 出错才说话。`;

const ConfigSchema = z.object({
  agent: z
    .object({
      model: z.string().optional(),
      systemPrompt: z.string().optional(),
      apiKey: z.string().optional(),
      apiKeyEnv: z.string().optional(),
      // 自定义 OpenAI 兼容端点：填了 baseUrl 就走自定义模式，绕过 pi-ai 内置 provider 列表
      baseUrl: z.string().optional(),
      api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]).optional(),
      // 自定义 HTTP headers（如 User-Agent）。某些端点（KIMI Coding 等）会按 UA 白名单。
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  paths: z
    .object({
      notes: z.string().optional(),
      proposals: z.string().optional(),
      state: z.string().optional(),
    })
    .optional(),
  skills: z.array(z.string()).optional(),
  // 是否扫描用户全局的 ~/.agents/skills/（Agent Skills 跨客户端共享目录）。
  // 默认 false：opennote 是专注的笔记 agent，不继承你整台机器装的跨客户端 skill，
  // 避免无关 skill 污染选择（详见 docs/skill-development.md）。
  globalAgentSkills: z.boolean().optional(),
  extensions: z.array(z.string()).optional(),
  weixin: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
});

export interface OpennoteConfig {
  agent: {
    model: string;
    systemPrompt: string;
    apiKey?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    api?: "openai-completions" | "openai-responses" | "anthropic-messages";
    headers?: Record<string, string>;
  };
  paths: {
    notes: string;
    proposals: string;
    state: string;
  };
  skills: string[];
  globalAgentSkills: boolean;
  extensions: string[];
  weixin: {
    enabled: boolean;
  };
  sourceFile?: string;
}

function findConfigFile(explicitPath?: string): string | undefined {
  if (explicitPath) {
    const abs = resolve(explicitPath);
    if (!existsSync(abs)) {
      throw new Error(`找不到配置文件: ${abs}`);
    }
    return abs;
  }
  const candidates = [
    resolve(process.cwd(), "opennote.yaml"),
    join(homedir(), ".opennote", "opennote.yaml"),
  ];
  return candidates.find((p) => existsSync(p));
}

export function loadConfig(explicitPath?: string): OpennoteConfig {
  const file = findConfigFile(explicitPath);
  let raw: unknown = {};
  if (file) {
    const text = readFileSync(file, "utf8");
    raw = parseYaml(text) ?? {};
  }

  const parsed = ConfigSchema.parse(raw);

  return {
    agent: {
      model: parsed.agent?.model ?? DEFAULT_MODEL,
      systemPrompt: parsed.agent?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      apiKey: parsed.agent?.apiKey,
      apiKeyEnv: parsed.agent?.apiKeyEnv,
      baseUrl: parsed.agent?.baseUrl,
      api: parsed.agent?.api,
      headers: parsed.agent?.headers,
    },
    paths: {
      notes: expandPath(parsed.paths?.notes ?? "~/.opennote/notes"),
      proposals: expandPath(parsed.paths?.proposals ?? "~/.opennote/proposals"),
      state: expandPath(parsed.paths?.state ?? "~/.opennote/state"),
    },
    skills: parsed.skills ?? [],
    globalAgentSkills: parsed.globalAgentSkills ?? false,
    extensions: parsed.extensions ?? [],
    weixin: {
      enabled: parsed.weixin?.enabled ?? false,
    },
    sourceFile: file,
  };
}
