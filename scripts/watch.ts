/**
 * 监听授权文件夹：新材料 → 证据 → 判断前提是否变化 → 涟漪 → 保存状态。
 *   npm run watch            # 规则判断
 *   npm run watch -- --llm   # gpt-6-sol 判断
 *   npm run watch -- --reset # 从演示种子重新开始
 * 另开终端：cp demo-workspace/待投放/预算表-v3.csv demo-workspace/对齐材料/
 */
import { brains } from "./harness.ts";
import {
  applyPremiseChange, emit, FileStore, LocalFolderSource, seedQ4, type AgentState, type Evidence,
} from "../app/core/src/index.ts";

const useLLM = process.argv.includes("--llm");
const store = new FileStore("data/state.json");
const b = brains(useLLM);
let state: AgentState = (!process.argv.includes("--reset") && (await store.load())) || seedQ4();
if (b.provider) state.model = { provider: b.provider.id, name: b.provider.model };

const grant = state.grants.g_folder!;
const src = new LocalFolderSource("demo-workspace", Object.values(state.evidence).filter((e) => e.source === "local_folder"));
const label: Record<string, string> = { needs_user: "需要你决定", paused: "已暂停", auto_updated: "已自动更新", compensate: "无法撤回·已起草补救", unaffected: "仍然成立" };

let queue = Promise.resolve();
async function handle(ev: Evidence) {
  state.evidence[ev.id] = ev;
  emit(state, { type: "evidence_observed", actor: "watcher", projectId: grant.projectId, visibleInTimeline: false,
    summary: ev.supersedes ? `收到《${ev.title}》，它是《${state.evidence[ev.supersedes]?.title ?? "旧版本"}》的新版本` : `收到新材料《${ev.title}》`, payload: { evidenceId: ev.id, supersedes: ev.supersedes } });
  console.log(`\n▶ 发现新材料：${ev.ref}${ev.supersedes ? `（替代 ${state.evidence[ev.supersedes]?.title ?? ev.supersedes}）` : ""}`);

  const matches = await b.match(state, ev);
  if (!matches.length) { console.log("  没有改变任何前提。"); await store.save(state); return; }
  for (const m of matches) {
    const p = state.premises[m.premiseId]!;
    console.log(`  前提「${p.label}」：${p.value} → ${m.newValue}（依据：“${m.quote}”，置信度 ${m.confidence}）`);
    const pc = await applyPremiseChange(state, { premiseId: m.premiseId, to: m.newValue, evidenceId: ev.id, assess: b.assess });
    for (const a of pc.assessments) console.log(`  判断「${state.decisions[a.decisionId]?.statement}」：${a.verdict} — ${a.reason}`);
    for (const [h, t] of Object.entries(label)) {
      const items = pc.impacts.filter((i) => i.handling === h);
      if (!items.length) continue;
      console.log(`  【${t}】`);
      for (const i of items) {
        const n = i.kind === "decision" ? state.decisions[i.id]?.statement : i.kind === "action" ? state.actions[i.id]?.label
          : Object.values(state.workCards).flatMap((c) => c.reminders).find((r) => r.id === i.id)?.reason;
        console.log(`    · [${state.workCards[i.workCardId]?.title}] ${n}`);
      }
    }
    for (const a of pc.assessments) if (a.suggestion) console.log(`  建议：${a.suggestion.statement}（代价：${a.suggestion.tradeoff}）`);
  }
  await store.save(state);
  console.log("  状态已保存。");
}

console.log(`判断：${b.label}`);
console.log(`授权：${grant.scopeLabel}`);
for (const ev of await src.read(grant)) await handle(ev);
await store.save(state);
src.watch(grant, (ev) => { queue = queue.then(() => handle(ev)).catch((e) => console.error("处理失败：", e.message)); });
console.log(`监听中：${grant.filter.dir}（Ctrl+C 退出）`);
