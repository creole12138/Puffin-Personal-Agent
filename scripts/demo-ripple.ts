/**
 * 命令行跑通闭环：放入新预算表 → 识别前提变化 → 标出受影响项 → 用户决定。
 *   npm run demo:ripple            # 规则判断（不联网）
 *   npm run demo:ripple -- --llm   # 用 .env 里的模型判断（gpt-6-sol）
 */
import "./env.ts";
import {
  applyPremiseChange, createProvider, FileStore, llmAssessor, providerConfigFromEnv,
  ReplayProvider, resolveDecision, ruleAssessor, seedQ4, type AgentState,
} from "../app/core/src/index.ts";

const useLLM = process.argv.includes("--llm");
const who: Record<string, string> = { user: "你", agent: "Agent", watcher: "Agent 发现" };
const label: Record<string, string> = { needs_user: "需要你决定", paused: "已暂停", auto_updated: "已自动更新", compensate: "无法撤回·已起草补救", unaffected: "仍然成立" };

function name(s: AgentState, kind: string, id: string) {
  if (kind === "decision") return s.decisions[id]?.statement;
  if (kind === "action") return s.actions[id]?.label;
  return Object.values(s.workCards).flatMap((c) => c.reminders).find((r) => r.id === id)?.reason;
}

const s = seedQ4();
let assess = ruleAssessor;
if (useLLM) {
  const cfg = providerConfigFromEnv();
  const p = new ReplayProvider(createProvider(cfg), "data/llm-cache", (process.env.LLM_MODE as "live" | "record" | "replay") ?? "record");
  s.model = { provider: p.id, name: p.model };
  assess = llmAssessor(p);
  console.log(`模型：${p.id} / ${p.model}`);
} else console.log("模型：规则判断（加 --llm 使用 .env 中的模型）");

s.evidence.ev_v3 = { id: "ev_v3", source: "local_folder", ref: "对齐材料/预算表-v3.csv", title: "小王发来的预算表 v3",
  excerpt: "Q4 总预算：30 万", observedAt: new Date().toISOString(), supersedes: "ev_budget_v2" };
console.log("\n▶ 监听到新材料：对齐材料/预算表-v3.csv（Q4 总预算：30 万）");

const pc = await applyPremiseChange(s, { premiseId: "pr_budget", to: "30 万", evidenceId: "ev_v3", assess });
console.log(`\n前提变化：Q4 预算 ${pc.from} → ${pc.to}`);
for (const a of pc.assessments) console.log(`  判断「${s.decisions[a.decisionId]?.statement}」：${a.verdict} — ${a.reason}`);
for (const [h, t] of Object.entries(label)) {
  const items = pc.impacts.filter((i) => i.handling === h);
  if (!items.length) continue;
  console.log(`\n【${t}】`);
  for (const i of items) console.log(`  · [${s.workCards[i.workCardId]?.title}] ${name(s, i.kind, i.id)}`);
}
const sug = s.decisions.d_planA?.suggestion;
if (sug) console.log(`\n建议：${sug.statement}，代价：${sug.tradeoff}`);

if (s.decisions.d_planA?.status !== "valid" && sug) {
  console.log("\n▶ 用户选择：采用建议");
  resolveDecision(s, "d_planA", { kind: "adopt_suggestion" });
}
console.log("\n时间线：");
for (const e of s.events.filter((e) => e.visibleInTimeline)) console.log(`  [${who[e.actor]}] ${e.summary}`);

const store = new FileStore("data/state.json");
await store.save(s);
console.log("\n状态已保存到 data/state.json");
