/**
 * 把 opennote 配置解析成 Pi 的 Model，以及 API key 的解析策略。
 */

import { getModel, getProviders } from "@earendil-works/pi-ai";
import type { KnownProvider, Model } from "@earendil-works/pi-ai";

import type { OpennoteConfig } from "../config.js";

export type ResolvedModel = Model<"openai-completions"> | ReturnType<typeof getModel>;

/**
 * 解析模型：
 *   - 填了 baseUrl → 走自定义 OpenAI 兼容端点
 *   - 否则按 "provider:model" 走 pi-ai 内置 provider 表
 */
export function resolveModel(config: OpennoteConfig): ResolvedModel {
  if (config.agent.baseUrl) return buildCustomModel(config);
  const { provider, modelName } = parseKnownModelSpec(config.agent.model);
  // modelId 在 pi-ai 里是按 provider narrow 的字面量类型。从字符串配置解析出来时
  // 无法静态收缩，所以这里 cast；运行时由 getModel 自己校验。
  return getModel(provider, modelName as never);
}

/**
 * 决定 Pi 怎么拿 API key：
 *   1. config.agent.apiKey 直接写值（优先级最高）
 *   2. config.agent.apiKeyEnv 指定一个环境变量名 → 从 process.env 读
 *   3. 都没配 → 返回 undefined，让 Pi 走自己的默认 env 行为
 *      （pi-ai 会自动找 ANTHROPIC_API_KEY / MOONSHOT_API_KEY / OPENAI_API_KEY 等）
 */
export function makeApiKeyResolver(
  config: OpennoteConfig,
): (provider: string) => string | undefined {
  return (_provider: string): string | undefined => {
    if (config.agent.apiKey) return config.agent.apiKey;
    if (config.agent.apiKeyEnv) return process.env[config.agent.apiKeyEnv];
    return undefined;
  };
}

interface ParsedKnownModel {
  provider: KnownProvider;
  modelName: string;
}

function parseKnownModelSpec(spec: string): ParsedKnownModel {
  const idx = spec.indexOf(":");
  const rawProvider = idx === -1 ? "anthropic" : spec.slice(0, idx);
  const modelName = idx === -1 ? spec : spec.slice(idx + 1);

  const knownProviders = getProviders();
  if (!knownProviders.includes(rawProvider as KnownProvider)) {
    throw new Error(
      `未知 provider: "${rawProvider}"。支持的 provider: ${knownProviders.join(", ")}`,
    );
  }

  return { provider: rawProvider as KnownProvider, modelName };
}

/**
 * 自定义 OpenAI 兼容端点：用户填了 baseUrl 时，绕过 pi-ai 内置 provider 表，
 * 直接构造一个 Model 对象。用于接 KIMI、本地 vLLM、ollama、各种第三方网关等。
 */
function buildCustomModel(config: OpennoteConfig): Model<"openai-completions"> {
  if (!config.agent.baseUrl) {
    throw new Error("buildCustomModel: baseUrl 是必填");
  }
  const api = config.agent.api ?? "openai-completions";
  if (api !== "openai-completions") {
    throw new Error(
      `Day 0 暂时只支持 openai-completions 作为自定义端点的 api，收到: ${api}`,
    );
  }
  // 用 model 字符串当 id / name。例如 "kimi-k2.6"。
  return {
    id: config.agent.model,
    name: config.agent.model,
    api: "openai-completions",
    // provider 在自定义路径下是 label，仅用于日志显示。
    // Provider = KnownProvider | string，所以任意字符串都可。
    provider: "custom",
    baseUrl: config.agent.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    // 自定义 HTTP headers。常见用途：伪装 User-Agent 以通过白名单（KIMI Coding 端点等）
    headers: config.agent.headers,
    // OpenAI 兼容端点的常见保守默认。KIMI / moonshot 也满足。
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
    },
  };
}
