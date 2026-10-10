/**
 * 工作区：一个访问者的一份独立工作状态（通过专属链接进入，不需要注册）。
 * 所有修改串行执行（避免并发写乱状态），改完落盘并推送给打开的页面。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  applyPremiseChange, commitDraft, draftWorkCard, emit, emptyState, FileStore, newId, resolveDecision, seedQ4,
  type AgentState, type Evidence, type ID, type PremiseChange,
} from "../core/src/index.ts";
import type { Brains } from "./brains.ts";
import { chat, describeProposal, makeCandidate, makeDrafter, makeRecomputer, makePlan, pushChat, runPlan } from "./agentOps.ts";
import { confirmProposal, introducePremise, markCorrected, propose, rollbackTo, verifyClaims, type Proposal } from "../core/src/index.ts";

import { CapError, usage, type Usage } from "./usage.ts";

export class LimitError extends Error {}

/** 全站每日模型调用上限：防止有人反复新建工作区刷掉费用 */
const GLOBAL_LIMIT = Number(process.env.LLM_DAILY_LIMIT_GLOBAL ?? 800);
const globalUsage = { day: new Date().toDateString(), calls: 0 };

export class Workspace {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(s: AgentState) => void>();
  llmCallsToday = 0;
  private day = new Date().toDateString();

  constructor(readonly id: string, public state: AgentState, private store: FileStore, private brains: Brains, private limit: number) {}

