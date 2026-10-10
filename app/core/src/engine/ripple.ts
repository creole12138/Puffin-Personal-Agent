/**
 * 涟漪：前提变化 → 受影响的决策 / 动作 / 提醒。
 *
 * 分工（见 types.ts 头注释）：
 * - "这条决策在新前提下还成立吗" 由 Assessor 判断（LLM 或规则，可替换）；
 * - 影响沿依赖图传播、按撤回成本决定处理方式，全部确定性完成，不靠 LLM。
 *
 * 处理方式：
 *   needs_user   决策被削弱/推翻 → 必须用户决定
 *   paused       依赖该决策、尚未执行的动作 / 下游决策 → 暂停等决定
 *   auto_updated 结果直接由前提计算的内部可逆动作、提醒 → 自动重算（可撤销）
 *   compensate   已执行且对外生效的动作 → 无法撤回，起草补救动作
 *   unaffected   依赖该前提但判断仍成立
 */
import type {
  Action, AgentState, Decision, DecisionAssessment, ID, ImpactItem, PremiseChange,
} from "../types.ts";
import { emit } from "./events.ts";
import { newId, now } from "./ids.ts";

export interface AssessInput {
  state: AgentState;
  premiseId: ID;
  from: string;
  to: string;
  decisions: Decision[];
}
export type Assessor = (input: AssessInput) => Promise<DecisionAssessment[]>;

/** 找出直接引用该前提的决策（跨工作卡、跨项目） */
export function directlyAffectedDecisions(state: AgentState, premiseId: ID): Decision[] {
  return Object.values(state.decisions).filter(
    (d) => d.premiseIds.includes(premiseId) && (d.status === "valid" || d.status === "weakened"),
  );
}

/** 从一组决策出发，沿 dependentDecisionIds 做 BFS，返回下游决策（不含起点） */
export function downstreamDecisions(state: AgentState, roots: ID[]): Decision[] {
  const seen = new Set(roots);
  const out: Decision[] = [];
  const queue = [...roots];
  while (queue.length) {
    const d = state.decisions[queue.shift()!];
    for (const dep of d?.dependentDecisionIds ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const dd = state.decisions[dep];
      if (dd) { out.push(dd); queue.push(dep); }
    }
  }
  return out;
}

function actionHandling(a: Action): ImpactItem["handling"] {
  if (a.status === "cancelled") return "unaffected";
  if (a.status === "done") return a.external || !a.reversible ? "compensate" : "auto_updated";
  return "paused";
}

/** 纯计算：给定判断，算出影响清单（不修改状态），便于预览与测试 */
export function computeImpacts(
  state: AgentState, premiseId: ID, assessments: DecisionAssessment[],
): ImpactItem[] {
  const impacts: ImpactItem[] = [];
  const seen = new Set<string>();
  const push = (i: ImpactItem) => {
    const k = `${i.kind}:${i.id}`;
    if (!seen.has(k)) { seen.add(k); impacts.push(i); }
  };

  const broken = assessments.filter((a) => a.verdict !== "still_valid").map((a) => a.decisionId);
  for (const a of assessments) {
    const d = state.decisions[a.decisionId];
    if (d) push({ kind: "decision", id: d.id, workCardId: d.workCardId, handling: a.verdict === "still_valid" ? "unaffected" : "needs_user" });
  }
  const downstream = downstreamDecisions(state, broken);
  for (const d of downstream) push({ kind: "decision", id: d.id, workCardId: d.workCardId, handling: "paused" });

  const brokenAll = new Set([...broken, ...downstream.map((d) => d.id)]);
  for (const a of Object.values(state.actions)) {
    if (a.premiseIds?.includes(premiseId) && !a.external && a.reversible && a.status !== "cancelled") {
      push({ kind: "action", id: a.id, workCardId: a.workCardId, handling: "auto_updated" });
    } else if (a.dependsOnDecisionIds.some((id) => brokenAll.has(id))) {
      const h = actionHandling(a);
      if (h !== "unaffected") push({ kind: "action", id: a.id, workCardId: a.workCardId, handling: h });
    }
  }
  for (const card of Object.values(state.workCards)) {
    for (const r of card.reminders) {
      if (r.premiseIds.includes(premiseId)) push({ kind: "reminder", id: r.id, workCardId: card.id, handling: "auto_updated" });
    }
  }
  return impacts;
}

/** 按新前提真正重算一份产出（通常由 LLM 实现），返回完整的新正文 */
export type Recomputer = (input: { state: AgentState; actionId: ID; premiseLabel: string; from: string; to: string }) => Promise<{ body: string }>;

export interface ApplyChangeInput {
  premiseId: ID;
  to: string;
  evidenceId: ID;
  actor?: "user" | "agent" | "watcher";
  assess: Assessor;
  recompute?: Recomputer;
}

