/**
 * 材料 → 草稿工作卡（自由场景的入口）。
 *
 * 模型通过 Pi 的工具调用提交结构；submit_workcard 做确定性校验：
 *   - 每条前提、决策都必须引用真实存在的材料（有来源）；
 *   - 决策只能引用本次提交里的前提，动作只能引用本次提交里的决策；
 *   - 依赖关系不能自指、不能指向不存在的决策。
 * 校验失败 → 把错误清单作为工具错误退回，模型在同一循环里修正重提。
 * 校验通过 → 写入 AgentState（阶段：草稿），并终止循环。
 */
import { Type, type Static } from "typebox";
import type { Api, Model } from "@mariozechner/pi-ai";
import { emit } from "../engine/events.ts";
import { newId, now } from "../engine/ids.ts";
import type { Action, AgentState, Decision, ID, Premise, WorkCard } from "../types.ts";
import { createWorkAgent, type WorkTool } from "./workAgent.ts";

const Ref = Type.String({ description: "本次提交内的局部 key，如 p1 / d1 / a1" });

export const WorkCardDraftSchema = Type.Object({
  title: Type.String({ description: "一句话说清这件事，动词开头，≤20 字" }),
  goal: Type.String({ description: "要达成的结果" }),
  status: Type.String({ description: "现在进展到哪、卡在哪" }),
  nextStep: Type.String({ description: "下一步最具体的一件事" }),
  waitingOn: Type.Union([Type.String(), Type.Null()], { description: "在等谁/等什么；没有则 null" }),
  premises: Type.Array(Type.Object({
    key: Ref, label: Type.String({ description: "如「Q4 预算」「对齐会时间」" }),
    value: Type.String({ description: "简短具体的取值，≤12 字，如「50 万」「周五」「已完成一半」。不要写成描述或“未确认”这类说明；拿不准就写最可能的值并设 confirmed=false" }),
    confirmed: Type.Boolean({ description: "材料里明确写出且无歧义才为 true；推测的为 false" }),
    evidenceIds: Type.Array(Type.String(), { description: "支撑它的材料 id，至少一个" }),
    quote: Type.String({ description: "材料原文摘录" }),
  })),
  decisions: Type.Array(Type.Object({
    key: Ref, statement: Type.String({ description: "已做出或正在倾向的决定" }),
    premiseKeys: Type.Array(Ref, { description: "它成立所依赖的前提" }),
    dependsOnDecisionKeys: Type.Array(Ref, { description: "它依赖的其他决策（上游）" }),
    reversalCost: Type.Union([Type.Literal("none"), Type.Literal("low"), Type.Literal("high"), Type.Literal("irreversible")]),
    confidence: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    evidenceIds: Type.Array(Type.String()),
    alternative: Type.Union([Type.Null(), Type.Object({ statement: Type.String(), tradeoff: Type.String() })],
      { description: "材料里提到的备选方案及代价；没有则 null" }),
  })),
  actions: Type.Array(Type.Object({
    key: Ref, label: Type.String({ description: "一件能做出具体产出的事（起草某文档、排出时间表、写一条消息），不能是“确认/了解/询问”某事" }),
    status: Type.Union([Type.Literal("planned"), Type.Literal("done")]),
    external: Type.Boolean({ description: "是否会被别人看到/对外生效（发消息、提交、发布）" }),
    dependsOnDecisionKeys: Type.Array(Ref),
    premiseKeys: Type.Array(Ref, { description: "若结果直接由某前提计算得出（如按预算算的表）" }),
  })),
  openQuestions: Type.Array(Type.Object({
    question: Type.String({ description: "一句话的问题，≤25 字，口语化" }),
    options: Type.Array(Type.String({ description: "可直接点选的回答，≤8 个字，不要括号和补充说明" }), { minItems: 2, maxItems: 4 }),
    premiseKey: Type.Union([Type.String(), Type.Null()], { description: "回答后会确定哪个前提；无则 null" }),
  }), { description: "拿不准、需要用户确认的点，最多 3 个" }),
});
export type WorkCardDraft = Static<typeof WorkCardDraftSchema>;

