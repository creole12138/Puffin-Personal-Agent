/**
 * 演示种子状态：Q4 规划（与 Claude Design 原型一致）。
 * 周一用户确认"主推方案 A"，前提是预算 50 万；周二小王发来预算表 v3（30 万）。
 */
import { emit } from "./engine/events.ts";
import { emptyState } from "./engine/store.ts";
import type { AgentState } from "./types.ts";

const T = (d: string) => `2026-09-${d}:00+08:00`;

export function seedQ4(): AgentState {
  const s = emptyState();

  s.evidence = {
    ev_chat: { id: "ev_chat", source: "local_folder", ref: "对齐材料/alex-chat-0918-0925.txt", title: "与 Alex 的聊天记录（9/18–9/25）",
      excerpt: "Alex 9/24：资源先给留存。方案 A 覆盖面更全，但要 45 万左右；B 大概 28 万。", observedAt: T("25T18:00") },
    ev_budget_v2: { id: "ev_budget_v2", source: "local_folder", ref: "对齐材料/预算表-v2.csv", title: "预算表 v2",
      excerpt: "Q4 总预算：50 万", observedAt: T("26T10:00") },
    ev_user: { id: "ev_user", source: "user_input", ref: "chat", title: "你说的", excerpt: "和 Alex 还有一些工作一直没对齐", observedAt: T("28T09:00") },
  };

  s.grants = {
    g_folder: { id: "g_folder", source: "local_folder", scopeLabel: "读取「对齐材料」文件夹 · 仅本项目 · 不对外发送",
      filter: { dir: "demo-workspace/对齐材料", where: "example" }, projectId: "p_q4", permissions: ["read", "watch"], grantedAt: T("28T09:05") },
  };

  s.premises = {
    pr_budget: { id: "pr_budget", label: "Q4 预算", value: "50 万", confirmed: true, evidenceIds: ["ev_budget_v2"], history: [], projectId: "p_q4" },
    pr_focus: { id: "pr_focus", label: "Q4 主线", value: "先做留存", confirmed: true, evidenceIds: ["ev_chat"], history: [], projectId: "p_q4" },
    pr_design: { id: "pr_design", label: "设计资源", value: "Q4 可用", confirmed: false, evidenceIds: [], history: [], projectId: "p_q4" },
  };

  s.projects = {
    p_q4: { id: "p_q4", name: "Q4 规划", goal: "10 月底前定下 Q4 主线、预算和人力",
      premiseIds: ["pr_budget", "pr_focus", "pr_design"], workCardIds: ["wc_alex", "wc_budget", "wc_retention", "wc_hc"], createdAt: T("28T09:00") },
  };

  s.decisions = {
    d_planA: { id: "d_planA", workCardId: "wc_alex", statement: "主推方案 A（需 45 万）",
      premiseIds: ["pr_budget", "pr_focus"], dependentDecisionIds: ["d_retScope"], derivedActionIds: ["a_sendAlex", "a_noteLi"],
      status: "valid", reversalCost: "high", confidence: "medium",
      provenance: { confirmedBy: "user", evidenceIds: ["ev_chat", "ev_budget_v2"], at: T("28T10:00") },
      suggestion: { statement: "改推方案 B（需 28 万）", tradeoff: "留存目标延后一个月" } },
    d_retScope: { id: "d_retScope", workCardId: "wc_retention", statement: "留存专项按方案 A 的范围设计",
      premiseIds: ["pr_focus", "pr_design"], dependentDecisionIds: [], derivedActionIds: [],
      status: "valid", reversalCost: "low", confidence: "medium",
      provenance: { confirmedBy: "agent", evidenceIds: ["ev_chat"], at: T("28T10:05") } },
  };

  s.actions = {
    a_sendAlex: { id: "a_sendAlex", workCardId: "wc_alex", label: "发给 Alex 的方案 A 对比材料", status: "planned",
      external: true, reversible: false, dependsOnDecisionIds: ["d_planA"], grantId: "g_folder" , output: { kind: "message", to: "Alex", title: "Q4 方案 A / B 对比", body: "Alex，方案 A 和 B 的对比整理好了：\n\n· 方案 A：覆盖面更全，预计 45 万左右\n· 方案 B：约 28 万，先覆盖核心留存场景\n\n按 Q4 总预算 50 万，A 能放下，余量 5 万。结合你说的先做留存，建议主推 A。财务数据小王周二给，到时我再核一遍数字。" } },
    a_costTable: { id: "a_costTable", workCardId: "wc_alex", label: "成本对比表（按预算计算）", status: "done",
      external: false, reversible: true, dependsOnDecisionIds: [], premiseIds: ["pr_budget"] , output: { kind: "document", title: "成本对比表（按预算计算）", body: "项目            方案 A      方案 B\n预计成本        45 万       28 万\n占 Q4 预算      90%         56%\n预算余量        5 万        22 万\n覆盖范围        完整留存    核心留存\n\n计算依据：Q4 总预算 50 万（预算表 v2）" } },
    a_noteLi: { id: "a_noteLi", workCardId: "wc_alex", label: "发给小李的初版预算说明", status: "done",
      external: true, reversible: false, dependsOnDecisionIds: ["d_planA"] , output: { kind: "message", to: "小李", title: "Q4 初版预算说明", body: "小李，Q4 初版预算先按总额 50 万来排，重点放在留存项目上，目前倾向方案 A（约 45 万）。等财务数据确认后我再同步最终版。" } },
    a_budgetReq: { id: "a_budgetReq", workCardId: "wc_budget", label: "季度预算申请总额", status: "done",
      external: false, reversible: true, dependsOnDecisionIds: [], premiseIds: ["pr_budget"] , output: { kind: "document", title: "季度预算申请总额", body: "Q4 预算申请总额：50 万\n\n其中留存专项预计 45 万（方案 A），其余 5 万作为机动。" } },
  };

  const card = (id: string, title: string, stage: AgentState["workCards"][string]["stage"], extra: Partial<AgentState["workCards"][string]> = {}) => ({
    id, projectId: "p_q4", stage, title, decisionIds: [], actionIds: [], premiseIds: [], openQuestions: [], reminders: [],
    originEvidenceIds: [], createdAt: T("28T09:00"), updatedAt: T("28T10:00"), ...extra,
  });
  s.workCards = {
    wc_alex: card("wc_alex", "和 Alex 对齐 Q4 优先级", "active", {
      goal: "就 Q4 先做什么达成一致", status: "方案 A 对比已完成，正在做 B", nextStep: "整理方案 A / B 对比", waitingOn: "财务数据（小王说周二给）",
      decisionIds: ["d_planA"], actionIds: ["a_sendAlex", "a_costTable", "a_noteLi"], premiseIds: ["pr_budget", "pr_focus"],
      originEvidenceIds: ["ev_user", "ev_chat"],
      reminders: [{ id: "r_meet", at: "2026-10-01T10:00:00+08:00", reason: "周四 10:00 对齐会，提前一天准备材料", kind: "deadline", premiseIds: [] }] }),
    wc_budget: card("wc_budget", "季度预算申请", "active", { actionIds: ["a_budgetReq"], premiseIds: ["pr_budget"],
      reminders: [{ id: "r_budget", at: "2026-10-02T18:00:00+08:00", reason: "周五提交，总额随预算前提变化", kind: "deadline", premiseIds: ["pr_budget"] }] }),
    wc_retention: card("wc_retention", "留存专项方案", "draft", { decisionIds: ["d_retScope"], premiseIds: ["pr_focus", "pr_design"] }),
    wc_hc: card("wc_hc", "招聘 HC 确认", "active", { waitingOn: "HR 回复（承诺周三）" }),
  };

  s.chats = {
    wc_alex: [
      { role: "user", text: "和 Alex 还有一些工作一直没对齐", at: T("28T09:00") },
      { role: "agent", text: "记下了，也从聊天记录里理了一版。", at: T("28T09:02") },
      { role: "agent", text: "方案 A 的对比已完成，正在做 B。财务数据小王说周二给。", at: T("28T15:30") },
    ],
  };
  const at = [T("28T09:00"), T("28T09:05"), T("28T10:00"), T("28T15:30")];
  emit(s, { type: "card_created", actor: "agent", workCardId: "wc_alex", projectId: "p_q4", summary: "根据你说的和聊天记录，整理出这张工作卡" });
  emit(s, { type: "grant_given", actor: "user", projectId: "p_q4", summary: "你允许我读取「对齐材料」文件夹（只用于 Q4 规划，只读）", payload: { grantId: "g_folder" } });
  emit(s, { type: "decision_made", actor: "user", workCardId: "wc_alex", summary: "你决定主推方案 A", payload: { decisionId: "d_planA" } });
  emit(s, { type: "external_action_executed", actor: "agent", workCardId: "wc_alex", summary: "初版预算说明已发给小李", payload: { actionId: "a_noteLi" } });
  s.events.forEach((e, k) => { if (at[k]) e.at = at[k]!; });
  return s;
}
