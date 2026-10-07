/**
 * 用 Pi 的 Agent 循环真实调用 .env 中的模型（gpt-6-sol），验证：
 * 1) Pi 能连上 OpenAI Responses API；2) 模型会调用工具；3) 对外发送被授权检查拦截。
 *   npm run pi:ping
 */
import "./env.ts";
import { Type } from "typebox";
import { createWorkAgent, piModelFromConfig, providerConfigFromEnv, seedQ4, type WorkTool } from "../app/core/src/index.ts";

const cfg = providerConfigFromEnv();
const state = seedQ4();
const tools: WorkTool[] = [
  { name: "read_material", label: "读取材料", description: "读取已授权文件夹「对齐材料」中的文件",
    parameters: Type.Object({ path: Type.String({ description: "如 对齐材料/预算表-v3.csv" }) }),
    requires: { permission: "read", source: "local_folder" },
    describe: (a, o) => o === "done" ? `读了《${String(a?.path ?? "").split("/").pop()}》` : `没能读到《${a?.path}》`,
    execute: async (_id, p: any) => ({ content: [{ type: "text", text: `${p.path}:\n项目,金额（万）\nQ4 总预算,30` }], details: {} }) },
  { name: "send_email", label: "发送邮件", description: "直接给某人发邮件",
    parameters: Type.Object({ to: Type.String(), body: Type.String() }), requires: { permission: "send", source: "email" },
    describe: (a) => `起草了给 ${a?.to} 的邮件，等你看过后由你发送`,
    execute: async () => { throw new Error("不应执行"); } },
];
const agent = createWorkAgent({
  state, tools, projectId: "p_q4", model: piModelFromConfig(cfg), getApiKey: () => cfg.apiKey,
  // 通用规范（prompts.ts）由 createWorkAgent 统一加在前面，这里只写本次任务
  systemPrompt: "先用工具读取材料，再按用户要求行动。用中文简短回答。",
  workState: { workCards: state.workCards, premises: state.premises, decisions: state.decisions, actions: state.actions },
});
agent.subscribe((e) => {
  if (e.type === "tool_execution_start") console.log(`→ 调用工具 ${e.toolName}`, JSON.stringify(e.args));
  if (e.type === "tool_execution_end") console.log(`← ${e.toolName} ${e.isError ? "被拦截/失败" : "完成"}`);
});
console.log(`Pi / ${cfg.provider} / ${cfg.model}`);
await agent.prompt("读一下 对齐材料/预算表-v3.csv，然后直接发邮件告诉 Alex 预算变了。");
const last = agent.state.messages.at(-1) as any;
if (agent.state.errorMessage) console.error("错误：", agent.state.errorMessage);
console.log("\nAgent：", last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""));
console.log("\n时间线（新增）："); for (const e of state.events.slice(4).filter((e) => e.visibleInTimeline)) console.log("  ·", e.summary);
