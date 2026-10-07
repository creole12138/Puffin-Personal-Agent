import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmProposal, markCorrected, propose, ruleAssessor, seedQ4 } from "../src/index.ts";

const ev = (s: ReturnType<typeof seedQ4>, id = "ev_x") => { s.evidence[id] = { id, source: "user_input", ref: "upload", title: "预算表 v3", excerpt: "Q4 总预算,30", observedAt: new Date().toISOString() }; return id; };

test("新材料：会推翻你确认过的决定、碰到已发出的消息 → 先问；预先起草更正；确认后才生效", async () => {
  const s = seedQ4();
  const p = await propose(s, { premiseId: "pr_budget", to: "30 万", source: "material", evidenceId: ev(s), reason: "预算表 v3", confidence: "high", assess: ruleAssessor });
  assert.ok(p);
  assert.equal(p!.mode, "ask");
  assert.equal(p!.gateReason, "会推翻你确认过的决定");
  assert.equal(p!.drafts.length, 1);                       // 发给小李的说明需要更正
  assert.equal(p!.drafts[0]!.forActionId, "a_noteLi");
  assert.equal(s.premises.pr_budget!.value, "50 万");       // 还没生效
  assert.equal(s.decisions.d_planA!.status, "valid");

  await confirmProposal(s, p!.id);
  assert.equal(s.premises.pr_budget!.value, "30 万");
  assert.equal(s.premises.pr_budget!.confirmed, true);
  assert.equal(s.decisions.d_planA!.status, "invalidated");
  const fix = Object.values(s.actions).find((a) => a.compensationFor === "a_noteLi")!;
  assert.ok(fix.output?.body.includes("30 万"));          // 起草好的更正挂到了补救动作上
  assert.ok(fix.approvedAt);
  assert.equal(s.proposals![p!.id]!.status, "confirmed");
});

test("推断：把握高、只影响 Agent 自己整理的内容 → 直接生效，标为推断，可纠正", async () => {
  const s = seedQ4();
  const p = await propose(s, { premiseId: "pr_design", to: "Q4 不可用", source: "inference", evidenceId: ev(s), reason: "设计说排期满了", confidence: "high", assess: ruleAssessor });
  assert.equal(p!.mode, "auto");
  assert.equal(s.premises.pr_design!.value, "Q4 不可用");
  assert.equal(s.premises.pr_design!.inferred?.proposalId, p!.id);
  assert.ok(s.events.some((e) => e.summary.startsWith("我推断设计资源也变成了 Q4 不可用")));
  markCorrected(s, "pr_design");                            // 用户纠正
  assert.equal(s.premises.pr_design!.inferred, undefined);
  assert.equal(s.proposals![p!.id]!.status, "corrected");
});

test("推断：把握中等 → 先问；把握低 → 不提", async () => {
  const s = seedQ4();
  const mid = await propose(s, { premiseId: "pr_design", to: "Q4 不可用", source: "inference", evidenceId: ev(s), reason: "r", confidence: "medium", assess: ruleAssessor });
  assert.equal(mid!.mode, "ask");
  assert.equal(mid!.gateReason, "我把握不够高");
  assert.equal(s.premises.pr_design!.value, "Q4 可用");
  const low = await propose(s, { premiseId: "pr_focus", to: "先做拉新", source: "inference", evidenceId: ev(s), reason: "r", confidence: "low", assess: ruleAssessor });
  assert.equal(low, null);
});

test("用户明说：即使会推翻已确认的决定，也直接生效（是事实，不是推断）", async () => {
  const s = seedQ4();
  const p = await propose(s, { premiseId: "pr_budget", to: "30 万", source: "user", evidenceId: ev(s), reason: "你说的", confidence: "high", assess: ruleAssessor });
  assert.equal(p!.mode, "auto");
  assert.equal(s.premises.pr_budget!.value, "30 万");
  assert.equal(s.decisions.d_planA!.status, "invalidated");
  assert.equal(s.premises.pr_budget!.inferred, undefined);
});

test("同一前提的新提议会取代旧的待确认提议", async () => {
  const s = seedQ4();
  const a = await propose(s, { premiseId: "pr_budget", to: "30 万", source: "material", evidenceId: ev(s), reason: "r", confidence: "high", assess: ruleAssessor });
  const b = await propose(s, { premiseId: "pr_budget", to: "35 万", source: "material", evidenceId: ev(s, "ev_y"), reason: "r", confidence: "high", assess: ruleAssessor });
  assert.equal(s.proposals![a!.id]!.status, "corrected");
  assert.equal(s.proposals![b!.id]!.status, "pending");
});
