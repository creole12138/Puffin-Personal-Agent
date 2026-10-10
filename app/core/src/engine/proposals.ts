/**
 * 变更提议：前提变化的统一入口（harness 层，确定性规则）。
 *
 * 1. preview：用判断器（LLM 或规则）判断受影响的决策，再用 computeImpacts 纯计算出影响清单——不改状态；
 * 2. gate：按来源、把握和影响分档（auto / ask），规则写在代码里，不依赖提示词；
 * 3. 碰到已对外发出的东西：调用起草器预先写好补救消息，和提议一起呈现；
 * 4. auto 立即 apply；ask 等用户确认后 apply（复用预演时的判断，不再调用模型）。
 */
import type { AgentState, DecisionAssessment, ID, ImpactItem, Proposal, ProposalSource } from "../types.ts";
import { emit } from "./events.ts";
import { newId, now } from "./ids.ts";
import { applyPremiseChange, computeImpacts, directlyAffectedDecisions, type Assessor, type Recomputer } from "./ripple.ts";

/** 起草补救消息（通常由 LLM 实现）；不可用时用模板 */
export type Drafter = (input: {
  state: AgentState; actionId: ID; premiseLabel: string; from: string; to: string;
}) => Promise<{ to: string; title: string; body: string }>;

export const templateDrafter: Drafter = async ({ state, actionId, premiseLabel, from, to }) => {
  const a = state.actions[actionId];
  return { to: "相关的人", title: `更正：${premiseLabel}`, body: `之前在「${a?.label ?? "之前的消息"}」里提到${premiseLabel}是 ${from}，现在变成了 ${to}，以这个为准。` };
};

export interface ProposeInput {
  premiseId: ID;
  to: string;
  source: ProposalSource;
  evidenceId: ID;
  reason: string;
  confidence: Proposal["confidence"];
  assess: Assessor;
  drafter?: Drafter;
  recompute?: Recomputer;
}

export async function preview(state: AgentState, premiseId: ID, from: string, to: string, assess: Assessor) {
  const decisions = directlyAffectedDecisions(state, premiseId);
  const assessments: DecisionAssessment[] = decisions.length ? await assess({ state, premiseId, from, to, decisions }) : [];
  return { assessments, impacts: computeImpacts(state, premiseId, assessments) };
}

export function gate(state: AgentState, source: ProposalSource, confidence: Proposal["confidence"], impacts: ImpactItem[]) {
  const confirmedHit = impacts.some((i) => i.kind === "decision" && i.handling === "needs_user" && state.decisions[i.id]?.provenance.confirmedBy === "user");
  const externalHit = impacts.some((i) => i.handling === "compensate");
  if (source === "user") return { mode: "auto" as const };
  if (confidence === "low") return { mode: "skip" as const };
  if (confirmedHit) return { mode: "ask" as const, gateReason: "会推翻你确认过的决定" };
  if (externalHit) return { mode: "ask" as const, gateReason: "会碰到已经对外发出的东西" };
  if (confidence !== "high") return { mode: "ask" as const, gateReason: "我把握不够高" };
  return { mode: "auto" as const };
}

/** 创建提议：预演 → 分档 → （需要时）起草补救 → auto 立即生效 */
export async function propose(state: AgentState, input: ProposeInput): Promise<Proposal | null> {
  const p = state.premises[input.premiseId];
  if (!p) throw new Error(`前提不存在：${input.premiseId}`);
  if (p.value === input.to) return null;
  // 同一前提已有待确认的提议：新的取代旧的
  for (const old of Object.values(state.proposals ?? {})) {
    if (old.status === "pending" && old.change.premiseId === p.id) { old.status = "corrected"; old.decidedAt = now(); }
  }
  const { assessments, impacts } = await preview(state, p.id, p.value, input.to, input.assess);
  const g = gate(state, input.source, input.confidence, impacts);
  if (g.mode === "skip") return null;

  const drafts: Proposal["drafts"] = [];
  for (const i of impacts.filter((x) => x.handling === "compensate")) {
    const d = await (input.drafter ?? templateDrafter)({ state, actionId: i.id, premiseLabel: p.label, from: p.value, to: input.to }).catch(() =>
      templateDrafter({ state, actionId: i.id, premiseLabel: p.label, from: p.value, to: input.to }));
    drafts.push({ forActionId: i.id, ...d });
  }
  const cardId = impacts[0]?.workCardId ?? Object.values(state.workCards).find((c) => c.premiseIds.includes(p.id))?.id;
  const prop: Proposal = {
    id: newId("prop"), workCardId: cardId, source: input.source, evidenceId: input.evidenceId, reason: input.reason,
    confidence: input.confidence, change: { premiseId: p.id, label: p.label, from: p.value, to: input.to },
    mode: g.mode, gateReason: "gateReason" in g ? g.gateReason : undefined,
    status: "pending", assessments, drafts, createdAt: now(),
  };
  (state.proposals ??= {})[prop.id] = prop;
  if (prop.mode === "auto") await apply(state, prop, input.recompute);
  else emit(state, { type: "plan_proposed", actor: "agent", workCardId: cardId,
    summary: `我判断${p.label}可能从 ${p.value} 变成 ${input.to}，因为${prop.gateReason}，先问你`, payload: { proposalId: prop.id } });
  return prop;
}

