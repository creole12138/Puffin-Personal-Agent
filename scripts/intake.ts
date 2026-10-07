/**
 * 用任意材料 + 目标，让 gpt-6-sol 生成草稿工作卡。
 *   npm run intake -- "我要和 Alex 对齐 Q4 优先级" demo-workspace/对齐材料/*.txt demo-workspace/对齐材料/*.csv
 *   npm run intake -- "下个月搬家" ~/Downloads/租约.txt
 */
import "./env.ts";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { draftWorkCard, emptyState, piModelFromConfig, providerConfigFromEnv } from "../app/core/src/index.ts";

const [goal, ...files] = process.argv.slice(2);
if (!goal) { console.error('用法：npm run intake -- "目标" [材料文件...]'); process.exit(1); }
const cfg = providerConfigFromEnv();
const s = emptyState({ provider: cfg.provider, name: cfg.model });
const ids: string[] = [];
for (const [i, f] of files.entries()) {
  const id = `ev_${i + 1}`;
  s.evidence[id] = { id, source: "user_input", ref: f, title: basename(f), excerpt: (await readFile(f, "utf8")).slice(0, 12000), observedAt: new Date().toISOString() };
  ids.push(id);
}
console.log(`用 ${cfg.provider}/${cfg.model} 整理：${goal}（${ids.length} 份材料）…`);
const t0 = Date.now();
const r = await draftWorkCard(s, { goal, evidenceIds: ids, model: piModelFromConfig(cfg), getApiKey: () => cfg.apiKey });
console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，提交 ${r.attempts} 次`);
if (!r.card) { console.error("没有生成工作卡：", r.errors.join("；")); process.exit(1); }
const c = r.card;
const src = (ids: string[]) => ids.map((i) => s.evidence[i]?.title).join("、");
console.log(`\n【草稿】${c.title}\n目标：${c.goal}\n现状：${c.status}\n下一步：${c.nextStep}${c.waitingOn ? `\n等待：${c.waitingOn}` : ""}`);
console.log("\n前提：");
for (const id of c.premiseIds) { const p = s.premises[id]!; console.log(`  · ${p.label}：${p.value}${p.confirmed ? "" : "（未确认）"} — 来自 ${src(p.evidenceIds)}`); }
console.log("决策：");
for (const id of c.decisionIds) { const d = s.decisions[id]!;
  console.log(`  · ${d.statement}  ← 依赖 ${d.premiseIds.map((p) => s.premises[p]?.label).join("、") || "—"}${d.suggestion ? `｜备选：${d.suggestion.statement}（${d.suggestion.tradeoff}）` : ""}`); }
console.log("动作：");
for (const id of c.actionIds) { const a = s.actions[id]!; console.log(`  · ${a.label}${a.external ? "（对外）" : ""} [${a.status}]`); }
if (c.openQuestions.length) { console.log("请确认："); for (const q of c.openQuestions) console.log(`  ? ${q.question}  [${q.options.join(" / ")}]`); }
console.log("\n时间线："); for (const e of s.events.filter((e) => e.visibleInTimeline)) console.log("  ·", e.summary);
