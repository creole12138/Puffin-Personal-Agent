/**
 * 工作卡 Agent = Pi Agent 循环 + 我们的状态层。
 *
 * Pi 负责：模型调用、流式输出、工具执行、多轮循环、中止/重试。
 * 我们在 Pi 的扩展点上加：
 *   beforeToolCall → 授权检查（渐进授权 H3）：没有对应 Grant 的工具调用被拦下，
 *                    对外动作（send）一律只允许起草；
 *   subscribe      → 把 Pi 的运行事件写进 AgentState.events（可审计、可续接）；
 *   tools          → 读取/修改工作状态的工具，而不是直接操作外部世界。
 */
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { emit } from "../engine/events.ts";
import { buildSystemPrompt } from "./prompts.ts";
import type { AgentState, Grant } from "../types.ts";

export type Permission = Grant["permissions"][number];

/** 每个工具声明自己需要的权限；没有声明的工具只读写内部状态，不需要授权 */
export interface WorkTool extends AgentTool<any> {
  requires?: { permission: Permission; source: Grant["source"] };
  /**
   * 用产品语言描述这次调用，写进时间线。
   * done：做完了；drafted：对外动作被改为起草；needs_grant：缺授权；failed：执行出错
   */
  describe?: (args: any, outcome: "done" | "drafted" | "needs_grant" | "failed") => string;
  /** 对外动作被改为起草时调用：把起草的内容保存下来，交给用户确认 */
  onDrafted?: (args: any) => void;
}

const SOURCE_NAME: Record<Grant["source"], string> = {
  user_input: "你提供的内容", local_folder: "材料文件夹", calendar: "日历", email: "邮箱",
};
const PERM_NAME: Record<Permission, string> = { read: "读取", watch: "持续关注", write: "修改", send: "代你发送" };

export interface WorkAgentOptions {
  state: AgentState;
  model: Model<Api>;
  tools: WorkTool[];
  /** 本次任务的指令；会叠加在通用规范（prompts.ts）之后 */
  systemPrompt: string;
  /** 注入给模型的当前工作状态摘要（可选） */
  workState?: unknown;
  projectId?: string;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
}

export function findGrant(state: AgentState, source: Grant["source"], permission: Permission, projectId?: string) {
  return Object.values(state.grants).find((g) =>
    g.source === source && !g.revokedAt && g.permissions.includes(permission)
    && (!g.expiresAt || g.expiresAt > new Date().toISOString())
    && (!projectId || !g.projectId || g.projectId === projectId));
}

export function createWorkAgent(o: WorkAgentOptions): Agent {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const blocked = new Map<string, "drafted" | "needs_grant">();
  const argsById = new Map<string, unknown>();
  const agent = new Agent({
    initialState: {
      systemPrompt: [
        buildSystemPrompt({ projectId: o.projectId, workState: o.workState, availableTools: o.tools }),
        "【本次任务】",
        o.systemPrompt.trim(),
      ].join("\n\n"),
      model: o.model, tools: o.tools, messages: [],
    },
    getApiKey: o.getApiKey,
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall, args }) => {
      const tool = byName.get(toolCall.name);
      const need = tool?.requires;
      if (!need) return undefined;
      if (need.permission === "send") {
        blocked.set(toolCall.id, "drafted");
        tool?.onDrafted?.(args);
        emit(o.state, { type: "action_status_changed", actor: "agent", projectId: o.projectId,
          summary: tool?.describe?.(args, "drafted") ?? `起草了「${tool?.label ?? toolCall.name}」，等你确认后由你发送`,
          payload: { tool: toolCall.name, args, outcome: "drafted" } });
        return { block: true, reason: tool?.onDrafted
          ? "已按规则改为起草并保存到工作卡上，等用户确认后由用户自己发送。不要重复起草，继续下一步。"
          : "对外发送未授权：请改为起草，交给用户确认后由用户自己发送。" };
      }
      const g = findGrant(o.state, need.source, need.permission, o.projectId);
      if (!g) {
        blocked.set(toolCall.id, "needs_grant");
        emit(o.state, { type: "action_status_changed", actor: "agent", projectId: o.projectId,
          summary: tool?.describe?.(args, "needs_grant") ?? `需要你允许我${PERM_NAME[need.permission]}${SOURCE_NAME[need.source]}，才能继续「${tool?.label ?? toolCall.name}」`,
          payload: { tool: toolCall.name, need, outcome: "needs_grant" } });
        return { block: true, reason: `没有 ${need.source} 的 ${need.permission} 授权。请向用户说明需要什么范围的授权及原因。` };
      }
      return undefined;
    },
  });

  agent.subscribe((ev) => {
    if (ev.type === "tool_execution_start") argsById.set(ev.toolCallId, ev.args);
    if (ev.type === "tool_execution_end") {
      // 被拦截的调用已在 beforeToolCall 里记过一条产品事件，这里不重复
      if (blocked.delete(ev.toolCallId)) return;
      const tool = byName.get(ev.toolName);
      const args = argsById.get(ev.toolCallId);
      const outcome = ev.isError ? "failed" : "done";
      const text = tool?.describe?.(args, outcome);
      emit(o.state, { type: "action_status_changed", actor: "agent", projectId: o.projectId,
        visibleInTimeline: Boolean(text) || ev.isError,
        summary: text ?? (ev.isError ? `「${tool?.label ?? ev.toolName}」没有完成，我会重试或换个办法` : `完成了「${tool?.label ?? ev.toolName}」`),
        payload: { toolCallId: ev.toolCallId, tool: ev.toolName, args, outcome } });
    }
  });
  return agent;
}
