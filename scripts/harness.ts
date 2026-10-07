/** 命令行脚本共用：按环境变量组装 Provider / 判断器 */
import "./env.ts";
import {
  createProvider, llmAssessor, llmMatcher, providerConfigFromEnv, ReplayProvider,
  ruleAssessor, ruleMatcher, type Assessor, type LLMProvider, type Matcher,
} from "../app/core/src/index.ts";

export interface Brains { provider: LLMProvider | null; assess: Assessor; match: Matcher; label: string }

export function brains(useLLM: boolean): Brains {
  if (!useLLM) return { provider: null, assess: ruleAssessor, match: ruleMatcher, label: "规则判断（加 --llm 使用 .env 中的模型）" };
  const mode = (process.env.LLM_MODE as "live" | "record" | "replay") ?? "record";
  const cfg = providerConfigFromEnv();
  const inner = mode === "replay" ? null : createProvider(cfg);
  const p = new ReplayProvider(inner, "data/llm-cache", mode, { id: cfg.provider, model: cfg.model });
  return { provider: p, assess: llmAssessor(p), match: llmMatcher(p), label: `${p.id} / ${p.model}（${mode}）` };
}
