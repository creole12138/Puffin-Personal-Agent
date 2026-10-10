/**
 * 言行一致：回复发给用户之前，和这一轮真实发生的事逐句核对。
 *
 * 1. facts —— 只从状态里取（事件日志 + 本轮提议），不经过模型；声称做了但核对不到的事件（claim 不成立）不算。
 * 2. 核对 —— 模型逐句检查回复里关于"做了什么 / 改了什么 / 发了什么 / 记下了什么"的说法：
 *    说了没做、做错对象、把草稿说成已发送、把推断说成用户说的、漏掉了需要用户决定的事，都算不一致。
 *    普通的回答内容（解释、建议、总结材料）不在核对范围内。
 * 3. 不一致 → 用核对给出的改写替换原回复（只许陈述 facts 里有的事），并在事件日志里留一条记录（不进时间线）。
 * 核对本身失败（超时、模型不可用）时退回到关键词规则，不阻塞对话。
 */
import { BASE_SYSTEM_PROMPT, cardSummary, checkClaim, emit, type AgentState, type Claim, type ID, type Proposal } from "../core/src/index.ts";
import type { Brains } from "./brains.ts";

/** 这一轮真实发生的事，用产品语言列出；同时给出硬事实 */
export function collectFacts(state: AgentState, since: number, made: Proposal[]): string[] {
  const facts: string[] = [];
  for (const e of state.events.slice(since)) {
    if (e.payload?.claimFailed) continue;
    const c = e.payload?.claim as Claim | undefined;
    if (c && !checkClaim(state, c)) continue;
    if (e.type === "evidence_observed" && !e.visibleInTimeline) continue;
    if (!e.summary?.trim()) continue;
    if (e.payload?.outcome === "failed" || (e.type === "action_status_changed" && !e.visibleInTimeline && !e.payload?.outcome)) continue;
    facts.push(e.summary);
  }
  for (const p of made) {
    if (p.mode === "ask" && p.status === "pending") facts.push(`提出了一个推断，等用户确认、尚未生效：${p.change.label} ${p.change.from} → ${p.change.to}（${p.reason}）`);
  }
  return [...new Set(facts)];
}

const HARD_RULES = [
  "本产品不会替用户发送任何消息或邮件：对外的内容只会起草，由用户自己发送。",
  "下面没列出的改动，这一轮都没有发生。",
];

export interface ReplyCheck { reply: string; corrected: boolean; problems: string[]; via: "model" | "rule" | "none" }

/** 关键词兜底（核对失败时用）：没有任何改动却声称改了；或声称已发送 */
function ruleCheck(reply: string, facts: string[]): ReplyCheck {
  const problems: string[] = [];
  if (!facts.length && /(已经?|帮你|给你)(更新|改好?|调整|记下|记好|取消|重算|重新计算|起草|写好)/.test(reply)) problems.push("声称做了改动，但这一轮没有任何改动");
  if (/(已经?|帮你|替你)(发送|发出|发给|发了|回复了|通知了?)/.test(reply)) problems.push("声称已经发送，但本产品不会替用户发送");
  if (!problems.length) return { reply, corrected: false, problems, via: "rule" };
  const note = facts.length ? `（更正：我没有替你发送任何消息；这一轮实际做的是：${facts.join("；")}。）` : "（更正：这一轮我其实还没有改动卡上的内容，也没有发送任何消息。）";
  return { reply: `${reply}\n${note}`, corrected: true, problems, via: "rule" };
}

export async function checkReply(state: AgentState, brains: Brains, o: { cardId: ID; userText: string; reply: string; since: number; made: Proposal[] }): Promise<ReplyCheck> {
  const facts = collectFacts(state, o.since, o.made);
  if (!o.reply.trim()) return { reply: o.reply, corrected: false, problems: [], via: "none" };
  let r: ReplyCheck;
  if (!brains.provider) r = ruleCheck(o.reply, facts);
  else {
    try {
      const res = await brains.provider.generateStructured<{ consistent: boolean; problems: string[]; revised: string }>({
        task: "check_reply",
        temperature: 0,
        messages: [
          { role: "system", content: BASE_SYSTEM_PROMPT.trim() + "\n\n【本次任务】\n" +
            "你是言行一致检查器。下面是助手刚写好、还没发给用户的回复，以及两份系统记录：\n" +
            "A.『这一轮实际发生的事』：这一轮助手做了什么；\nB.『工作卡当前状态』：卡上已有的前提、决策、动作、材料等（包含这一轮之前就有的事实）。\n" +
            "检查规则：\n" +
            "- 回复里说『这一轮我做了/改了/记下/取消/起草/发送/通知/重算了什么』，必须能在 A 里找到；\n" +
            "- 回复里描述现状（进度、预算、哪个决策成立或失效、哪个动作暂停、有没有草稿），必须和 B 一致；和 B 一致就算有依据，不需要出现在 A 里；\n" +
            "- 以下都算不一致：说做了但 A 里没有；数值或对象和 A、B 不符；把起草说成已发送、已通知；把还在等确认的推断说成已经改好，或说成用户说过的话；把用户的打算说成已经发生；A 里有需要用户决定或已暂停的事，回复却说一切照旧。\n" +
            "- 解释、建议、对材料的总结、向用户提问不在检查范围内。拿不准时判一致，不要因为措辞或省略细节判不一致。\n" +
            "一致：consistent=true，problems 为空，revised 原样返回回复。\n" +
            "不一致：consistent=false，problems 每条一句说明哪里对不上；revised 只改对不上的那几处，其余逐字保留原回复；草稿要说明『还没发送，等你确认后由你发送』；纯文本。" },
          { role: "user", content: JSON.stringify({ 用户这一轮说的: o.userText, 助手的回复: o.reply, 这一轮实际发生的事: facts.length ? facts : ["（没有任何改动）"], 工作卡当前状态: cardSummary(state, o.cardId), 硬性事实: HARD_RULES }, null, 2) },
        ],
        schema: { type: "object", additionalProperties: false, required: ["consistent", "problems", "revised"],
          properties: { consistent: { type: "boolean" }, problems: { type: "array", items: { type: "string" } }, revised: { type: "string" } } },
      });
      const d = res.data;
      r = d.consistent || !d.revised?.trim()
        ? { reply: o.reply, corrected: false, problems: d.problems ?? [], via: "model" }
        : { reply: d.revised.trim(), corrected: true, problems: d.problems ?? [], via: "model" };
    } catch (e) {
      console.warn(`[reply-check] 核对失败，改用关键词规则：${(e as Error).message}`);
      r = ruleCheck(o.reply, facts);
    }
  }
  if (r.corrected) {
    console.error(`[reply-check] 回复与实际不一致，已改写：${r.problems.join("；")}\n  原：${o.reply}\n  新：${r.reply}`);
    emit(state, { type: "action_status_changed", actor: "agent", workCardId: o.cardId, visibleInTimeline: false,
      summary: "回复和实际做的事对不上，发出前已改正", payload: { replyCheck: { original: o.reply, revised: r.reply, problems: r.problems, facts, via: r.via } } });
  }
  return r;
}
