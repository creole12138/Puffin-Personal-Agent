// 云朵小管家 —— 网页端。结构与视觉照 Claude Design 原型「工作卡 Agent 原型」。原生 JS，无构建步骤。
const $app = document.getElementById("app");
const AV = (w, h) => `<img src="/agent.svg" alt="" width="${w}" height="${h}" style="width:${w}px;height:${h}px;flex-shrink:0">`;
const S = {
  wsId: null, ws: null, view: "home", sel: null, proj: null, tlEvent: null, rollbackNote: false,
  busy: null, pending: null, ask: "", chatText: "", attach: [], candAttach: [],
  why: false, editing: null, editVal: "", openDoc: new Set(), projMenu: false, newProj: "",
  demoFlip: false, moreNews: false, moreNext: false, showCard: false,
  sceneIn: {}, scene: null, vEdit: null, vText: "", folder: null, calUrl: "", confirmDelete: false, lastSeen: null, more: false, tour: 0, tourDecided: false,
  quote: "", quoteBtn: null, copied: null,
};
const TEXT_EXT = /\.(txt|md|csv|json|tsv|ics|log|rtf)$/i;
/** RTF → 纯文本（够用的简化版：处理转义、Unicode、去掉控制字和分组） */
function rtfToText(r) {
  if (!/^\s*\{\\rtf/.test(r)) return r;
  r = r.replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "").replace(/\{\\(fonttbl|colortbl|stylesheet|info|expandedcolortbl)(?:[^{}]|\{[^{}]*\})*\}/g, "");
  r = r.replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode(n < 0 ? Number(n) + 65536 : Number(n)));
  r = r.replace(/\\'([0-9a-f]{2})/gi, (_, h) => "\u0000" + h);
  r = r.replace(/\\(par|line)\b ?/g, "\n").replace(/\\tab\b ?/g, "\t").replace(/\\[a-z]+-?\d* ?/gi, "").replace(/\\([{}\\])/g, "$1").replace(/[{}]/g, "");
  r = r.replace(/(\u0000[0-9a-f]{2})+/gi, (m) => { try { return new TextDecoder("gbk").decode(new Uint8Array(m.split("\u0000").filter(Boolean).map((h) => parseInt(h, 16)))); } catch { return ""; } });
  return r.replace(/\n{3,}/g, "\n\n").trim();
}
const readText = async (f) => /\.rtf$/i.test(f.name) ? rtfToText(await f.text()) : f.text();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const st = () => S.ws?.state;
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

// ---------- 网络 ----------
async function api(path, body, method = "POST") {
  const url = path.startsWith("/api/") ? path : `/api/w/${S.wsId}${path}`;
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `服务器返回 ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  if (data.state) S.ws = data;
  return data;
}
async function withBusy(msg, fn) {
  S.busy = msg; render();
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { const k = decideAlerts(); S.alertKeys = new Set(k.keys()); S.bubbles = (S.bubbles ?? []).filter((b) => k.has(b.key)); S.busy = null; render(); }
}
let toastTimer;
function toast(msg, err = false) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "show" + (err ? " err" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ""), err ? 6000 : 3200);
}
function connectStream() {
  const es = new EventSource(`/api/w/${S.wsId}/stream`);
  es.onmessage = (m) => { S.ws = JSON.parse(m.data); checkAlerts(); render(); };
}

// ---------- 主动提醒（冒泡） ----------
function decideAlerts() {
  const s = st(), out = new Map(); if (!s) return out;
  const title = (id) => s.workCards[id]?.title ?? "工作卡";
  for (const pc of openChanges()) {
    const key = `ev:${pc.evidenceId || pc.id}`, cards = pc.impacts.filter((i) => i.handling === "needs_user").map((i) => i.workCardId);
    const prev = out.get(key); const all = [...new Set([...(prev?.cards ?? []), ...cards])];
    const src = s.evidence[pc.evidenceId]?.title;
    out.set(key, { cards: all, text: `${src ? `《${src}》里` : ""}${s.premises[pc.premiseId]?.label ?? "一个条件"}变成了 ${pc.to}`, sub: all.length > 1 ? `牵动了 ${all.length} 件事的决定` : `「${title(all[0])}」的决定需要再看看` });
  }
  for (const p of Object.values(s.proposals ?? {})) if (p.status === "pending" && p.workCardId && ![...out.values()].some((v) => v.cards.includes(p.workCardId)))
    out.set(`pr:${p.id}`, { cards: [p.workCardId], text: `${p.change.label}可能从 ${p.change.from} 变成 ${p.change.to}`, sub: `「${title(p.workCardId)}」等你确认` });
  return out;
}
function checkAlerts() {
  const now = decideAlerts(), keys = new Set(now.keys());
  if (!S.alertKeys) { S.alertKeys = keys; return; }
  const fresh = [...keys].filter((k) => !S.alertKeys.has(k));
  S.alertKeys = keys;
  S.bubbles = (S.bubbles ?? []).filter((b) => keys.has(b.key));
  if (fresh.length && !S.busy) for (const k of fresh) S.bubbles.push({ key: k, ...now.get(k) });
}
function bubbleView() {
  const bs = S.bubbles ?? []; if (!bs.length) return "";
  const b = bs[bs.length - 1], more = bs.length - 1;
  return `<div class="bubble" role="alert">${AV(44, 39)}<div class="bubble-b">
    <div class="s12" style="color:var(--amber);font-weight:600">${more ? `刚发现 ${bs.length} 处变化` : "刚发现一处变化"}</div>
    <div class="bubble-t">${esc(b.text)}</div><div class="s13 muted">${esc(b.sub)}</div>
    <div class="row" style="gap:8px;margin-top:8px"><button class="btn sm mint" data-act="bubble-go" data-id="${b.cards[0]}" data-key="${esc(b.key)}">去看看</button><button class="btn sm" data-act="bubble-later">稍后</button></div></div></div>`;
}

// ---------- 派生数据 ----------
const allCards = () => Object.values(st()?.workCards ?? {}).filter((c) => c.stage !== "parked").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const cardsOf = (pid) => allCards().filter((c) => (c.projectId ?? null) === pid);
function openChanges() {
  const s = st(); if (!s) return [];
  return Object.values(s.premiseChanges).filter((pc) => !pc.resolvedAt &&
    pc.impacts.some((i) => i.kind === "decision" && i.handling === "needs_user" && ["invalidated", "weakened"].includes(s.decisions[i.id]?.status)));
}
const changesFor = (cardId) => openChanges().filter((pc) => pc.impacts.some((i) => i.workCardId === cardId && i.handling === "needs_user"));
const needsYou = (c) => changesFor(c.id).length > 0 || Object.values(st()?.proposals ?? {}).some((p) => p.workCardId === c.id && p.status === "pending");
const STAGE = { candidate: ["候选", "candtag"], draft: ["草稿", "draft"], active: ["进行中", "active"], done: ["已完成", "muted"], parked: ["搁置", "muted"] };
const ACT = { planned: ["计划中", "muted"], paused: ["已暂停", "warn"], running: ["进行中", "active"], done: ["已完成", "active"], cancelled: ["已取消", "muted"] };
const DEC = { valid: ["成立", "active"], weakened: ["待确认", "warn"], invalidated: ["不再成立", "bad"], superseded: ["已被替代", "muted"] };
const evTitle = (id) => st().evidence[id]?.title ?? "材料";
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function when(iso) {
  const d = new Date(iso); if (isNaN(d)) return String(iso);
  const now = new Date(), days = Math.round((new Date(d.toDateString()) - new Date(now.toDateString())) / 864e5);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const day = days === 0 ? "今天" : days === 1 ? "明天" : days === -1 ? "昨天" : days > 1 && days < 7 ? WD[d.getDay()] : `${d.getMonth() + 1}/${d.getDate()}`;
  return { label: `${day} ${hm}`, days };
}
const whenLabel = (iso) => (typeof when(iso) === "string" ? when(iso) : when(iso).label);
function timeAgo(iso) { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`; }
const decisionMain = (c) => c.decisionIds.map((id) => st().decisions[id]).filter(Boolean).find((d) => d.status !== "superseded") ?? null;
const isExample = () => Boolean(st()?.workCards.wc_alex && st().premises.pr_budget);

// ---------- 渲染 ----------
function render() {
  const f = document.activeElement, keep = f?.dataset?.keep, sel = keep ? [f.selectionStart, f.selectionEnd] : null;
  const viewKey = `${S.view}:${S.sel}:${S.proj}`, sameView = viewKey === S._viewKey; S._viewKey = viewKey;
  const scrollMain = sameView ? $app.querySelector(".main")?.scrollTop : 0, scrollMsgs = $app.querySelector(".msgs");
  const atBottom = scrollMsgs ? scrollMsgs.scrollHeight - scrollMsgs.scrollTop - scrollMsgs.clientHeight < 40 : true;
  $app.innerHTML = S.wsId ? shell() : landing();
  if (S.wsId && S.ws) $app.insertAdjacentHTML("beforeend", bubbleView());
  if (S.wsId && S.preview) $app.insertAdjacentHTML("beforeend", previewModal());
  const ht = S.hint && $app.querySelector(".task.hinted");
  if (ht) { const r = ht.getBoundingClientRect();
    $app.insertAdjacentHTML("beforeend", `<div class="hint-pop" role="status" style="left:${r.right + 14}px;top:${r.top + r.height / 2}px">${esc(S.hint.text)}<button class="x-btn" data-act="hint-x" aria-label="知道了"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`); }
  if (S.wsId && S.scene) $app.insertAdjacentHTML("beforeend", sceneModal());
  if (S.wsId && S.vfModal) $app.insertAdjacentHTML("beforeend", vfModal());
  if (S.wsId && S.mats) $app.insertAdjacentHTML("beforeend", matsModal());
  if (S.busy) $app.insertAdjacentHTML("beforeend", `<div class="busy"><div class="box2">${AV(44, 39)}<div>${S.busy.split("\n").map((t, i) => `<div class="${i ? "s12 muted" : ""}">${esc(t)}</div>`).join("")}</div><div class="spin"></div></div></div>`);
  if (keep) { const el = $app.querySelector(`[data-keep="${keep}"]`); if (el) { el.focus(); try { el.setSelectionRange(...sel); } catch {} } }
  const m = $app.querySelector(".main"); if (m && scrollMain) m.scrollTop = scrollMain;
  const msgs = $app.querySelector(".msgs"); if (msgs && atBottom) msgs.scrollTop = msgs.scrollHeight;
}

function landing() {
  return `<div class="landing">
    <div class="hero">${AV(84, 74)}<h1>我是云朵小管家。<br>把一件正在推进的事交给我。</h1></div>
    <p class="lede">我记住的不是聊天记录，而是这件事的状态：在推进什么、依据是什么、哪些前提一变会影响什么。预算改了、会议挪了，我会告诉你哪些决定受影响、哪些动作已经暂停、哪些已经发出去需要补一句更正。</p>
    <div class="pillars">
      <div class="pillar"><b>有来源</b><span class="muted s13">每条结论都能点开看依据来自哪份材料。</span></div>
      <div class="pillar"><b>有边界</b><span class="muted s13">只读你授权的范围；对外的事只起草，不替你发出。</span></div>
      <div class="pillar"><b>会变化</b><span class="muted s13">前提一变，受影响的决定和动作一起被找出来。</span></div>
      <div class="pillar"><b>可续接</b><span class="muted s13">状态可以导出，换个会话、换个模型接着做。</span></div>
    </div>
    <div class="row cta">
      <button class="btn mint lg" data-act="create">开始</button>
      <label class="btn lg">导入之前导出的状态<input type="file" accept=".json,application/json" data-change="import" hidden></label>
    </div>
    <p class="landing-foot">每个人会得到一个专属链接，只有拿到链接的人能看到里面的内容。上传的材料只保存在这个工作区，可以随时删除。请不要上传敏感信息。</p>
  </div>`;
}

function shell() {
  if (!S.ws) return `<div class="boot">加载工作区…</div>`;
  const s = st();
  if (S.view === "card" && !s.workCards[S.sel]) S.view = "home";
  if (S.view === "project" && !s.projects[S.proj]) S.view = "home";
  const main = { home, card: () => cardView(s.workCards[S.sel]), project: projectView, timeline: timelineView, demo: demoView }[S.view] ?? home;
  return `<div class="app">
    <div class="top">
      <button class="who" data-act="home" title="回到主页"><svg class="home-ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h5v-6h4v6h5V9.5"/></svg>${AV(32, 28)}云朵小管家<span class="en">Puffin</span></button>
      <div class="sp"></div>
      <span class="meta">模型：${esc(S.ws.model)}</span>
      <div style="position:relative"><button class="btn ghost" data-act="more" aria-expanded="${S.more}">更多 ▾</button>
        ${S.more ? `<div class="menu" role="menu">
          <button role="menuitem" data-act="copy-link">复制这个工作区的链接<span>用它随时回到这里</span></button>
          <a role="menuitem" href="/api/w/${S.wsId}/export" download>导出工作状态<span>下载全部内容，可在别处导入继续；包含你给过的材料原文</span></a>
          <button role="menuitem" data-act="open-mats">全部材料<span>这个工作区里你给过的文件</span></button>
          <a role="menuitem" href="/">导入 / 新建工作区<span>回到开始页</span></a>
          <button role="menuitem" class="danger" data-act="delete">${S.confirmDelete ? "再点一次，确认删除" : "删除这个工作区"}<span>工作卡、材料和对话都会删除，无法恢复</span></button>
        </div>` : ""}</div>
    </div>
    <div class="cols">
      <nav class="nav" aria-label="工作与项目">${nav()}</nav>
      <main class="main">${main()}</main>
      ${S.view === "home" && !allCards().length && !S.chatText ? "" : `<aside class="chat" aria-label="和云朵小管家对话">${chatPanel()}</aside>`}
    </div>
  </div>`;
}

function nav() {
  const s = st(), projects = Object.values(s.projects), loose = cardsOf(null);
  const taskBtn = (c) => `<button class="task ${S.view === "card" && S.sel === c.id ? "on" : ""} ${S.hint?.cardId === c.id ? "hinted" : ""}" data-act="open" data-id="${c.id}">${esc(c.title)}${c.stage === "candidate" ? "" : `<span class="st"> · ${STAGE[c.stage][0]}</span>`}${needsYou(c) ? `<span class="flag"> · 待决定</span><i class="pulse" aria-hidden="true"></i>` : ""}</button>`;
  const grants = Object.values(s.grants).filter((g) => !g.revokedAt && g.source !== "user_input");
  const cal = grants.find((g) => g.source === "calendar");
  const mats = Object.values(s.evidence).filter((e) => !["chat", "edit"].includes(e.ref)).length;
  return `
  ${projects.length ? `<div class="nav-title">项目</div>` : ""}
  ${projects.map((p) => {
    const cs = cardsOf(p.id), att = cs.filter(needsYou).length;
    return `<button class="proj ${S.view === "project" && S.proj === p.id ? "on" : ""}" data-act="project" data-id="${p.id}">
      <div class="name"><span>${esc(p.name)}</span>${att ? `<span class="tag warn">${att} 待决定</span>` : ""}</div>
      <div class="s11 muted" style="margin-top:4px">${cs.length} 项工作 · 共享 ${p.premiseIds.length} 个前提条件</div></button>
      ${cs.length ? `<div class="tasks">${cs.map(taskBtn).join("")}</div>` : ""}`; }).join("")}
  <div class="nav-title" style="${projects.length ? "margin-top:10px" : ""}">${projects.length ? "未归类" : "工作"}</div>
  ${loose.length ? `<div class="tasks" style="border:none;margin:0;padding:0">${loose.map(taskBtn).join("")}</div>`
    : `<div class="s12 faint" style="line-height:1.7;padding:4px">${projects.length ? "暂无" : "还没有工作。接住的第一件事会出现在这里，相关的事多了，我会建议归成项目。"}</div>`}
  <button class="newthing" data-act="home">＋ 开启一件新的事</button>
  <div class="sources">
    <div class="nav-title">连接</div>
    ${connectors(grants, cal)}
  </div>`;
}

