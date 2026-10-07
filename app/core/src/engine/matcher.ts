import type { LLMProvider } from "../provider/types.ts";
import type { AgentState, Evidence, ID } from "../types.ts";
import { BASE_SYSTEM_PROMPT } from "../harness/prompts.ts";

/** 新证据是否改变了某个前提（感知第三层：LLM 判断，规则兜底） */
export interface PremiseMatch {
  premiseId: ID;
  newValue: string;
  quote: string;
  confidence: "low" | "medium" | "high";
}
export type Matcher = (state: AgentState, ev: Evidence) => Promise<PremiseMatch[]>;

export function llmMatcher(provider: LLMProvider): Matcher {
  return async (state, ev) => {
    const premises = Object.values(state.premises);
    if (!premises.length) return [];
    const res = await provider.generateStructured<{ changes: PremiseMatch[] }>({
      task: "match_premises",
      messages: [
        { role: "system", content: BASE_SYSTEM_PROMPT.trim() + "\n\n【本次任务】\n" +
          "你检查一份新材料是否改变了用户工作中的某个前提。只报告材料中明确写出、且与当前值不同的变化；" +
          "没有变化就返回空数组。newValue 用与当前值相同的格式（如“30 万”）。quote 摘录原文依据。" },
        { role: "user", content: JSON.stringify({
          premises: premises.map((p) => ({ premiseId: p.id, label: p.label, current: p.value })),
          evidence: { title: ev.title, ref: ev.ref, content: ev.excerpt },
        }, null, 2) },
      ],
      schema: {
        type: "object", additionalProperties: false, required: ["changes"],
        properties: { changes: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["premiseId", "newValue", "quote", "confidence"],
          properties: {
            premiseId: { type: "string", enum: premises.map((p) => p.id) },
            newValue: { type: "string" }, quote: { type: "string" },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
          },
        } } },
      },
    });
    return res.data.changes.filter((c) => state.premises[c.premiseId]?.value !== c.newValue);
  };
}

/** 规则兜底：识别 "<前提名>,<数字>" 这类表格行 */
export const ruleMatcher: Matcher = async (state, ev) => {
  const out: PremiseMatch[] = [];
  for (const p of Object.values(state.premises)) {
    const key = p.label.replace(/^Q4\s*/, "");
    const m = ev.excerpt.match(new RegExp(`(Q4\\s*)?总?${key}[^\\n\\d]*?(\\d+(?:\\.\\d+)?)`));
    if (!m) continue;
    const v = `${m[2]} 万`;
    if (v !== p.value) out.push({ premiseId: p.id, newValue: v, quote: m[0], confidence: "medium" });
  }
  return out;
};
