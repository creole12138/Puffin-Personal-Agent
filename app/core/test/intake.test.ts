import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { applyPremiseChange, draftWorkCard, emptyState, ruleAssessor, validateDraft, type WorkCardDraft } from "../src/index.ts";

/** 与 Q4 无关的新场景：搬家 */
function moveState() {
  const s = emptyState();
  s.evidence.ev_lease = { id: "ev_lease", source: "user_input", ref: "upload", title: "新租约.txt",
    excerpt: "起租日 10 月 15 日。搬家公司报价 3000 元，需提前一周预约。", observedAt: new Date().toISOString() };
  return s;
}
const good: WorkCardDraft = {
  title: "10 月中搬进新家", goal: "10 月 15 日前完成搬家", status: "租约已签，搬家公司未约", nextStep: "预约搬家公司",
  waitingOn: null,
  premises: [{ key: "p1", label: "起租日", value: "10 月 15 日", confirmed: true, evidenceIds: ["ev_lease"], quote: "起租日 10 月 15 日" }],
  decisions: [{ key: "d1", statement: "10 月 14 日搬家", premiseKeys: ["p1"], dependsOnDecisionKeys: [], reversalCost: "low",
    confidence: "medium", evidenceIds: ["ev_lease"], alternative: null }],
  actions: [{ key: "a1", label: "预约搬家公司（10 月 14 日）", status: "planned", external: true, dependsOnDecisionKeys: ["d1"], premiseKeys: [] }],
  openQuestions: [{ question: "旧房什么时候退？", options: ["10 月 14 日", "月底"], premiseKey: null }],
};

test("校验能发现编造的引用", () => {
  const s = moveState();
  const bad = structuredClone(good);
  bad.decisions[0]!.premiseKeys = ["p9"];
  bad.premises[0]!.evidenceIds = ["ev_nope"];
  const errs = validateDraft(s, bad, new Set(["ev_lease"]));
  assert.ok(errs.some((e) => e.includes("p9")));
  assert.ok(errs.some((e) => e.includes("ev_nope")));
});

test("Pi 循环：第一次提交被退回，修正后生成草稿卡；新卡能参与影响传播", async () => {
  const s = moveState();
  const bad = structuredClone(good); bad.decisions[0]!.premiseKeys = ["p9"];
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read_material", { evidenceId: "ev_lease" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("submit_workcard", bad)], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("submit_workcard", good)], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("不应走到这里")]),
  ]);
  const r = await draftWorkCard(s, { goal: "我要搬家", evidenceIds: ["ev_lease"], model: faux.getModel() });
  faux.unregister();

  assert.equal(r.attempts, 2);
  assert.ok(r.card);
  assert.equal(r.card!.stage, "draft");
  assert.equal(r.card!.openQuestions.length, 1);
  const tl = s.events.filter((e) => e.visibleInTimeline).map((e) => e.summary);
  assert.ok(tl.some((t) => t.startsWith("根据《新租约.txt》整理出草稿「10 月中搬进新家」")));
  assert.ok(!tl.some((t) => /submit_workcard|read_material/.test(t)));

  // 起租日推迟 → 搬家决策需重新确认，预约暂停
  const premiseId = r.card!.premiseIds[0]!;
  const pc = await applyPremiseChange(s, { premiseId, to: "10 月 22 日", evidenceId: "ev_lease", assess: ruleAssessor });
  assert.equal(pc.impacts.find((i) => i.kind === "decision")?.handling, "needs_user");
  assert.equal(pc.impacts.find((i) => i.kind === "action")?.handling, "paused");
});

test("校验：必须有决策；不被依赖的前提、写成描述的值、“确认某事”的动作都会被退回", () => {
  const s = moveState();
  const bad = structuredClone(good);
  bad.decisions = [];
  bad.premises.push({ key: "p2", label: "作业材料", value: "用户提供了一份文档，但尚未确认它是否就是作业题目", confirmed: false, evidenceIds: ["ev_lease"], quote: "x" });
  bad.actions = [{ key: "a1", label: "确认作业题目和截止时间", status: "planned", external: false, dependsOnDecisionKeys: [], premiseKeys: [] }];
  const errs = validateDraft(s, bad, new Set(["ev_lease"])).join("\n");
  assert.match(errs, /至少给出 1 条决策/);
  assert.match(errs, /p2「作业材料」没有被任何决策或动作依赖/);
  assert.match(errs, /p2「作业材料」的值「/);
  assert.match(errs, /应放进 openQuestions/);
  assert.deepEqual(validateDraft(s, good, new Set(["ev_lease"])), []);
  const bad2 = structuredClone(good);
  bad2.premises[0]!.value = "用户所说的“明天”";
  bad2.actions[0]!.label = "向用户询问航班号";
  const e2 = validateDraft(s, bad2, new Set(["ev_lease"])).join("\n");
  assert.match(e2, /要写成简短具体的取值/);
  assert.match(e2, /应放进 openQuestions/);
});
