import {
  createProvider, llmAssessor, llmMatcher, piModelFromConfig, providerConfigFromEnv, ReplayProvider,
  ruleAssessor, ruleMatcher, type Assessor, type Matcher,
} from "../core/src/index.ts";
import type { Api, Model } from "@mariozechner/pi-ai";
import { countCall } from "./usage.ts";

export interface Brains {
  /** 单次结构化调用（候选卡等轻量任务）；未配置模型时为 null */
  provider: import("../core/src/index.ts").LLMProvider | null;
  match: Matcher;
  assess: Assessor;
  model: Model<Api> | null;
  getApiKey: () => string | undefined;
  modelInfo: { provider: string; name: string };
  label: string;
}

/**
 * LLM_MODE：
 *   live（默认）— 真实调用 .env 中的模型，结果同时存档（data/llm-cache），供示例案例离线回放；
 *   rule        — 开发用：规则判断，不联网（不能整理新工作卡）。
 */
export function makeBrains(env = process.env): Brains {
  const cfg = providerConfigFromEnv(env);
  const modelInfo = { provider: cfg.provider, name: cfg.model };
  if (env.LLM_MODE === "rule" || !cfg.apiKey) {
    return { provider: null, match: ruleMatcher, assess: ruleAssessor, model: null, getApiKey: () => undefined, modelInfo,
      label: cfg.apiKey ? "规则判断（开发模式）" : "未配置模型 key：只能体验示例案例" };
  }
  // 计数挂在真实请求上：结构化调用包在缓存里层（命中缓存不计）；Pi 循环每次请求模型前都会取一次 key
  const inner = createProvider(cfg);
  const counted = { id: inner.id, model: inner.model,
    generateStructured: (req: any) => { countCall(); return inner.generateStructured(req); },
    generateText: (req: any) => { countCall(); return inner.generateText(req); } } as typeof inner;
  const p = new ReplayProvider(counted, env.LLM_CACHE_DIR ?? "data/llm-cache", "record");
  return { provider: p, match: llmMatcher(p), assess: llmAssessor(p), model: piModelFromConfig(cfg), getApiKey: () => { countCall(); return cfg.apiKey; }, modelInfo, label: `${cfg.provider} / ${cfg.model}` };
}
