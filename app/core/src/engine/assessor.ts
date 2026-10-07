import type { LLMProvider } from "../provider/types.ts";
import type { DecisionAssessment } from "../types.ts";
import type { Assessor } from "./ripple.ts";
import { BASE_SYSTEM_PROMPT } from "../harness/prompts.ts";

/**
 * LLM 判断：新前提下每条决策是否仍成立，并给替代建议。
 * 只把"必要上下文"交给模型：前提新旧值、决策、它依赖的其他前提与证据摘录。
 */
export function llmAssessor(provider: LLMProvider): Assessor {
  return async ({ state, premiseId, from, to, decisions }) => {
    const premise = state.premises[premiseId]!;
    const ctx = decisions.map((d) => ({
      decisionId: d.id,
      statement: d.statement,
      otherPremises: d.premiseIds.filter((p) => p !== premiseId).map((p) => {
        const pr = state.premises[p];
        return pr ? `${pr.label}：${pr.value}${pr.confirmed ? "" : "（未确认）"}` : p;
      }),
      evidence: d.provenance.evidenceIds.map((e) => state.evidence[e]?.excerpt).filter(Boolean),
      alternativesMentioned: d.suggestion?.statement ?? null,
    }));
    const res = await provider.generateStructured<{ assessments: DecisionAssessment[] }>({
      task: "assess_decisions",
      temperature: 0,
      messages: [
        { role: "system", content: BASE_SYSTEM_PROMPT.trim() + "\n\n【本次任务】\n" +
          "你是工作状态检查器。一个前提的取值变了，判断每条决策是否仍成立。" +
          "只依据给出的材料，不要编造数字。verdict: still_valid / weakened / invalidated。" +
          "若不再成立，给出一个具体替代决策和它的代价（一句话）；仍成立时 suggestion 为 null。reason 用一句中文。" },
        { role: "user", content: JSON.stringify({ premise: premise.label, from, to, decisions: ctx }, null, 2) },
      ],
      schema: {
        type: "object", additionalProperties: false, required: ["assessments"],
        properties: {
          assessments: { type: "array", items: {
            type: "object", additionalProperties: false,
            required: ["decisionId", "verdict", "reason", "suggestion"],
            properties: {
              decisionId: { type: "string", enum: decisions.map((d) => d.id) },
              verdict: { type: "string", enum: ["still_valid", "weakened", "invalidated"] },
              reason: { type: "string" },
              suggestion: { anyOf: [{ type: "null" }, {
                type: "object", additionalProperties: false, required: ["statement", "tradeoff"],
                properties: { statement: { type: "string" }, tradeoff: { type: "string" } },
              }] },
            },
          } },
        },
      },
    });
    return res.data.assessments.map((a) => ({ ...a, suggestion: a.suggestion ?? undefined }));
  };
}

/**
 * 规则判断（无网络时的兜底 & 测试用）：
 * 决策文本里写了"需 N 万"时，与新预算比较；否则保守地标为 weakened。
 */
export const ruleAssessor: Assessor = async ({ to, decisions, state }) => {
  const budget = parseWan(to);
  return decisions.map((d): DecisionAssessment => {
    const need = parseWan(d.statement);
    if (budget !== null && need !== null) {
      if (need <= budget) return { decisionId: d.id, verdict: "still_valid", reason: `需 ${need} 万，在 ${budget} 万以内` };
      const alt = Object.values(state.decisions).find((x) => x.workCardId === d.workCardId && x.suggestion)?.suggestion;
      return { decisionId: d.id, verdict: "invalidated", reason: `需 ${need} 万，超出新预算 ${budget} 万`, suggestion: d.suggestion ?? alt };
    }
    return { decisionId: d.id, verdict: "weakened", reason: "依赖的前提已变化，需重新确认" };
  });
};

function parseWan(s: string): number | null {
  const m = s.match(/(\d+(?:\.\d+)?)\s*万/);
  return m ? Number(m[1]) : null;
}