  subscribe(fn: (s: AgentState) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** 串行执行一次修改；出错时状态回滚到修改前 */
  run<T>(fn: (s: AgentState) => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      const snapshot = structuredClone(this.state);
      const since = this.state.events.length;
      const u: Usage = { calls: 0, cap: 0 };
      try {
        const out = await usage.run(u, () => fn(this.state));
        verifyClaims(this.state, since);
        await this.store.save(this.state);
        for (const l of this.listeners) l(this.state);
        return out;
      } catch (e) {
        this.state = snapshot;
        if (e instanceof CapError) throw new LimitError(e.message);
        throw e;
      } finally {
        this.charge(u.calls);
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private rollDay() {
    const today = new Date().toDateString();
    if (today !== this.day) { this.day = today; this.llmCallsToday = 0; }
    if (globalUsage.day !== today) { globalUsage.day = today; globalUsage.calls = 0; }
  }

  /** 开始一次要用模型的操作：只检查还有没有余量，并把 n 设为这次的调用上限；按实际调用次数在 run 结束时扣 */
  private useLLM(n = 1) {
    this.rollDay();
    const left = Math.min(this.limit - this.llmCallsToday, GLOBAL_LIMIT - globalUsage.calls);
    if (this.llmCallsToday >= this.limit) throw new LimitError(`今天这个工作区的模型调用次数已用完（${this.limit} 次），明天再来，或者导出状态后在本地继续。`);
    if (globalUsage.calls >= GLOBAL_LIMIT) throw new LimitError("今天的体验名额用完了，明天再来；也可以先点「载入一个完整的例子」看看。");
    const u = usage.getStore();
    if (u) u.cap = Math.max(u.cap, u.calls + Math.min(n, left));
  }

  private charge(n: number) {
    if (!n) return;
    this.rollDay();
    this.llmCallsToday += n;
    globalUsage.calls += n;
  }

  // ---------- 操作 ----------

  loadExample() {
    return this.run((s) => {
      // 合并进当前工作区：保留你已有的工作、连接（日历、文件夹）和对话，只把例子加进来
      const ex = seedQ4() as unknown as Record<string, unknown>, cur = s as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(ex)) {
        if (k === "model" || k === "version") continue;
        if (k === "events" && Array.isArray(v)) { cur.events = [...((cur.events as unknown[]) ?? []), ...v].sort((a: any, b: any) => String(a.at).localeCompare(String(b.at))); continue; }
        if (v && typeof v === "object" && !Array.isArray(v)) cur[k] = { ...((cur[k] as object) ?? {}), ...(v as object) };
        else if (cur[k] === undefined) cur[k] = v;
      }
    });
  }

  addMaterial(input: { title: string; text: string; source?: Evidence["source"]; ref?: string; supersedes?: ID }) {
    return this.run(async (s) => {
      const ev: Evidence = {
        id: newId("evd"), source: input.source ?? "user_input", ref: input.ref ?? "upload", title: input.title,
        excerpt: input.text.slice(0, 20000), observedAt: new Date().toISOString(), supersedes: input.supersedes,
      };
      s.evidence[ev.id] = ev;
      emit(s, { type: "evidence_observed", actor: ev.source === "user_input" ? "user" : "watcher",
        summary: ev.supersedes ? `收到《${ev.title}》，它是《${s.evidence[ev.supersedes]?.title ?? "旧版本"}》的新版本` : `收到新材料《${ev.title}》`,
        payload: { evidenceId: ev.id } });
      const changes: PremiseChange[] = [];
      const proposals: Proposal[] = [];
      if (Object.keys(s.premises).length) {
        this.useLLM(12);
        const matches = await this.brains.match(s, ev);
        for (const m of matches) {
          // 新材料里读出的变化也走统一入口：把握高且影响小直接生效，否则先问
          const prop = await propose(s, { premiseId: m.premiseId, to: m.newValue, source: "material",
            evidenceId: ev.id, reason: `《${ev.title}》里写着“${m.quote}”`, confidence: m.confidence, assess: this.brains.assess, drafter: makeDrafter(this.brains), recompute: makeRecomputer(this.brains) });
          if (!prop) continue;
          proposals.push(prop);
          if (prop.premiseChangeId) changes.push(s.premiseChanges[prop.premiseChangeId]!);
          if (prop.workCardId) pushChat(s, prop.workCardId, "agent", describeProposal(s, prop), { proposalIds: [prop.id] });
        }
        // 材料里冒出的新事实：登记成新前提，走同一条 预演 → 分档 → 影响传播 的路
        for (const f of matches.newFacts ?? []) {
          const cardId = s.decisions[f.affectsDecisionIds[0]!]?.workCardId;
          if (!cardId) continue;
          const { proposal: prop } = await introducePremise(s, { cardId, label: f.label, value: f.value, evidenceId: ev.id,
            affectsDecisionIds: f.affectsDecisionIds.filter((d) => s.decisions[d]?.workCardId === cardId), source: "material",
            confidence: f.confidence, reason: `《${ev.title}》里写着“${f.quote}”`, assess: this.brains.assess, drafter: makeDrafter(this.brains), recompute: makeRecomputer(this.brains) });
          if (!prop) continue;
          proposals.push(prop);
          if (prop.premiseChangeId) changes.push(s.premiseChanges[prop.premiseChangeId]!);
          if (prop.workCardId) pushChat(s, prop.workCardId, "agent", describeProposal(s, prop), { proposalIds: [prop.id] });
        }
        if (!matches.length && !matches.newFacts?.length) emit(s, { type: "evidence_observed", actor: "agent", visibleInTimeline: false, summary: "新材料没有改变任何前提", payload: { evidenceId: ev.id } });
      }
      await this.refreshPlans(s, proposals);
      return { evidence: ev, changes, proposals };
    });
  }

  draftCard(goal: string, evidenceIds: ID[], projectId?: ID) {
    return this.run(async (s) => {
      if (!this.brains.model) throw new Error("服务器没有配置模型，无法整理工作卡。");
      this.useLLM(4);
      if (!goal.trim() && !evidenceIds.length) throw new Error("说一句你想推进的事，或者给我一份材料。");
      if (goal.trim()) {
        const id = newId("evd");
        s.evidence[id] = { id, source: "user_input", ref: "chat", title: "你说的", excerpt: goal, observedAt: new Date().toISOString() };
        evidenceIds = [id, ...evidenceIds];
      }
      const r = await draftWorkCard(s, { goal: goal || "根据材料整理出我正在推进的事", evidenceIds, projectId, model: this.brains.model, getApiKey: this.brains.getApiKey });
      if (!r.card) throw new Error(`没能整理出工作卡：${r.errors.slice(0, 3).join("；") || "模型没有返回结果"}`);
      return r.card;
    });
  }

  answerQuestion(cardId: ID, questionId: ID, answer: string) {
    return this.run((s) => {
      const c = s.workCards[cardId]; const q = c?.openQuestions.find((x) => x.id === questionId);
      if (!c || !q) throw new Error("问题不存在");
      q.answer = answer;
      if (q.premiseId && s.premises[q.premiseId]) {
        const p = s.premises[q.premiseId]!;
        // 还没确认的值被用户补全，是"澄清"不是"变化"，不记历史；已确认的值被改掉才算变化
        if (p.value !== answer) {
          if (p.confirmed) p.history.push({ value: p.value, evidenceIds: p.evidenceIds, at: new Date().toISOString() });
          p.value = answer;
        }
        p.confirmed = true;
      }
      emit(s, { type: "question_answered", actor: "user", workCardId: c.id, summary: `你确认：${q.question}——${answer}`, payload: { questionId, answer } });
    });
  }

  confirmCard(cardId: ID) {
    return this.run((s) => {
      const c = s.workCards[cardId];
      if (!c) throw new Error("工作卡不存在");
      c.stage = "active"; c.updatedAt = new Date().toISOString();
      for (const d of c.decisionIds) { const x = s.decisions[d]; if (x) x.provenance = { ...x.provenance, confirmedBy: "user", at: c.updatedAt }; }
      emit(s, { type: "card_stage_changed", actor: "user", workCardId: c.id, summary: `你确认了「${c.title}」，开始推进`, payload: { stage: "active" } });
    });
  }

  resolve(decisionId: ID, kind: "adopt_suggestion" | "keep" | "custom", note = "") {
    return this.run((s) => resolveDecision(s, decisionId, kind === "keep" ? { kind, note: note || "仍按原计划" } : kind === "custom" ? { kind, statement: note } : { kind }));
  }

  editPremise(premiseId: ID, value: string) {
    return this.run(async (s) => {
      const p = s.premises[premiseId];
      if (!p) throw new Error("前提不存在");
      if (p.value === value) return null;
      this.useLLM(6);
      const id = newId("evd");
      s.evidence[id] = { id, source: "user_input", ref: "edit", title: "你的修改", excerpt: `${p.label}：${value}`, observedAt: new Date().toISOString() };
      markCorrected(s, premiseId);
      const prop = await propose(s, { premiseId, to: value, source: "user", evidenceId: id, reason: "你改的", confidence: "high", assess: this.brains.assess, drafter: makeDrafter(this.brains), recompute: makeRecomputer(this.brains) });
      await this.refreshPlans(s, [prop]);
      if (prop?.drafts.length && prop.workCardId) pushChat(s, prop.workCardId, "agent", `之前发出去的${prop.drafts.length > 1 ? "几条" : "那条"}消息里还是旧的${p.label}，我拟好了更正，你看看。`, { proposalIds: [prop.id] });
      return prop?.premiseChangeId ? s.premiseChanges[prop.premiseChangeId]! : null;
    });
  }

  /**
   * 前提变了，而某张卡上有待确认的执行计划：按最新信息重拟（没有模型时标记为过期）。
   * 只看已经生效的变化；待确认的提议生效时再处理。
   */
  private async refreshPlans(s: AgentState, props: (Proposal | null | undefined)[]) {
    const applied = props.filter((p): p is Proposal => Boolean(p) && (p!.status === "applied" || p!.status === "confirmed"));
    if (!applied.length) return;
    for (const c of Object.values(s.workCards)) {
      if (c.plan?.status !== "proposed") continue;
      const hit = applied.filter((p) => c.premiseIds.includes(p.change.premiseId))
        .map((p) => ({ premiseId: p.change.premiseId, label: p.change.label, from: p.change.from, to: p.change.to }));
      if (!hit.length) continue;
      if (this.brains.model) { this.useLLM(3); await makePlan(s, this.brains, c.id, hit); }
      else c.plan.revision = { changes: hit, previousSteps: c.plan.steps, stale: true, at: new Date().toISOString() };
    }
  }

  candidate(text: string, brief = "") {
    return this.run(async (s) => {
      if (!text.trim()) throw new Error("说一句你想推进的事");
      if (this.brains.provider) this.useLLM(1);
      return { id: await makeCandidate(s, this.brains, text, brief) };
    });
  }

  remind(cardId: ID) {
    return this.run((s) => {
      const c = s.workCards[cardId]; if (!c) throw new Error("工作卡不存在");
      const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0);
      c.reminders.push({ id: newId("r"), at: t.toISOString(), reason: "你让我明天提醒你", kind: "open_loop", premiseIds: [] });
      emit(s, { type: "card_stage_changed", actor: "user", workCardId: c.id, summary: `「${c.title}」明天 9:00 提醒你`, payload: {} });
    });
  }

  dismiss(cardId: ID) {
    return this.run((s) => {
      const c = s.workCards[cardId]; if (!c) throw new Error("工作卡不存在");
      c.stage = "parked";
      emit(s, { type: "card_stage_changed", actor: "user", workCardId: c.id, summary: `「${c.title}」先不管了`, payload: { stage: "parked" } });
    });
  }

  setProject(cardId: ID, target: { projectId?: ID | null; newName?: string }) {
    return this.run((s) => {
      const c = s.workCards[cardId]; if (!c) throw new Error("工作卡不存在");
      let pid = target.projectId ?? null;
      if (target.newName?.trim()) {
        pid = newId("p");
        s.projects[pid] = { id: pid, name: target.newName.trim(), goal: "", premiseIds: [], workCardIds: [], createdAt: new Date().toISOString() };
      }
      if (c.projectId && s.projects[c.projectId]) s.projects[c.projectId]!.workCardIds = s.projects[c.projectId]!.workCardIds.filter((x) => x !== c.id);
      c.projectId = pid ?? undefined; c.suggestedProject = undefined;
      if (pid) {
        const p = s.projects[pid]; if (!p) throw new Error("项目不存在");
        p.workCardIds.push(c.id);
        for (const pr of c.premiseIds) { s.premises[pr]!.projectId = pid; if (!p.premiseIds.includes(pr)) p.premiseIds.push(pr); }
        emit(s, { type: "card_stage_changed", actor: "user", workCardId: c.id, projectId: pid, summary: `「${c.title}」归入了项目「${p.name}」`, payload: {} });
      } else emit(s, { type: "card_stage_changed", actor: "user", workCardId: c.id, summary: `「${c.title}」单独放着，不归入项目`, payload: {} });
    });
  }

  /** 候选 → 草稿：读材料、整理结构；候选卡被草稿卡替代，对话记录一并带过去 */
  draftFromCandidate(cardId: ID, evidenceIds: ID[]) {
    return this.run(async (s) => {
      const cand = s.workCards[cardId]; if (!cand) throw new Error("工作卡不存在");
      if (!this.brains.model) throw new Error("服务器没有配置模型，无法整理工作卡。");
      this.useLLM(4);
      const said = cand.originEvidenceIds.map((id) => s.evidence[id]?.excerpt).join("\n");
      const r = await draftWorkCard(s, { goal: `${cand.title}（用户原话：${said}）`, evidenceIds: [...cand.originEvidenceIds, ...evidenceIds],
        projectId: cand.projectId, model: this.brains.model, getApiKey: this.brains.getApiKey });
      if (!r.card) throw new Error(`没能整理出工作卡：${r.errors.slice(0, 3).join("；") || "模型没有返回结果"}`);
      s.chats ??= {};
      s.chats[r.card.id] = [...(s.chats[cardId] ?? []), { role: "agent", text: r.card.openQuestions.length ? `理了一版，有 ${r.card.openQuestions.length} 处拿不准，标在卡上了。` : "理了一版，你看看对不对。", at: new Date().toISOString() }];
      r.card.reminders.push(...cand.reminders);
      for (const g of Object.values(s.grants)) if (g.filter?.cardId === cardId) g.filter = { ...g.filter, cardId: r.card.id };
      delete s.workCards[cardId]; delete s.chats[cardId];
      if (cand.projectId) { const p = s.projects[cand.projectId]; if (p) p.workCardIds = p.workCardIds.filter((x) => x !== cardId); }
      return r.card;
    });
  }

  plan(cardId: ID) { return this.run(async (s) => { this.useLLM(3); return makePlan(s, this.brains, cardId); }); }
  runPlan(cardId: ID) { return this.run(async (s) => { this.useLLM(10); return runPlan(s, this.brains, cardId); }); }
  chat(cardId: ID, text: string, quote?: string) {
    return this.run(async (s) => {
      if (!text.trim()) throw new Error("说点什么");
      this.useLLM(12);
      const r = await chat(s, this.brains, cardId, text, quote?.trim() ? quote.trim().slice(0, 500) : undefined);
      await this.refreshPlans(s, r.proposals);
      return { reply: r.reply };
    });
  }

  confirm(proposalId: ID) {
    return this.run(async (s) => { if (this.brains.provider) this.useLLM(4); const p = await confirmProposal(s, proposalId, { recompute: makeRecomputer(this.brains) }); await this.refreshPlans(s, [p]); return p; });
  }
  cancelAction(actionId: ID) {
    return this.run((s) => {
      const a = s.actions[actionId]; if (!a) throw new Error("这个动作不存在");
      if (a.status === "done") throw new Error("这件事已经做完了");
      a.status = "cancelled";
      const orig = a.compensationFor ? s.actions[a.compensationFor] : undefined;
      const name = orig ? `「${orig.label}」的更正` : `「${a.label}」`;
      emit(s, { type: "action_status_changed", actor: "user", workCardId: a.workCardId, summary: `你决定不发${name}`, payload: { actionId: a.id, status: "cancelled", claim: { kind: "action_status", actionId: a.id, status: "cancelled" } } });
      pushChat(s, a.workCardId, "agent", `好，${name}不发了，已经从待办里拿掉。之后需要的话跟我说一声，我再起草。`);
      return a;
    });
  }
  rollback(eventId: ID) {
    return this.run(async (s) => {
      this.useLLM(1);
      const r = await rollbackTo(s, eventId, this.brains.assess);
      const cardId = s.events.find((e) => e.id === eventId)?.workCardId;
      if (cardId) pushChat(s, cardId, "agent", `已回到那个时间点的状态。${r.stillChanged.length ? `不过${r.stillChanged.join("，")}，我已经重新检查过。` : ""}${r.cannotUndo.length ? `你已经发出去的（${r.cannotUndo.join("、")}）回不到之前，需要的话我可以起草更正。` : ""}`);
      return r;
    });
  }

  grant(g: { source: "local_folder" | "calendar"; scopeLabel: string; filter: Record<string, unknown>; permissions: ("read" | "watch")[] }) {
    return this.run((s) => {
      const id = newId("g");
      s.grants[id] = { id, ...g, grantedAt: new Date().toISOString() };
      emit(s, { type: "grant_given", actor: "user", summary: `你允许我${g.scopeLabel}`, payload: { grantId: id } });
      return s.grants[id]!;
    });
  }

  revoke(grantId: ID) {
    return this.run((s) => {
      const g = s.grants[grantId];
      if (!g) throw new Error("授权不存在");
      g.revokedAt = new Date().toISOString();
      emit(s, { type: "grant_revoked", actor: "user", summary: `你收回了授权：${g.scopeLabel}`, payload: { grantId } });
    });
  }
}

export class WorkspaceManager {
  private open = new Map<string, Workspace>();
  constructor(private dir: string, private brains: Brains, private limit: number) {}

