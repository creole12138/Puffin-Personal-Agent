/**
 * 需要云朵小管家"动脑"的操作：候选、执行计划、执行、对话。
 * 都基于 Pi 的 Agent 循环（createWorkAgent），通用规范由 prompts.ts 统一注入。
 */
import { Type } from "typebox";
import {
  BASE_SYSTEM_PROMPT, cardSummary, cardTools, createWorkAgent, emit, newId, now, readableEvidence, templateDrafter,
  type AgentState, type ChatEntry, type Drafter, type ID, type Proposal, type WorkTool,
} from "../core/src/index.ts";
import type { Brains } from "./brains.ts";

export function pushChat(state: AgentState, scope: string, role: ChatEntry["role"], text: string, extra: Partial<ChatEntry> = {}) {
  state.chats ??= {};
  (state.chats[scope] ??= []).push({ role, text, at: now(), ...extra });
  if (state.chats[scope]!.length > 200) state.chats[scope] = state.chats[scope]!.slice(-200);
}

function lastText(messages: unknown[]): string {
  const m = [...messages].reverse().find((x: any) => x.role === "assistant") as any;
  return (m?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
}

/** 起草补救消息：碰到已经对外发出的东西时，写好一条给对方的更正 */
export function makeDrafter(brains: Brains): Drafter {
  if (!brains.provider) return templateDrafter;
  return async ({ state, actionId, premiseLabel, from, to }) => {
    const a = state.actions[actionId];
    const r = await brains.provider!.generateStructured<{ to: string; title: string; body: string }>({
      task: "draft_correction",
      messages: [
        { role: "system", content: BASE_SYSTEM_PROMPT.trim() + "\n\n【本次任务】\n用户之前已经对外发出过一件事，现在其中依赖的一个前提变了。替用户起草一条简短的更正消息（≤80 字，口语、礼貌、直接说清新情况和需要对方做什么）。to 写收件人称呼（从原动作里推断，推断不出就写“对方”）。不要编造原动作里没有的信息。" },
        { role: "user", content: JSON.stringify({ 之前发出的: a?.label, 之前的内容: a?.output?.body ?? null, 变化: `${premiseLabel}：${from} → ${to}` }) },
      ],
      schema: { type: "object", additionalProperties: false, required: ["to", "title", "body"], properties: { to: { type: "string" }, title: { type: "string" }, body: { type: "string" } } },
    });
    return r.data;
  };
}

/** 把一条提议写成一句自然语言（新材料触发、没有对话回复时用） */
export function describeProposal(state: AgentState, p: Proposal): string {
  const src = p.source === "material" ? `《${state.evidence[p.evidenceId]?.title ?? "新材料"}》里，` : "";
  const what = `${p.change.label}从 ${p.change.from} 变成了 ${p.change.to}`;
  if (p.mode === "auto") return `${src}${what}，我已经按这个更新了。`;
  return `${src}看起来${what}。因为${p.gateReason}，先问你一下：要按这个更新吗？${p.drafts.length ? ` 之前发出去的${p.drafts.length > 1 ? "几条" : "那条"}消息，我也拟好了更正。` : ""}`;
}

/** 用户随口一句 → 候选卡（先记下、第一步是什么、可能属于哪个项目） */
export async function makeCandidate(state: AgentState, brains: Brains, text: string): Promise<ID> {
  const projects = Object.values(state.projects).map((p) => ({ id: p.id, name: p.name, goal: p.goal }));
  let title = text.trim().slice(0, 30), firstStep = "先把上次聊到哪、还差什么列出来", projectId: string | null = null, why = "";
  if (brains.provider) {
    const r = await brains.provider.generateStructured<{ title: string; firstStep: string; projectId: string | null; why: string }>({
      task: "make_candidate",
      messages: [
        { role: "system", content: BASE_SYSTEM_PROMPT.trim() + "\n\n【本次任务】\n用户随口说了一件事，你先把它记下来，作为一件待跟进的事。\n" +
          "title：把这件事写成一句要推进的事，动词开头，≤16 字；尽量保留用户原话里的关键词（人名、对象、说法），不要改换概念。\n" +
          "firstStep：这是给用户的一个按钮，表示你提出要马上帮他做的事。点下去后，你会立刻读他给的话和材料，把这件事整理成一张工作卡（目标、现状、依据、还差什么、拿不准要问他的）。" +
          "所以它必须：用你的口吻向用户提议（如“先把……理一下”“帮你把……列出来”）；描述的是整理和梳理，而不是让用户去做事，也不是去联系别人；≤20 字。\n" +
          "例：用户说“和 Alex 那事一直没对齐”→ firstStep“先把上次聊到哪、还差什么列出来”。\n" +
          "如果明显属于某个已有项目，给出 projectId 和一句理由 why（点出共同的人、材料或前提）；否则 projectId 为 null、why 为空字符串。不要编造。" },
        { role: "user", content: JSON.stringify({ said: text, projects }) },
      ],
      schema: { type: "object", additionalProperties: false, required: ["title", "firstStep", "projectId", "why"], properties: {
        title: { type: "string" }, firstStep: { type: "string" }, why: { type: "string" },
        projectId: { anyOf: [{ type: "null" }, { type: "string", enum: projects.length ? projects.map((p) => p.id) : ["_"] }] } } },
    });
    ({ title, firstStep, why } = r.data);
    projectId = r.data.projectId && state.projects[r.data.projectId] ? r.data.projectId : null;
  }
  const evId = newId("evd");
  state.evidence[evId] = { id: evId, source: "user_input", ref: "chat", title: "你说的", excerpt: text, observedAt: now() };
  const id = newId("wc");
  state.workCards[id] = { id, stage: "candidate", title, nextStep: firstStep, decisionIds: [], actionIds: [], premiseIds: [],
    openQuestions: [], reminders: [], originEvidenceIds: [evId], createdAt: now(), updatedAt: now(),
    ...(projectId ? { suggestedProject: { projectId, why } } : {}) };
  emit(state, { type: "card_created", actor: "agent", workCardId: id, summary: `记下了「${title}」`, payload: {} });
  pushChat(state, id, "user", text);
  pushChat(state, id, "agent", "记下了。要我先帮你理一下现状吗？");
  return id;
}

/** 草稿卡 → 执行计划（等用户在对话面板里确认） */
type PlanChange = NonNullable<NonNullable<AgentState["workCards"][string]["plan"]>["revision"]>["changes"][number];

export async function makePlan(state: AgentState, brains: Brains, cardId: ID, revise?: PlanChange[]) {
  const c = state.workCards[cardId];
  if (!c) throw new Error("工作卡不存在");
  if (!brains.model) throw new Error("服务器没有配置模型");
  const previous = c.plan?.status === "proposed" ? c.plan : undefined;
  let plan: { steps: string[]; scopeLabel: string } | undefined;
  const tools: WorkTool[] = [{
    name: "submit_plan", label: "提交执行计划", description: "提交执行计划",
    parameters: Type.Object({
      steps: Type.Array(Type.String({ description: "一步具体的事，≤30 字" }), { minItems: 1, maxItems: 5 }),
      scopeLabel: Type.String({ description: "执行需要的授权范围，一句话，如“读取你给的 2 份材料 · 仅本任务 · 不对外发送”" }),
    }),
    execute: async (_id, p: any) => { plan = p; return { content: [{ type: "text", text: "ok" }], details: {}, terminate: true }; },
  }];
  const agent = createWorkAgent({ state, model: brains.model, getApiKey: brains.getApiKey, tools, projectId: c.projectId, workState: cardSummary(state, cardId),
    systemPrompt: "为这张工作卡拟一个执行计划，交给用户确认后再执行。只能包含你用现有工具做得到的事：读材料、起草内部文档、起草消息（不会替用户发送）、设提醒。用户已回答的确认问题要体现在计划里。计划里的数字、日期等要和工作卡上最新的前提一致。调用 submit_plan 提交。" });
  await agent.prompt(revise?.length && previous
    ? `前提变了：${revise.map((r) => `${r.label} ${r.from} → ${r.to}`).join("；")}。\n按最新信息修订下面这份计划；没受影响的步骤原样保留（逐字不变），受影响的改写。\n原计划：\n${previous.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    : "请拟执行计划。");
  if (!plan) throw new Error(agent.state.errorMessage ? `模型调用失败：${agent.state.errorMessage}` : "没能生成执行计划");
  if (revise?.length && previous) {
    // 合并多次修订的变化：同一前提只保留最初的 from 和最新的 to
    const merged = [...(previous.revision?.stale ? [] : previous.revision?.changes ?? [])];
    for (const r of revise) { const old = merged.find((m) => m.premiseId === r.premiseId); if (old) old.to = r.to; else merged.push({ ...r }); }
    const base = previous.revision && !previous.revision.stale ? previous.revision.previousSteps : previous.steps;
    c.plan = { ...previous, steps: plan.steps, scopeLabel: plan.scopeLabel, revision: { changes: merged.filter((m) => m.from !== m.to), previousSteps: base, at: now() } };
    emit(state, { type: "plan_proposed", actor: "agent", workCardId: cardId, summary: `按新的${revise.map((r) => r.label).join("、")}更新了执行计划，等你确认`, payload: { planId: c.plan.id } });
    return c.plan;
  }
  c.plan = { id: newId("plan"), steps: plan.steps, scopeLabel: plan.scopeLabel, grantIds: [], status: "proposed", createdAt: now() };
  emit(state, { type: "plan_proposed", actor: "agent", workCardId: cardId, summary: `拟了 ${plan.steps.length} 步执行计划，等你确认`, payload: { planId: c.plan.id } });
  pushChat(state, cardId, "agent", "计划拟好了，放在下面。确认后我就开始；对外的事我只起草，不会替你发出去。");
  return c.plan;
}

/** 用户确认计划 → 进入进行中，云朵小管家按计划推进 */
export async function runPlan(state: AgentState, brains: Brains, cardId: ID) {
  const c = state.workCards[cardId];
  if (!c?.plan) throw new Error("还没有执行计划");
  if (!brains.model) throw new Error("服务器没有配置模型");
  c.plan.status = "confirmed";
  c.stage = "active";
  const gid = newId("g");
  state.grants[gid] = { id: gid, source: "user_input", scopeLabel: c.plan.scopeLabel ?? "读取这件事的材料 · 仅本任务 · 不对外发送",
    filter: { evidenceIds: readableEvidence(state, cardId) }, workCardId: cardId, permissions: ["read"], grantedAt: now() };
  c.plan.grantIds = [gid];
  emit(state, { type: "plan_confirmed", actor: "user", workCardId: cardId, summary: `你确认了执行计划，授权：${state.grants[gid]!.scopeLabel}`, payload: { grantId: gid } });

  const agent = createWorkAgent({ state, model: brains.model, getApiKey: brains.getApiKey, projectId: c.projectId,
    tools: cardTools({ state, cardId, assess: brains.assess }), workState: cardSummary(state, cardId),
    systemPrompt: "用户已确认下面的执行计划，按步骤推进。每步用工具实际完成（起草文档要写出完整可用的内容）。对外消息只起草。完成后用两三句话告诉用户做了什么、还差什么、下一步是什么。" });
  await agent.prompt(`执行计划：\n${c.plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  const reply = lastText(agent.state.messages) || (agent.state.errorMessage ? `执行中出了问题：${agent.state.errorMessage}` : "计划里的事做完了。");
  c.updatedAt = now();
  pushChat(state, cardId, "agent", reply);
  return { reply };
}

/** 对话：在某张工作卡的上下文里和云朵小管家说话 */
export async function chat(state: AgentState, brains: Brains, cardId: ID, text: string, quote?: string) {
  const c = state.workCards[cardId];
  if (!c) throw new Error("工作卡不存在");
  if (!brains.model) throw new Error("服务器没有配置模型");
  const history = (state.chats?.[cardId] ?? []).slice(-12).map((m) => `${m.role === "user" ? "用户" : "你"}：${m.text}`).join("\n");
  pushChat(state, cardId, "user", text, quote ? { quote } : {});
  const made: Proposal[] = [];
  const agent = createWorkAgent({ state, model: brains.model, getApiKey: brains.getApiKey, projectId: c.projectId,
    tools: cardTools({ state, cardId, assess: brains.assess, drafter: makeDrafter(brains), onProposal: (p) => made.push(p) }), workState: cardSummary(state, cardId),
    systemPrompt: [
      "你在和用户讨论这张工作卡。回答要短（≤3 句），用纯文本，不要用 Markdown 符号（如 ** 或 #）。",
      "用户告诉你一个变化时：",
      "1. 用户明确说了的，直接更新：已有前提用 update_premise，卡上没有的新事实用 add_premise。值只写简短具体的值，如「周六」。",
      "2. 再想清楚它会连带改变卡上哪些前提。比如“面试推迟到周六”，作业截止很可能也跟着变。对每个连带变化调用 propose_change，如实给出把握（high/medium/low）和一句理由；不要用 update_premise 擅自改。",
      "3. 系统会决定推断是直接生效还是先问用户，并在界面上给出确认按钮。你的回复里用自然语言说清：你记下了什么、推断了什么、为什么；需要确认的问一句即可，不要列选项。",
      "4. 用户的简短回答要结合上一轮理解：你推断“作业截止也是周六”，用户答“对”/“也推迟了”，就等于确认，用 update_premise 更新为「周六」，不要再追问同一件事。",
      "5. 用户引用了你说过的话并纠正时，按用户说的值用 update_premise 更新被纠正的那个前提。",
      "需要起草就起草；只是提问就直接回答，不要调用工具。",
    ].join("\n") });
  await agent.prompt(`${history ? `之前的对话：\n${history}\n\n` : ""}${quote ? `用户引用了你说的：「${quote}」\n` : ""}用户：${text}`);
  const reply = lastText(agent.state.messages) || (agent.state.errorMessage ? `出了点问题：${agent.state.errorMessage}` : "好的。");
  c.updatedAt = now();
  pushChat(state, cardId, "agent", reply, made.length ? { proposalIds: made.map((p) => p.id) } : {});
  return { reply, proposals: made };
}
