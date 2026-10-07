/**
 * 工作卡快照与回退（"回到这里"）。
 * 回退只恢复工作状态（决策、下一步、未执行的动作），不撤回已经发生的事；
 * 回退后若某条决策依赖的前提已经变了，立刻重新判断，并生成待处理的前提变化。
 */
import type { AgentState, DecisionStatus, ActionStatus, ID, PremiseChange } from "../types.ts";
import { emit } from "./events.ts";
import { newId, now } from "./ids.ts";
import { computeImpacts, type Assessor } from "./ripple.ts";

export interface CardSnapshot {
  title: string; stage: string; status?: string; nextStep?: string; waitingOn?: string;
  decisions: { id: ID; statement: string; status: DecisionStatus }[];
  premises: { id: ID; label: string; value: string }[];
  actions: { id: ID; label: string; status: ActionStatus }[];
}

export function snapshotCard(state: AgentState, cardId: ID): CardSnapshot | undefined {
  const c = state.workCards[cardId];
  if (!c) return undefined;
  return {
    title: c.title, stage: c.stage, status: c.status, nextStep: c.nextStep, waitingOn: c.waitingOn,
    decisions: c.decisionIds.map((id) => state.decisions[id]).filter(Boolean).map((d) => ({ id: d!.id, statement: d!.statement, status: d!.status })),
    premises: c.premiseIds.map((id) => state.premises[id]).filter(Boolean).map((p) => ({ id: p!.id, label: p!.label, value: p!.value })),
    actions: c.actionIds.map((id) => state.actions[id]).filter(Boolean).map((a) => ({ id: a!.id, label: a!.label, status: a!.status })),
  };
}

export interface RollbackResult { cannotUndo: string[]; stillChanged: string[]; change?: PremiseChange }

export async function rollbackTo(state: AgentState, eventId: ID, assess: Assessor): Promise<RollbackResult> {
  const ev = state.events.find((e) => e.id === eventId);
  const snap = ev?.payload.snapshot as CardSnapshot | undefined;
  const cardId = ev?.workCardId;
  if (!ev || !snap || !cardId || !state.workCards[cardId]) throw new Error("这个时间点没有可以回到的工作卡状态");
  const c = state.workCards[cardId]!;
  const snapDec = new Set(snap.decisions.map((d) => d.id));
  const snapAct = new Map(snap.actions.map((a) => [a.id, a.status]));

  // 已经发生、无法撤回的：快照之后执行的外部动作
  const cannotUndo = c.actionIds.map((id) => state.actions[id]!).filter((a) => a.external && a.status === "done" && snapAct.get(a.id) !== "done").map((a) => a.label);
  for (const a of c.actionIds.map((id) => state.actions[id]!)) {
    if (a.external && a.status === "done" && snapAct.get(a.id) === "done") cannotUndo.push(a.label);
  }

  // 恢复决策
  for (const d of snap.decisions) {
    const cur = state.decisions[d.id]; if (!cur) continue;
    cur.status = d.status; if (d.status === "valid") cur.supersededBy = undefined;
  }
  for (const id of c.decisionIds) if (!snapDec.has(id)) state.decisions[id]!.status = "superseded";
  // 恢复未发生的动作
  for (const a of c.actionIds.map((id) => state.actions[id]!)) {
    const was = snapAct.get(a.id);
    if (a.status === "done") continue;
    a.status = was ?? "cancelled";
  }
  c.status = snap.status; c.nextStep = snap.nextStep; c.waitingOn = snap.waitingOn; c.updatedAt = now();

  // 前提从快照到现在变了的，重新判断
  const stillChanged: string[] = [];
  let change: PremiseChange | undefined;
  for (const sp of snap.premises) {
    const p = state.premises[sp.id];
    if (!p || p.value === sp.value) continue;
    stillChanged.push(`${p.label}现在是 ${p.value}（当时是 ${sp.value}）`);
    const decisions = c.decisionIds.map((id) => state.decisions[id]!).filter((d) => d.status === "valid" && d.premiseIds.includes(p.id));
    if (!decisions.length) continue;
    const assessments = await assess({ state, premiseId: p.id, from: sp.value, to: p.value, decisions });
    for (const a of assessments) {
      const d = state.decisions[a.decisionId]!;
      if (a.verdict !== "still_valid") { d.status = a.verdict; if (a.suggestion) d.suggestion = a.suggestion; }
    }
    change = { id: newId("pc"), premiseId: p.id, from: sp.value, to: p.value, evidenceId: p.evidenceIds[0] ?? "", assessments,
      impacts: computeImpacts(state, p.id, assessments).filter((i) => i.workCardId === cardId), detectedAt: now() };
    state.premiseChanges[change.id] = change;
  }

  emit(state, { type: "rolled_back", actor: "user", workCardId: cardId,
    summary: `你让「${c.title}」回到了「${ev.summary}」时的状态${stillChanged.length ? `；${stillChanged.join("，")}，已重新检查` : ""}`,
    payload: { toEventId: eventId, cannotUndo } });
  return { cannotUndo, stillChanged, change };
}
