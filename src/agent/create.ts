/**
 * 把 opennote 配置组装成一个 Pi Agent。
 *
 * Day 0：只配 systemPrompt + model
 * Day 1+ ：在这里 register tools（fetch_url / save_note / ...）
 * Day 5+ ：挂 extensions（weixin / cron / 等）
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, getProviders } from "@earendil-works/pi-ai";
import type { KnownProvider, Model } from "@earendil-works/pi-ai";

import type { OpennoteConfig } from "../config.js";

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
 * 直接构造一个 Model 对象。
 *
 * 用于接 KIMI、本地 vLLM、自己跑的 ollama、各种第三方网关等。
 */
function buildCustomModel(
  config: OpennoteConfig,
): Model<"openai-completions"> {
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

export function createOpennoteAgent(config: OpennoteConfig): Agent {
  let model: Model<"openai-completions"> | ReturnType<typeof getModel>;
  if (config.agent.baseUrl) {
    model = buildCustomModel(config);
  } else {
    const { provider, modelName } = parseKnownModelSpec(config.agent.model);
    // modelId 在 pi-ai 里是按 provider narrow 的字面量类型。从字符串配置
    // 解析出来时无法静态收缩，所以这里 cast；运行时由 getModel 自己校验。
    model = getModel(provider, modelName as never);
  }

  return new Agent({
    initialState: {
      systemPrompt: config.agent.systemPrompt,
      model,
    },
    getApiKey: makeApiKeyResolver(config),
    onPayload: process.env.OPENNOTE_DEBUG_HTTP
      ? (payload: unknown) => {
          console.error("[payload]", JSON.stringify(payload).slice(0, 600));
        }
      : undefined,
    onResponse: process.env.OPENNOTE_DEBUG_HTTP
      ? (response: unknown) => {
          console.error("[response]", JSON.stringify(response).slice(0, 600));
        }
      : undefined,
  });
}

/**
 * 决定 Pi 怎么拿 API key：
 *   1. config.agent.apiKey 直接写值（优先级最高）
 *   2. config.agent.apiKeyEnv 指定一个环境变量名 → 从 process.env 读
 *   3. 都没配 → 返回 undefined，让 Pi 走自己的默认 env 行为
 *      （pi-ai 会自动找 ANTHROPIC_API_KEY / MOONSHOT_API_KEY / OPENAI_API_KEY 等）
 */
function makeApiKeyResolver(config: OpennoteConfig) {
  return (_provider: string): string | undefined => {
    if (config.agent.apiKey) return config.agent.apiKey;
    if (config.agent.apiKeyEnv) return process.env[config.agent.apiKeyEnv];
    return undefined;
  };
}
