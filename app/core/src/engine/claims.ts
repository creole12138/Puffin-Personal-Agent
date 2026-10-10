/**
 * 说到做到：时间线上「已经做了 X」的事件，必须能在状态里核对到 X 真的发生了。
 *
 * 写事件时在 payload.claim 里附上可核对的断言；每次状态变更结束（Workspace.run 收尾）调用 verifyClaims：
 * 核对不过的事件从时间线撤下、标记 claimFailed，并补一条如实说明。这样任何一处「只发事件不执行」的 bug
 * 都不会以「已完成」的样子出现在用户面前，也会在日志里留下报错，方便发现。
 */
import type { AgentState, Event } from "../types.ts";
import { emit } from "./events.ts";

export type Claim =
  /** 产出已按新值重算：有对应这次变化的历史版本，且新正文写进了新值 */
  | { kind: "output_recomputed"; actionId: string; premiseChangeId: string; mustInclude: string }
  /** 起草了内容：动作上真的挂着产出 */
  | { kind: "has_output"; actionId: string }
  /** 动作状态已改 */
  | { kind: "action_status"; actionId: string; status: string }
  /** 前提已更新为某值 */
  | { kind: "premise_value"; premiseId: string; value: string }
  /** 提醒已调整：时间或理由和改之前不同 */
  | { kind: "reminder_changed"; reminderId: string; before: string };

const squash = (t: string) => t.replace(/\s+/g, "");

export function checkClaim(state: AgentState, c: Claim): boolean {
  switch (c.kind) {
    case "output_recomputed": {
      const a = state.actions[c.actionId];
      return !!a?.output && !!a.outputHistory?.some((h) => h.premiseChangeId === c.premiseChangeId) && squash(a.output.body).includes(squash(c.mustInclude));
    }
    case "has_output": return !!state.actions[c.actionId]?.output?.body?.trim();
    case "action_status": return state.actions[c.actionId]?.status === c.status;
    case "premise_value": return state.premises[c.premiseId]?.value === c.value;
    case "reminder_changed": {
      const r = Object.values(state.workCards).flatMap((w) => w.reminders).find((x) => x.id === c.reminderId);
      return !!r && `${r.at}｜${r.reason}` !== c.before;
    }
  }
}

/** 核对 since 之后新写入的事件；返回没做成的那些 */
export function verifyClaims(state: AgentState, since: number): Event[] {
  const failed: Event[] = [];
  for (const ev of state.events.slice(since)) {
    const c = ev.payload?.claim as Claim | undefined;
    if (!c || ev.payload.claimFailed || checkClaim(state, c)) continue;
    ev.payload.claimFailed = true;
    const wasVisible = ev.visibleInTimeline;
    ev.visibleInTimeline = false;
    failed.push(ev);
    console.error(`[claim] 事件声称已完成但状态里核对不到：${ev.summary} ${JSON.stringify(c)}`);
    if (wasVisible) emit(state, { type: ev.type, actor: "agent", workCardId: ev.workCardId, projectId: ev.projectId,
      summary: `刚才那步没有真正做成（${ev.summary.slice(0, 40)}），我先撤下了这条记录，需要的话可以在对话里让我重做`, payload: { correctsEventId: ev.id } });
  }
  return failed;
}