  private path(id: string) {
    if (!/^[a-z0-9]{12}$/.test(id)) throw new Error("工作区链接无效");
    return join(this.dir, `${id}.json`);
  }

  async create(from?: AgentState): Promise<Workspace> {
    await mkdir(this.dir, { recursive: true });
    const id = randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(12, "0").slice(0, 12);
    const state = from ?? emptyState(this.brains.modelInfo);
    if (from) emit(state, { type: "imported", actor: "user", summary: `从导出的状态续接（上次使用 ${from.model.provider}/${from.model.name}）`, payload: {} });
    if (from && (from.model.provider !== this.brains.modelInfo.provider || from.model.name !== this.brains.modelInfo.name)) {
      emit(state, { type: "model_switched", actor: "agent", summary: `换成 ${this.brains.modelInfo.name} 继续，工作状态原样保留`, payload: { from: from.model, to: this.brains.modelInfo } });
      state.model = this.brains.modelInfo;
    }
    const ws = new Workspace(id, state, new FileStore(this.path(id)), this.brains, this.limit);
    await ws.run(() => undefined);
    this.open.set(id, ws);
    return ws;
  }

  async get(id: string): Promise<Workspace | null> {
    const hit = this.open.get(id);
    if (hit) return hit;
    const store = new FileStore(this.path(id));
    const state = await store.load();
    if (!state) return null;
    const ws = new Workspace(id, state, store, this.brains, this.limit);
    this.open.set(id, ws);
    return ws;
  }

  async remove(id: string) {
    this.open.delete(id);
    await rm(this.path(id), { force: true });
  }

  async list(): Promise<string[]> {
    try { return (await readdir(this.dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch { return []; }
  }
}
