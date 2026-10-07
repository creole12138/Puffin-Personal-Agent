/**
 * 云朵小管家在一张工作卡上能用的工具。
 * 工具只改"工作状态"：读材料、起草文档、起草消息（对外发送一律只起草）、设提醒、更新前提（触发影响传播）。
 */
import { Type } from "typebox";
import { emit } from "../engine/events.ts";
import { newId, now } from "../engine/ids.ts";
import { type Assessor } from "../engine/ripple.ts";
import { markCorrected, propose, type Drafter } from "../engine/proposals.ts";
import type { AgentState, ID, Proposal } from "../types.ts";
import type { WorkTool } from "./workAgent.ts";

export interface ToolContext {
  state: AgentState;
  cardId: ID;
  assess: Assessor;
  /** 本次可读的材料；为空表示卡片与项目相关的全部材料 */
  evidenceIds?: ID[];
  drafter?: Drafter;
  /** 本轮产生的变更提议（对话把它们挂到回复消息上） */
  onProposal?: (p: Proposal) => void;
}

export function readableEvidence(state: AgentState, cardId: ID): ID[] {
  const c = state.workCards[cardId];
  if (!c) return [];
  const ids = new Set<ID>(c.originEvidenceIds);
  for (const p of c.premiseIds) for (const e of state.premises[p]?.evidenceIds ?? []) ids.add(e);
  for (const d of c.decisionIds) for (const e of state.decisions[d]?.provenance.evidenceIds ?? []) ids.add(e);
  // 同一项目共享的材料
  if (c.projectId) for (const other of Object.values(state.workCards)) if (other.projectId === c.projectId) for (const e of other.originEvidenceIds) ids.add(e);
  return [...ids].filter((id) => state.evidence[id]);
}