/** 纯函数校验，返回人能读懂的错误清单（给模型修正用） */
export function validateDraft(state: AgentState, d: WorkCardDraft, allowedEvidence: Set<ID>): string[] {
  const errs: string[] = [];
  const keys = new Set<string>();
  const dup = (k: string) => { if (keys.has(k)) errs.push(`key 重复：${k}`); keys.add(k); };
  const pKeys = new Set(d.premises.map((p) => p.key));
  const dKeys = new Set(d.decisions.map((x) => x.key));
  const ev = (ids: string[], where: string) => {
    if (!ids.length) errs.push(`${where} 没有引用任何材料`);
    for (const id of ids) if (!allowedEvidence.has(id) || !state.evidence[id]) errs.push(`${where} 引用了不存在或未授权的材料：${id}`);
  };
  if (!d.title.trim()) errs.push("title 为空");
  for (const p of d.premises) { dup(p.key); ev(p.evidenceIds, `前提 ${p.key}`); }
  for (const x of d.decisions) {
    dup(x.key); ev(x.evidenceIds, `决策 ${x.key}`);
    for (const k of x.premiseKeys) if (!pKeys.has(k)) errs.push(`决策 ${x.key} 引用了不存在的前提 ${k}`);
    for (const k of x.dependsOnDecisionKeys) {
      if (k === x.key) errs.push(`决策 ${x.key} 依赖了自己`);
      else if (!dKeys.has(k)) errs.push(`决策 ${x.key} 依赖了不存在的决策 ${k}`);
    }
    if (!x.premiseKeys.length && !x.dependsOnDecisionKeys.length) errs.push(`决策 ${x.key} 没有说明依赖哪些前提或决策`);
  }
  for (const a of d.actions) {
    dup(a.key);
    for (const k of a.dependsOnDecisionKeys) if (!dKeys.has(k)) errs.push(`动作 ${a.key} 依赖了不存在的决策 ${k}`);
    for (const k of a.premiseKeys) if (!pKeys.has(k)) errs.push(`动作 ${a.key} 引用了不存在的前提 ${k}`);
  }
  for (const q of d.openQuestions) if (q.premiseKey && !pKeys.has(q.premiseKey)) errs.push(`问题「${q.question}」指向不存在的前提 ${q.premiseKey}`);
  if (d.openQuestions.length > 3) errs.push("待确认问题超过 3 个，请只保留最关键的");
  if (hasCycle(d)) errs.push("决策之间的依赖形成了环");
  if (!d.decisions.length) errs.push("至少给出 1 条决策（用户已做出或正在倾向的做法），并写清它依赖哪些前提");
  for (const p of d.premises) {
    const used = d.decisions.some((x) => x.premiseKeys.includes(p.key)) || d.actions.some((a) => a.premiseKeys.includes(p.key));
    if (!used) errs.push(`前提 ${p.key}「${p.label}」没有被任何决策或动作依赖：它变了不会影响什么，要么让依赖它的决策引用它，要么去掉（需要确认的放进 openQuestions）`);
    if (p.value.length > 14 || /待确认|未确认|待补充|不确定|用户(所)?说/.test(p.value)) errs.push(`前提 ${p.key}「${p.label}」的值「${p.value}」要写成简短具体的取值（≤12 字，如「明天」「周五」），不要写说明；不确定就设 confirmed=false，并放进 openQuestions 去问`);
  }
  for (const a of d.actions) if (/(确认|询问|问清|了解|核实|弄清|索取|请用户|向用户)/.test(a.label)) errs.push(`动作 ${a.key}「${a.label}」是在确认信息，应放进 openQuestions，而不是动作`);
  return errs;
}

function hasCycle(d: WorkCardDraft): boolean {
  const g = new Map(d.decisions.map((x) => [x.key, x.dependsOnDecisionKeys]));
  const state = new Map<string, 1 | 2>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 1) return true;
    if (state.get(k) === 2) return false;
    state.set(k, 1);
    for (const n of g.get(k) ?? []) if (visit(n)) return true;
    state.set(k, 2);
    return false;
  };
  return [...g.keys()].some(visit);
}

