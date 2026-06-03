/**
 * opennote.yaml 配置加载。
 *
 * 查找顺序：
 *   1. --config <path> 显式指定
 *   2. ./opennote.yaml（项目级）
 *   3. ~/.opennote/opennote.yaml（用户级）
 *   4. 全部缺失 → 用内置默认（不报错）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";

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
      // iLink 服务地址，默认 https://ilinkai.weixin.qq.com（DEFAULT_BASE_URL）。
      baseUrl: z.string().optional(),
      // 白名单：只有这些 ilink_user_id 能驱动 agent。空 = 谁都不行（安全默认）。
      allowFrom: z.array(z.string()).optional(),
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
    baseUrl?: string;
    allowFrom: string[];
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
      baseUrl: parsed.weixin?.baseUrl,
      allowFrom: parsed.weixin?.allowFrom ?? [],
    },
    sourceFile: file,
  };
}

/**
 * 决定 allowFrom 写回哪个文件：有加载到的配置文件就写它；没有就写用户级
 * ~/.opennote/opennote.yaml（不污染项目库，也不需要项目里先有配置）。
 */
export function resolveWritableConfigPath(config: OpennoteConfig): string {
  return config.sourceFile ?? join(homedir(), ".opennote", "opennote.yaml");
}

/**
 * 把一个 ilink_user_id 写进 opennote.yaml 的 weixin.allowFrom（顺手把 enabled 置 true）。
 * 用 yaml Document API 做，保留原文件注释与结构；已存在则跳过（幂等）。
 * 返回是否真的新增了。
 */
export function addWeixinAllowFrom(targetPath: string, userId: string): "added" | "exists" {
  const text = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  const doc = parseDocument(text);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (doc.toJSON() as any) ?? {};
  const existing: string[] = data?.weixin?.allowFrom ?? [];
  if (existing.includes(userId)) return "exists";

  if (!doc.hasIn(["weixin"])) doc.setIn(["weixin"], { enabled: true, allowFrom: [] });
  if (doc.getIn(["weixin", "allowFrom"]) == null) doc.setIn(["weixin", "allowFrom"], []);
  if (doc.getIn(["weixin", "enabled"]) !== true) doc.setIn(["weixin", "enabled"], true);
  doc.addIn(["weixin", "allowFrom"], userId);

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, doc.toString(), "utf8");
  return "added";
}