const squash = (t: string) => t.replace(/\s+/g, "");
/** 重算并校验：新正文必须和旧的不同、且写进了新值；不过关重试一次。成功才替换产出 */
async function recomputeOutput(state: AgentState, a: Action, label: string, from: string, to: string, recompute: Recomputer, premiseChangeId: ID): Promise<boolean> {
  const old = a.output!;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await recompute({ state, actionId: a.id, premiseLabel: label, from, to });
      const body = r.body?.trim();
      if (!body || body === old.body.trim() || !squash(body).includes(squash(to))) continue;
      (a.outputHistory ??= []).push({ body: old.body, reason: `${label}：${from} → ${to}`, at: now(), premiseChangeId });
      a.output = { ...old, body };
      return true;
    } catch (e) { console.warn(`重算「${a.label}」失败：${(e as Error).message}`); }
  }
  return false;
}

/** 应用前提变化：更新前提 → 判断 → 传播 → 写状态与事件 */
export async function applyPremiseChange(state: AgentState, input: ApplyChangeInput): Promise<PremiseChange> {
  const premise = state.premises[input.premiseId];
  if (!premise) throw new Error(`前提不存在：${input.premiseId}`);
  const from = premise.value;
  const actor = input.actor ?? "watcher";

  premise.history.push({ value: from, evidenceIds: [...premise.evidenceIds], at: now() });
  premise.value = input.to;
  premise.evidenceIds = [input.evidenceId];
  premise.confirmed = false; // 新值来自证据，用户确认前标为未确认

  const candidates = directlyAffectedDecisions(state, premise.id);
  const assessments = candidates.length
    ? await input.assess({ state, premiseId: premise.id, from, to: input.to, decisions: candidates })
    : [];
  const impacts = computeImpacts(state, premise.id, assessments);

  const change: PremiseChange = {
    id: newId("pc"), premiseId: premise.id, from, to: input.to,
    evidenceId: input.evidenceId, impacts, assessments, detectedAt: now(),
  };
  state.premiseChanges[change.id] = change;

  emit(state, {
    type: "premise_changed", actor, projectId: premise.projectId,
    summary: `${premise.label}从 ${from} 变成了 ${input.to}`,
    payload: { premiseChangeId: change.id, premiseId: premise.id, from, to: input.to, evidenceId: input.evidenceId },
  });

  // 写回各对象状态
  for (const a of assessments) {
    const d = state.decisions[a.decisionId];
    if (!d || a.verdict === "still_valid") continue;
    d.status = a.verdict;
    if (a.suggestion) d.suggestion = a.suggestion;
    emit(state, {
      type: "decision_status_changed", actor: "agent", workCardId: d.workCardId,
      summary: a.verdict === "invalidated" ? `「${d.statement}」不再成立，需要你决定：${a.reason}` : `「${d.statement}」可能需要调整：${a.reason}`,
      payload: { decisionId: d.id, status: d.status, premiseChangeId: change.id },
    });
  }
  for (const i of impacts) {
    if (i.kind === "decision" && i.handling === "paused") {
      const d = state.decisions[i.id]!;
      d.status = "weakened";
      emit(state, { type: "decision_status_changed", actor: "agent", workCardId: d.workCardId, visibleInTimeline: false,
        summary: `「${d.statement}」先放一放，等你对上游的决定`, payload: { decisionId: d.id, status: d.status, premiseChangeId: change.id } });
    }
    if (i.kind === "action") {
      const a = state.actions[i.id]!;
      if (i.handling === "paused" && a.status !== "paused") {
        a.status = "paused";
        emit(state, { type: "action_status_changed", actor: "agent", workCardId: a.workCardId,
          summary: `先暂停了「${a.label}」，等你决定后再继续`, payload: { actionId: a.id, status: "paused", premiseChangeId: change.id } });
      } else if (i.handling === "compensate") {
        const comp: Action = {
          id: newId("act"), workCardId: a.workCardId, label: `更正说明：${premise.label}已变为 ${input.to}（针对「${a.label}」）`,
          status: "planned", external: true, reversible: false, dependsOnDecisionIds: [], compensationFor: a.id,
        };
        state.actions[comp.id] = comp;
        state.workCards[a.workCardId]?.actionIds.push(comp.id);
        emit(state, { type: "action_status_changed", actor: "agent", workCardId: a.workCardId,
          summary: `「${a.label}」你已经发出去了；我起草了一份更正，等你确认`, payload: { actionId: comp.id, compensationFor: a.id, premiseChangeId: change.id, claim: { kind: "has_output", actionId: comp.id } } });
      } else if (i.handling === "auto_updated") {
        if (!a.output) {
          emit(state, { type: "action_status_changed", actor: "agent", workCardId: a.workCardId,
            summary: `「${a.label}」之后按新的${premise.label}（${input.to}）来做`, payload: { actionId: a.id, autoUpdated: true, premiseChangeId: change.id } });
        } else if (input.recompute && await recomputeOutput(state, a, premise.label, from, input.to, input.recompute, change.id)) {
          emit(state, { type: "action_status_changed", actor: "agent", workCardId: a.workCardId,
            summary: `「${a.label}」已按新的${premise.label}（${input.to}）重新计算`, payload: { actionId: a.id, autoUpdated: true, premiseChangeId: change.id, claim: { kind: "output_recomputed", actionId: a.id, premiseChangeId: change.id, mustInclude: input.to } } });
        } else {
          // 没能真正重算：不假装更新，先暂停，产出保持原样并标明依据已过时
          a.status = "paused";
          emit(state, { type: "action_status_changed", actor: "agent", workCardId: a.workCardId,
            summary: `「${a.label}」还是按 ${from} 算的，我没能自动重算，先暂停；可以在对话里让我重算`, payload: { actionId: a.id, status: "paused", recomputeFailed: true, premiseChangeId: change.id } });
        }
      }
    }
  }
  // 提醒：时间或理由里写着旧值的，直接换成新值；否则标出来请用户重设，不假装已调整
  for (const i of impacts) {
    if (i.kind !== "reminder" || i.handling !== "auto_updated") continue;
    const r = state.workCards[i.workCardId]?.reminders.find((x) => x.id === i.id);
    if (!r) continue;
    const before = `${r.at}｜${r.reason}`;
    if (from && (r.at.includes(from) || r.reason.includes(from))) {
      r.at = r.at.split(from).join(input.to); r.reason = r.reason.split(from).join(input.to); r.stale = undefined;
      emit(state, { type: "action_status_changed", actor: "agent", workCardId: i.workCardId,
        summary: `提醒已按新的${premise.label}（${input.to}）调整：${r.reason}`, payload: { reminderId: r.id, premiseChangeId: change.id, claim: { kind: "reminder_changed", reminderId: r.id, before } } });
    } else {
      r.stale = `${premise.label}从 ${from} 变成了 ${input.to}`;
      emit(state, { type: "action_status_changed", actor: "agent", workCardId: i.workCardId,
        summary: `提醒「${r.reason}」依赖的${premise.label}变了，时间可能要跟着调整，我还没改`, payload: { reminderId: r.id, premiseChangeId: change.id } });
    }
  }
  for (const card of Object.values(state.workCards)) {
    if (impacts.some((i) => i.workCardId === card.id)) card.updatedAt = now();
  }
  return change;
}

