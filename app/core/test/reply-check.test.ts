import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { ruleAssessor, ruleMatcher, seedQ4 } from "../src/index.ts";
import { chat } from "../../server/agentOps.ts";
import { collectFacts } from "../../server/replyCheck.ts";
import type { Brains } from "../../server/brains.ts";

/** 检查器用的假 provider：记录收到的内容，按 decide 返回结果 */
function brainsWith(faux: ReturnType<typeof registerFauxProvider>, decide: ((input: any) => any) | "throw" | null, seen: any[] = []): Brains {
  const provider = decide === null ? null : {
    id: "openai", model: "test",
    generateStructured: async (req: any) => {
      if (req.task !== "check_reply") throw new Error(`unexpected task ${req.task}`);
      const input = JSON.parse(req.messages[1].content); seen.push(input);
      if (decide === "throw") throw new Error("timeout");
      return { data: decide(input), provider: "openai", model: "test", raw: "", latencyMs: 1 };
    },
    generateText: async () => { throw new Error("no"); },
  };
  return { provider: provider as any, match: ruleMatcher, assess: ruleAssessor, model: faux.getModel(), getApiKey: () => "x",
    modelInfo: { provider: "openai", name: "test" }, label: "test" };
}

test("说『已经发给 Alex』但实际只起草：核对发现不一致，回复被改写，并留下记录", async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("send_message", { to: "Alex", subject: "方案", body: "定方案 B" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("好的，已经发给 Alex 了。")]),
  ]);
  const seen: any[] = [];
  const s = seedQ4();
  const r = await chat(s, brainsWith(faux, (i) => ({ consistent: false, problems: ["把起草说成了已发送"], revised: "给 Alex 的消息起草好了，还没发送，等你确认后由你发送。" }), seen), "wc_alex", "直接发给 Alex，说定方案 B");
  faux.unregister();
  assert.equal(r.reply, "给 Alex 的消息起草好了，还没发送，等你确认后由你发送。");
  assert.ok(seen[0].这一轮实际发生的事.some((f: string) => /起草了给 Alex 的消息/.test(f)), "核对拿到的事实来自事件日志");
  assert.ok(seen[0].硬性事实.some((f: string) => /不会替用户发送/.test(f)));
  assert.equal(s.chats!.wc_alex!.at(-1)!.text, r.reply, "存进对话的是改写后的版本");
  const log = s.events.find((e) => e.payload.replyCheck);
  assert.ok(log && !log.visibleInTimeline, "改写留有审计记录，但不进时间线");
  assert.equal((log!.payload.replyCheck as any).original, "好的，已经发给 Alex 了。");
});

test("言行一致时回复原样保留", async () => {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("方案 A 的对比已经做完，正在做 B。")])]);
  const s = seedQ4();
  const r = await chat(s, brainsWith(faux, (i) => ({ consistent: true, problems: [], revised: i.助手的回复 })), "wc_alex", "进展如何？");
  faux.unregister();
  assert.equal(r.reply, "方案 A 的对比已经做完，正在做 B。");
  assert.ok(!s.events.some((e) => e.payload.replyCheck));
});

test("没有任何改动时，核对拿到的事实是『没有任何改动』", async () => {
  const faux = registerFauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("已经把预算改成 30 万了。")])]);
  const seen: any[] = [];
  const s = seedQ4();
  await chat(s, brainsWith(faux, (i) => ({ consistent: false, problems: ["没有改动"], revised: "我还没有改预算。要改成 30 万吗？" }), seen), "wc_alex", "预算是不是要改？");
  faux.unregister();
  assert.deepEqual(seen[0].这一轮实际发生的事, ["（没有任何改动）"]);
  assert.equal(s.premises.pr_budget!.value, "50 万");
});

test("核对本身失败：退回关键词规则，照样纠正『已发送』", async () => {
  const faux = registerFauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("send_message", { to: "Alex", subject: "x", body: "y" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("搞定，已经发给 Alex 了。")]),
  ]);
  const s = seedQ4();
  const r = await chat(s, brainsWith(faux, "throw"), "wc_alex", "发给 Alex");
  faux.unregister();
  assert.match(r.reply, /更正：我没有替你发送任何消息/);
  assert.match(r.reply, /起草了给 Alex 的消息/);
});

test("事实清单不收录核对不过的事件", () => {
  const s = seedQ4();
  const n = s.events.length;
  s.events.push({ id: "e1", type: "action_status_changed", at: "", actor: "agent", visibleInTimeline: true, summary: "成本表已重算", payload: { claim: { kind: "has_output", actionId: "不存在" } } } as any);
  s.events.push({ id: "e2", type: "action_status_changed", at: "", actor: "agent", visibleInTimeline: true, summary: "起草了《对比表》", payload: {} } as any);
  assert.deepEqual(collectFacts(s, n, []), ["起草了《对比表》"]);
});