/** 把校验过的草稿写入状态：局部 key → 全局 id；下游依赖反向登记到上游决策 */
export function commitDraft(state: AgentState, d: WorkCardDraft, o: { projectId?: ID; originEvidenceIds: ID[] }): WorkCard {
  const t = now();
  const cardId = newId("wc");
  const pid = new Map<string, ID>(), did = new Map<string, ID>(), aid = new Map<string, ID>();
  for (const p of d.premises) pid.set(p.key, newId("pr"));
  for (const x of d.decisions) did.set(x.key, newId("dec"));
  for (const a of d.actions) aid.set(a.key, newId("act"));

  for (const p of d.premises) {
    const pr: Premise = { id: pid.get(p.key)!, label: p.label, value: p.value, confirmed: p.confirmed,
      evidenceIds: p.evidenceIds, history: [], projectId: o.projectId };
    state.premises[pr.id] = pr;
  }
  for (const x of d.decisions) {
    const dec: Decision = {
      id: did.get(x.key)!, workCardId: cardId, statement: x.statement,
      premiseIds: x.premiseKeys.map((k) => pid.get(k)!), dependentDecisionIds: [], derivedActionIds: [],
      status: "valid", reversalCost: x.reversalCost, confidence: x.confidence,
      provenance: { confirmedBy: "agent", evidenceIds: x.evidenceIds, at: t },
      suggestion: x.alternative ?? undefined,
    };
    state.decisions[dec.id] = dec;
  }
  for (const x of d.decisions) for (const up of x.dependsOnDecisionKeys) state.decisions[did.get(up)!]!.dependentDecisionIds.push(did.get(x.key)!);
  for (const a of d.actions) {
    const act: Action = {
      id: aid.get(a.key)!, workCardId: cardId, label: a.label, status: a.status,
      external: a.external, reversible: !a.external, dependsOnDecisionIds: a.dependsOnDecisionKeys.map((k) => did.get(k)!),
      premiseIds: a.premiseKeys.length ? a.premiseKeys.map((k) => pid.get(k)!) : undefined,
    };
    state.actions[act.id] = act;
    for (const k of a.dependsOnDecisionKeys) state.decisions[did.get(k)!]!.derivedActionIds.push(act.id);
  }
  const card: WorkCard = {
    id: cardId, projectId: o.projectId, stage: "draft", title: d.title, goal: d.goal, status: d.status,
    nextStep: d.nextStep, waitingOn: d.waitingOn ?? undefined,
    decisionIds: [...did.values()], actionIds: [...aid.values()], premiseIds: [...pid.values()],
    openQuestions: d.openQuestions.map((q) => ({ id: newId("q"), question: q.question, options: q.options,
      premiseId: q.premiseKey ? pid.get(q.premiseKey) : undefined })),
    reminders: [], originEvidenceIds: o.originEvidenceIds, createdAt: t, updatedAt: t,
  };
  state.workCards[card.id] = card;
  if (o.projectId && state.projects[o.projectId]) {
    const pj = state.projects[o.projectId]!;
    pj.workCardIds.push(card.id);
    pj.premiseIds.push(...card.premiseIds);
  }
  const sources = o.originEvidenceIds.map((id) => state.evidence[id]?.title).filter(Boolean);
  emit(state, { type: "card_created", actor: "agent", workCardId: card.id, projectId: o.projectId,
    summary: `根据${sources.length ? `《${sources.join("》《")}》` : "你说的"}整理出草稿「${card.title}」${card.openQuestions.length ? `，有 ${card.openQuestions.length} 处需要你确认` : ""}`,
    payload: { workCardId: card.id } });
  return card;
}