export type Resolution = { kind: "adopt_suggestion" } | { kind: "keep"; note: string } | { kind: "custom"; statement: string };

/** 用户对"需要你决定"的决策做出选择；下游暂停项随之恢复或取消 */
export function resolveDecision(state: AgentState, decisionId: ID, r: Resolution): Decision {
  const old = state.decisions[decisionId];
  if (!old) throw new Error(`决策不存在：${decisionId}`);
  const at = now();
  let current: Decision;

  if (r.kind === "adopt_suggestion" || r.kind === "custom") {
    if (r.kind === "adopt_suggestion" && !old.suggestion) throw new Error("该决策没有替代建议");
    if (r.kind === "custom" && !r.statement.trim()) throw new Error("写一下你想怎么做");
    current = {
      id: newId("dec"), workCardId: old.workCardId, statement: r.kind === "custom" ? r.statement.trim() : old.suggestion!.statement,
      premiseIds: [...old.premiseIds], dependentDecisionIds: [...old.dependentDecisionIds], derivedActionIds: [],
      status: "valid", reversalCost: old.reversalCost, confidence: "medium",
      provenance: { confirmedBy: "user", evidenceIds: [...old.provenance.evidenceIds], at },
    };
    state.decisions[current.id] = current;
    state.workCards[old.workCardId]?.decisionIds.push(current.id);
    old.status = "superseded";
    old.supersededBy = current.id;
    for (const aid of old.derivedActionIds) {
      const a = state.actions[aid];
      if (a && a.status === "paused") {
        a.status = "cancelled";
        emit(state, { type: "action_status_changed", actor: "agent", workCardId: a.workCardId,
          summary: `「${a.label}」不再需要，已取消`, payload: { actionId: a.id, status: "cancelled", claim: { kind: "action_status", actionId: a.id, status: "cancelled" } } });
      }
    }
  } else {
    old.status = "valid";
    old.provenance = { ...old.provenance, confirmedBy: "user", at };
    current = old;
    for (const aid of old.derivedActionIds) {
      const a = state.actions[aid];
      if (a && a.status === "paused") a.status = "planned";
    }
  }
  for (const d of downstreamDecisions(state, [old.id])) if (d.status === "weakened") d.status = "valid";

  emit(state, {
    type: "decision_made", actor: "user", workCardId: old.workCardId,
    summary: r.kind === "keep" ? `你决定仍然「${old.statement}」：${r.note}` : `你决定改为「${current.statement}」`,
    payload: { decisionId: current.id, supersedes: r.kind === "keep" ? undefined : old.id },
  });
  for (const pc of Object.values(state.premiseChanges)) {
    if (!pc.resolvedAt && pc.impacts.some((i) => i.id === old.id)) {
      pc.resolvedAt = at;
      // 用户已基于新值做出决定，视为确认了这个新前提
      const p = state.premises[pc.premiseId];
      if (p && p.value === pc.to) p.confirmed = true;
    }
  }
  return current;
}
