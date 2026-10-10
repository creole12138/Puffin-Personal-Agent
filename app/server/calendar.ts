/**
 * 日历来源：定期拉取 .ics 订阅链接，按日程 UID 对比上一次快照，
 * 识别"改时间 / 取消 / 新增"，转成材料交给同一条 前提判断 → 影响传播 流程。
 * 只读；链接即凭证，只保存在该工作区的授权里。
 */
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { emit } from "../core/src/index.ts";
import type { Workspace, WorkspaceManager } from "./workspace.ts";

export interface CalEvent { uid: string; summary: string; start: string; end?: string; status?: string; location?: string }

const TZ = process.env.DISPLAY_TZ ?? "Asia/Shanghai";
const WINDOW_DAYS = 60;

/** 极简 ICS 解析：够用即可（VEVENT 的 UID/SUMMARY/DTSTART/DTEND/STATUS/LOCATION） */
export function parseICS(text: string): CalEvent[] {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: CalEvent[] = []; let cur: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur?.UID && cur.DTSTART && !cur["RECURRENCE-ID"]) {
        out.push({ uid: cur.UID, summary: unescape(cur.SUMMARY ?? "（无标题）"), start: fmt(cur.DTSTART), end: cur.DTEND ? fmt(cur.DTEND) : undefined,
          status: cur.STATUS, location: cur.LOCATION ? unescape(cur.LOCATION) : undefined });
      }
      cur = null;
    } else if (cur) {
      const i = line.indexOf(":"); if (i < 0) continue;
      const [name] = line.slice(0, i).split(";");
      cur[name!] = line.slice(i + 1);
    }
  }
  return out;
}
const unescape = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");

/** 20261001T100000Z → 用 DISPLAY_TZ 显示；无 Z 的按原样当作本地时间；全天事件只显示日期 */
function fmt(v: string): string {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return v;
  const [, y, mo, d, h, mi, , z] = m;
  if (!h) return `${y}-${mo}-${d}（全天）`;
  if (!z) return `${y}-${mo}-${d} ${h}:${mi}`;
  const dt = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!));
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(dt);
  return p.replace(",", "");
}

function inWindow(e: CalEvent) {
  const t = Date.parse(e.start.slice(0, 16).replace(" ", "T"));
  if (Number.isNaN(t)) return true;
  const now = Date.now();
  return t > now - 86400_000 && t < now + WINDOW_DAYS * 86400_000;
}

export function diff(prev: Record<string, CalEvent>, next: CalEvent[]): string[] {
  const out: string[] = []; const seen = new Set<string>();
  for (const e of next) {
    seen.add(e.uid);
    const p = prev[e.uid];
    if (!p) { if (inWindow(e)) out.push(`新增日程「${e.summary}」：${e.start}`); continue; }
    if (e.status === "CANCELLED" && p.status !== "CANCELLED") out.push(`日程「${e.summary}」已取消（原定 ${p.start}）`);
    else if (p.start !== e.start) out.push(`日程「${e.summary}」从 ${p.start} 改到了 ${e.start}`);
    else if (p.summary !== e.summary) out.push(`日程「${p.summary}」改名为「${e.summary}」（${e.start}）`);
  }
  for (const [uid, p] of Object.entries(prev)) if (!seen.has(uid) && inWindow(p)) out.push(`日程「${p.summary}」被删除了（原定 ${p.start}）`);
  return out;
}

async function assertPublicHttps(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw.replace(/^webcal:/i, "https:")); } catch { throw new Error("日历链接格式不对"); }
  if (u.protocol !== "https:") throw new Error("只支持 https 的日历链接");
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
  for (const { address } of addrs) {
    if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1|fc|fd|fe80)/i.test(address)) throw new Error("不支持内网地址");
  }
  return u;
}

