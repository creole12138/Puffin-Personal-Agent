import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPremiseChange, computeImpacts, resolveDecision, ruleAssessor, seedQ4 } from "../src/index.ts";

const handlingOf = (impacts: { id: string; handling: string }[], id: string) => impacts.find((i) => i.id === id)?.handling;

test("预算 50→30 万：影响按撤回成本分级", async () => {
  const s = seedQ4();
  s.evidence.ev_v3 = { id: "ev_v3", source: "local_folder", ref: "预算表-v3.csv", title: "预算表 v3", excerpt: "Q4 总预算：30 万", observedAt: new Date().toISOString(), supersedes: "ev_budget_v2" };
  const pc = await applyPremiseChange(s, { premiseId: "pr_budget", to: "30 万", evidenceId: "ev_v3", assess: ruleAssessor });

  assert.equal(handlingOf(pc.impacts, "d_planA"), "needs_user");
  assert.equal(handlingOf(pc.impacts, "d_retScope"), "paused");      // 下游决策，跨工作卡
  assert.equal(handlingOf(pc.impacts, "a_sendAlex"), "paused");      // 未执行的外部动作
  assert.equal(handlingOf(pc.impacts, "a_costTable"), "auto_updated");
  assert.equal(handlingOf(pc.impacts, "a_budgetReq"), "auto_updated"); // 同项目另一张卡
  assert.equal(handlingOf(pc.impacts, "a_noteLi"), "compensate");    // 已执行外部动作
  assert.equal(handlingOf(pc.impacts, "r_budget"), "auto_updated");

  assert.equal(s.decisions.d_planA!.status, "invalidated");
  assert.equal(s.actions.a_sendAlex!.status, "paused");
  assert.equal(s.premises.pr_budget!.value, "30 万");
  assert.equal(s.premises.pr_budget!.history.at(-1)!.value, "50 万");
  assert.ok(Object.values(s.actions).some((a) => a.compensationFor === "a_noteLi"));
});

test("预算仍够时，决策不受影响", async () => {
  const s = seedQ4();
  const pc = await applyPremiseChange(s, { premiseId: "pr_budget", to: "48 万", evidenceId: "ev_budget_v2", assess: ruleAssessor });
  assert.equal(handlingOf(pc.impacts, "d_planA"), "unaffected");
  assert.equal(handlingOf(pc.impacts, "a_sendAlex"), undefined);
  assert.equal(s.decisions.d_planA!.status, "valid");
});

test("采用替代建议：旧决策被替代，暂停动作取消，下游恢复", async () => {
  const s = seedQ4();
  await applyPremiseChange(s, { premiseId: "pr_budget", to: "30 万", evidenceId: "ev_budget_v2", assess: ruleAssessor });
  const next = resolveDecision(s, "d_planA", { kind: "adopt_suggestion" });
  assert.equal(next.statement, "改推方案 B（需 28 万）");
  assert.equal(s.decisions.d_planA!.status, "superseded");
  assert.equal(s.actions.a_sendAlex!.status, "cancelled");
  assert.equal(s.decisions.d_retScope!.status, "valid");
  assert.ok(Object.values(s.premiseChanges).every((p) => p.resolvedAt));
});

test("computeImpacts 是纯函数，不改状态", () => {
  const s = seedQ4();
  const before = JSON.stringify(s);
  computeImpacts(s, "pr_budget", [{ decisionId: "d_planA", verdict: "invalidated", reason: "x" }]);
  assert.equal(JSON.stringify(s), before);
});