const SYSTEM = `把用户的一件事整理成"工作卡"，让用户随时知道：在推进什么、依据是什么、哪些前提一变会影响什么。
做法：
1. 用 read_material 读完相关材料（只能读给出的材料 id）。
2. 调用 submit_workcard 提交结构。要求：
   - 只写材料里有依据的内容，不编造人名、数字、日期；推测的前提 confirmed=false。
   - 前提是"会变、一变就影响决策"的事实：截止时间、预算、人手、进度、别人的立场等。值写成简短具体的取值（如「周五」），不要写成描述；拿不准的写最可能的值、confirmed=false，并在 openQuestions 里问，用 premiseKey 关联。只是背景信息、变了也不影响任何决定的，不要放进前提。
   - 至少给出 1 条决策：用户已经做出或正在倾向的做法（如「先做最小可运行版本，再补文档」）。材料里没有明说的，可以根据目标和前提提出一个合理的倾向，confidence=low。每条决策写清依赖哪些前提。
   - 动作是能做出具体产出的事，写清依赖哪个决策；会对外生效的 external=true。不要把"确认/询问某事"写成动作，那些属于 openQuestions。
   - 拿不准的点放进 openQuestions，最多 3 个，只问会影响判断的事。问题一句话、口语化；每个给 2–4 个可以直接点选的选项，每个选项不超过 8 个字，不加括号或补充说明（如「是题目」「已有一半」「本周五」，而不是「本周五，具体时刻待补充」）。
3. 如果 submit_workcard 返回错误，按错误逐条修正后重新提交。
全部用中文。`;

export interface IntakeInput {
  goal: string;
  evidenceIds: ID[];
  projectId?: ID;
  model: Model<Api>;
  getApiKey?: (p: string) => string | undefined;
  maxAttempts?: number;
}

export async function draftWorkCard(state: AgentState, input: IntakeInput): Promise<{ card?: WorkCard; attempts: number; errors: string[] }> {
  const allowed = new Set(input.evidenceIds);
  let card: WorkCard | undefined;
  let attempts = 0;
  let lastErrors: string[] = [];
  const max = input.maxAttempts ?? 3;

  const tools: WorkTool[] = [
    { name: "read_material", label: "读取材料", description: "按 id 读取用户提供的材料全文",
      parameters: Type.Object({ evidenceId: Type.String() }),
      // 读用户自己说的话不算一件事，不进时间线
      describe: (a, o) => (o === "done" && state.evidence[a?.evidenceId]?.ref !== "chat" ? `读了《${state.evidence[a?.evidenceId]?.title ?? "材料"}》` : ""),
      execute: async (_id, p: any) => {
        const e = allowed.has(p.evidenceId) ? state.evidence[p.evidenceId] : undefined;
        if (!e) throw new Error(`材料 ${p.evidenceId} 不存在或不在本次范围内。可用：${[...allowed].join(", ")}`);
        return { content: [{ type: "text", text: `# ${e.title}（${e.id}）\n${e.excerpt}` }], details: {} };
      } },
    { name: "submit_workcard", label: "提交工作卡", description: "提交整理好的工作卡结构；校验失败会返回错误清单",
      parameters: WorkCardDraftSchema,
      execute: async (_id, draft: any) => {
        attempts++;
        const errs = validateDraft(state, draft as WorkCardDraft, allowed);
        if (errs.length) {
          lastErrors = errs;
          if (attempts >= max) return { content: [{ type: "text", text: `仍有问题，停止重试：\n- ${errs.join("\n- ")}` }], details: { errs }, terminate: true };
          throw new Error(`请修正后重新提交：\n- ${errs.join("\n- ")}`);
        }
        card = commitDraft(state, draft as WorkCardDraft, { projectId: input.projectId, originEvidenceIds: [...allowed] });
        lastErrors = [];
        return { content: [{ type: "text", text: `已创建草稿卡 ${card.id}` }], details: { workCardId: card.id }, terminate: true };
      } },
  ];

  const agent = createWorkAgent({ state, model: input.model, tools, systemPrompt: SYSTEM, projectId: input.projectId, getApiKey: input.getApiKey });
  const list = input.evidenceIds.map((id) => `- ${id}：${state.evidence[id]?.title}`).join("\n");
  await agent.prompt(`目标：${input.goal}\n\n可用材料：\n${list || "（无，只根据目标整理）"}`);
  if (!card && agent.state.errorMessage) lastErrors.push(agent.state.errorMessage);
  return { card, attempts, errors: lastErrors };
}