export function cardTools(ctx: ToolContext): WorkTool[] {
  const { state, cardId } = ctx;
  const card = () => state.workCards[cardId]!;
  const allowed = () => new Set(ctx.evidenceIds ?? readableEvidence(state, cardId));
  const addAction = (a: Omit<import("../types.ts").Action, "id" | "workCardId">) => {
    const id = newId("act");
    state.actions[id] = { id, workCardId: cardId, ...a };
    card().actionIds.push(id);
    card().updatedAt = now();
    return state.actions[id]!;
  };

  return [
    {
      name: "read_material", label: "读取材料", description: "按 id 读取这件事相关的材料全文",
      parameters: Type.Object({ evidenceId: Type.String() }),
      describe: (a, o) => (o === "done" && state.evidence[a?.evidenceId]?.ref !== "chat" ? `读了《${state.evidence[a?.evidenceId]?.title ?? "材料"}》` : ""),
      execute: async (_id, p: any) => {
        if (!allowed().has(p.evidenceId)) throw new Error(`材料 ${p.evidenceId} 不在这件事的范围内。可读：${[...allowed()].join(", ")}`);
        const e = state.evidence[p.evidenceId]!;
        return { content: [{ type: "text", text: `# ${e.title}\n${e.excerpt}` }], details: {} };
      },
    },
    {
      name: "write_document", label: "起草文档", description: "起草一份内部文档（对比表、提纲、会议材料、清单等），保存到工作卡上供用户查看。不会发给任何人。",
      parameters: Type.Object({ title: Type.String(), body: Type.String({ description: "Markdown 正文" }) }),
      describe: (a, o) => (o === "done" ? `起草了《${a?.title}》` : `没能起草《${a?.title}》`),
      execute: async (_id, p: any) => {
        addAction({ label: `起草《${p.title}》`, status: "done", external: false, reversible: true, dependsOnDecisionIds: [],
          output: { kind: "document", title: p.title, body: p.body }, doneAt: now() });
        return { content: [{ type: "text", text: `已保存《${p.title}》到工作卡` }], details: {} };
      },
    },
    {
      name: "send_message", label: "发送消息", description: "给某人发消息或邮件。注意：本产品不会替用户发送，调用后会自动变成草稿交给用户确认。",
      parameters: Type.Object({ to: Type.String(), subject: Type.String(), body: Type.String() }),
      requires: { permission: "send", source: "email" },
      describe: (a) => `起草了给 ${a?.to} 的消息，等你看过后由你发送`,
      onDrafted: (p: any) => addAction({ label: `给 ${p.to} 的消息：${p.subject}`, status: "planned", external: true, reversible: false,
        dependsOnDecisionIds: card().decisionIds.filter((d) => state.decisions[d]?.status === "valid"),
        output: { kind: "message", title: p.subject, body: p.body, to: p.to } }),
      execute: async () => { throw new Error("不应执行"); },
    },
    {
      name: "add_premise", label: "记下新前提", description: "用户提到一个新的、会影响这件事的事实（如面试时间、新的约束），而卡上还没有对应的前提时调用。只在值已经明确时使用。",
      parameters: Type.Object({
        label: Type.String({ description: "如「面试时间」" }), value: Type.String({ description: "简短具体的值，≤12 字" }),
        userQuote: Type.String(), affectsDecisionIds: Type.Array(Type.String(), { description: "依赖它的决策 id，可为空" }),
      }),
      describe: (a, o) => (o === "done" ? `记下了新前提：${a?.label} = ${a?.value}` : ""),
      execute: async (_id, p: any) => {
        const bad = badValue(p.value); if (bad) throw new Error(bad);
        const evId = newId("evd");
        state.evidence[evId] = { id: evId, source: "user_input", ref: "chat", title: "你在对话里说的", excerpt: p.userQuote, observedAt: now() };
        const id = newId("pr");
        state.premises[id] = { id, label: p.label, value: p.value, confirmed: true, evidenceIds: [evId], history: [], projectId: card().projectId };
        card().premiseIds.push(id);
        if (card().projectId) state.projects[card().projectId!]?.premiseIds.push(id);
        for (const d of p.affectsDecisionIds ?? []) if (state.decisions[d]?.workCardId === cardId) state.decisions[d]!.premiseIds.push(id);
        card().updatedAt = now();
        return { content: [{ type: "text", text: `已记下 ${id}` }], details: {} };
      },
    },
    {
      name: "set_reminder", label: "设提醒", description: "在某个时间提醒用户。reason 要说清为什么是这个时间。",
      parameters: Type.Object({ at: Type.String({ description: "ISO 时间或“周四 9:00”这类描述" }), reason: Type.String(),
        kind: Type.Union([Type.Literal("deadline"), Type.Literal("waiting_on_others"), Type.Literal("pending_decision"), Type.Literal("open_loop")]) }),
      describe: (a) => `设了提醒：${a?.at}，${a?.reason}`,
      execute: async (_id, p: any) => {
        card().reminders.push({ id: newId("r"), at: p.at, reason: p.reason, kind: p.kind, premiseIds: [] });
        return { content: [{ type: "text", text: "提醒已设置" }], details: {} };
      },
    },
    {
      name: "update_premise", label: "更新前提", description: "用户明确说出某个前提的新值时调用（如“面试推迟到周六了”里的面试时间）。会立即生效并自动找出受影响的决策和动作。你自己推断出来的连带变化不要用这个，用 propose_change。",
      parameters: Type.Object({ premiseId: Type.String(), newValue: Type.String({ description: "简短具体的新值，≤12 字，如「周六」「10 月 11 日 18:00」" }), userQuote: Type.String({ description: "用户原话（可合并上下文，如“面试推迟到周六；作业也推迟了”）" }) }),
      describe: () => "",
      execute: async (_id, p: any) => {
        const pr = state.premises[p.premiseId];
        if (!pr) throw new Error(`前提不存在。可用：${card().premiseIds.map((id) => `${id}=${state.premises[id]?.label}`).join("；")}。如果是新出现的前提，用 add_premise。`);
        const bad = badValue(p.newValue);
        if (bad) throw new Error(bad);
        const evId = newId("evd");
        state.evidence[evId] = { id: evId, source: "user_input", ref: "chat", title: "你在对话里说的", excerpt: p.userQuote, observedAt: now() };
        markCorrected(state, pr.id);
        const prop = await propose(state, { premiseId: pr.id, to: p.newValue, source: "user", evidenceId: evId, reason: "你说的", confidence: "high", assess: ctx.assess, drafter: ctx.drafter });
        if (!prop) return { content: [{ type: "text", text: "值没有变化" }], details: {} };
        ctx.onProposal?.(prop);
        const pc = prop.premiseChangeId ? state.premiseChanges[prop.premiseChangeId] : undefined;
        const n = pc?.impacts.filter((i) => i.handling !== "unaffected").length ?? 0;
        return { content: [{ type: "text", text: `已更新。影响 ${n} 项${prop.drafts.length ? `；已起草 ${prop.drafts.length} 条给别人的更正消息，界面会展示给用户确认` : ""}。` }], details: {} };
      },
    },
    {
      name: "propose_change", label: "提出推断", description: "用户说的变化很可能连带改变卡上另一个前提时（如面试推迟→作业截止可能也推迟），提出你的推断。不要用 update_premise 擅自改。系统会按把握和影响决定：直接生效并告诉用户，或先问用户。你在回复里用自然语言说出推断即可，不要再额外提问同一件事。",
      parameters: Type.Object({
        premiseId: Type.String(), newValue: Type.String({ description: "推断的新值，简短具体" }),
        confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], { description: "high：几乎必然（常识或用户明显暗示）；medium：很可能但需要确认；low：只是一种可能" }),
        reason: Type.String({ description: "一句话理由，≤25 字" }),
      }),
      describe: () => "",
      execute: async (_id, p: any) => {
        const pr = state.premises[p.premiseId];
        if (!pr) throw new Error(`前提不存在。可用：${card().premiseIds.map((id) => `${id}=${state.premises[id]?.label}`).join("；")}`);
        const bad = badValue(p.newValue); if (bad) throw new Error(bad);
        const evId = newId("evd");
        state.evidence[evId] = { id: evId, source: "user_input", ref: "chat", title: "推断", excerpt: p.reason, observedAt: now() };
        const prop = await propose(state, { premiseId: pr.id, to: p.newValue, source: "inference", evidenceId: evId, reason: p.reason, confidence: p.confidence, assess: ctx.assess, drafter: ctx.drafter });
        if (!prop) return { content: [{ type: "text", text: "把握太低，没有提出。回复里可以顺带提一句，不要追问。" }], details: {} };
        ctx.onProposal?.(prop);
        return { content: [{ type: "text", text: prop.mode === "auto"
          ? `已直接按推断更新（把握高、影响小）。回复里告诉用户你改了什么，不要问是否同意。`
          : `已提出，等用户确认（${prop.gateReason}）。回复里说出推断和原因，问一句即可，界面会给确认按钮。${prop.drafts.length ? `已起草 ${prop.drafts.length} 条更正消息，回复里简单提一下。` : ""}` }], details: {} };
      },
    },
  ];
}

