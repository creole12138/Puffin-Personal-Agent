import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { createWorkAgent, type WorkTool } from "../src/harness/workAgent.ts";
import { seedQ4 } from "../src/index.ts";

test("Pi 循环 + 授权检查：读取放行，对外发送被拦截，事件入日志", async () => {
  const state = seedQ4();
  const before = state.events.length;
  const reads: string[] = [];
  const tools: WorkTool[] = [
    { name: "read_material", label: "读取材料", description: "读取授权文件夹里的材料",
      parameters: Type.Object({ path: Type.String() }), requires: { permission: "read", source: "local_folder" },
      execute: async (_id, p: any) => { reads.push(p.path); return { content: [{ type: "text", text: "Q4 总预算,30" }], details: {} }; } },
    { name: "send_message", label: "发送消息", description: "给别人发消息",
      parameters: Type.Object({ to: Type.String(), text: Type.String() }), requires: { permission: "send", source: "email" },
      execute: async () => { throw new Error("不应被执行"); } },
  ];
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read_material", { path: "对齐材料/预算表-v3.csv" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("send_message", { to: "Alex", text: "预算降了" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("已起草给 Alex 的说明，等你确认后发送。")]),
  ]);
  const agent = createWorkAgent({ state, model: faux.getModel(), tools, systemPrompt: "test", projectId: "p_q4" });
  await agent.prompt("看看新预算表，然后告诉 Alex");
  faux.unregister();

  assert.deepEqual(reads, ["对齐材料/预算表-v3.csv"]);
  const newEvents = state.events.slice(before).map((e) => e.summary);
  const drafted = state.events.slice(before).filter((e) => e.payload.outcome === "drafted");
  assert.equal(drafted.length, 1, "被拦截的对外动作只记一条");
  assert.ok(!newEvents.some((s) => /send_message|工具|拦截/.test(s)), "时间线不出现技术用语");
  const toolResults = agent.state.messages.filter((m: any) => m.role === "toolResult") as any[];
  assert.equal(toolResults.length, 2);
  assert.equal(toolResults[1].isError, true);
  const last = agent.state.messages.at(-1) as any;
  assert.match(last.content[0].text, /起草/);
});

test("撤销授权后，读取也会被拦截", async () => {
  const state = seedQ4();
  state.grants.g_folder!.revokedAt = new Date().toISOString();
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("read_material", { path: "x" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("需要你重新授权。")]),
  ]);
  let ran = false;
  const agent = createWorkAgent({ state, model: faux.getModel(), systemPrompt: "t", projectId: "p_q4", tools: [
    { name: "read_material", label: "读", description: "读", parameters: Type.Object({ path: Type.String() }),
      requires: { permission: "read", source: "local_folder" }, execute: async () => { ran = true; return { content: [], details: {} }; } }] });
  await agent.prompt("读一下");
  faux.unregister();
  assert.equal(ran, false);
  assert.ok(state.events.some((e) => e.summary.startsWith("需要你允许我读取材料文件夹")));
});

test("所有 Agent 调用都以通用规范为基础，任务指令叠加在后", () => {
  const faux = registerFauxProvider();
  const agent = createWorkAgent({ state: seedQ4(), model: faux.getModel(), tools: [], systemPrompt: "整理工作卡的任务指令", projectId: "p_q4" });
  faux.unregister();
  const sp = agent.state.systemPrompt;
  assert.ok(sp.indexOf("持续协作型工作 Agent") < sp.indexOf("【本次任务】"));
  assert.ok(sp.indexOf("【本次任务】") < sp.indexOf("整理工作卡的任务指令"));
  assert.match(sp, /p_q4/);
});

test("对话工具：前提值必须简短具体；新事实用 add_premise 记下", async () => {
  const { cardTools, ruleAssessor } = await import("../src/index.ts");
  const state = seedQ4();
  const tools = cardTools({ state, cardId: "wc_alex", assess: ruleAssessor, userText: "面试推迟到周六了" });
  const update = tools.find((t) => t.name === "update_premise")!;
  const add = tools.find((t) => t.name === "add_premise")!;
  await assert.rejects(update.execute("1", { premiseId: "pr_budget", newValue: "面试改到周六；作业截止是否随之改变尚未确认", userQuote: "x" }), /不是一个简短具体的值/);
  assert.equal(state.premises.pr_budget!.value, "50 万");
  await add.execute("2", { label: "面试时间", value: "周六", userQuote: "面试推迟到周六了", affectsDecisionIds: ["d_planA"] });
  const p = Object.values(state.premises).find((x) => x.label === "面试时间")!;
  assert.equal(p.value, "周六");
  assert.ok(state.workCards.wc_alex!.premiseIds.includes(p.id));
  assert.ok(state.decisions.d_planA!.premiseIds.includes(p.id));
});

test("userQuote 必须出自本轮用户消息，编造的原话降级为推断、先问用户", async () => {
  const { cardTools, ruleAssessor, quoteInUserText } = await import("../src/index.ts");
  assert.ok(quoteInUserText("预算砍到 30 万；方案 A 不做了", "跟你说下，预算砍到30万了，方案A不做了"));
  assert.ok(!quoteInUserText("预算砍到 5 万", "Alex 那边有什么进展"));
  assert.ok(!quoteInUserText("预算砍到 5 万", undefined));
  const state = seedQ4();
  const before = state.premises.pr_budget!.value, decStatus = state.decisions.d_planA!.status;
  const made: any[] = [];
  const tools = cardTools({ state, cardId: "wc_alex", assess: ruleAssessor, userText: "Alex 那边有什么进展", onProposal: (p) => made.push(p) });
  const r = await tools.find((t) => t.name === "update_premise")!.execute("1", { premiseId: "pr_budget", newValue: "5 万", userQuote: "用户原话：预算砍到 5 万" });
  assert.match((r.content[0] as any).text, /找不到/);
  assert.equal(state.premises.pr_budget!.value, before, "前提没有被直接改掉");
  assert.equal(state.decisions.d_planA!.status, decStatus, "确认过的决定没有被判失效");
  assert.equal(made.length, 1); assert.equal(made[0].source, "inference"); assert.equal(made[0].mode, "ask");
  await assert.rejects(tools.find((t) => t.name === "add_premise")!.execute("2", { label: "新预算", value: "5 万", userQuote: "预算砍到 5 万", affectsDecisionIds: [] }), /找不到/);
});
