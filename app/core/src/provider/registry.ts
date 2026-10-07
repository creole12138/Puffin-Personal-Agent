import { OpenAIProvider } from "./openai.ts";
import { ProviderError, type LLMProvider, type ProviderConfig, type ProviderId } from "./types.ts";

type Factory = (cfg: ProviderConfig) => LLMProvider;

/** 新增 Provider：实现 LLMProvider，再在这里注册一行 */
const factories: Partial<Record<ProviderId, Factory>> = {
  openai: (cfg) => new OpenAIProvider(cfg),
  // kimi: (cfg) => new KimiProvider(cfg),        // 第二阶段
  // anthropic: (cfg) => new AnthropicProvider(cfg),
};

export function availableProviders(): ProviderId[] {
  return Object.keys(factories) as ProviderId[];
}

export function createProvider(cfg: ProviderConfig): LLMProvider {
  const f = factories[cfg.provider];
  if (!f) throw new ProviderError(`Provider "${cfg.provider}" 尚未实现（已实现：${availableProviders().join(", ")}）`, cfg.provider);
  return f(cfg);
}

/** 第一阶段：从环境变量读配置，默认 openai / gpt-6-sol，用户不需要手动切换 */
export function providerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const provider = (env.LLM_PROVIDER ?? "openai") as ProviderId;
  const keyVar: Record<ProviderId, string> = { openai: "OPENAI_API_KEY", kimi: "MOONSHOT_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
  const baseVar: Record<ProviderId, string> = { openai: "OPENAI_BASE_URL", kimi: "MOONSHOT_BASE_URL", anthropic: "ANTHROPIC_BASE_URL" };
  return {
    provider,
    model: env.LLM_MODEL ?? "gpt-6-sol",
    apiKey: env[keyVar[provider]],
    baseUrl: env[baseVar[provider]],
  };
}
