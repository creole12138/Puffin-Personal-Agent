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
/** 材料里冒出的、卡上还没有的新事实（会影响某些决策） */
export interface NewFact {
  label: string;
  value: string;
  quote: string;
  confidence: "low" | "medium" | "high";
  affectsDecisionIds: ID[];
}
/** 已有前提的变化；附带 newFacts（可能为空） */
export type MatchResult = PremiseMatch[] & { newFacts?: NewFact[] };
export type Matcher = (state: AgentState, ev: Evidence) => Promise<MatchResult>;

export function llmMatcher(provider: LLMProvider): Matcher {
  return async (state, ev) => {
    const premises = Object.values(state.premises);
    if (!premises.length) return [];
    const decisions = Object.values(state.decisions).filter((d) => d.status === "valid" || d.status === "weakened");
    const res = await provider.generateStructured<{ changes: PremiseMatch[]; newFacts: NewFact[] }>({
      task: "match_premises",
      messages: [
        { role: "system", content: BASE_SYSTEM_PROMPT.trim() + "\n\n【本次任务】\n" +
          "你检查一份新材料对用户工作的影响，输出两类结果：\n" +
          "1. changes：材料明确写出、且与某个已有前提当前值不同的变化。newValue 用与当前值相同的格式（如“30 万”）。\n" +
          "2. newFacts：材料里出现了卡上还没有对应前提、但会让某条决策不再成立或需要调整的新事实（如“#421 最早 10/20 才能合入”冲击“10/17 发布”）。" +
          "label 写成前提名（如「#421 预计合入」），value 写成简短具体的取值（≤12 字），affectsDecisionIds 填它冲击的决策，至少一条。" +
          "已有前提能表达的写进 changes，不要重复写进 newFacts；与任何决策无关的背景信息不要写；最多 3 条。\n" +
          "两类都没有就返回空数组。quote 摘录原文依据，只写材料里明确写出的内容，不要推测。" },
        { role: "user", content: JSON.stringify({
          premises: premises.map((p) => ({ premiseId: p.id, label: p.label, current: p.value })),
          decisions: decisions.map((d) => ({ decisionId: d.id, statement: d.statement, card: state.workCards[d.workCardId]?.title,
            dependsOn: d.premiseIds.map((id) => state.premises[id]?.label).filter(Boolean) })),
          evidence: { title: ev.title, ref: ev.ref, content: ev.excerpt },
        }, null, 2) },
      ],
      schema: {
        type: "object", additionalProperties: false, required: ["changes", "newFacts"],
        properties: {
          changes: { type: "array", items: {
            type: "object", additionalProperties: false, required: ["premiseId", "newValue", "quote", "confidence"],
            properties: {
              premiseId: { type: "string", enum: premises.map((p) => p.id) },
              newValue: { type: "string" }, quote: { type: "string" },
              confidence: { type: "string", enum: ["low", "medium", "high"] },
            },
          } },
          newFacts: { type: "array", items: {
            type: "object", additionalProperties: false, required: ["label", "value", "quote", "confidence", "affectsDecisionIds"],
            properties: {
              label: { type: "string" }, value: { type: "string" }, quote: { type: "string" },
              confidence: { type: "string", enum: ["low", "medium", "high"] },
              affectsDecisionIds: { type: "array", items: { type: "string", enum: decisions.length ? decisions.map((d) => d.id) : ["_"] } },
            },
          } },
        },
      },
    });
    const out: MatchResult = res.data.changes.filter((c) => state.premises[c.premiseId]?.value !== c.newValue);
    const labels = new Set(premises.map((p) => p.label));
    out.newFacts = (res.data.newFacts ?? [])
      .map((f) => ({ ...f, affectsDecisionIds: f.affectsDecisionIds.filter((id) => state.decisions[id]) }))
      .filter((f) => f.affectsDecisionIds.length && f.value?.trim() && !labels.has(f.label))
      .slice(0, 3);
    return out;
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