// ---------- 连接 ----------
const CI = {
  folder: ["#E3F3EE", "#178A73", `<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>`],
  cal: ["#FDEEE4", "#C2622D", `<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>`],
  mail: ["#FCE8E6", "#C5392F", `<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>`],
  code: ["#ECEEF1", "#24292F", `<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 4-6 3-10 6"/>`],
  drive: ["#E7F0FD", "#2D6FD2", `<path d="M8.5 4h7l5.5 9.5-3.5 6h-11L3 13.5z"/><path d="M8.5 4 12 10M3 13.5h11M17.5 19.5 14 13.5"/>`],
  health: ["#FDE8EE", "#D23A63", `<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>`],
};
const cIcon = (k) => { const [bg, fg, d] = CI[k]; return `<span class="cn-ic" style="background:${bg};color:${fg}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg></span>`; };
function connectors(grants, cal) {
  const row = (k, name, status, right, cls = "") => `<div class="cn ${cls}">${cIcon(k)}<div class="cn-t"><div>${name}</div>${status ? `<div class="cn-s">${status}</div>` : ""}</div>${right}</div>`;
  const fGrants = grants.filter((g) => g.source === "local_folder" && g.filter?.where !== "example" && g.id !== "g_folder");
  const exGrant = grants.find((g) => g.source === "local_folder" && (g.filter?.where === "example" || g.id === "g_folder"));
  const folder = S.folder
    ? row("folder", "本机项目文件夹", `「${esc(S.folder.name)}」· 网页开着时检查`, `<button class="link" data-act="folder-stop">停止</button>`, "on")
    : fGrants.length ? row("folder", "本机项目文件夹", `${esc(fGrants[0].scopeLabel)}`, `<button class="link" data-act="revoke" data-id="${fGrants[0].id}">收回</button>`, "on")
    : "showDirectoryPicker" in window ? row("folder", "本机项目文件夹", "", `<button class="cn-btn" data-act="folder">连接</button>`)
    : row("folder", "本机项目文件夹", "需要 Chrome 或 Edge", "");
  const calRow = cal
    ? row("cal", "日历", `已连接${cal.filter.lastCheckedAt ? ` · ${timeAgo(cal.filter.lastCheckedAt)}检查过` : ""}`, `<span class="row" style="gap:6px"><button class="link" data-act="cal-check">检查</button><button class="link" data-act="revoke" data-id="${cal.id}">断开</button></span>`, "on")
    : row("cal", "日历", "", `<button class="cn-btn" data-act="nav-cal">${S.navCal ? "取消" : "连接"}</button>`)
      + (S.navCal ? `<div class="cn-cal"><input type="url" placeholder="粘贴 .ics 日历链接" aria-label="日历链接" value="${esc(S.calUrl)}" data-bind="calUrl" data-keep="navcal"><button class="btn sm mint" data-act="cal">连接</button></div>` : "");
  const soon = [["mail", "Gmail"], ["code", "GitHub"], ["drive", "Google Drive"], ["health", "Apple Health"]]
    .map(([k, n]) => row(k, n, "", `<button class="cn-soon" data-act="soon" data-v="${n}">即将支持</button>`, "off")).join("");
  const ex = exGrant ? row("folder", "示例文件夹「对齐材料」（模拟）", "Q4 规划示例自带，无需创建", "", "on") : "";
  const vf = Object.values(st().evidence).some((e) => e.ref?.startsWith(`${VF}/`)) ? row("folder", "示例项目文件夹（模拟）", "正在关注 · 3 个文件", `<button class="cn-btn" data-act="vf-show">打开</button>`, "on") : "";
  return folder + ex + vf + calRow + `<div class="cn-sep">示意 · 即将支持</div>` + soon;
}
function matsModal() {
  if (!S.mats) return "";
  const ev = Object.values(st().evidence).filter((e) => !["chat", "edit"].includes(e.ref));
  return `<div class="modal-bg" data-act="close-mats"><div class="modal" role="dialog" aria-label="全部材料" data-act="noop">
    <div class="modal-h">${ICON_FILE}<b>全部材料 · ${ev.length} 份</b><span style="flex:1"></span>
      <label class="btn sm mint" style="cursor:pointer">＋ 添加<input type="file" multiple accept=".txt,.md,.csv,.json,.tsv,.ics,.rtf" data-change="material-files" hidden></label><button class="x-btn" data-act="close-mats" aria-label="关闭"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div style="padding:8px 20px 16px;overflow:auto">${ev.map((e) => `<div class="li"><div><div>${esc(e.title)}</div><div class="s12 faint">${esc((e.excerpt || "").slice(0, 60))}</div></div><span class="s12 faint" style="white-space:nowrap">${e.at ? timeAgo(e.at) : ""}</span></div>`).join("") || `<div class="s13 muted" style="padding:12px 0">还没有材料。可以在首页把文件拖进输入框，或点「添加」。</div>`}</div></div></div>`;
}

