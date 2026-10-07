/**
 * Provider 配置 → Pi 的 Model 对象。
 * Pi（@mariozechner/pi-ai）本身就是多 Provider 的统一接口；这里只负责把我们的配置映射过去。
 * gpt-6-sol 不在 Pi 内置模型表中，按自定义模型声明（OpenAI Responses API）。
 */
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ProviderConfig } from "../provider/types.ts";

export function piModelFromConfig(cfg: ProviderConfig): Model<Api> {
  switch (cfg.provider) {
    case "openai":
      return {
        id: cfg.model, name: cfg.model, api: "openai-responses", provider: "openai",
        baseUrl: cfg.baseUrl ?? "https://api.openai.com/v1",
        reasoning: true, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000, maxTokens: 32000,
      } as Model<Api>;
    case "kimi":
      return {
        id: cfg.model, name: cfg.model, api: "openai-completions", provider: "kimi",
        baseUrl: cfg.baseUrl ?? "https://api.moonshot.cn/v1",
        reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 16000,
      } as Model<Api>;
    case "anthropic":
      return {
        id: cfg.model, name: cfg.model, api: "anthropic-messages", provider: "anthropic",
        baseUrl: cfg.baseUrl ?? "https://api.anthropic.com",
        reasoning: true, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000, maxTokens: 32000,
      } as Model<Api>;
  }
}
