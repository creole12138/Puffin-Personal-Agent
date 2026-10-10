import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cardTools, confirmProposal, FileStore, introducePremise, NEW_PREMISE, ruleAssessor, seedQ4, type Matcher } from "../src/index.ts";
import { Workspace } from "../../server/workspace.ts";
import type { Brains } from "../../server/brains.ts";

test("用户说出新约束（add_premise）：决策被重新检查，依赖它的动作暂停", async () => {
  const s = seedQ4();
  const tools = cardTools({ state: s, cardId: "wc_alex", assess: ruleAssessor, userText: "Alex 下周开始休假两周" });
  const out = await tools.find((t) => t.name === "add_premise")!.execute("1", { label: "Alex 休假", value: "下周起两周", userQuote: "Alex 下周开始休假两周", affectsDecisionIds: ["d_planA"] });
  const p = Object.values(s.premises).find((x) => x.label === "Alex 休假")!;
  assert.equal(p.value, "下周起两周");
  assert.equal(p.confirmed, true);
  assert.deepEqual(p.history, [], "占位值不进历史");
  assert.notEqual(s.decisions.d_planA!.status, "valid", "决策被重新判断");
  assert.equal(s.actions.a_sendAlex!.status, "paused", "依赖该决策的对外动作暂停");
  assert.match((out.content[0] as any).text, /影响/);
  assert.ok(s.events.some((e) => e.type === "premise_changed" && /新增了「Alex 休假」/.test(e.summary)), "时间线写的是『新增』而不是『从（原本没有）变成』");
});

test("材料里的新事实，把握低：不生成提议，临时前提撤掉不留痕", async () => {
  const s = seedQ4();
  const n = Object.keys(s.premises).length;
  const r = await introducePremise(s, { cardId: "wc_alex", label: "竞品降价", value: "8 折", evidenceId: "ev_chat", affectsDecisionIds: ["d_planA"],
    source: "material", confidence: "low", reason: "x", assess: ruleAssessor });
  assert.equal(r.proposal, null);
  assert.equal(Object.keys(s.premises).length, n);
  assert.ok(!s.decisions.d_planA!.premiseIds.some((id) => !s.premises[id]), "决策上不留悬空引用");
});

test("材料里的新事实，冲击用户确认过的决策：先问；确认后才生效", async () => {
  const s = seedQ4();
  const r = await introducePremise(s, { cardId: "wc_alex", label: "Alex 立场", value: "倾向方案 B", evidenceId: "ev_chat", affectsDecisionIds: ["d_planA"],
    source: "material", confidence: "high", reason: "x", assess: ruleAssessor });
  assert.equal(r.proposal!.mode, "ask");
  assert.equal(s.premises[r.premiseId!]!.value, NEW_PREMISE, "确认前不生效");
  assert.equal(s.decisions.d_planA!.status, "valid");
  await confirmProposal(s, r.proposal!.id);
  assert.equal(s.premises[r.premiseId!]!.value, "倾向方案 B");
  assert.notEqual(s.decisions.d_planA!.status, "valid");
});

test("新材料带来的新事实走进 Workspace.addMaterial：生成提议并在对话里说明", async () => {
  const s = seedQ4();
  const match: Matcher = async () => Object.assign([], { newFacts: [{ label: "#421 预计合入", value: "最早 10/20", quote: "最早 10/20 能合", confidence: "high" as const, affectsDecisionIds: ["d_planA"] }] });
  const brains: Brains = { provider: null, match, assess: ruleAssessor, model: null, getApiKey: () => undefined, modelInfo: { provider: "openai", name: "t" }, label: "t" };
  const dir = await mkdtemp(join(tmpdir(), "nf-"));
  const ws = new Workspace("nf0000000001", s, new FileStore(join(dir, "s.json")), brains, 99);
  const r = await ws.addMaterial({ title: "李想的消息", text: "#421 最早 10/20 能合" });
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0]!.change.from, NEW_PREMISE);
  assert.match(ws.state.chats!.wc_alex!.at(-1)!.text, /出现了一个新情况：#421 预计合入 = 最早 10\/20/);
});