// ---------- 场景入口 ----------
const SCENES = {
  today: {
    title: "今天最重要的事", short: "根据邮件、会议和项目资料，帮你梳理今日重点", grad: "lilac",
    sub: "结合邮件、会议纪要、日历和项目资料，告诉你今天先做什么",
    can: ["找出邮件里真正需要回复或决策的事情", "从会议纪要中识别承诺和待办", "结合日历判断时间紧迫度", "发现长时间没有推进的事项", "给出今天最值得做的 3 件事", "直接准备邮件、会议材料或任务清单"],
    example: "今天最重要的是确认产品发布页文案。你在周一的会议里答应今天给出反馈，但设计稿还没有收到你的意见。建议先花 20 分钟完成批注。我可以帮你整理需要确认的 4 个问题。",
    cta: "查看我的今日重点",
    frame: "【今天最重要的事】请从下面的邮件、会议纪要和项目资料里，找出今天最值得先做的 3 件事（真正要我回复或决定的、我答应过别人的、快到期的、很久没推进的），每件说清楚为什么是今天、先做哪一步、大概要多久，并准备好可以直接用的草稿。",
    inputs: [
      { key: "email", ref: "email", label: "邮件", ph: "连接邮箱即将支持，现在可以先把要处理的邮件粘贴进来试试~（带上发件人和主题更准）" },
      { key: "minutes", ref: "minutes", label: "会议纪要", ph: "连接会议软件即将支持，现在可以先把会议纪要或文字稿粘贴进来试试~" },
    ],
    sample: {
      email: "发件人：林夏（设计）\n主题：发布页设计稿 v3，麻烦周五前给意见\n正文：发布页 v3 改了首屏标题和价格区，需要你确认文案方向，周五（10/10）前给到我就能赶上下周一开发。\n\n发件人：王磊（销售）\n主题：客户 A 想提前看演示\n正文：客户 A 希望下周三前看到新版本演示，能否安排 30 分钟？\n\n发件人：HR\n主题：Q4 晋升材料提交提醒\n正文：本月 20 日前提交团队成员的晋升材料。",
      minutes: "10/6 周一 产品周会\n- 发布页文案：我（你）负责周五前给设计反馈\n- 支付流程改版：张明负责，预计 10/14 提测\n- 客户 A 演示：待定，等销售确认时间\n- 下次周会 10/13",
    },
  },
  release: {
    title: "持续为你关注项目进展", short: "根据 GitHub PR 和 Issue，及时发现发布风险", grad: "sky",
    sub: "根据 GitHub PR、Issue 和项目资料，告诉你发布是否按计划进行",
    can: ["识别哪些 PR 影响本次发布", "跟踪 PR 的创建、审核、合并和 CI 状态", "发现长期没有更新的任务", "结合发布日历判断风险", "整理当前阻塞项和负责人", "自动生成发布周报或同步消息"],
    example: "距离周五发布还有 3 天，但支付流程 PR 还没有通过审核，相关测试任务也没有更新。建议今天先确认审核人，并安排一次回归测试。要我帮你整理发布风险清单吗？",
    cta: "关注这个发布",
    frame: "【持续关注项目进展】请根据下面的发布计划和 GitHub PR / Issue 情况，判断这次发布是否能按计划进行：哪些 PR 影响发布、谁在阻塞、哪些很久没更新、风险有多大、今天应该先推动什么，并准备好可以发给团队的同步消息草稿。",
    inputs: [
      { key: "plan", ref: "release", label: "发布计划", ph: "发布日期、范围、负责人，比如：v2.3 周五 10/17 发布，包含支付改版和新首页" },
      { key: "github", ref: "github", label: "GitHub PR / Issue", ph: "连接 GitHub 即将支持，现在可以先把 PR 和 Issue 的列表、状态、评论粘贴进来试试~" },
    ],
    sample: {
      plan: "v2.3 计划 10/17（周五）发布，范围：支付流程改版、新首页、订单导出。发布负责人：你；测试：赵琳。",
      github: "#412 支付流程改版（张明）— Open，等待 review 4 天，CI 通过，未指定 reviewer\n#418 新首页（陈一）— Merged 10/8\n#421 订单导出（李想）— Open，CI 失败（单测 2 个），最后更新 10/3\nIssue #398 支付回归测试用例 — 赵琳，In progress，最后更新 10/2\nIssue #405 新首页埋点 — Done",
    },
  },
  fitness: {
    title: "制定我的减脂计划", short: "结合健康数据和日历，安排更可执行的每日计划", grad: "peach",
    sub: "根据健康数据和日历，帮你安排今天吃什么、动多少、怎么坚持",
    can: ["读取睡眠、步数、运动等趋势", "结合今天的会议和空闲时间安排运动", "根据你的目标制定每日计划", "发现连续几天没有运动或状态下降", "根据实际完成情况调整下一周计划", "在需要时提醒你，但不进行医疗诊断"],
    example: "你昨晚睡眠不足，今天有 3 个连续会议。建议把原定的 45 分钟训练改成晚饭后的 20 分钟快走，并把今天的晚餐安排得更简单。要我帮你调整今天的计划吗？",
    cta: "开始我的减脂计划",
    frame: "【减脂计划】请根据我的目标、健康数据摘要和今天的日程，安排今天可执行的运动和饮食，以及这一周的节奏。只谈时间、精力和习惯安排，不做任何医疗诊断或用药、热量处方；数据看起来异常时，建议我咨询专业人士。",
    inputs: [
      { key: "goal", ref: "goal", label: "你的目标", ph: "比如：3 个月减 5 公斤，每周至少运动 3 次" },
      { key: "health", ref: "health", label: "健康数据", ph: "连接 Apple Health 即将支持，现在可以先把最近几天的睡眠、步数、运动摘要粘贴进来试试~" },
      { key: "day", ref: "schedule", label: "今天的安排", ph: "自动读取日历即将支持，现在可以先写一下今天的会议和空闲时间试试~" },
    ],
    sample: {
      goal: "3 个月减 5 公斤，每周至少运动 3 次，原计划今晚 19:00 力量训练 45 分钟。",
      health: "近 5 天：睡眠 7.2h / 6.8h / 6.5h / 5.9h / 5.1h（昨晚）\n步数：8200 / 6100 / 4300 / 3900 / 3100\n运动：周一跑步 30 分钟，之后 4 天没有运动",
      day: "10:00–12:30 连续 3 个会议；14:00–15:00 评审；18:30 后空闲",
    },
  },
  meeting: {
    title: "会议之后别让事情丢了", short: "从会议纪要里找出谁要做什么，并帮你跟进", grad: "mint",
    sub: "从会议纪要里找出谁要做什么，并帮你完成后续跟进",
    can: ["整理待办清单和负责人", "起草跟进邮件", "设置截止时间提醒", "准备下次会议议程"],
    example: "周一的周会里有 4 个待办，其中「支付流程提测」和「客户 A 演示时间」还没有负责人确认。我起草了一封跟进邮件，要发给与会者吗？",
    cta: "整理这次会议",
    frame: "【会议之后的跟进】请从下面的会议纪要里找出所有承诺和待办（谁、做什么、什么时候），标出没有负责人或没有截止时间的，起草一封跟进邮件，并准备下次会议的议程。",
    inputs: [{ key: "minutes", ref: "minutes", label: "会议纪要", ph: "连接会议软件即将支持，现在可以先把会议纪要或文字稿（飞书妙记、腾讯会议等）粘贴进来试试~" }],
    sample: { minutes: "10/6 周一 产品周会（参会：你、张明、林夏、王磊、赵琳）\n- 发布页文案：你周五前给设计反馈\n- 支付流程改版：张明负责，预计 10/14 提测\n- 客户 A 演示：时间待定，谁来准备没说\n- 回归测试用例：赵琳更新，没定时间\n- 下次周会 10/13" },
  },
};
const VF = "示例项目";
const VF_FILES = [
  ["发布计划.md", "# v2.3 发布计划\n发布日期：10/17（周五）\n范围：支付流程改版、新首页、订单导出\n发布负责人：你\n测试负责人：赵琳\n上线前需要：全部 PR 合并、回归测试通过、客服话术更新"],
  ["PR 状态.md", "# PR 状态（从 GitHub 同步）\n#412 支付流程改版（张明）— Open，等待 review 4 天，CI 通过，未指定 reviewer\n#418 新首页（陈一）— Merged 10/8\n#421 订单导出（李想）— Open，CI 失败（单测 2 个），最后更新 10/3"],
  ["测试进度.md", "# 测试进度\n支付回归测试用例（赵琳）：进行中，完成 40%，最后更新 10/2\n新首页埋点验证：已完成\n订单导出：等 #421 修复后再测"],
];
const latestOf = (ref) => { const s = st(), list = Object.values(s.evidence).filter((e) => e.ref === ref); return list.find((e) => !list.some((x) => x.supersedes === e.id)); };
const vfFiles = () => VF_FILES.map(([n]) => latestOf(`${VF}/${n}`)).filter(Boolean);
function vfList() {
  return vfFiles().map((e) => { const n = e.ref.slice(VF.length + 1), open = S.vEdit === e.ref;
    return `<div class="vf-f"><button class="out-file" data-act="vf-open" data-ref="${esc(e.ref)}">${ICON_FILE}<span>${esc(n)}</span></button>${e.supersedes ? `<span class="tag ok">刚改过</span>` : ""}</div>
      ${S.vfResult?.ref === e.ref && !open ? vfResultBlock() : ""}
      ${open ? `<div class="vf-ed"><textarea rows="7" data-bind="vText" data-keep="vtext">${esc(S.vText)}</textarea><div class="row" style="gap:8px;justify-content:flex-end"><button class="choice sm" data-act="vf-open" data-ref="${esc(e.ref)}">取消</button><button class="btn sm mint" data-act="vf-save" data-ref="${esc(e.ref)}">保存</button></div></div>` : ""}`; }).join("");
}
function vfResultBlock() {
  const r = S.vfResult;
  return `<div class="vf-res ${r.warn ? "warn" : ""}">
    <div class="vf-diff"><div class="s12 faint" style="margin-bottom:4px">已保存，你改了：</div>${r.diff.slice(0, 6).map(([t, l]) => `<div class="d${t === "+" ? "a" : "r"}"><span>${t}</span>${esc(l)}</div>`).join("") || `<div class="s13 faint">只改了空白或格式</div>`}</div>
    <div class="vf-out">${AV(22, 19)}<span>${esc(r.outcome)}</span>${r.go ? `<button class="more-link" data-act="vf-go" data-id="${r.go}">${r.warn ? "去确认 ›" : "查看 ›"}</button>` : ""}</div></div>`;
}
function vfPanel(c) {
  const s = st();
  if (S.vfModal || !(c.originEvidenceIds ?? []).some((id) => s.evidence[id]?.ref?.startsWith(`${VF}/`))) return "";
  return `<div class="panel pad24 vf"><div class="row" style="justify-content:space-between"><div class="lbl">${ICON_FOLDER} 示例项目文件夹（模拟）· 我正在关注</div><span class="s12 faint">当项目文件信息有变化时，我会提醒你</span></div>${vfList()}</div>`;
}
function vfModal() {
  if (!S.vfModal) return "";
  return `<div class="modal-bg" data-act="vf-close"><div class="modal" role="dialog" aria-label="示例项目文件夹" data-act="noop">
    <div class="modal-h">${ICON_FOLDER}<b>示例项目文件夹（模拟）</b><span class="s12 faint" style="margin-left:6px">改一个文件并保存，我会判断牵动了什么</span><span style="flex:1"></span><button class="x-btn" data-act="vf-close" aria-label="关闭"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div style="padding:6px 22px 16px;overflow:auto">${vfList()}</div></div></div>`;
}
function visibleScenes() {
  const refs = new Set(Object.values(st()?.evidence ?? {}).map((e) => e.ref));
  const cal = Object.values(st()?.grants ?? {}).some((g) => g.source === "calendar" && !g.revokedAt);
  const used = [];
  if (refs.has("email") || cal) used.push("today");
  if (refs.has("github") || refs.has("release")) used.push("release");
  if (refs.has("health")) used.push("fitness");
  if (refs.has("minutes")) used.push("meeting");
  const base = ["today", "release", "fitness"];
  return used.length ? [...new Set([...used, ...base])].slice(0, 4) : base;
}
function sceneCards() {
  const ids = visibleScenes();
  return `<div class="scene-h">云朵可以先帮你做这些</div>
    <div class="scenes n${ids.length}">${ids.map((id) => { const c = SCENES[id];
      return `<button class="scene g-${c.grad}" data-act="scene" data-id="${id}"><b>${c.title}</b><small>${c.short}</small></button>`; }).join("")}</div>`;
}
function sceneModal() {
  const c = SCENES[S.scene]; if (!c) return "";
  const v = S.sceneIn;
  return `<div class="modal-bg" data-act="close-scene"><div class="modal scene-m" role="dialog" aria-label="${c.title}" data-act="noop">
    <div class="scene-top g-${c.grad}"><div><b>${c.title}</b><div class="s13" style="color:var(--ink2);margin-top:4px">${c.sub}</div></div><button class="x-btn" data-act="close-scene" aria-label="关闭"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="scene-body" style="padding-top:20px">
      ${S.scene === "release" ? `<div class="sfold">${cIcon("folder")}<div style="flex:1"><b>接管项目文件夹（推荐）</b><div class="s13" style="color:var(--ink2);margin-top:2px">选一个项目目录，我先读一遍理出进展；之后里面的文件有变动，我会自动判断牵动了什么并提醒你（网页开着时检查）</div></div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:stretch">${"showDirectoryPicker" in window ? `<button class="btn mint" data-act="scene-folder">选择文件夹</button>` : `<span class="s12 faint">需要 Chrome 或 Edge</span>`}<button class="btn" data-act="scene-vfolder">用示例项目文件夹试试</button></div></div>
        <div class="sor">或者先粘贴</div>` : ""}
      ${c.inputs.map((i) => `<label class="sin"><span>${i.label}</span><textarea rows="${i.key === "goal" || i.key === "plan" ? 3 : i.key === "day" ? 4 : 6}" placeholder="${i.ph.includes("即将支持") ? `${esc(i.ph)}&#10;&#10;` : ""}例如：&#10;${esc(c.sample[i.key] ?? "").replace(/\n/g, "&#10;")}" data-scene="${i.key}" data-keep="scene-${i.key}">${esc(v[i.key] ?? "")}</textarea></label>`).join("")}
    </div>
    <div class="scene-f"><button class="btn" data-act="scene-sample">用示例数据试试</button><span style="flex:1"></span><button class="btn mint lg" data-act="scene-go">${c.cta}</button></div>
  </div></div>`;
}

// ---------- 首页 ----------
function startCards() {
  const cal = Object.values(st()?.grants ?? {}).find((g) => g.source === "calendar" && !g.revokedAt);
  const card = (act, t, sub, extra = "") => `<button class="prompt" data-act="${act}"><b>${t}</b><small>${sub}</small>${extra}</button>`;
  const c2 = S.folder ? `<div class="prompt done"><b>接管项目文件夹</b><small>正在关注「${esc(S.folder.name)}」，有变动会提醒你</small></div>`
    : "showDirectoryPicker" in window ? card("folder", "接管项目文件夹", "丝滑推进项目执行")
    : `<div class="prompt done"><b>接管项目文件夹</b><small>需要用 Chrome 或 Edge 打开</small></div>`;
  const c3 = cal ? `<div class="prompt done"><b>连上日历</b><small>已连接，变化帮你盯着</small></div>`
    : S.calOpen ? `<div class="prompt open"><b>连上日历</b><input type="url" placeholder="粘贴 .ics 日历链接" aria-label="日历链接" value="${esc(S.calUrl)}" data-bind="calUrl" data-keep="cal">
        <div class="row" style="gap:8px"><button class="btn sm mint" data-act="cal">连接</button><button class="choice sm" data-act="cal-open">取消</button></div></div>`
    : card("cal-open", "连上日历", "做你的时间管理大师");
  return c2 + c3;
}
function revisit() {
  const s = st(), since = S.lastSeen ?? "0", DAY = 864e5, nowT = Date.now();
  const title = (id) => { const c = s.workCards[id]; return c ? `${c.projectId ? `${esc(s.projects[c.projectId]?.name)} · ` : ""}${esc(c.title)}` : ""; };
  const items = [];
  // 同一份新材料引起的变化合成一条，列出牵动的卡
  const groups = new Map();
  openChanges().forEach((pc) => { const key = pc.evidenceId || pc.id; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(pc); });
  for (const pcs of groups.values()) {
    const pc = pcs[0], p = s.premises[pc.premiseId];
    const cards = [...new Set(pcs.flatMap((x) => x.impacts.filter((i) => i.handling === "needs_user").map((i) => i.workCardId)))];
    const i = pc.impacts.find((x) => x.handling === "needs_user"), d = s.decisions[i.id];
    const t = cards.length > 1 ? `${p?.label}变成 ${pc.to}，牵动 ${cards.length} 件事的决定，需要再看看` : `${p?.label}变成 ${pc.to}，「${d?.statement}」${d?.status === "invalidated" ? "不再成立" : "需要再看看"}`;
    items.push({ k: "decide", id: cards[0] ?? i.workCardId, cards, t });
  }
  Object.values(s.proposals ?? {}).filter((p) => p.status === "pending" && p.workCardId && !items.some((x) => x.id === p.workCardId || x.cards?.includes(p.workCardId)))
    .forEach((p) => items.push({ k: "decide", id: p.workCardId, t: `${p.change?.label ?? "一个条件"}可能变了，等你确认` }));
  s.events.filter((e) => e.visibleInTimeline && e.actor !== "user" && e.at > since && e.type !== "card_created" && e.workCardId).slice(-4).reverse()
    .forEach((e) => items.push({ k: "news", id: e.workCardId, t: e.summary }));
  allCards().filter((c) => c.stage === "active" && !needsYou(c)).forEach((c) => {
    const idle = Math.floor((nowT - new Date(c.updatedAt).getTime()) / DAY);
    const waiting = (c.openQuestions ?? []).filter((q) => !q.answer);
    if (idle >= 3) items.push({ k: "stuck", id: c.id, t: `${idle} 天没有进展${c.nextStep ? `，下一步还是「${c.nextStep}」` : ""}` });
    else if (waiting.length) items.push({ k: "stuck", id: c.id, t: `还在等你回答：${waiting[0].question}` });
  });
  allCards().flatMap((c) => c.reminders.map((r) => ({ r, c }))).map(({ r, c }) => ({ w: when(r.at), r, c }))
    .filter(({ w }) => typeof w !== "string" && w.days >= 0 && w.days <= 7).sort((x, y) => x.w.days - y.w.days).slice(0, 3)
    .forEach(({ w, r, c }) => items.push({ k: "next", id: c.id, t: `${w.label}${w.days > 0 ? `（还有 ${w.days} 天）` : ""}：${r.reason || "提醒"}` }));
  const K = { decide: ["要你决定", "warn"], news: ["新进展", "ok"], stuck: ["可能卡住了", "stuck"], next: ["快到了", "info"] };
  const order = ["decide", "stuck", "next", "news"], list = items.sort((x, y) => order.indexOf(x.k) - order.indexOf(y.k));
  const hour = new Date().getHours(), hi = hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const shown = S.moreNews ? list : list.slice(0, 3);
  return `<section class="alerts">
    <div class="alerts-h"><b>${hi}，这是我替你盯着的</b><span class="faint s12">${list.length ? `${list.length} 条提醒` : ""}</span></div>
    ${shown.map((x) => `<button class="al" data-act="open" data-id="${x.id}"><span class="tag al-${K[x.k][1]}">${K[x.k][0]}</span>
      <span class="al-t"><span class="al-c">${x.cards?.length > 1 ? x.cards.map(title).join("、") : title(x.id)}</span><span>${esc(x.t)}</span></span><span class="al-go">查看 ›</span></button>`).join("")
      || `<div class="s13 muted" style="padding:6px 2px">一切按计划进行，暂时没有要你操心的。</div>`}
    ${list.length > 3 ? `<button class="al-more" data-act="more-news">${S.moreNews ? "收起" : `展开其余 ${list.length - 3} 条`}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${S.moreNews ? 180 : 0}deg)"><path d="m6 9 6 6 6-6"/></svg></button>` : ""}
  </section>`;
}

function home() {
  const first = allCards().length === 0, inProj = S.proj && S.view === "home" ? st().projects[S.proj] : null;
  const title = inProj ? `今天想和我一起在「${esc(inProj.name)}」里做什么呢？` : "今天想和我一起做什么呢？";
  return `<div class="wrap home-wrap">
    ${first ? "" : revisit()}
    <div class="hero">${AV(84, 74)}<div class="h" style="font-size:${first ? 30 : 24}px">${title}</div></div>
    ${sceneCards()}
    <div class="composer" data-drop="attach">
      <textarea rows="3" aria-label="说一件事" placeholder="说一件放不下的事，比如：和 Alex 还有一些工作一直没对齐&#10;也可以把相关文件拖进来" data-bind="ask" data-keep="ask">${esc(S.ask)}</textarea>
      <div class="composer-f">
        <div class="chips">${S.attach.map((a, i) => `<span class="chip">${esc(a.title)}<button aria-label="移除" data-act="unattach" data-i="${i}">×</button></span>`).join("")}</div>
        <button class="btn mint lg" data-act="tell">Tell me</button>
      </div>
    </div>
    <div class="hints"><div class="row" style="gap:6px"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#C9922E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="提示"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/></svg><a href="#" data-act="demo">快速认识云朵小管家</a></div>${isExample() ? "" : `<div>应用示例：<a href="#" data-act="example">看看云朵小管家是怎么协助做 Q4 规划的</a></div>`}</div>
  </div>`;
}

// ---------- 工作卡 ----------
const ICON_FOLDER = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.6l2 2.2h8.4A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>`;
const ICON_CHEV = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
function projectLine(c) {
  const s = st(), p = c.projectId ? s.projects[c.projectId] : null, ps = Object.values(s.projects);
  return `<div class="pp-wrap">
    <button class="pp ${p ? "set" : ""}" data-act="proj-menu" aria-haspopup="menu" aria-expanded="${S.projMenu}">${ICON_FOLDER}<span>${p ? esc(p.name) : "归入项目"}</span>${ICON_CHEV}</button>
    ${S.projMenu ? `<div class="pp-menu" role="menu">
      ${ps.length ? `<div class="pp-h">放进已有项目</div>${ps.map((x) => `<button role="menuitemradio" aria-checked="${x.id === c.projectId}" class="pp-item ${x.id === c.projectId ? "on" : ""}" data-act="set-proj" data-id="${x.id}">${ICON_FOLDER}<span>${esc(x.name)}</span>${x.id === c.projectId ? `<span class="pp-check">✓</span>` : ""}</button>`).join("")}<div class="pp-sep"></div>` : ""}
      <div class="pp-h">新建项目</div>
      <div class="pp-new"><input type="text" placeholder="比如：秋招面试" aria-label="新项目名" value="${esc(S.newProj)}" data-bind="newProj" data-keep="np"><button class="btn mint" data-act="new-proj">新建</button></div>
      ${p ? `<div class="pp-sep"></div><button class="pp-item muted" data-act="set-proj" data-id="">移出项目，单独放着</button>` : ""}
    </div>` : ""}
  </div>`;
}

function cardView(c) {
  if (c.stage === "candidate") return candidateView(c);
  if (c.stage === "draft") return draftView(c);
  if (changesFor(c.id).length && !S.showCard) return rippleView(c, changesFor(c.id)[0]);
  return activeView(c);
}

function candidateView(c) {
  const s = st(), sug = c.suggestedProject && s.projects[c.suggestedProject.projectId];
  const ps = Object.values(s.projects);
  const reminded = c.reminders.length > 0;
  return `<div class="wrap" style="max-width:560px;margin-top:24px;gap:16px">
    <div class="row" style="gap:10px">${AV(44, 39)}<div style="font-size:14px;color:var(--ink2)">这件事我先记下了，接下来——</div></div>
    <div class="cand">
      <div class="s12 muted">依据：你刚才说的</div>
      <div style="font-size:24px;font-weight:700">${esc(c.title)}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="opt dark" data-act="cand-draft" data-id="${c.id}">${esc(c.nextStep || "先把上次聊到哪、还差什么列出来")}</button>
        <button class="opt" data-act="remind" data-id="${c.id}" ${reminded ? "disabled" : ""}>${reminded ? "好，明天 9:00 提醒你" : "明天提醒我"}</button>
        <button class="opt plain" data-act="dismiss" data-id="${c.id}">不需要</button>
      </div>
      ${sug ? `<div style="border-top:1px solid var(--line3);padding-top:14px;display:flex;flex-direction:column;gap:8px">
        <div class="s13">看起来属于 <b style="font-weight:500">${esc(sug.name)}</b>${c.suggestedProject.why ? `：${esc(c.suggestedProject.why)}` : ""}</div>
        <div class="row" style="gap:8px"><button class="btn" data-act="set-proj" data-id="${sug.id}">归入${esc(sug.name)}</button><button class="btn" data-act="set-proj" data-id="">单独放着</button></div></div>`
      : c.projectId ? `<div class="s13 muted" style="border-top:1px solid var(--line3);padding-top:14px">已归入 ${esc(s.projects[c.projectId]?.name)}</div>`
      : ps.length ? `<div style="border-top:1px solid var(--line3);padding-top:14px">${projectLine(c)}</div>` : ""}
    </div>
    ${S.candAttach.length ? `<div class="chips">${S.candAttach.map((a, i) => `<span class="chip">${esc(a.title)}<button aria-label="移除" data-act="uncand" data-i="${i}">×</button></span>`).join("")}</div>` : ""}
    <label class="dropzone" data-drop="cand" style="cursor:pointer">拖入相关的聊天记录、纪要或表格，我能补全更多<input type="file" multiple accept=".txt,.md,.csv,.json,.tsv,.ics,.rtf" data-change="cand" hidden></label>
  </div>`;
}

function draftView(c) {
  const s = st(), unanswered = c.openQuestions.filter((q) => !q.answer).length;
  const mats = c.originEvidenceIds.filter((id) => s.evidence[id]?.ref !== "chat").map(evTitle);
  return `<div class="panel" style="max-width:720px;margin:20px auto 0">
    <div class="row" style="gap:10px"><span class="tag draft">草稿</span><span class="s12 muted">来自：${["你说的", ...mats].map(esc).join(" + ")}</span><span style="flex-grow:1"></span>${projectLine(c)}</div>
    <div class="title26">${esc(c.title)}</div>
    <div class="grid2">
      <div><div class="lbl">目标</div><div class="val">${esc(c.goal || "—")}</div></div>
      <div><div class="lbl">现状</div><div class="val">${esc(c.status || "—")}</div></div>
      <div><div class="lbl">下一步</div><div class="val">${esc(c.nextStep || "—")}</div></div>
      <div><div class="lbl">${c.waitingOn ? "等待" : "材料"}</div><div class="val">${esc(c.waitingOn || mats.join(" · ") || "—")}</div></div>
    </div>
    ${c.openQuestions.length ? `<div class="confirm"><div class="t">请确认（${unanswered}）</div>
      ${c.openQuestions.map((q, i) => `<div class="q"><div class="qt"><span class="qn">${i + 1}</span>${esc(q.question)}</div><div class="opts">${q.options.map((o) => `<button class="choice ${q.answer === o ? "on" : ""}" data-act="answer" data-card="${c.id}" data-q="${q.id}" data-v="${esc(o)}" aria-pressed="${q.answer === o}">${esc(o)}</button>`).join("")}</div></div>`).join("")}</div>` : ""}
    <details class="more why-details" ${S.why ? "open" : ""}><summary><span class="why-btn">${ICON_CHEV_DOWN}依据</span></summary><div style="display:flex;flex-direction:column;gap:14px;margin-top:12px">
      <div><div class="lbl" style="margin-bottom:4px">依赖的条件</div>${conditionsList(c.premiseIds.map((id) => s.premises[id]).filter(Boolean))}</div>${decisionsBlock(c)}</div></details>
    <div class="row"><button class="btn mint lg" data-act="plan" data-id="${c.id}" ${c.plan?.status === "proposed" ? "disabled" : ""}>${c.plan?.status === "proposed" ? "计划已生成，在右边确认" : "生成执行计划"}</button>
      <span class="s12 muted">${c.plan?.status === "proposed" ? "" : unanswered ? `还有 ${unanswered} 处没确认，也可以先生成` : "确认无误，可以生成计划了"}</span></div>
  </div>
  ${vfPanel(c) ? `<div style="max-width:720px;margin:16px auto 0">${vfPanel(c)}</div>` : ""}`;
}

const ICON_CHEV_DOWN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
const ICON_CHEV_UP = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>`;
const ICON_FILE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>`;
const ICON_MSG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>`;
const ICON_NOTE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16M4 10h16M4 15h10M4 20h7"/></svg>`;
const fileName = (a) => `${(a.output?.title || a.label).replace(/[\\/:*?"<>|]/g, "-")}.md`;
/** 轻量 Markdown 渲染（先转义再加标记，不执行任何 HTML） */
function mdToHtml(src) {
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
  const lines = String(src ?? "").replace(/\r/g, "").split("\n"), out = []; let i = 0;
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue; }
    if (/^\s*$/.test(l)) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { const n = Math.min(m[1].length + 1, 5); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`); continue;
    }
    if (/^\s*>/.test(l)) { const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, "")); out.push(`<blockquote>${buf.map(inline).join("<br>")}</blockquote>`); continue; }
    if (/^\s*([-*·•]|\d+[.、)])\s+/.test(l)) {
      const ol = /^\s*\d/.test(l), buf = [];
      while (i < lines.length && /^\s*([-*·•]|\d+[.、)])\s+/.test(lines[i])) {
        const ind = /^\s{2,}/.test(lines[i]); buf.push(`<li${ind ? ' class="sub"' : ""}>${inline(lines[i].replace(/^\s*([-*·•]|\d+[.、)])\s+/, ""))}</li>`); i++;
      }
      out.push(ol ? `<ol>${buf.join("")}</ol>` : `<ul>${buf.join("")}</ul>`); continue;
    }
    const buf = []; while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|```|\s*([-*·•]|\d+[.、)])\s+|\s*>|\s*\|.*\|\s*$)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }
  return out.join("");
}
function previewModal() {
  const a = S.preview && st()?.actions[S.preview]; if (!a?.output) return "";
  return `<div class="modal-bg" data-act="close-preview"><div class="modal" role="dialog" aria-label="${esc(fileName(a))}" data-act="noop">
    <div class="modal-h">${ICON_FILE}<b>${esc(fileName(a))}</b><span style="flex:1"></span>
      <button class="btn sm mint" data-act="download-out" data-id="${a.id}">下载</button><button class="x-btn" data-act="close-preview" aria-label="关闭"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="modal-b md">${mdToHtml(a.output.body)}</div></div></div>`;
}
const whyBtn = () => `<button class="why-btn ${S.why ? "on" : ""}" data-act="why" aria-expanded="${S.why}">${S.why ? ICON_CHEV_UP : ICON_CHEV_DOWN}依据</button>`;
const ICON_PEN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>`;
/** 依赖的条件：一行一个，悬停露出铅笔，点开原地编辑 */
function conditionsList(list) {
  return `<div class="conds">${list.map((p) => {
    const was = p.history.at(-1)?.value;
    const state = p.inferred ? `<span class="tag info" title="${esc(p.inferred.reason)}">推断</span>` : p.confirmed ? "" : `<span class="tag warn">未确认</span>`;
    if (S.editing === p.id) return `<div class="cond editing"><span class="c-lbl">${esc(p.label)}</span>
      <input type="text" value="${esc(S.editVal)}" data-bind="editVal" data-keep="edit" aria-label="${esc(p.label)}的新值">
      <button class="btn mint small-btn" data-act="edit-save" data-id="${p.id}">保存</button><button class="btn ghost small-btn" data-act="edit-cancel">取消</button></div>`;
    return `<div class="cond" id="cond-${p.id}"><span class="c-lbl">${esc(p.label)}</span>
      <div class="c-main"><div class="c-line"><span class="c-val">${esc(p.value)}</span>${was && was !== p.value && p.confirmed ? `<span class="was">${esc(was)}</span>` : ""}${state}</div>
        <div class="c-src">来自 ${p.evidenceIds.map(evTitle).map(esc).join("、") || "—"}</div></div>
      <button class="pen" data-act="edit" data-id="${p.id}" aria-label="修改${esc(p.label)}">${ICON_PEN}<span>修改</span></button></div>`; }).join("") || `<div class="s13 faint">暂无</div>`}</div>`;
}

function decisionsBlock(c) {
  const s = st();
  return `<div><div class="lbl" style="margin-bottom:6px">决策</div><div class="list">${c.decisionIds.map((id) => s.decisions[id]).filter(Boolean).map((d) =>
    `<div class="li"><div>${d.status === "superseded" || d.status === "invalidated" ? `<span class="strike">${esc(d.statement)}</span>` : esc(d.statement)}</div><span class="tag ${DEC[d.status][1]}">${DEC[d.status][0]}</span></div>`).join("") || `<div class="s13 faint">还没有决策</div>`}</div></div>`;
}
function actionsBlock(c) {
  const s = st();
  return `<div><div class="lbl" style="margin-bottom:6px">动作与产出</div><div class="list">${c.actionIds.map((id) => s.actions[id]).filter(Boolean).map((a) => {
    const [l, cls] = a.status === "cancelled" || a.status === "done" ? ACT[a.status] : a.compensationFor && !a.approvedAt ? ["等你确认", "warn"] : a.output?.kind === "message" && a.status === "planned" ? ["草稿 · 等你发送", "info"] : ACT[a.status];
    const open = S.openDoc.has(a.id);
    const o = a.output, ext = a.external ? ` <span class="tag muted">对外</span>` : "";
    let name, body = "";
    if (!o) name = `<span>${esc(a.label)}</span>${ext}`;
    else if (o.kind === "document") name = `<button class="out-file" data-act="preview" data-id="${a.id}" title="预览与下载">${ICON_FILE}<span>${esc(fileName(a))}</span></button>${ext}`;
    else {
      name = `<button class="out-exp" data-act="doc" data-id="${a.id}" aria-expanded="${open}">${open ? ICON_CHEV_UP : ICON_CHEV_DOWN}${o.kind === "message" ? ICON_MSG : ICON_NOTE}<span>${esc(a.label)}</span></button>${ext}`;
      if (open) body = o.kind === "message"
        ? `<div class="omsg"><div class="omsg-h"><div><span class="faint">发给</span> ${esc(o.to || "—")}</div>${o.title ? `<div><span class="faint">主题</span> ${esc(o.title)}</div>` : ""}</div>
            <div class="omsg-b">${esc(o.body)}</div>
            <div class="omsg-f"><span class="faint s12">${a.status === "done" ? "已发出的原文" : "草稿还没发出，可以复制后自己发送"}</span><button class="choice sm" data-act="copy-out" data-id="${a.id}">复制</button></div></div>`
        : `<div class="note-b md">${mdToHtml(o.body)}</div>`;
    }
    return `<div class="li" style="flex-direction:column;align-items:stretch;gap:0"><div class="row" style="justify-content:space-between;gap:12px">
      <span class="row" style="gap:6px;min-width:0">${name}</span><span class="tag ${cls}">${l}</span></div>${body}</div>`; }).join("") || `<div class="s13 faint">还没有动作</div>`}</div></div>`;
}

function activeView(c) {
  const s = st(), d = decisionMain(c);
  const rem = c.reminders.map((r) => ({ r, w: when(r.at) })).filter(({ w }) => typeof w !== "string" && w.days >= 0).sort((a, b) => String(a.r.at).localeCompare(String(b.r.at)))[0];
  const prem = d ? d.premiseIds.map((id) => s.premises[id]).filter(Boolean) : [];
  const all = c.premiseIds.map((id) => s.premises[id]).filter(Boolean);
  const others = all.filter((p) => !prem.includes(p));
  const attention = all.filter((p) => p.inferred || !p.confirmed);
  const canDemo = c.id === "wc_alex" && s.premises.pr_budget?.value === "50 万" && !Object.values(s.evidence).some((e) => e.ref === "对齐材料/预算表-v3.csv");
  const ghEv0 = (c.originEvidenceIds ?? []).map((id) => s.evidence[id]).find((e) => (e?.ref === "github" || e?.ref === `${VF}/PR 状态.md`) && /#412/.test(e.excerpt));
  const ghEv = ghEv0 && latestOf(ghEv0.ref);
  const canSim = ghEv && !/#412[^\n]*Merged/.test(ghEv.excerpt);
  return `<div style="display:flex;flex-direction:column;gap:16px">
    ${changesFor(c.id).length ? `<div class="amber row" style="justify-content:space-between"><span>有一处前提变化需要你决定</span><button class="btn" data-act="show-ripple">去处理</button></div>` : ""}
    ${Object.values(st().proposals ?? {}).some((p) => p.workCardId === c.id && p.status === "pending") ? `<div class="amber">有一处变化在右边等你确认</div>` : ""}
    <div class="panel" style="gap:20px">
      <div class="row" style="gap:10px"><span class="tag active">进行中</span>${rem ? `<span class="s12 muted">${esc(rem.w.label)}${rem.w.days > 0 ? ` · 还有 ${rem.w.days} 天` : ""} · ${esc(rem.r.reason)}</span>` : ""}<span style="flex-grow:1"></span>${projectLine(c)}</div>
      <div class="title26">${esc(c.title)}</div>
      ${trackStrip(c)}
      <div class="grid3" style="gap:20px">
        <div><div class="lbl">进度</div><div class="val">${esc(c.status || "—")}</div></div>
        <div><div class="lbl">等待</div><div class="val">${esc(c.waitingOn || "—")}</div></div>
        <div><div class="lbl">关键决策</div><div class="val row" style="gap:8px">${esc(d?.statement ?? "—")}${d ? whyBtn() : ""}</div></div>
      </div>
      ${S.why ? `<div class="why2">
        <div class="why2-h">${d ? `为什么是「${esc(d.statement)}」` : "依据"}</div>
        <section><div class="why2-sub">依赖的条件<span>${(prem.length ? prem : all).length}</span></div>${conditionsList(prem.length ? prem : all)}
          ${prem.length && others.length ? `<div class="why2-sub minor">这件事的其他条件<span>${others.length}</span></div>${conditionsList(others)}` : ""}</section>
        ${d?.provenance.evidenceIds.length ? `<section><div class="why2-sub">依据的原文<span>${d.provenance.evidenceIds.length}</span></div>
          <div class="quotes">${d.provenance.evidenceIds.map((id) => `<figure class="quote"><blockquote>${esc(s.evidence[id]?.excerpt.slice(0, 160))}</blockquote><figcaption>${esc(evTitle(id))}</figcaption></figure>`).join("")}</div></section>` : ""}
      </div>`
      : attention.length ? `<button class="attn" data-act="why">${attention.map((p) => p.inferred ? `${esc(p.label)}已按推断改为 ${esc(p.value)}` : `依赖还没确认的条件：${esc(p.label)} ${esc(p.value)}`).join("；")} <span class="link">查看依据</span></button>` : ""}
      ${c.nextStep ? `<div><div class="lbl">下一步</div><div class="val">${esc(c.nextStep)}</div></div>` : ""}
    </div>
    <div class="panel pad24">${actionsBlock(c)}</div>
    ${vfPanel(c)}
    <div class="cta2">
      ${canSim ? `<button class="demo play" data-act="sim-pr"><img src="/play.svg" alt="" width="40" height="40"><span><b>模拟一次变化：Git 仓库中 #412 支付流程 PR 合并了</b><small>看看我会怎么发现变化、调整风险判断</small></span></button>`
        : canDemo ? `<button class="demo play" data-act="demo-change"><img src="/play.svg" alt="" width="40" height="40"><span><b>${S.demoSent ? "已模拟：新预算表放进了文件夹" : "演示：小王发来新的预算表"}</b><small>${S.demoSent ? "我在后台看，看完会来找你，你可以先去别处" : "模拟他把 30 万的新预算表放进「对齐材料」文件夹"}</small></span></button>`
        : `<div class="newmat" data-drop="material"><span>有新的材料？给我看看，我判断会不会改变什么<small class="faint" style="display:block;font-size:12px;margin-top:2px">支持 txt、md、rtf、csv、json、ics 文件</small></span><label class="btn mint" style="cursor:pointer">上传新材料<input type="file" multiple accept=".txt,.md,.csv,.json,.tsv,.ics,.rtf" data-change="material-files" hidden></label></div>`}
    </div>
  </div>`;
}

function rippleView(c, pc) {
  const s = st(), p = s.premises[pc.premiseId];
  const on = pc.impacts.filter((i) => i.workCardId === c.id), other = pc.impacts.filter((i) => i.workCardId !== c.id && i.handling !== "unaffected");
  const name = (i) => i.kind === "decision" ? s.decisions[i.id]?.statement : i.kind === "action" ? s.actions[i.id]?.label : Object.values(s.workCards).flatMap((x) => x.reminders).find((r) => r.id === i.id)?.reason;
  const nDec = pc.impacts.filter((i) => i.kind === "decision" && i.handling !== "unaffected").length, nAct = pc.impacts.filter((i) => i.kind !== "decision" && i.handling !== "unaffected").length;
  const nAuto = pc.impacts.filter((i) => i.handling === "auto_updated").length, nNeed = pc.impacts.filter((i) => i.handling === "needs_user").length;
  const comp = (i) => Object.values(s.actions).find((a) => a.compensationFor === i.id);
  const box = (cls, k, i, extra = "") => `<div class="ritem"><div class="k ${cls}">${k}</div><div class="v">${esc(name(i))}</div>${extra}</div>`;
  return `<div class="panel pad24">
    <div class="rp-head"><div class="t">前提变化：${esc(p?.label)}从 ${esc(pc.from)} 变成 ${esc(pc.to)}</div>
      <div class="d">来源：${esc(evTitle(pc.evidenceId))} · 影响 ${nDec} 条结论、${nAct} 个动作 · 已自动处理 ${nAuto} 项，需要你决定 ${nNeed} 项</div></div>
    ${on.filter((i) => i.handling === "needs_user").map((i) => { const d = s.decisions[i.id], a = pc.assessments.find((x) => x.decisionId === i.id);
      if (!d || !["invalidated", "weakened"].includes(d.status)) return "";
      return `<div class="s12 muted">需要你决定</div><div class="need">
        <div class="row" style="gap:10px"><span class="tag ${d.status === "invalidated" ? "bad" : "warn"}">${d.status === "invalidated" ? "不再成立" : "可能要调整"}</span><span class="strike">${esc(d.statement)}</span></div>
        ${a?.reason ? `<div class="s13 muted">${esc(a.reason)}</div>` : ""}
        ${d.suggestion ? `<div style="font-size:14px">建议${esc(d.suggestion.statement)}，代价是${esc(d.suggestion.tradeoff)}</div>` : ""}
        <div class="row" style="gap:8px">${d.suggestion ? `<button class="btn mint" data-act="resolve" data-id="${d.id}" data-kind="adopt_suggestion">采用建议</button>` : ""}<button class="btn" data-act="resolve" data-id="${d.id}" data-kind="keep">仍按原决定</button><button class="btn ghost" data-act="own-open" data-id="${d.id}">我想换个做法</button></div>
        ${S.ownFor === d.id ? `<div class="own"><input type="text" placeholder="直接写你的决定，比如：先做方案 B 的核心部分，A 下季度再补" data-bind="ownText" data-keep="own" value="${esc(S.ownText)}"><button class="btn mint" data-act="resolve-own" data-id="${d.id}">按我的来</button></div><div class="s12 faint">相关的计划和草稿会按你的决定重新检查</div>` : ""}</div>`; }).join("")}
    <div class="grid2" style="gap:12px">
      ${on.filter((i) => i.handling === "paused").map((i) => box("paused", "已暂停，等上面决定", i)).join("")}
      ${on.filter((i) => i.handling === "auto_updated").map((i) => box("auto", "已自动更新", i)).join("")}
      ${on.filter((i) => i.handling === "compensate").map((i) => box("comp", "你已发出，需要补一句更正", i, comp(i) ? `<div class="s12" style="margin-top:6px">${comp(i).status === "cancelled" ? "你决定不发更正" : comp(i).approvedAt ? "更正消息已确认，在右边可以复制去发送" : "我起草了一份更正，在右边等你确认"}</div>` : "")).join("")}
      ${on.filter((i) => i.handling === "unaffected").map((i) => box("keep", "仍然成立", i)).join("")}
    </div>
    ${other.length ? `<div class="also"><div class="s12 muted">同一项目里也受影响${c.projectId ? `（${esc(p?.label)}是${esc(s.projects[c.projectId]?.name)}的共享前提条件）` : ""}</div>
      ${other.map((i) => `<div>· ${esc(s.workCards[i.workCardId]?.title)}：${esc(name(i))}，<span style="color:${i.handling === "auto_updated" ? "var(--green)" : i.handling === "compensate" ? "var(--red)" : "var(--amber)"}">${{ auto_updated: "已自动调整", paused: "等上面决定", needs_user: "需要你决定", compensate: "已发生，已起草更正" }[i.handling]}</span></div>`).join("")}</div>` : ""}
    <div><button class="more-link" data-act="show-card">查看完整背景 ›</button></div>
  </div>`;
}

// ---------- 卡片经历（标题下的小时间轴） ----------
const EV_ICON = {
  card_created: `<path d="M12 5v14M5 12h14"/>`,
  decision_made: `<path d="m5 12 5 5 9-10"/>`,
  plan_confirmed: `<path d="M8 5v14l11-7z"/>`,
  external_action_executed: `<path d="M5 12h13M13 6l6 6-6 6"/>`,
  premise_changed: `<path d="M12 7v6M12 17h.01"/>`,
  rolled_back: `<path d="M4 10h11a5 5 0 0 1 0 10H9"/><path d="m8 6-4 4 4 4"/>`,
};
const evIcon = (t) => `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EV_ICON[t] ?? `<circle cx="12" cy="12" r="3"/>`}</svg>`;
const cardEvents = (s, c) => s.events.filter((e) => e.visibleInTimeline && (e.workCardId === c.id || (e.type === "premise_changed" && c.premiseIds.includes(e.payload.premiseId))));
const shortDate = (at) => { const d = new Date(at); return `${d.getMonth() + 1}/${d.getDate()}`; };
const TRACK_TYPES = new Set(["card_created", "decision_made", "plan_confirmed", "external_action_executed", "premise_changed", "rolled_back"]);
function snapDiff(c, snap) {
  const s = st(), rows = [], curD = decisionMain(c)?.statement, oldD = snap.decisions.find((d) => d.status !== "superseded")?.statement;
  if (oldD !== curD) rows.push(["关键决策", oldD ?? "—", curD ?? "—"]);
  snap.premises.forEach((p) => { const now = s.premises[p.id]?.value; if (now && now !== p.value) rows.push([p.label, p.value, now]); });
  if ((snap.nextStep || "") !== (c.nextStep || "")) rows.push(["下一步", snap.nextStep || "—", c.nextStep || "—"]);
  return rows;
}
function tkGuide() {
  let seen = false; try { seen = localStorage.getItem("puffin.tkGuide") === "1"; } catch {}
  if (seen || S.tkGuideOff) return "";
  return `<div class="tk-guide" role="note"><b>这是这件事的经历</b>
    <div class="tk-legend"><span><i class="lgd agent"></i>云朵小管家做的</span><span><i class="lgd user"></i>你做的</span><span><i class="lgd warn"></i>条件变化</span></div>
    <div>实心的节点可以回到那时；悬停看是什么事，点开看当时和现在的差别。</div>
    <button class="btn sm mint" data-act="tk-guide-ok">知道了</button></div>`;
}
function trackStrip(c) {
  const s = st(), evs = cardEvents(s, c).filter((e) => TRACK_TYPES.has(e.type)); if (!evs.length) return "";
  const pick = S.tlEvent ? evs.find((e) => e.id === S.tlEvent) : null;
  const dot = (e) => `<button class="tk ${pick?.id === e.id ? "on" : ""} ${e.payload.snapshot && snapDiff(c, e.payload.snapshot).length ? "rb" : ""} t-${e.type === "premise_changed" ? "warn" : e.actor === "user" ? "user" : "agent"}" data-act="tk" data-id="${e.id}" aria-label="${esc(e.summary)}">
      <span class="tk-dot"></span><span class="tk-d">${shortDate(e.at)}</span><span class="tk-tip">${esc(e.summary)}</span></button>`;
  return `<div class="track"><div class="track-row">${evs.map(dot).join("")}<span class="tk now"><span class="tk-dot"></span><span class="tk-d">现在</span></span></div>
    ${pick ? trackDetail(c, pick) : tkGuide()}</div>`;
}
function trackDetail(c, e) {
  const s = st(), snap = e.payload.snapshot, who = { user: "你", agent: "云朵小管家", watcher: "云朵小管家" }[e.actor];
  const head = `<div class="tkd-h"><span><b>${esc(e.summary)}</b><span class="faint s12"> · ${who} · ${timeAgo(e.at)}</span></span><button class="choice sm" data-act="tk" data-id="${e.id}">收起</button></div>`;
  if (!snap) return `<div class="tkd">${head}</div>`;
  const rows = snapDiff(c, snap);
  const body = rows.length ? `<table class="tkd-t"><tr><th></th><th>那时</th><th>现在</th></tr>${rows.map(([k, a, b]) => `<tr><td>${esc(k)}</td><td>${esc(a)}</td><td><b>${esc(b)}</b></td></tr>`).join("")}</table>`
    : "";
  const note = S.rollbackNote && rows.length ? `<div class="amber s13" style="line-height:1.7">回到这时只恢复工作状态，不会撤回已经发生的事${c.actionIds.map((id) => s.actions[id]).filter((a) => a?.external && a.status === "done").map((a) => `；${esc(a.label)}已经发出`).join("")}。之后变化过的条件会重新检查。</div>` : "";
  return `<div class="tkd">${head}${body}${note}${rows.length ? `<div><button class="btn sm ${S.rollbackNote ? "dark" : ""}" data-act="rollback" data-id="${e.id}">${S.rollbackNote ? "确认回到这时" : "回到这时"}</button></div>` : ""}</div>`;
}

// ---------- 时间线 ----------
function timelineView() {
  const s = st(), c = s.workCards[S.sel];
  if (!c) return home();
  const evs = s.events.filter((e) => e.visibleInTimeline && (e.workCardId === c.id || (e.type === "premise_changed" && c.premiseIds.includes(e.payload.premiseId))));
  const pick = S.tlEvent && evs.find((e) => e.id === S.tlEvent) ? evs.find((e) => e.id === S.tlEvent) : [...evs].reverse().find((e) => e.payload.snapshot);
  const snap = pick?.payload.snapshot;
  const cur = decisionMain(c);
  return `<div class="tlwrap">
    <div class="tllist"><div class="s12 muted" style="margin-bottom:6px">时间线 · 只记关键事件</div>
      ${evs.map((e) => `<button class="ev ${pick?.id === e.id ? "on" : ""}" ${e.payload.snapshot ? `data-act="tl-pick" data-id="${e.id}"` : "disabled"}><div style="font-size:14px">${esc(e.summary)}</div><div class="m">${{ user: "你", agent: "云朵小管家", watcher: "云朵小管家发现" }[e.actor]} · ${timeAgo(e.at)}</div></button>`).join("")}
      <div class="ev"><div style="font-size:14px">现在</div></div>
      <button class="link" style="align-self:flex-start;margin-top:8px" data-act="open" data-id="${c.id}">← 回到工作卡</button>
    </div>
    <div class="panel pad24" style="flex-grow:1;gap:16px">
      ${snap ? `<div class="s12 muted">当时的工作卡快照（只读）· ${timeAgo(pick.at)} · ${esc(pick.summary)}</div>
        <div class="grid2">
          <div><div class="lbl">关键决策</div><div class="val">${esc(snap.decisions.find((d) => d.status !== "superseded")?.statement ?? "—")}${cur && cur.statement !== snap.decisions.find((d) => d.status !== "superseded")?.statement ? `<span class="now">现在：${esc(cur.statement)}</span>` : ""}</div></div>
          <div><div class="lbl">前提</div><div class="val">${snap.premises.map((p) => { const now = s.premises[p.id]?.value; return `${esc(p.label)} ${esc(p.value)}${now && now !== p.value ? `<span class="now">现在：${esc(now)}</span>` : ""}`; }).join("<br>") || "—"}</div></div>
          <div><div class="lbl">下一步</div><div class="val">${esc(snap.nextStep || "—")}</div></div>
        </div>
        <div class="row" style="gap:8px;border-top:1px solid var(--line3);padding-top:16px">
          <button class="btn dark" data-act="rollback" data-id="${pick.id}">${S.rollbackNote ? "确认回到这里" : "回到这里"}</button>
          <button class="btn" disabled title="下一版支持">从这里分叉</button>
        </div>
        ${S.rollbackNote ? `<div class="amber" style="line-height:1.7">回退只恢复工作状态，不撤回已发生的事：<br>${snap.premises.filter((p) => s.premises[p.id] && s.premises[p.id].value !== p.value).map((p) => `· ${esc(p.label)}的变化（${esc(p.value)} → ${esc(s.premises[p.id].value)}）仍在，回退后依赖它的决定会立即重新检查`).join("<br>")}
          ${c.actionIds.map((id) => s.actions[id]).filter((a) => a?.external && a.status === "done").map((a) => `<br>· ${esc(a.label)}你已经发出去了，回到这时也收不回`).join("")}</div>` : ""}`
      : `<div class="muted">选择左边一个时间点，查看当时的工作卡。</div>`}
    </div>
  </div>`;
}

// ---------- 项目 ----------
function projectView() {
  const s = st(), p = s.projects[S.proj], cs = cardsOf(p.id);
  const changed = openChanges().filter((pc) => s.premises[pc.premiseId]?.projectId === p.id);
  const refs = (pid) => cs.filter((c) => c.premiseIds.includes(pid) || c.actionIds.some((a) => s.actions[a]?.premiseIds?.includes(pid))).length;
  return `<div style="display:flex;flex-direction:column;gap:18px">
    <div><div class="lbl">项目</div><div style="font-size:28px;font-weight:700;margin-top:2px">${esc(p.name)}</div>${p.goal ? `<div style="font-size:14px;color:var(--ink2);margin-top:6px">目标：${esc(p.goal)}</div>` : ""}</div>
    ${p.premiseIds.length ? `<div class="grid3">${p.premiseIds.map((id) => s.premises[id]).filter(Boolean).map((pr) => {
      const was = pr.history.at(-1)?.value, n = refs(pr.id);
      return `<div class="prem ${was && was !== pr.value ? "changed" : pr.confirmed ? "" : "unconf"}"><div class="lbl">共享前提条件 · ${esc(pr.label)}</div><div style="font-size:16px;margin-top:4px">${esc(pr.value)}${was && was !== pr.value ? `<span class="s12 muted">（原 ${esc(was)}）</span>` : ""}</div>
        <div class="s11" style="margin-top:6px;color:${pr.confirmed ? "var(--ink3)" : "var(--red)"}">${pr.confirmed ? "" : "未确认 · "}被 ${n} 项工作引用</div></div>`; }).join("")}</div>` : ""}
    ${changed.length ? `<div class="amber">${changed.map((pc) => `${esc(s.premises[pc.premiseId]?.label)}变化影响了本项目 ${new Set(pc.impacts.filter((i) => i.handling !== "unaffected").map((i) => i.workCardId)).size} 项工作：${pc.impacts.filter((i) => i.handling === "needs_user").length} 项需要你决定，${pc.impacts.filter((i) => i.handling === "auto_updated").length} 项已自动调整`).join("；")}</div>` : ""}
    <div class="row"><div class="lbl" style="flex-grow:1">工作</div><button class="btn outline-mint" data-act="new-in-proj">＋ 在这个项目里开始新对话</button></div>
    <div class="grid2" style="gap:12px">${cs.map((c) => { const d = decisionMain(c);
      return `<button class="pcard" data-act="open" data-id="${c.id}"><div class="row" style="gap:8px">${c.stage === "candidate" ? "" : `<span class="tag ${STAGE[c.stage][1]}">${STAGE[c.stage][0]}</span>`}${needsYou(c) ? `<span class="s11" style="color:var(--red)">需要你决定</span>` : ""}</div>
        <div style="font-size:15px;font-weight:500">${esc(c.title)}</div><div class="s13" style="color:var(--ink2)">${esc(d?.statement ?? c.waitingOn ?? c.nextStep ?? "")}</div></button>`; }).join("")}</div>
  </div>`;
}

// ---------- 快速认识云朵小管家（引导，不调用模型） ----------
function demoView() {
  const steps = ["你丢给我一段纪要", "几天后，来了新消息", "我会这样告诉你", "你做决定，我接着跟"];
  const k = S.tour;
  const dots = `<div class="tour-steps">${steps.map((t, i) => `<button class="tour-step ${i === k ? "on" : i < k ? "done" : ""}" data-act="tour" data-i="${i}"><span>${i + 1}</span>${t}</button>`).join("")}</div>`;
  const note = (hl) => `<div class="box" style="padding:18px;font-size:14px;line-height:1.9;display:block"><div class="lbl">周会纪要 · 9/22</div>
    ……大家都觉得 <mark class="g">10 月 15 日前上灰度</mark>。设计这边 <mark class="${hl ? "r" : "a"}">应该够用吧</mark>。<mark class="b">法务审核要多久还不知道</mark>。小李周三前出方案……</div>`;
  const card = (broken) => `<div class="box" style="border-color:var(--line2);padding:18px;font-size:14px">
    <div class="row" style="gap:8px"><span class="tag active">进行中</span><b style="font-weight:500">新版灰度上线</b></div>
    <div><span class="s11" style="color:var(--green)">决定</span><div class="${broken ? "strike" : ""}">10 月 15 日前上线灰度</div>${broken ? `<div class="s12" style="color:var(--red)">依赖的前提变了，需要你重新决定</div>` : ""}</div>
    <div><span class="s11" style="color:var(--amber)">暂定假设（没人确认）</span><div>${broken ? `<span class="strike">设计资源够用</span> → <b style="font-weight:500">灰度前只有 1 位设计</b>` : "设计资源够用"}</div></div>
    <div><span class="s11" style="color:var(--blue)">待确认</span><div>法务审核要多久？</div></div>
    <div><span class="s11 muted">下一步</span><div>小李周三前出方案</div></div></div>`;
  const nextBtn = (label = "下一步") => `<button class="btn mint lg" data-act="tour" data-i="${k + 1}">${label}</button>`;
  const cap = (t) => `<div class="tour-cap">${AV(44, 39)}<div>${t}</div></div>`;
  let body = "";
  if (k === 0) body = `${cap("你随手丢给我一段会议纪要。我不会只做个摘要，而是拆成<b>决定</b>、<b>没人确认的假设</b>、<b>待确认</b>和<b>下一步</b>，并记住决定依赖哪些假设。")}
    <div class="grid2" style="gap:16px">${note(false)}${card(false)}</div><div class="row">${nextBtn()}</div>`;
  if (k === 1) body = `${cap("几天后你没来找我，但你授权我关注的地方来了一条新消息。我读到后发现：「设计资源够用」这个假设不成立了，而「10 月 15 日上灰度」正是依赖它做的决定。")}
    <div class="grid2" style="gap:16px">
      <div class="box" style="padding:18px"><div class="lbl">新材料 · 9/25 · 来自你授权的「项目群聊记录」文件夹</div>
        <div class="msg agent" style="max-width:none;border-color:var(--amber-line)">设计 Lily：Q4 的排期已经满了，灰度前最多只能给 1 个人，而且要到 10 月下旬。</div>
        <div class="s12 muted">我只读你授权的范围；没授权的群聊、邮箱我看不到。</div></div>
      ${card(true)}</div><div class="row"><button class="btn" data-act="tour" data-i="0">上一步</button>${nextBtn("看我怎么告诉你")}</div>`;
  if (k === 2) body = `${cap("变化发生后，我不会把它埋在聊天记录里。你下次打开页面，会在三个地方同时看到它；点进去是一张影响清单，只有真正需要你拍板的事才会等你。")}
    <div class="grid3" style="gap:12px">
      <div class="box"><div class="lbl">① 左栏：项目上出现标记</div>
        <div class="proj" style="pointer-events:none"><div class="name"><span>新版上线</span><span class="tag warn">1 待决定</span></div><div class="s11 muted" style="margin-top:4px">3 项工作 · 共享 2 个前提条件</div></div></div>
      <div class="box"><div class="lbl">② 首页：自你上次离开</div>
        <div class="box" style="border-color:var(--amber-line);gap:6px;padding:12px"><div class="s12" style="color:var(--amber);font-weight:500">需要你决定 · 1</div><div class="s13">设计只剩 1 人，「10 月 15 日上灰度」需要重新决定</div></div></div>
      <div class="box"><div class="lbl">③ 对话：我主动说</div>
        <div class="msg agent" style="max-width:none">Lily 说设计排不过来，10 月 15 日上灰度可能要重新定。我先把给法务的提审邮件草稿停下了，你看看要不要改时间？</div></div>
    </div>
    <div class="panel pad24"><div class="rp-head"><div class="t">前提变化：设计资源从「够用」变成「灰度前只有 1 位」</div><div class="d">来源：项目群聊记录 9/25 · 影响 1 个决定、2 个动作 · 已自动处理 1 项，需要你决定 1 项</div></div>
      <div class="need"><div class="row" style="gap:10px"><span class="tag bad">不再成立</span><span class="strike">10 月 15 日前上线灰度</span></div>
        <div>建议推迟到 10 月 29 日，代价是错过双十一前的数据观察期</div>
        <div class="row" style="gap:8px"><button class="btn mint" data-act="tour-decide">采用建议</button><button class="btn" data-act="tour-decide">仍按原计划</button></div></div>
      <div class="grid2" style="gap:12px">
        <div class="ritem"><div class="k paused">已暂停，等上面决定</div><div class="v">给法务的提审邮件（草稿，未发送）</div></div>
        <div class="ritem"><div class="k auto">已自动更新</div><div class="v">「10 月 13 日提醒你准备上线」改为跟随新日期</div></div>
        <div class="ritem"><div class="k keep">仍然成立</div><div class="v">小李周三前出方案</div></div>
      </div></div>
    <div class="row"><button class="btn" data-act="tour" data-i="1">上一步</button></div>`;
  if (k === 3) body = `${cap(S.tourDecided ? "记下了。之后我会按新的日期继续跟：提醒顺延、提审草稿按新时间改好等你看。每一步都记在时间线上，哪天想反悔，可以回到之前任何一个时间点。" : "你做完决定后，我会按新的决定接着跟，并把过程记在时间线上。")}
    <div class="grid2" style="gap:16px">
      <div class="tllist" style="width:auto"><div class="s12 muted" style="margin-bottom:6px">时间线 · 只记关键事件</div>
        ${[["根据纪要整理出这张工作卡", "云朵小管家 · 9/22"], ["你确认：10 月 15 日前上线灰度", "你 · 9/22"], ["设计资源从「够用」变成「灰度前只有 1 位」", "云朵小管家发现 · 9/25"], ["先暂停了给法务的提审邮件", "云朵小管家 · 9/25"], ...(S.tourDecided ? [["你决定改为 10 月 29 日上线灰度", "你 · 刚刚"], ["提审邮件草稿已按新日期改好，等你确认", "云朵小管家 · 刚刚"]] : [])]
          .map(([t, m], i) => `<div class="ev ${i === 1 ? "on" : ""}"><div style="font-size:14px">${t}</div><div class="m">${m}</div></div>`).join("")}</div>
      <div class="box" style="padding:18px"><div class="lbl">当时的工作卡快照（只读）· 9/22</div>
        <div><div class="lbl">决定</div><div class="val">10 月 15 日前上线灰度 ${S.tourDecided ? `<span class="now">现在：10 月 29 日</span>` : ""}</div></div>
        <div><div class="lbl">前提</div><div class="val">设计资源够用 <span class="now">现在：只有 1 位</span></div></div>
        <div class="amber">可以「回到这里」：只恢复工作状态，已经发生的事不会被撤回。</div></div>
    </div>
    <div class="tour-end"><div style="font-weight:500">这就是云朵小管家：记住的不是聊天，而是这件事依赖什么；依赖的东西一变，我会找出影响、告诉你、等你拍板。</div>
      <div class="row" style="justify-content:center">
        ${isExample() ? "" : `<button class="btn mint lg" data-act="example">载入完整例子，亲手试一遍</button>`}
        <button class="btn lg" data-act="home">用你自己的一件事试试</button></div></div>`;
  return `<div class="wrap" style="max-width:960px;gap:18px">
    <div class="row" style="justify-content:space-between"><div><div class="lbl">快速认识云朵小管家</div><div style="font-size:22px;font-weight:700">它怎么持续跟进一件事的变化</div></div>
      <button class="btn" data-act="home">← 回到首页</button></div>
    ${dots}${body}
    <div class="s12 faint">这是一段示意，不会调用模型，也不会读取你的任何数据。</div>
  </div>`;
}

// ---------- 对话面板 ----------
function chatPanel() {
  const s = st();
  let scope = "云朵小管家", title = "有事随时找我", msgs = [], plan = null, key = null;
  const c = (S.view === "card" || S.view === "timeline") ? s.workCards[S.sel] : null;
  if (c) {
    scope = c.projectId ? s.projects[c.projectId]?.name ?? "" : "未归类"; title = c.title; key = c.id;
    msgs = s.chats?.[c.id] ?? []; if (c.plan?.status === "proposed") plan = c.plan;
    if (!msgs.length) msgs = [{ role: "agent", text: "关于这件事，有什么变化或者想让我做的，直接跟我说。" }];
  } else if (S.view === "project" && s.projects[S.proj]) {
    scope = "项目"; title = s.projects[S.proj].name;
    msgs = [{ role: "agent", text: `这 ${cardsOf(S.proj).length} 项工作共用 ${s.projects[S.proj].premiseIds.length} 个前提，任何一个变了，我会一起检查。想在这个项目里开始一件新的事，直接告诉我。` }];
  } else {
    msgs = [{ role: "agent", text: "有一件不想丢的事，随口说，或者丢一份材料给我。" }];
  }
  const pending = S.pending && S.pending.key === key;
  return `<div class="head">${AV(36, 32)}<div style="min-width:0"><div class="sc">${esc(scope)}</div><div class="ti">${esc(title)}</div></div></div>
    <div class="msgs">
      ${msgs.map((m) => `${m.quote ? `<div class="msg-quote">${esc(m.quote)}</div>` : ""}<div class="msg ${m.role}" data-quotable="1">${esc(m.text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")}${(m.proposalIds ?? []).map(proposalBlock).join("")}</div>`).join("")}
      ${pending ? `${S.pending.quote ? `<div class="msg-quote">${esc(S.pending.quote)}</div>` : ""}<div class="msg user">${esc(S.pending.text)}</div><div class="msg agent thinking"><div class="spin"></div>想一想…</div>` : ""}
      ${plan ? planCard(c, plan) : ""}
    </div>
    ${S.quote ? `<div class="quote-chip"><span>引用：${esc(S.quote)}</span><button aria-label="取消引用" data-act="unquote">×</button></div>` : ""}
    <div class="input ${S.quote ? "with-quote" : ""}"><textarea rows="1" placeholder="${S.quote ? "说说哪里不对" : "说点什么……"}" aria-label="对云朵小管家说" data-bind="chatText" data-keep="chat">${esc(S.chatText)}</textarea><button class="btn mint" style="min-height:30px;padding:4px 10px" data-act="send" ${pending ? "disabled" : ""}>发送</button></div>`;
}

// ---------- 执行计划（一张卡体现最新信息和修改点） ----------
function planCard(c, plan) {
  const rev = plan.revision, prev = new Set(rev && !rev.stale ? rev.previousSteps : plan.steps);
  const diff = (rev?.changes ?? []).map((x) => `<div class="diff"><span class="d-lbl">${esc(x.label)}</span><span class="d-from">${esc(x.from)}</span><span class="d-arr" aria-hidden="true">→</span><span class="d-to">${esc(x.to)}</span></div>`).join("");
  return `<div class="plan" data-quotable="1"><div class="t">即将执行 · 确认后开始</div>
    ${rev ? `<div class="plan-rev"><div class="s11" style="color:var(--amber)">${rev.stale ? "前提变了，这份计划可能需要重拟" : "已按最新信息更新"}</div>${diff}</div>` : ""}
    <ol>${plan.steps.map((x) => `<li>${esc(x)}${rev && !rev.stale && !prev.has(x) ? ` <span class="upd">已更新</span>` : ""}</li>`).join("")}</ol>
    <div class="s11 muted">授权：${esc(plan.scopeLabel || "读取这件事的材料 · 仅本任务 · 不对外发送")}</div>
    <div class="row" style="gap:8px">${rev?.stale
      ? `<button class="btn mint" data-act="replan" data-id="${c.id}">按最新信息重拟</button>`
      : `<button class="btn mint" data-act="run" data-id="${c.id}">开始执行</button><button class="btn" data-act="replan" data-id="${c.id}">重新拟</button>`}</div>
    <div class="s11 faint">不对？选中那句话，在下面告诉我</div></div>`;
}

// ---------- 变更提议（挂在对话消息下） ----------
function proposalBlock(id) {
  const s = st(), p = s.proposals?.[id];
  if (!p) return "";
  // 修改点已经体现在待确认的计划卡里，就不在消息下重复
  const pl = p.workCardId ? s.workCards[p.workCardId]?.plan : null;
  if (pl?.status === "proposed" && pl.revision?.changes.some((x) => x.premiseId === p.change.premiseId) && p.status === "applied" && !p.drafts.length) return "";
  const done = p.status === "confirmed", gone = p.status === "corrected" || p.status === "dismissed";
  const draftsReady = p.drafts.filter((d) => d.actionId && s.actions[d.actionId]);
  const allCancelled = p.drafts.length > 0 && p.drafts.every((d) => d.actionId && s.actions[d.actionId]?.status === "cancelled");
  const needConfirm = p.status === "pending" || (p.status === "applied" && p.drafts.length > 0 && !allCancelled);
  const confirmLabel = p.status === "pending"
    ? `确认改为 ${p.change.to}${p.drafts.length && !allCancelled ? "，更正消息待我发送" : ""}`
    : "更正消息没问题，待我发送";
  return `<div class="prop ${gone ? "gone" : ""}">
    <div class="diff"><span class="d-lbl">${esc(p.change.label)}</span><span class="d-from">${esc(p.change.from)}</span><span class="d-arr" aria-hidden="true">→</span><span class="d-to">${esc(p.change.to)}</span>${p.status === "applied" && p.source !== "user" && !p.drafts.length ? `<span class="d-tag">已更新</span>` : ""}</div>
    ${p.drafts.map((d) => { const a = d.actionId ? s.actions[d.actionId] : null; return `<div class="draft" data-quotable="1"><div class="s11 muted">拟发给 ${esc(d.to)}</div><div>${esc(d.body)}</div>
      ${a?.status === "cancelled" ? `<div class="s11 muted">你决定不发了</div>` : `<div class="row" style="gap:12px">${done && a ? `<button class="link" data-act="copy" data-text="${esc(d.body)}">${S.copied === d.body ? "已复制" : "复制，去发送"}</button>` : ""}${a ? `<button class="link" style="color:var(--ink3)" data-act="cancel-act" data-id="${a.id}">不用发了</button>` : ""}</div>`}</div>`; }).join("")}
    ${gone ? `<div class="s11 muted">已按你的纠正处理</div>`
      : done ? `<div class="s11" style="color:var(--green)">✓ 已确认</div>`
      : needConfirm ? `<div class="prop-act"><button class="btn mint" data-act="confirm-prop" data-id="${p.id}">${esc(confirmLabel)}</button>${p.drafts.length && !allCancelled ? `<button class="link" style="color:var(--ink3)" data-act="confirm-nosend" data-id="${p.id}">${p.status === "pending" ? "只改条件，更正不用发" : "更正不用发了"}</button>` : ""}<span class="s11 faint">不对？选中那句话，在下面告诉我</span></div>`
      : `<div class="s11 faint">不对？选中那句话，在下面告诉我</div>`}
  </div>`;
}

// ---------- 材料 ----------
async function readFiles(files) {
  const out = [];
  for (const f of files) {
    if (!TEXT_EXT.test(f.name)) { toast(`暂不支持 ${f.name}，请用 txt / md / rtf / csv / json`, true); continue; }
    if (f.size > 1_000_000) { toast(`${f.name} 太大（上限 1MB）`, true); continue; }
    out.push({ title: f.name, text: await readText(f) });
  }
  return out;
}
async function upload(list, extra = {}) {
  const ids = []; let changes = [], proposals = [];
  for (const a of list) { const r = await api("/materials", { title: a.title, text: a.text, ...extra }); ids.push(r.result.evidence.id); changes = changes.concat(r.result.changes ?? []); proposals = proposals.concat(r.result.proposals ?? []); }
  return { ids, changes, proposals };
}
function reportChanges(changes, proposals = []) {
  const ask = proposals.find((p) => p.status === "pending");
  if (ask) { toast(`${ask.change.label}可能变了，在右边等你确认`); if (ask.workCardId) { S.sel = ask.workCardId; S.view = "card"; S.showCard = true; } return true; }
  if (!changes?.length) return false;
  const s = st(), pc = changes[0];
  const cid = pc.impacts.find((i) => i.handling === "needs_user")?.workCardId ?? pc.impacts[0]?.workCardId;
  toast(`${s.premises[pc.premiseId]?.label}变了，${pc.impacts.filter((i) => i.handling !== "unaffected").length} 项受影响`);
  if (cid) { S.sel = cid; S.view = "card"; S.showCard = false; }
  return true;
}

// ---------- 本机文件夹 ----------
const folderKey = () => `folder:${S.wsId}`;
const stem = (n) => n.replace(/[-_ ]?v\d+(?=\.\w+$)/i, "");
async function pickFolder() {
  let handle; try { handle = await window.showDirectoryPicker({ mode: "read" }); } catch { return; }
  const g = await api("/grants", { source: "local_folder", scopeLabel: `读取本机文件夹「${handle.name}」（只读，网页开着时）`, filter: { dir: handle.name, where: "browser" }, permissions: ["read", "watch"] });
  let files = {}; try { const saved = JSON.parse(store.get(folderKey()) || "null"); if (saved?.name === handle.name) files = saved.files; } catch {}
  S.folder = { handle, name: handle.name, grantId: g.result.id, files };
  await withBusy(`我在看「${handle.name}」里有什么`, () => scanFolder());
  folderLoop();
}
async function scanFolder() {
  const F = S.folder; if (!F) return; let n = 0;
  for await (const entry of F.handle.values()) {
    if (entry.kind !== "file" || !TEXT_EXT.test(entry.name) || entry.name.startsWith(".")) continue;
    const file = await entry.getFile(), prev = F.files[entry.name];
    if (prev && prev.lm === file.lastModified && prev.size === file.size) continue;
    if (file.size > 1_000_000 || ++n > 20) continue;
    const sib = prev ?? Object.entries(F.files).filter(([k]) => k !== entry.name && stem(k) === stem(entry.name)).map(([, v]) => v).pop();
    const r = await api("/materials", { title: entry.name, text: await readText(file), source: "local_folder", ref: `${F.name}/${entry.name}`, supersedes: sib?.evidenceId });
    F.files[entry.name] = { lm: file.lastModified, size: file.size, evidenceId: r.result.evidence.id };
  }
  checkAlerts();
  store.set(folderKey(), JSON.stringify({ name: F.name, files: F.files })); render();
}
let folderTimer;
function folderLoop() { clearTimeout(folderTimer); folderTimer = setTimeout(async () => { if (!S.folder) return; if (!S.busy) await scanFolder().catch((e) => toast(`读取文件夹失败：${e.message}`, true)); folderLoop(); }, 4000); }

// ---------- 交互 ----------
const openCard = (id) => { S.sel = id; S.view = "card"; S.why = false; S.showCard = false; S.projMenu = false; S.candAttach = []; };
const actions = {
  async create() { const r = await api("/api/workspaces", {}); go(r.id); },
  home() { S.view = "home"; S.sel = null; S.proj = null; render(); },
  open(el) { if (S.hint?.cardId === el.dataset.id) S.hint = null; openCard(el.dataset.id); render(); },
  "tk-guide-ok"() { S.tkGuideOff = true; try { localStorage.setItem("puffin.tkGuide", "1"); } catch {} render(); },
  "bubble-go"(el) { S.bubbles = []; openCard(el.dataset.id); S.showCard = false; render(); },
  "bubble-later"() { S.bubbles = []; render(); },
  "hint-x"() { S.hint = null; render(); },
  project(el) { S.proj = el.dataset.id; S.view = "project"; render(); },
  demo() { S.view = "demo"; S.tour = 0; S.tourDecided = false; render(); },
  "demo-flip"() { S.demoFlip = !S.demoFlip; render(); },
  "start-free"() { const i = $app.querySelector('[data-keep="ask"]'); i?.focus(); i?.scrollIntoView({ block: "center", behavior: "smooth" }); },
  "cal-open"() { S.calOpen = !S.calOpen; render(); if (S.calOpen) $app.querySelector('[data-keep="cal"]')?.focus(); },
  prompt(el) { S.ask = `${el.dataset.v}：`; render(); $app.querySelector('[data-keep="ask"]')?.focus(); },
  example: () => withBusy("我把例子摆好", async () => { await api("/example", {}); S.lastSeen = "2026-09-28T16:00:00+08:00"; S.view = "home"; S.hint = { cardId: "wc_alex", text: "从这里开始：点开它，试试预算变了会牵动什么" }; }),
  unattach(el) { S.attach.splice(Number(el.dataset.i), 1); render(); },
  uncand(el) { S.candAttach.splice(Number(el.dataset.i), 1); render(); },
  async tell() {
    if (!S.ask.trim() && !S.attach.length) return toast("随口说一件事就行", true);
    const text = S.ask.trim() || `帮我看看这${S.attach.length > 1 ? "几" : ""}份材料`;
    await withBusy("我先记下来", async () => {
      const r = await api("/candidates", { text });
      const cid = r.result.id;
      if (S.proj && st().projects[S.proj] && S.view === "home") await api(`/cards/${cid}/project`, { projectId: S.proj });
      const att = S.attach; S.attach = []; S.ask = ""; openCard(cid); S.candAttach = att;
    });
  },
  "cand-draft": (el) => withBusy("我在看你说的话和材料，把这件事理一理\n要一小会儿，可以先喝口水", async () => {
    const { ids } = await upload(S.candAttach);
    const r = await api(`/cards/${el.dataset.id}/draft`, { evidenceIds: ids });
    S.candAttach = []; openCard(r.result.id);
  }),
  remind: (el) => withBusy("好，明天提醒你", () => api(`/cards/${el.dataset.id}/remind`, {})),
  dismiss: (el) => withBusy("好，这件事先放下", async () => { await api(`/cards/${el.dataset.id}/dismiss`, {}); S.view = "home"; }),
  "proj-menu"() { S.projMenu = !S.projMenu; render(); },
  "set-proj": (el) => withBusy("我把它放进项目里", async () => { await api(`/cards/${S.sel}/project`, { projectId: el.dataset.id || null }); S.projMenu = false; }),
  "new-proj": () => withBusy("我建一个新项目", async () => { if (!S.newProj.trim()) throw new Error("写一个项目名"); await api(`/cards/${S.sel}/project`, { newName: S.newProj }); S.newProj = ""; S.projMenu = false; }),
  "new-in-proj"() { S.view = "home"; S.sel = null; render(); },
  answer: (el) => withBusy("记下了", () => api(`/cards/${el.dataset.card}/answer`, { questionId: el.dataset.q, answer: el.dataset.v })),
  plan: (el) => withBusy("我想想怎么一步步推进\n稍等片刻", () => api(`/cards/${el.dataset.id}/plan`, {})),
  replan: (el) => withBusy("我换个思路再拟一版", () => api(`/cards/${el.dataset.id}/plan`, {})),
  run: (el) => withBusy("我开始动手了：读材料、起草、排提醒\n可能要一两分钟，做完会在右边告诉你", async () => { await api(`/cards/${el.dataset.id}/run`, {}); }),
  why() { S.why = !S.why; render(); },
  scene(el) { S.scene = el.dataset.id; S.sceneIn = {}; render(); },
  "close-scene"() { S.scene = null; render(); },
  async "scene-folder"() {
    const c = SCENES.release; S.scene = null; render();
    await pickFolder(); if (!S.folder) return;
    const ids = Object.values(S.folder.files).map((f) => f.evidenceId).filter(Boolean);
    if (!ids.length) return toast("这个文件夹里没有我能读的文件（txt / md / csv / json）", true);
    return withBusy("我在读这个文件夹，把项目进展理一理\n要一小会儿，可以先喝口水", async () => {
      const r = await api("/candidates", { text: `${c.title}：${S.folder.name}`, brief: c.frame });
      const d = await api(`/cards/${r.result.id}/draft`, { evidenceIds: ids });
      openCard(d.result.id);
    });
  },
  "scene-vfolder"() {
    const c = SCENES.release; S.scene = null;
    return withBusy("我在读示例项目文件夹，把项目进展理一理\n要一小会儿，可以先喝口水", async () => {
      const ids = [];
      for (const [n, t] of VF_FILES) { const m = await api("/materials", { title: n, text: t, source: "local_folder", ref: `${VF}/${n}` }); ids.push(m.result.evidence.id); }
      const r = await api("/candidates", { text: `${c.title}：v2.3 发布`, brief: c.frame });
      const d = await api(`/cards/${r.result.id}/draft`, { evidenceIds: ids });
      openCard(d.result.id);
    });
  },
  "vf-go"(el) { S.vfModal = false; S.vfResult = null; openCard(el.dataset.id); S.showCard = !!st().proposals && Object.values(st().proposals).some((p) => p.workCardId === el.dataset.id && p.status === "pending") ? true : false; render(); },
  "vf-show"() { S.vfModal = true; S.vEdit = null; render(); },
  "vf-close"() { S.vfModal = false; S.vEdit = null; render(); },
  "vf-open"(el) { const ref = el.dataset.ref; S.vfResult = null; if (S.vEdit === ref) { S.vEdit = null; } else { S.vEdit = ref; S.vText = latestOf(ref)?.excerpt ?? ""; } render(); },
  "vf-save": (el) => withBusy("文件有变动，我看看会牵动什么", async () => {
    const old = latestOf(el.dataset.ref); if (!old) return;
    if (S.vText.trim() === old.excerpt.trim()) { S.vEdit = null; return toast("内容没有变化"); }
    const a = old.excerpt.split("\n").map((x) => x.trim()), bb = S.vText.split("\n").map((x) => x.trim());
    const diff = [...a.filter((x) => x && !bb.includes(x)).map((l) => ["-", l]), ...bb.filter((x) => x && !a.includes(x)).map((l) => ["+", l])];
    const r = await api("/materials", { title: el.dataset.ref.slice(VF.length + 1), text: S.vText, source: "local_folder", ref: old.ref, supersedes: old.id });
    const st0 = st(), props = (r.result.proposals ?? []), changes = r.result.changes ?? [];
    const ask = props.find((p) => p.status === "pending"), applied = props.filter((p) => p.status === "applied");
    let outcome, go = null;
    if (ask) { outcome = `${ask.change.label}可能从「${ask.change.from}」变成「${ask.change.to}」，牵动了「${st0.workCards[ask.workCardId]?.title ?? "工作卡"}」，等你确认`; go = ask.workCardId; }
    else if (changes.length) { const pc = changes[0], n = pc.impacts.filter((i) => i.handling !== "unaffected").length; outcome = `${st0.premises[pc.premiseId]?.label}从「${pc.from}」变成「${pc.to}」，${n} 项受影响${applied.length ? "，已自动更新" : ""}`; go = pc.impacts.find((i) => i.handling === "needs_user")?.workCardId ?? pc.impacts[0]?.workCardId ?? null; }
    else outcome = "看过了，这次改动没有改变卡上的判断";
    S.vfResult = { ref: old.ref, diff, outcome, go, warn: !!ask };
    S.vEdit = null;
  }),
  "sim-pr": () => withBusy("Git 仓库里有新动静，我看看", async () => {
    const s = st(), c = s.workCards[S.sel];
    const o0 = (c?.originEvidenceIds ?? []).map((id) => s.evidence[id]).find((e) => (e?.ref === "github" || e?.ref === `${VF}/PR 状态.md`) && /#412/.test(e.excerpt));
    const old = o0 && latestOf(o0.ref); if (!old) return;
    const text = old.excerpt.replace(/#412[^\n]*/, "#412 支付流程改版（张明）— Merged 10/10，reviewer 王磊已通过，CI 通过");
    const r = await api("/materials", { title: old.ref.startsWith(VF) ? "PR 状态.md" : "GitHub PR / Issue（更新）", text, source: "local_folder", ref: old.ref, supersedes: old.id });
    if (!reportChanges(r.result.changes, r.result.proposals)) toast("看过了，这次变化没有改变卡上的判断");
  }),
  "scene-sample"() { S.sceneIn = { ...SCENES[S.scene].sample }; return actions["scene-go"](); },
  "scene-go"() {
    const c = SCENES[S.scene], v = S.sceneIn;
    const filled = c.inputs.filter((i) => (v[i.key] ?? "").trim());
    if (!filled.length) return toast("输入框还是空的，可以直接点「用示例数据试试」", true);
    const sid = S.scene; S.scene = null;
    return withBusy("我在看你给的信息，把这件事理一理\n要一小会儿，可以先喝口水", async () => {
      const r = await api("/candidates", { text: c.title, brief: c.frame });
      const cid = r.result.id, ids = [];
      for (const i of filled) { const m = await api("/materials", { title: `${i.label}（${c.title}）`, text: v[i.key], ref: i.ref }); ids.push(m.result.evidence.id); }
      const d = await api(`/cards/${cid}/draft`, { evidenceIds: ids });
      openCard(d.result.id); S.sceneIn = {};
    });
  },
  "nav-cal"() { S.navCal = !S.navCal; render(); if (S.navCal) $app.querySelector('[data-keep="navcal"]')?.focus(); },
  soon(el) { toast(`${el.dataset.v} 还在示意阶段，下一版接入`); },
  "open-mats"() { S.more = false; S.mats = true; render(); },
  "close-mats"() { S.mats = false; render(); },
  preview(el) { S.preview = el.dataset.id; render(); },
  "close-preview"() { S.preview = null; render(); },
  "download-out"(el) { const a = st().actions[el.dataset.id]; const url = URL.createObjectURL(new Blob([`# ${a.output.title}\n\n${a.output.body}\n`], { type: "text/markdown;charset=utf-8" }));
    const l = document.createElement("a"); l.href = url; l.download = fileName(a); document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); },
  async "copy-out"(el) { const o = st().actions[el.dataset.id].output; try { await navigator.clipboard.writeText(o.body); toast("已复制"); } catch { toast("复制失败，请手动选中复制", true); } },
  doc(el) { const id = el.dataset.id; S.openDoc.has(id) ? S.openDoc.delete(id) : S.openDoc.add(id); render(); },
  edit(el) { S.editing = el.dataset.id; S.editVal = st().premises[el.dataset.id].value; render(); },
  "edit-cancel"() { S.editing = null; render(); },
  "edit-save": (el) => withBusy("我看看这个变化会牵动哪些事", async () => { const r = await api(`/premises/${el.dataset.id}`, { value: S.editVal }); S.editing = null; if (r.result) reportChanges([r.result]); }),
  "own-open"(el) { S.ownFor = S.ownFor === el.dataset.id ? null : el.dataset.id; S.ownText = ""; render(); if (S.ownFor) $app.querySelector('[data-keep="own"]')?.focus(); },
  "resolve-own": (el) => { if (!S.ownText.trim()) return toast("写一下你想怎么做", true); return withBusy("好，按你说的来", async () => { await api(`/decisions/${el.dataset.id}/resolve`, { kind: "custom", statement: S.ownText.trim() }); S.ownFor = null; S.ownText = ""; S.showCard = true; }); },
  "confirm-nosend": (el) => withBusy("好，只改条件，不发更正", async () => {
    const id = el.dataset.id; await api(`/proposals/${id}/confirm`, {});
    const r = await api(`/api/w/${S.wsId}`, undefined, "GET").catch(() => null);
    const p = (r?.state ?? st()).proposals?.[id];
    for (const d of p?.drafts ?? []) if (d.actionId) await api(`/actions/${d.actionId}/cancel`, {}).catch(() => {});
    S.showCard = false;
  }),
  "cancel-act": (el) => withBusy("好，不发了", () => api(`/actions/${el.dataset.id}/cancel`, {})),
  resolve: (el) => withBusy("好，按你的决定来", async () => { await api(`/decisions/${el.dataset.id}/resolve`, { kind: el.dataset.kind }); S.showCard = true; }),
  "show-card"() { S.showCard = true; render(); },
  "show-ripple"() { S.showCard = false; render(); },
  "demo-change"() {
    if (S.demoSent) return;
    S.demoSent = true; render();
    toast("已模拟：小王把新预算表放进了「对齐材料」文件夹。你可以继续做别的，我看完会来找你");
    setTimeout(async () => {
      try {
        const v2 = st().evidence.ev_budget_v2;
        await api("/materials", { title: "预算表 v3（小王）", text: "项目,金额（万）\nQ4 总预算,30\n留存专项,20\n拉新,5\n其他,5\n备注,小王：Q4 总预算下调，以此版为准", source: "local_folder", ref: "对齐材料/预算表-v3.csv", supersedes: v2?.id });
        checkAlerts(); render();
      } catch (e) { S.demoSent = false; toast(e.message, true); render(); }
    }, 2000);
  },
  timeline() { S.view = "timeline"; S.tlEvent = null; S.rollbackNote = false; render(); },
  tk(el) { S.tlEvent = S.tlEvent === el.dataset.id ? null : el.dataset.id; S.rollbackNote = false; render(); },
  "tl-pick"(el) { S.tlEvent = el.dataset.id; S.rollbackNote = false; render(); },
  rollback: (el) => { if (!S.rollbackNote) { S.rollbackNote = true; render(); return; }
    return withBusy("好，我们回到那时候", async () => { await api(`/events/${el.dataset.id}/rollback`, {}); S.rollbackNote = false; S.tlEvent = null; S.view = "card"; S.showCard = false; }); },
  "confirm-prop": (el) => withBusy("好，按这个来", async () => { await api(`/proposals/${el.dataset.id}/confirm`, {}); S.showCard = false; }),
  unquote() { S.quote = ""; render(); },
  quote() { S.quote = S.quoteBtn?.text ?? ""; S.quoteBtn = null; removeQuoteBtn(); render(); $app.querySelector('[data-keep="chat"]')?.focus(); },
  async copy(el) { try { await navigator.clipboard.writeText(el.dataset.text); S.copied = el.dataset.text; render(); } catch { toast("复制失败，请手动选中复制", true); } },
  async send() {
    const text = S.chatText.trim(); if (!text) return;
    const c = (S.view === "card" || S.view === "timeline") ? st().workCards[S.sel] : null;
    if (!c) { S.ask = text; S.chatText = ""; return actions.tell(); }
    const quote = S.quote;
    S.pending = { key: c.id, text, quote }; S.chatText = ""; S.quote = ""; render();
    try { await api(`/cards/${c.id}/chat`, { text, quote }); if (openChanges().length) { S.showCard = false; } }
    catch (e) { toast(e.message, true); S.chatText = text; S.quote = quote; } finally { S.pending = null; render(); }
  },
  revoke: (el) => withBusy("好，我不再看那里了", async () => { const g = st().grants[el.dataset.id]; await api(`/grants/${el.dataset.id}/revoke`, {}); if (g?.source === "local_folder" && S.folder?.grantId === g.id) { S.folder = null; clearTimeout(folderTimer); } }),
  folder: () => pickFolder().catch((e) => toast(e.message, true)),
  "folder-stop"() { const id = S.folder?.grantId; S.folder = null; clearTimeout(folderTimer); if (id) actions.revoke({ dataset: { id } }); },
  cal: () => withBusy("我看一眼你的日历", async () => { const r = await api("/calendar", { url: S.calUrl }); S.calUrl = ""; S.calOpen = false; S.navCal = false; toast(`已连接，读到近期 ${r.result.events} 个日程`); }),
  "cal-check": () => withBusy("我看看日历有没有变", async () => { const r = await api("/calendar/check", {}); if (r.result.changes.length) toast(`日历有 ${r.result.changes.length} 处变化`); else toast("日历没有变化"); }),
  "more-news"() { S.moreNews = !S.moreNews; render(); },
  "more-next"() { S.moreNext = !S.moreNext; render(); },
  more() { S.more = !S.more; render(); },
  tour(el) { S.tour = Number(el.dataset.i); if (S.tour < 3) S.tourDecided = false; render(); },
  "tour-decide"() { S.tourDecided = true; S.tour = 3; render(); },
  async "copy-link"() { S.more = false; try { await navigator.clipboard.writeText(location.href); toast("链接已复制，用它可以回到这个工作区"); } catch { toast(location.href); } },
  async delete() {
    if (!S.confirmDelete) { S.confirmDelete = true; render(); setTimeout(() => { S.confirmDelete = false; render(); }, 4000); return; }
    await api(`/api/w/${S.wsId}`, undefined, "DELETE"); location.href = "/";
  },
};

