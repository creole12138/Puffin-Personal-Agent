import type { AgentState, Event, EventType, ID } from "../types.ts";
import { newId, now } from "./ids.ts";
import { snapshotCard } from "./snapshot.ts";

/** 这些关键事件会自动附上当时的工作卡快照，用于时间线查看和"回到这里" */
const SNAPSHOT_TYPES = new Set<EventType>(["card_created", "card_stage_changed", "decision_made", "plan_confirmed", "rolled_back"]);

export interface EmitInput {
  type: EventType;
  actor: Event["actor"];
  summary: string;
  payload?: Record<string, unknown>;
  workCardId?: ID;
  projectId?: ID;
  visibleInTimeline?: boolean;
}

/** 所有状态变更都必须写事件：时间线、回退、续接都基于它 */
export function emit(state: AgentState, e: EmitInput): Event {
  const ev: Event = {
    id: newId("ev"),
    type: e.type,
    at: now(),
    actor: e.actor,
    visibleInTimeline: e.visibleInTimeline ?? true,
    summary: e.summary,
    payload: { ...(e.payload ?? {}), ...(e.workCardId && SNAPSHOT_TYPES.has(e.type) ? { snapshot: snapshotCard(state, e.workCardId) } : {}) },
    workCardId: e.workCardId,
    projectId: e.projectId,
  };
  state.events.push(ev);
  return ev;
}