/** 前提值必须简短具体；返回错误说明，或 null */
export function badValue(v: string): string | null {
  if (!v?.trim()) return "值不能为空";
  if (v.length > 16 || /待确认|未确认|待补充|不确定|是否|尚未|；/.test(v))
    return `「${v}」不是一个简短具体的值。只写值本身（≤12 字，如「周六」）。如果还不确定，不要更新，先用一句是/否问题向用户确认你的推断。`;
  return null;
}

/** 给模型的工作卡摘要（不含内部 id 以外的冗余） */
export function cardSummary(state: AgentState, cardId: ID) {
  const c = state.workCards[cardId];
  if (!c) return null;
  return {
    card: { id: c.id, title: c.title, stage: c.stage, goal: c.goal, status: c.status, nextStep: c.nextStep, waitingOn: c.waitingOn,
      project: c.projectId ? state.projects[c.projectId]?.name : null },
    premises: c.premiseIds.map((id) => state.premises[id]).filter(Boolean).map((p) => ({ id: p!.id, label: p!.label, value: p!.value, confirmed: p!.confirmed })),
    decisions: c.decisionIds.map((id) => state.decisions[id]).filter(Boolean).map((d) => ({ id: d!.id, statement: d!.statement, status: d!.status, premiseIds: d!.premiseIds })),
    actions: c.actionIds.map((id) => state.actions[id]).filter(Boolean).map((a) => ({ label: a!.label, status: a!.status, external: a!.external })),
    openQuestions: c.openQuestions.map((q) => ({ question: q.question, answer: q.answer ?? null })),
    reminders: c.reminders.map((r) => ({ at: r.at, reason: r.reason })),
    materials: readableEvidence(state, cardId).map((id) => ({ id, title: state.evidence[id]!.title })),
  };
}

export function emitAgentNote(state: AgentState, cardId: ID, summary: string) {
  emit(state, { type: "action_status_changed", actor: "agent", workCardId: cardId, summary, payload: {} });
}