document.addEventListener("click", async (e) => {
  if (S.more && !e.target.closest('[data-act="more"]') && !e.target.closest(".menu")) { S.more = false; render(); }
  if (S.projMenu && !e.target.closest(".pp-wrap")) { S.projMenu = false; render(); }
  const el = e.target.closest("[data-act]"); if (!el || el.disabled) return;
  const fn = actions[el.dataset.act]; if (!fn) return;
  e.preventDefault();
  try { await fn(el); } catch (err) { toast(err.message, true); }
});
document.addEventListener("input", (e) => { const k = e.target.dataset?.bind; if (k) S[k] = e.target.value; const sk = e.target.dataset?.scene; if (sk) S.sceneIn[sk] = e.target.value; });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (S.preview || S.mats || S.navCal || S.scene || S.vfModal)) { S.preview = null; S.mats = false; S.navCal = false; S.scene = null; S.vfModal = false; render(); return; }
  const b = e.target.dataset?.bind;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && b === "chatText") { e.preventDefault(); actions.send(); }
  if (e.key === "Enter" && !e.isComposing && b === "ownText") { e.preventDefault(); $app.querySelector('[data-act="resolve-own"]')?.click(); }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && b === "ask") { e.preventDefault(); actions.tell(); }
  if (e.key === "Enter" && !e.isComposing && b === "editVal") { e.preventDefault(); $app.querySelector('[data-act="edit-save"]')?.click(); }
});
async function materialFiles(files) {
  const list = await readFiles(files); if (!list.length) return;
  await withBusy("我看看这份材料有没有改变什么", async () => { const { changes, proposals } = await upload(list); if (!reportChanges(changes, proposals)) toast("材料收下了，没有改变任何前提"); });
}
document.addEventListener("change", async (e) => {
  const k = e.target.dataset?.change; if (!k) return;
  if (k === "attach") { S.attach.push(...await readFiles(e.target.files)); render(); }
  if (k === "cand") { S.candAttach.push(...await readFiles(e.target.files)); render(); }
  if (k === "material-files") await materialFiles(e.target.files);
  if (k === "import") { const f = e.target.files[0]; if (f) await withBusy("我把之前的工作接回来", async () => { const r = await api("/api/workspaces", { importState: JSON.parse(await f.text()) }); go(r.id); }); }
  e.target.value = "";
});
document.addEventListener("dragover", (e) => { const d = e.target.closest?.("[data-drop]"); if (d) { e.preventDefault(); d.classList.add("over"); } });
document.addEventListener("dragleave", (e) => e.target.closest?.("[data-drop]")?.classList.remove("over"));
document.addEventListener("drop", async (e) => {
  const d = e.target.closest?.("[data-drop]"); if (!d) return; e.preventDefault(); d.classList.remove("over");
  const list = await readFiles(e.dataTransfer.files);
  if (d.dataset.drop === "attach") S.attach.push(...list);
  else if (d.dataset.drop === "cand") S.candAttach.push(...list);
  else if (d.dataset.drop === "material") { await materialFiles(e.dataTransfer.files); return; }
  render();
});

