/**
 * HTTP 服务：网页 + API + 实时推送（SSE）。只用 node:http，无框架。
 *   PORT=3000 npm start
 */
import "../../scripts/env.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBrains } from "./brains.ts";
import { LimitError, WorkspaceManager, type Workspace } from "./workspace.ts";
import { CalendarWatcher } from "./calendar.ts";
import type { AgentState } from "../core/src/index.ts";

const PORT = Number(process.env.PORT ?? 3000);
const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const brains = makeBrains();
const mgr = new WorkspaceManager(process.env.DATA_DIR ?? "data/workspaces", brains, Number(process.env.LLM_DAILY_LIMIT_PER_WORKSPACE ?? 60));
const calendar = new CalendarWatcher(mgr, Number(process.env.CALENDAR_POLL_SECONDS ?? 120));

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

/** 给页面的报错：模型服务的原始报错（可能含 key 片段、内部细节）只进服务器日志 */
function publicMessage(err: Error): string {
  const raw = err.message ?? "";
  if (err.name === "ProviderError" || /OpenAI \d{3}|api key|sk-[\w*-]{4,}/i.test(raw)) return "模型服务暂时不可用，请稍后再试。";
  return raw.replace(/sk-[\w*-]{4,}/g, "sk-***");
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body<T>(req: IncomingMessage, max = 2_000_000): Promise<T> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > max) throw new Error("内容太大（上限约 2MB）"); chunks.push(c as Buffer); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : ({} as T);
}

/** 给页面的状态：去掉内部字段，附上模型信息 */
function view(ws: Workspace) {
  return { id: ws.id, state: ws.state, model: brains.label, canDraft: Boolean(brains.model), llmCallsToday: ws.llmCallsToday };
}