async function apply(state: AgentState, prop: Proposal, recompute?: Recomputer) {
  const actor = prop.source === "user" ? "user" : prop.source === "material" ? "watcher" : "agent";
  const pc = await applyPremiseChange(state, { premiseId: prop.change.premiseId, to: prop.change.to, evidenceId: prop.evidenceId, actor, assess: async () => prop.assessments, recompute });
  prop.premiseChangeId = pc.id;
  prop.status = "applied";
  const p = state.premises[prop.change.premiseId]!;
  if (prop.source === "user") { p.confirmed = true; p.inferred = undefined; }
  else if (prop.mode === "auto") p.inferred = { proposalId: prop.id, reason: prop.reason };
  // 把预先起草的补救消息挂到影响传播生成的补救动作上
  for (const d of prop.drafts) {
    const act = Object.values(state.actions).find((a) => a.compensationFor === d.forActionId && !a.output);
    if (act) { act.output = { kind: "message", title: d.title, body: d.body, to: d.to }; act.label = `给 ${d.to} 的更正：${d.title}`; d.actionId = act.id; }
  }
  // 时间线说了「起草了一份更正」，就必须真有正文：预先起草没覆盖到的，用模板补上
  for (const act of Object.values(state.actions)) {
    if (!act.compensationFor || act.output || act.status !== "planned") continue;
    const t = await templateDrafter({ state, actionId: act.compensationFor, premiseLabel: prop.change.label, from: prop.change.from, to: prop.change.to });
    act.output = { kind: "message", title: t.title, body: t.body, to: t.to };
  }
  if (prop.source !== "user" && prop.mode === "auto") {
    emit(state, { type: "premise_changed", actor: "agent", workCardId: prop.workCardId, visibleInTimeline: true,
      summary: `我推断${prop.change.label}也变成了 ${prop.change.to}（${prop.reason}），已先按这个更新，可以随时纠正`, payload: { proposalId: prop.id, claim: { kind: "premise_value", premiseId: prop.change.premiseId, value: prop.change.to } } });
  }
}

/** 用户点确认：pending → 生效；applied（有推断标记或待发消息）→ 标记确认 */
export async function confirmProposal(state: AgentState, id: ID, opts: { recompute?: Recomputer } = {}) {
  const prop = state.proposals?.[id];
  if (!prop) throw new Error("这条提议不存在");
  if (prop.status === "pending") await apply(state, prop, opts.recompute);
  else if (prop.status !== "applied") throw new Error("这条提议已经处理过了");
  const p = state.premises[prop.change.premiseId];
  if (p) { p.confirmed = true; p.inferred = undefined; }
  for (const d of prop.drafts) if (d.actionId && state.actions[d.actionId]) state.actions[d.actionId]!.approvedAt = now();
  prop.status = "confirmed"; prop.decidedAt = now();
  emit(state, { type: "plan_confirmed", actor: "user", workCardId: prop.workCardId,
    summary: `你确认了：${prop.change.label}改为 ${prop.change.to}${prop.drafts.length ? `，更正消息待你发送` : ""}`, payload: { proposalId: id } });
  return prop;
}

/** 用户用自然语言纠正了同一前提：之前的提议作废，推断标记清除 */
export function markCorrected(state: AgentState, premiseId: ID) {
  for (const prop of Object.values(state.proposals ?? {})) {
    if (prop.change.premiseId === premiseId && (prop.status === "pending" || prop.status === "applied")) { prop.status = "corrected"; prop.decidedAt = now(); }
  }
  const p = state.premises[premiseId];
  if (p) p.inferred = undefined;
}