// 选中对话或工作卡里的文字 → 浮出"引用到对话"
function removeQuoteBtn() { document.getElementById("quote-btn")?.remove(); }
document.addEventListener("mouseup", () => setTimeout(() => {
  const sel = window.getSelection(), text = sel?.toString().trim();
  removeQuoteBtn();
  if (!text || !S.wsId || text.length < 2) return;
  const node = sel.anchorNode?.parentElement;
  if (!node?.closest(".chat .msgs, .main") || node.closest("input, textarea, button")) return;
  if (!(S.view === "card" || S.view === "timeline") || !st()?.workCards[S.sel]) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  S.quoteBtn = { text: text.slice(0, 200) };
  const b = document.createElement("button");
  b.id = "quote-btn"; b.className = "quote-btn"; b.dataset.act = "quote"; b.textContent = "引用到对话";
  b.style.left = `${Math.min(window.innerWidth - 120, rect.left + rect.width / 2 - 50)}px`;
  b.style.top = `${Math.max(8, rect.top - 40)}px`;
  document.body.appendChild(b);
}, 0));
document.addEventListener("mousedown", (e) => { if (!e.target.closest?.("#quote-btn")) removeQuoteBtn(); });

function go(id) { history.pushState(null, "", `/w/${id}`); boot(); }
async function boot() {
  const m = location.pathname.match(/^\/w\/([a-z0-9]{12})$/);
  S.wsId = m?.[1] ?? null; S.ws = null; render();
  if (!S.wsId) return;
  S.lastSeen = store.get(`seen:${S.wsId}`);
  try { await api("", undefined, "GET"); connectStream(); render(); }
  catch (e) { $app.innerHTML = `<div class="landing"><h2>${esc(e.message)}</h2><p><a href="/">重新开始</a></p></div>`; }
  // 记录"上次来访"：离开页面时写入，供下次回访首页计算"自你上次离开"
  addEventListener("pagehide", () => store.set(`seen:${S.wsId}`, new Date().toISOString()));
}
window.addEventListener("popstate", boot);
boot();