async function fetchICS(url: string): Promise<CalEvent[]> {
  const u = await assertPublicHttps(url);
  const res = await fetch(u, { signal: AbortSignal.timeout(15000), cache: "no-store", headers: { accept: "text/calendar", "cache-control": "no-cache", pragma: "no-cache" } });
  if (!res.ok) {
    const google = /calendar\.google\.com/.test(u.hostname);
    if ((res.status === 404 || res.status === 403) && google) throw new Error(`Google 返回 ${res.status}：这个链接本身打不开。请确认复制的是「iCal 格式的私密地址」（不是公开地址），且日历不是公司账号限制外部访问的；新建的日历可能要等一会儿才生效`);
    if (res.status === 404 || res.status === 403) throw new Error(`日历链接打不开（${res.status}）：可以先把链接粘到浏览器的无痕窗口里试试，能下载到 .ics 文件才能连接`);
    throw new Error(`日历链接打不开（${res.status}）`);
  }
  const text = await res.text();
  if (text.length > 5_000_000) throw new Error("日历太大");
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("这个链接返回的不是日历（.ics）");
  return parseICS(text);
}

type Snapshot = Record<string, CalEvent>;

export class CalendarWatcher {
  private timer?: NodeJS.Timeout;
  constructor(private mgr: WorkspaceManager, private everySeconds: number) {}

  private grantsOf(ws: Workspace, projectId?: string | null) {
    return Object.values(ws.state.grants).filter((g) => g.source === "calendar" && !g.revokedAt && (projectId === undefined || (g.filter?.projectId ?? null) === projectId));
  }

  /** projectId 为空：Puffin 的连接（所有项目可用）；否则只给这个项目 */
  async connect(ws: Workspace, url: string, projectId?: string) {
    const events = await fetchICS(url);
    const snapshot: Snapshot = Object.fromEntries(events.map((e) => [e.uid, e]));
    const pname = projectId ? ws.state.projects[projectId]?.name : "";
    const g = await ws.grant({ source: "calendar", scopeLabel: `读取并持续关注这个日历（只读${projectId ? `，仅「${pname}」` : ""}）`, filter: { url, snapshot, lastCheckedAt: new Date().toISOString(), ...(projectId ? { projectId } : {}) }, permissions: ["read", "watch"] });
    const upcoming = events.filter(inWindow).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 40);
    const text = upcoming.map((e) => `- ${e.start}${e.end ? ` ~ ${e.end.slice(11)}` : ""}｜${e.summary}${e.location ? `｜${e.location}` : ""}${e.status === "CANCELLED" ? "｜已取消" : ""}`).join("\n");
    await ws.addMaterial({ title: `日历${pname ? `（${pname}）` : ""}（接下来 ${WINDOW_DAYS} 天）`, text: text || "（近期没有日程）", source: "calendar", ref: projectId ? `calendar:${projectId}` : "calendar" });
    return { grantId: g.id, events: upcoming.length };
  }

  async checkNow(ws: Workspace, projectId?: string | null) {
    const gs = this.grantsOf(ws, projectId);
    if (!gs.length) throw new Error("还没有连接日历");
    const all: string[] = [];
    for (const g of gs) {
      const events = await fetchICS(String(g.filter.url));
      const changes = diff((g.filter.snapshot ?? {}) as Snapshot, events);
      await ws.run((s) => {
        const gg = s.grants[g.id]!;
        gg.filter = { ...gg.filter, snapshot: Object.fromEntries(events.map((e) => [e.uid, e])), lastCheckedAt: new Date().toISOString() };
        if (!changes.length) emit(s, { type: "evidence_observed", actor: "watcher", visibleInTimeline: false, summary: "日历没有变化", payload: {} });
      });
      const pid = g.filter?.projectId as string | undefined;
      if (changes.length) await ws.addMaterial({ title: `日历变化${pid ? `（${ws.state.projects[pid]?.name ?? ""}）` : ""}`, text: changes.join("\n"), source: "calendar", ref: pid ? `calendar:${pid}` : "calendar" });
      all.push(...changes);
    }
    const latest = gs.flatMap((g) => Object.values((ws.state.grants[g.id]?.filter.snapshot ?? {}) as Snapshot)).filter(inWindow).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 3).map((e) => `${e.summary} ${e.start}`);
    return { changes: all, latest };
  }

  start() {
    const tick = async () => {
      for (const id of await this.mgr.list()) {
        const ws = await this.mgr.get(id).catch(() => null);
        if (ws && this.grantsOf(ws).length) await this.checkNow(ws).catch((e) => console.warn(`日历检查失败 ${id}：${(e as Error).message}`));
      }
    };
    this.timer = setInterval(tick, this.everySeconds * 1000);
    this.timer.unref();
  }
}
