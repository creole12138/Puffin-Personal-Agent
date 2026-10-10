/**
 * 新事实：卡上原本没有的前提出现了（用户说的新约束、新材料里冒出的新情况）。
 *
 * 和"已有前提变了"走同一条路：先把它登记成一个取值为 NEW_PREMISE 的前提、挂到受影响的决策上，
 * 再用 propose 把取值从 NEW_PREMISE 改成真实值 —— 于是自动得到预演影响、按把握和影响分档（直接生效 / 先问）、
 * 决策重新判断、动作暂停或起草补救、事件留痕，全部复用现有逻辑。
 * 没有生成提议（把握太低）时，把临时登记的前提撤掉，不留痕迹。
 */
import { NEW_PREMISE, newId } from "./ids.ts";
import { propose, type Drafter } from "./proposals.ts";
import type { Assessor, Recomputer } from "./ripple.ts";
import type { AgentState, ID, Proposal, ProposalSource } from "../types.ts";

export { NEW_PREMISE };

export interface IntroduceInput {
  cardId: ID;
  label: string;
  value: string;
  evidenceId: ID;
  /** 这个新事实可能影响的决策（只接受这张卡上、仍有效的） */
  affectsDecisionIds: ID[];
  source: ProposalSource;
  confidence: Proposal["confidence"];
  reason: string;
  assess: Assessor;
  drafter?: Drafter;
  recompute?: Recomputer;
}

export async function introducePremise(state: AgentState, i: IntroduceInput): Promise<{ premiseId?: ID; proposal: Proposal | null }> {
  const card = state.workCards[i.cardId];
  if (!card) throw new Error("工作卡不存在");
  const decisions = [...new Set(i.affectsDecisionIds)].filter((d) => {
    const x = state.decisions[d];
    return x && x.workCardId === i.cardId && (x.status === "valid" || x.status === "weakened");
  });
  const id = newId("pr");
  state.premises[id] = { id, label: i.label, value: NEW_PREMISE, confirmed: false, evidenceIds: [i.evidenceId], history: [], projectId: card.projectId };
  card.premiseIds.push(id);
  if (card.projectId) state.projects[card.projectId]?.premiseIds.push(id);
  for (const d of decisions) state.decisions[d]!.premiseIds.push(id);

  const proposal = await propose(state, { premiseId: id, to: i.value, source: i.source, evidenceId: i.evidenceId, reason: i.reason,
    confidence: i.confidence, assess: i.assess, drafter: i.drafter, recompute: i.recompute });

  if (!proposal) {
    delete state.premises[id];
    card.premiseIds = card.premiseIds.filter((x) => x !== id);
    if (card.projectId) { const pj = state.projects[card.projectId]; if (pj) pj.premiseIds = pj.premiseIds.filter((x) => x !== id); }
    for (const d of decisions) state.decisions[d]!.premiseIds = state.decisions[d]!.premiseIds.filter((x) => x !== id);
    return { proposal: null };
  }
  // 占位值不是一段真实历史：生效后从历史里去掉
  const p = state.premises[id]!;
  p.history = p.history.filter((h) => h.value !== NEW_PREMISE);
  return { premiseId: id, proposal };
}