type Handler = (ws: Workspace, b: any, m: RegExpMatchArray) => Promise<unknown>;
const routes: [string, RegExp, Handler][] = [
  ["POST", /^\/example$/, (ws) => ws.loadExample()],
  ["POST", /^\/materials$/, (ws, b) => ws.addMaterial({ title: String(b.title || "未命名材料"), text: String(b.text || ""), source: b.source, ref: b.ref, supersedes: b.supersedes })],
  ["POST", /^\/cards$/, (ws, b) => ws.draftCard(String(b.goal || ""), Array.isArray(b.evidenceIds) ? b.evidenceIds : [], b.projectId)],
  ["POST", /^\/cards\/([\w-]+)\/answer$/, (ws, b, m) => ws.answerQuestion(m[1]!, String(b.questionId), String(b.answer))],
  ["POST", /^\/cards\/([\w-]+)\/confirm$/, (ws, _b, m) => ws.confirmCard(m[1]!)],
  ["POST", /^\/decisions\/([\w-]+)\/resolve$/, (ws, b, m) => ws.resolve(m[1]!, b.kind === "keep" ? "keep" : "adopt_suggestion", b.note)],
  ["POST", /^\/premises\/([\w-]+)$/, (ws, b, m) => ws.editPremise(m[1]!, String(b.value))],
  ["POST", /^\/grants$/, (ws, b) => ws.grant(b)],
  ["POST", /^\/candidates$/, (ws, b) => ws.candidate(String(b.text || ""), String(b.brief || ""))],
  ["POST", /^\/cards\/([\w-]+)\/remind$/, (ws, _b, m) => ws.remind(m[1]!)],
  ["POST", /^\/cards\/([\w-]+)\/dismiss$/, (ws, _b, m) => ws.dismiss(m[1]!)],
  ["POST", /^\/cards\/([\w-]+)\/project$/, (ws, b, m) => ws.setProject(m[1]!, { projectId: b.projectId ?? null, newName: b.newName })],
  ["POST", /^\/cards\/([\w-]+)\/draft$/, (ws, b, m) => ws.draftFromCandidate(m[1]!, Array.isArray(b.evidenceIds) ? b.evidenceIds : [])],
  ["POST", /^\/cards\/([\w-]+)\/plan$/, (ws, _b, m) => ws.plan(m[1]!)],
  ["POST", /^\/cards\/([\w-]+)\/run$/, (ws, _b, m) => ws.runPlan(m[1]!)],
  ["POST", /^\/cards\/([\w-]+)\/chat$/, (ws, b, m) => ws.chat(m[1]!, String(b.text || ""), b.quote ? String(b.quote) : undefined)],
  ["POST", /^\/proposals\/([\w-]+)\/confirm$/, (ws, _b, m) => ws.confirm(m[1]!)],
  ["POST", /^\/events\/([\w-]+)\/rollback$/, (ws, _b, m) => ws.rollback(m[1]!)],
  ["POST", /^\/grants\/([\w-]+)\/revoke$/, (ws, _b, m) => ws.revoke(m[1]!)],
  ["POST", /^\/calendar$/, async (ws, b) => calendar.connect(ws, String(b.url || ""))],
  ["POST", /^\/calendar\/check$/, async (ws) => calendar.checkNow(ws)],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  try {
    if (p === "/api/health") return send(res, 200, { ok: true, model: brains.label });
    if (p === "/api/workspaces" && req.method === "POST") {
      const b = await body<{ importState?: AgentState }>(req);
      if (b.importState && (b.importState as AgentState).version !== 1) throw new Error("不是可识别的导出文件");
      const ws = await mgr.create(b.importState);
      return send(res, 200, view(ws));
    }
    const m = p.match(/^\/api\/w\/([a-z0-9]{12})(\/.*)?$/);
    if (m) {
      const ws = await mgr.get(m[1]!);
      if (!ws) return send(res, 404, { error: "找不到这个工作区，可能已被删除。" });
      const sub = m[2] ?? "";
      if (req.method === "GET" && sub === "") return send(res, 200, view(ws));
      if (req.method === "GET" && sub === "/export") {
        res.writeHead(200, { "content-type": "application/json", "content-disposition": `attachment; filename="workcard-state-${ws.id}.json"` });
        // 日历链接相当于只读钥匙，不随导出文件带走；导入后需要重新连接日历
        const out = structuredClone(ws.state);
        for (const g of Object.values(out.grants)) if (g.source === "calendar") { g.filter = { removedOnExport: true }; g.revokedAt ??= new Date().toISOString(); }
        return res.end(JSON.stringify(out, null, 2));
      }
      if (req.method === "DELETE" && sub === "") { await mgr.remove(ws.id); return send(res, 200, { ok: true }); }
      if (req.method === "GET" && sub === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify(view(ws))}\n\n`);
        const off = ws.subscribe(() => res.write(`data: ${JSON.stringify(view(ws))}\n\n`));
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => { off(); clearInterval(ping); });
        return;
      }
      for (const [method, re, h] of routes) {
        const mm = sub.match(re);
        if (mm && req.method === method) {
          const result = await h(ws, await body(req), mm);
          return send(res, 200, { result, ...view(ws) });
        }
      }
      return send(res, 404, { error: "服务器版本和页面不一致：请重启服务器（npm start）后刷新页面" });
    }
    // 静态文件：/ 和 /w/:id 都返回单页应用
    let file = p === "/" || p.startsWith("/w/") ? "index.html" : normalize(p).replace(/^[/\\]+/, "");
    if (file.includes("..")) return send(res, 400, { error: "bad path" });
    const buf = await readFile(join(WEB, file)).catch(() => null);
    if (!buf) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch (e) {
    const err = e as Error;
    const code = err instanceof LimitError ? 429 : err instanceof SyntaxError ? 400 : 400;
    if (!(err instanceof LimitError)) console.error(err);
    send(res, code, { error: publicMessage(err) });
  }
});

server.listen(PORT, () => console.log(`云朵小管家：http://localhost:${PORT}（模型：${brains.label}）`));
calendar.start();
