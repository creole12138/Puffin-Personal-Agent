// 云朵小管家 —— 网页端。结构与视觉照 Claude Design 原型「工作卡 Agent 原型」。原生 JS，无构建步骤。
const $app = document.getElementById("app");
const AV = (w, h) => `<img src="/agent.svg" alt="" width="${w}" height="${h}" style="width:${w}px;height:${h}px;flex-shrink:0">`;
const S = {
  wsId: null, ws: null, view: "home", sel: null, proj: null, tlEvent: null, rollbackNote: false,
  busy: null, pending: null, ask: "", chatText: "", attach: [], candAttach: [],
  why: false, editing: null, editVal: "", openDoc: new Set(), projMenu: false, newProj: "",
  demoFlip: false, moreNews: false, moreNext: false, showCard: false,
  folder: null, calUrl: "", confirmDelete: false, lastSeen: null, more: false, tour: 0, tourDecided: false,
  quote: "", quoteBtn: null, copied: null,
};
const TEXT_EXT = /\.(txt|md|csv|json|tsv|ics|log)$/i;
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
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { S.busy = null; render(); }
}
let toastTimer;
function toast(msg, err = false) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "show" + (err ? " err" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ""), err ? 6000 : 3200);
}
function connectStream() {
  const es = new EventSource(`/api/w/${S.wsId}/stream`);
  es.onmessage = (m) => { S.ws = JSON.parse(m.data); render(); };
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
const needsYou = (c) => changesFor(c.id).length > 0;
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
  if (S.busy) $app.insertAdjacentHTML("beforeend", `<div class="busy"><div class="box2">${AV(44, 39)}<div>${S.busy.split("\n").map((t, i) => `<div class="${i ? "s12 muted" : ""}">${esc(t)}</div>`).join("")}</div><div class="spin"></div></div></div>`);
  if (keep) { const el = $app.querySelector(`[data-keep="${keep}"]`); if (el) { el.focus(); try { el.setSelectionRange(...sel); } catch {} } }
  const m = $app.querySelector(".main"); if (m && scrollMain) m.scrollTop = scrollMain;
  const msgs = $app.querySelector(".msgs"); if (msgs && atBottom) msgs.scrollTop = msgs.scrollHeight;
}

function landing() {
  return `<div class="landing">
    <div class="hero">${AV(84, 74)}<h1>我是云朵小管家。<br>把一件正在推进的事交给我。</h1></div>
    <p style="margin-top:22px">我记住的不是聊天记录，而是这件事的状态：在推进什么、依据是什么、哪些前提一变会影响什么。预算改了、会议挪了，我会告诉你哪些决定受影响、哪些动作已经暂停、哪些已经没法撤回。</p>
    <div class="pillars">
      <div class="pillar"><b>有来源</b><span class="muted s13">每条结论都能点开看依据来自哪份材料。</span></div>
      <div class="pillar"><b>有边界</b><span class="muted s13">只读你授权的范围；对外的事只起草，不替你发出。</span></div>
      <div class="pillar"><b>会变化</b><span class="muted s13">前提一变，受影响的决定和动作一起被找出来。</span></div>
      <div class="pillar"><b>可续接</b><span class="muted s13">状态可以导出，换个会话、换个模型接着做。</span></div>
    </div>
    <div class="row">
      <button class="btn mint lg" data-act="create">开始</button>
      <label class="btn lg">导入之前导出的状态<input type="file" accept=".json,application/json" data-change="import" hidden></label>
    </div>
    <p class="s12 faint" style="margin-top:28px">每个人会得到一个专属链接，只有拿到链接的人能看到里面的内容。上传的材料只保存在这个工作区，可以随时删除。请不要上传敏感信息。</p>
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
      <div class="who">${AV(32, 28)}云朵小管家<span class="en">Puffin</span></div>
      <div class="sp"></div>
      <span class="meta">模型：${esc(S.ws.model)}</span>
      <div style="position:relative"><button class="btn ghost" data-act="more" aria-expanded="${S.more}">更多 ▾</button>
        ${S.more ? `<div class="menu" role="menu">
          <button role="menuitem" data-act="copy-link">复制这个工作区的链接<span>用它随时回到这里</span></button>
          <a role="menuitem" href="/api/w/${S.wsId}/export" download>导出工作状态<span>下载全部内容，可在别处导入继续；包含你给过的材料原文</span></a>
          <a role="menuitem" href="/">导入 / 新建工作区<span>回到开始页</span></a>
        </div>` : ""}</div>
    </div>
    <div class="cols">
      <nav class="nav" aria-label="工作与项目">${nav()}</nav>
      <main class="main">${main()}</main>
      <aside class="chat" aria-label="和云朵小管家对话">${chatPanel()}</aside>
    </div>
  </div>`;
}

function nav() {
  const s = st(), projects = Object.values(s.projects), loose = cardsOf(null);
  const taskBtn = (c) => `<button class="task ${S.view === "card" && S.sel === c.id ? "on" : ""}" data-act="open" data-id="${c.id}">${esc(c.title)}${c.stage === "candidate" ? "" : `<span class="st"> · ${STAGE[c.stage][0]}</span>`}${needsYou(c) ? `<span class="flag"> · 待决定</span>` : ""}</button>`;
  const grants = Object.values(s.grants).filter((g) => !g.revokedAt && g.source !== "user_input");
  const cal = grants.find((g) => g.source === "calendar");
  const mats = Object.values(s.evidence).filter((e) => !["chat", "edit"].includes(e.ref)).length;
  return `
  ${projects.length ? `<div class="nav-title">项目</div>` : ""}
  ${projects.map((p) => {
    const cs = cardsOf(p.id), att = cs.filter(needsYou).length;
    return `<button class="proj ${S.view === "project" && S.proj === p.id ? "on" : ""}" data-act="project" data-id="${p.id}">
      <div class="name"><span>${esc(p.name)}</span>${att ? `<span class="tag warn">${att} 待决定</span>` : ""}</div>
      <div class="s11 muted" style="margin-top:4px">${cs.length} 项工作 · 共享 ${p.premiseIds.length} 个前提</div></button>
      ${cs.length ? `<div class="tasks">${cs.map(taskBtn).join("")}</div>` : ""}`; }).join("")}
  <div class="nav-title" style="${projects.length ? "margin-top:10px" : ""}">${projects.length ? "未归类" : "工作"}</div>
  ${loose.length ? `<div class="tasks" style="border:none;margin:0;padding:0">${loose.map(taskBtn).join("")}</div>`
    : `<div class="s12 faint" style="line-height:1.7;padding:4px">${projects.length ? "暂无" : "还没有工作。接住的第一件事会出现在这里，相关的事多了，我会建议归成项目。"}</div>`}
  <button class="newthing" data-act="home">＋ 开启一件新的事</button>
  <div class="sources">
    <div class="nav-title">材料与授权</div>
    <div class="src-row"><span>材料 ${mats} 份</span><label class="link" style="cursor:pointer">＋ 添加<input type="file" multiple accept=".txt,.md,.csv,.json,.tsv,.ics" data-change="material-files" hidden></label></div>
    ${S.folder ? `<div class="grant">正在关注本机文件夹「${esc(S.folder.name)}」<div class="row"><span class="faint">网页开着时检查</span><button class="link" data-act="folder-stop">停止</button></div></div>`
      : "showDirectoryPicker" in window ? `<button class="btn" data-act="folder" style="justify-content:flex-start">选择本机文件夹</button>`
      : `<div class="s12 faint">选择本机文件夹需要 Chrome 或 Edge</div>`}
    ${cal ? `<div class="grant">日历已连接${cal.filter.lastCheckedAt ? ` · ${timeAgo(cal.filter.lastCheckedAt)} 检查过` : ""}<div class="row"><button class="link" data-act="cal-check">立即检查</button><button class="link" data-act="revoke" data-id="${cal.id}">断开</button></div></div>`
      : `<div style="display:grid;gap:6px"><input type="url" placeholder="粘贴 .ics 日历链接" aria-label="日历链接" value="${esc(S.calUrl)}" data-bind="calUrl" data-keep="cal"><button class="btn" data-act="cal" style="justify-self:start">连接日历</button></div>`}
    ${grants.filter((g) => g.source === "local_folder").map((g) => `<div class="grant">${esc(g.scopeLabel)}<div class="row"><span class="faint">${timeAgo(g.grantedAt)}</span><button class="link" data-act="revoke" data-id="${g.id}">收回</button></div></div>`).join("")}
    <button class="link" style="text-align:left;color:var(--ink3)" data-act="delete">${S.confirmDelete ? "再点一次，确认删除这个工作区" : "删除这个工作区"}</button>
  </div>`;
}

// ---------- 首页 ----------
function revisit() {
  const s = st(), since = S.lastSeen ?? "0";
  const needs = openChanges();
  const news = s.events.filter((e) => e.visibleInTimeline && e.actor !== "user" && e.at > since && e.type !== "card_created").slice(-6).reverse();
  const next = allCards().flatMap((c) => c.reminders.map((r) => ({ r, c }))).filter(({ r }) => { const w = when(r.at); return typeof w !== "string" && w.days >= 0; })
    .sort((a, b) => String(a.r.at).localeCompare(String(b.r.at)));
  const hour = new Date().getHours(), hi = hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const n = needs.length + news.length;
  const cardTitle = (id) => { const c = s.workCards[id]; return c ? `${c.projectId ? `${esc(s.projects[c.projectId]?.name)} · ` : ""}${esc(c.title)}` : ""; };
  return `<div style="display:flex;flex-direction:column;gap:10px">
    <div class="greet">${hi} · ${S.lastSeen && n ? `自你上次离开，有 ${n} 件事有变化` : "这是你手上的事"}</div>
    <div class="grid3">
      <div class="box" style="border-color:${needs.length ? "var(--amber-line)" : "var(--line)"};gap:8px">
        <div class="s12" style="color:var(--amber);font-weight:500">需要你决定 · ${needs.length}</div>
        ${needs.slice(0, 2).map((pc) => { const p = s.premises[pc.premiseId], i = pc.impacts.find((x) => x.handling === "needs_user"), d = s.decisions[i.id];
          return `<div class="s11 muted">${cardTitle(i.workCardId)}</div><div style="line-height:1.6">${esc(p?.label)}变成 ${esc(pc.to)}，「${esc(d?.statement)}」${d?.status === "invalidated" ? "不再成立" : "需要再看看"}</div>
          <button class="btn mint" style="align-self:flex-start;padding:6px 12px;min-height:0;font-size:12px" data-act="open" data-id="${i.workCardId}">去处理</button>`; }).join("") || `<div class="s13 faint">没有</div>`}
      </div>
      <div class="box">
        <div class="s12" style="color:var(--green);font-weight:500">有新进展 · ${news.length}</div>
        ${(S.moreNews ? news : news.slice(0, 2)).map((e) => `<div><div class="s11 muted">${cardTitle(e.workCardId) || timeAgo(e.at)}</div><div style="line-height:1.6">${esc(e.summary)}</div></div>`).join("") || `<div class="s13 faint">没有</div>`}
        ${news.length > 2 ? `<button class="link" style="align-self:flex-start" data-act="more-news">${S.moreNews ? "收起" : `还有 ${news.length - 2} 条`}</button>` : ""}
      </div>
      <div class="box">
        <div class="s12" style="color:var(--blue);font-weight:500">接下来</div>
        ${(S.moreNext ? next : next.slice(0, 2)).map(({ r, c }) => { const w = when(r.at); return `<div><div class="s11 muted">${esc(w.label)}${w.days > 0 ? ` · 还有 ${w.days} 天` : ""}</div><div style="line-height:1.6">${esc(c.title)}</div></div>`; }).join("") || `<div class="s13 faint">没有排期</div>`}
        ${next.length > 2 ? `<button class="link" style="align-self:flex-start" data-act="more-next">${S.moreNext ? "收起" : `还有 ${next.length - 2} 件`}</button>` : ""}
      </div>
    </div></div>`;
}

function home() {
  const first = allCards().length === 0, inProj = S.proj && S.view === "home" ? st().projects[S.proj] : null;
  const title = inProj ? `今天想和我一起在「${esc(inProj.name)}」里做什么呢？` : "今天想和我一起做什么呢？";
  return `<div class="wrap">
    ${first ? "" : revisit()}
    <div class="hero">${AV(84, 74)}<div class="h" style="font-size:${first ? 30 : 24}px">${title}</div></div>
    <div style="font-size:17px;color:var(--ink2)">最近有没有一件事——</div>
    <div class="grid3">
      ${["你还在反复想", "明天不处理会变麻烦", "开始了却一直没收尾"].map((t) => `<button class="prompt" data-act="prompt" data-v="${t}">${t}</button>`).join("")}
    </div>
    <div class="ask">
      <div class="in"><input type="text" aria-label="说一件事" placeholder="比如：和 Alex 还有一些工作一直没对齐" value="${esc(S.ask)}" data-bind="ask" data-keep="ask"><button class="btn mint lg" data-act="tell">Tell me</button></div>
      <label class="drop" data-drop="attach" style="display:flex;align-items:center;justify-content:center;cursor:pointer">拖一份材料<input type="file" multiple accept=".txt,.md,.csv,.json,.tsv,.ics" data-change="attach" hidden></label>
    </div>
    ${S.attach.length ? `<div class="chips">${S.attach.map((a, i) => `<span class="chip">${esc(a.title)}<button aria-label="移除" data-act="unattach" data-i="${i}">×</button></span>`).join("")}<span class="s12 muted">说一句这是什么事，然后点 Tell me</span></div>` : ""}
    <div class="s13 muted">想不出来？<a href="#" data-act="demo">快速认识云朵小管家</a>${isExample() ? "" : ` · 或者<a href="#" data-act="example">载入一个完整的例子</a>（Q4 规划）`}</div>
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
    <label class="dropzone" data-drop="cand" style="cursor:pointer">拖入相关的聊天记录、纪要或表格，我能补全更多<input type="file" multiple accept=".txt,.md,.csv,.json,.tsv,.ics" data-change="cand" hidden></label>
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
    <details class="more" ${S.why ? "open" : ""}><summary>依据</summary><div style="display:flex;flex-direction:column;gap:14px;margin-top:12px">
      <div><div class="lbl" style="margin-bottom:4px">依赖的条件</div>${conditionsList(c.premiseIds.map((id) => s.premises[id]).filter(Boolean))}</div>${decisionsBlock(c)}</div></details>
    <div class="row"><button class="btn mint lg" data-act="plan" data-id="${c.id}" ${c.plan?.status === "proposed" ? "disabled" : ""}>${c.plan?.status === "proposed" ? "计划已生成，在右边确认" : "生成执行计划"}</button>
      <span class="s12 muted">${c.plan?.status === "proposed" ? "" : unanswered ? `还有 ${unanswered} 处没确认，也可以先生成` : "确认无误，可以生成计划了"}</span></div>
  </div>`;
}

const ICON_PEN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>`;
/** 依赖的条件：一行一个，悬停露出铅笔，点开原地编辑 */
function conditionsList(list) {
  return `<div class="conds">${list.map((p) => {
    const was = p.history.at(-1)?.value;
    const state = p.inferred ? `<span class="tag info" title="${esc(p.inferred.reason)}">推断</span>` : p.confirmed ? "" : `<span class="tag warn">未确认</span>`;
    if (S.editing === p.id) return `<div class="cond editing"><span class="c-lbl">${esc(p.label)}</span>
      <input type="text" value="${esc(S.editVal)}" data-bind="editVal" data-keep="edit" aria-label="${esc(p.label)}的新值">
      <button class="btn mint small-btn" data-act="edit-save" data-id="${p.id}">保存</button><button class="btn ghost small-btn" data-act="edit-cancel">取消</button></div>`;
    return `<div class="cond" id="cond-${p.id}"><span class="c-lbl">${esc(p.label)}</span><span class="c-val">${esc(p.value)}</span>${was && was !== p.value && p.confirmed ? `<span class="was">${esc(was)}</span>` : ""}${state}
      <span class="c-src">来自 ${p.evidenceIds.map(evTitle).map(esc).join("、") || "—"}</span>
      <button class="pen" data-act="edit" data-id="${p.id}" aria-label="修改${esc(p.label)}" title="修改">${ICON_PEN}</button></div>`; }).join("") || `<div class="s13 faint">暂无</div>`}</div>`;
}

function decisionsBlock(c) {
  const s = st();
  return `<div><div class="lbl" style="margin-bottom:6px">决策</div><div class="list">${c.decisionIds.map((id) => s.decisions[id]).filter(Boolean).map((d) =>
    `<div class="li"><div>${d.status === "superseded" || d.status === "invalidated" ? `<span class="strike">${esc(d.statement)}</span>` : esc(d.statement)}</div><span class="tag ${DEC[d.status][1]}">${DEC[d.status][0]}</span></div>`).join("") || `<div class="s13 faint">还没有决策</div>`}</div></div>`;
}
function actionsBlock(c) {
  const s = st();
  return `<div><div class="lbl" style="margin-bottom:6px">动作与产出</div><div class="list">${c.actionIds.map((id) => s.actions[id]).filter(Boolean).map((a) => {
    const [l, cls] = a.compensationFor ? ["等你确认", "warn"] : a.output?.kind === "message" && a.status === "planned" ? ["草稿 · 等你发送", "info"] : ACT[a.status];
    const open = S.openDoc.has(a.id);
    return `<div class="li" style="flex-direction:column;align-items:stretch;gap:0"><div class="row" style="justify-content:space-between">
      <span>${esc(a.label)}${a.external ? ` <span class="tag muted">对外</span>` : ""}</span>
      <span class="row" style="gap:8px">${a.output ? `<button class="link" data-act="doc" data-id="${a.id}">${open ? "收起" : "查看"}</button>` : ""}<span class="tag ${cls}">${l}</span></span></div>
      ${open && a.output ? `<div class="doc">${a.output.to ? `收件人：${esc(a.output.to)}\n主题：${esc(a.output.title)}\n\n` : ""}${esc(a.output.body)}</div>` : ""}</div>`; }).join("") || `<div class="s13 faint">还没有动作</div>`}</div></div>`;
}

function activeView(c) {
  const s = st(), d = decisionMain(c);
  const rem = c.reminders.map((r) => ({ r, w: when(r.at) })).filter(({ w }) => typeof w !== "string" && w.days >= 0).sort((a, b) => String(a.r.at).localeCompare(String(b.r.at)))[0];
  const prem = d ? d.premiseIds.map((id) => s.premises[id]).filter(Boolean) : [];
  const all = c.premiseIds.map((id) => s.premises[id]).filter(Boolean);
  const others = all.filter((p) => !prem.includes(p));
  const attention = all.filter((p) => p.inferred || !p.confirmed);
  const canDemo = c.id === "wc_alex" && s.premises.pr_budget?.value === "50 万";
  return `<div style="display:flex;flex-direction:column;gap:16px">
    ${changesFor(c.id).length ? `<div class="amber row" style="justify-content:space-between"><span>有一处前提变化需要你决定</span><button class="btn" data-act="show-ripple">去处理</button></div>` : ""}
    ${Object.values(st().proposals ?? {}).some((p) => p.workCardId === c.id && p.status === "pending") ? `<div class="amber">有一处变化在右边等你确认</div>` : ""}
    <div class="panel" style="gap:20px">
      <div class="row" style="gap:10px"><span class="tag active">进行中</span>${rem ? `<span class="s12 muted">${esc(rem.w.label)}${rem.w.days > 0 ? ` · 还有 ${rem.w.days} 天` : ""} · ${esc(rem.r.reason)}</span>` : ""}<span style="flex-grow:1"></span>${projectLine(c)}</div>
      <div class="title26">${esc(c.title)}</div>
      <div class="grid3" style="gap:20px">
        <div><div class="lbl">进度</div><div class="val">${esc(c.status || "—")}</div></div>
        <div><div class="lbl">等待</div><div class="val">${esc(c.waitingOn || "—")}</div></div>
        <div><div class="lbl">关键决策</div><div class="val row" style="gap:8px">${esc(d?.statement ?? "—")}${d ? `<button class="choice" style="padding:2px 8px;min-height:0;font-size:12px;color:var(--ink2)" data-act="why" aria-expanded="${S.why}">依据</button>` : ""}</div></div>
      </div>
      ${S.why ? `<div class="why"><div style="font-weight:500">${d ? `为什么是「${esc(d.statement)}」` : "依据"}</div>
        <div><div class="lbl" style="margin-bottom:4px">依赖的条件</div>${conditionsList(prem.length ? prem : c.premiseIds.map((id) => s.premises[id]).filter(Boolean))}
          ${prem.length && others.length ? `<div class="lbl" style="margin:8px 0 4px">这件事的其他条件</div>${conditionsList(others)}` : ""}</div>
        ${d?.provenance.evidenceIds.length ? `<div><div class="lbl" style="margin-bottom:4px">依据的原文</div>${d.provenance.evidenceIds.map((id) => `<div>「${esc(s.evidence[id]?.excerpt.slice(0, 120))}」 <span class="muted">— ${esc(evTitle(id))}</span></div>`).join("")}</div>` : ""}
        ${d ? `<div class="muted">置信度：${{ low: "低", medium: "中", high: "高" }[d.confidence]} · ${d.provenance.confirmedBy === "user" ? `你于 ${timeAgo(d.provenance.at)} 确认` : "我整理的，还没经你确认"}</div>` : ""}</div>`
      : attention.length ? `<button class="attn" data-act="why">${attention.map((p) => p.inferred ? `${esc(p.label)}已按推断改为 ${esc(p.value)}` : `依赖还没确认的条件：${esc(p.label)} ${esc(p.value)}`).join("；")} <span class="link">查看依据</span></button>` : ""}
      ${c.nextStep ? `<div><div class="lbl">下一步</div><div class="val">${esc(c.nextStep)}</div></div>` : ""}
    </div>
    <div class="panel pad24">${actionsBlock(c)}</div>
    <div class="cta2">
      ${canDemo ? `<button class="demo play" data-act="demo-change"><img src="/play.svg" alt="" width="40" height="40"><span><b>演示：小王发来新的预算表</b><small>Q4 预算 50 万 → 30 万，看看会牵动哪些事</small></span></button>`
        : `<label class="demo" style="cursor:pointer" data-drop="material">给我一份新材料，我看看会不会改变什么<input type="file" multiple accept=".txt,.md,.csv,.json,.tsv,.ics" data-change="material-files" hidden></label>`}
      <button class="tl" data-act="timeline">时间线</button>
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
        <div class="row" style="gap:8px">${d.suggestion ? `<button class="btn mint" data-act="resolve" data-id="${d.id}" data-kind="adopt_suggestion">采用建议</button>` : ""}<button class="btn" data-act="resolve" data-id="${d.id}" data-kind="keep">仍按原决定</button></div></div>`; }).join("")}
    <div class="grid2" style="gap:12px">
      ${on.filter((i) => i.handling === "paused").map((i) => box("paused", "已暂停，等上面决定", i)).join("")}
      ${on.filter((i) => i.handling === "auto_updated").map((i) => box("auto", "已自动更新", i)).join("")}
      ${on.filter((i) => i.handling === "compensate").map((i) => box("comp", "已执行，无法撤回", i, comp(i) ? `<div class="s12" style="margin-top:6px">${comp(i).approvedAt ? "更正消息已确认，在右边可以复制去发送" : "我起草了一份更正消息，在右边等你确认"}</div>` : "")).join("")}
      ${on.filter((i) => i.handling === "unaffected").map((i) => box("keep", "仍然成立", i)).join("")}
    </div>
    ${other.length ? `<div class="also"><div class="s12 muted">同一项目里也受影响${c.projectId ? `（${esc(p?.label)}是${esc(s.projects[c.projectId]?.name)}的共享前提）` : ""}</div>
      ${other.map((i) => `<div>· ${esc(s.workCards[i.workCardId]?.title)}：${esc(name(i))}，<span style="color:${i.handling === "auto_updated" ? "var(--green)" : i.handling === "compensate" ? "var(--red)" : "var(--amber)"}">${{ auto_updated: "已自动调整", paused: "等上面决定", needs_user: "需要你决定", compensate: "已发生，已起草更正" }[i.handling]}</span></div>`).join("")}</div>` : ""}
    <div><button class="btn ghost" data-act="show-card">看工作卡</button></div>
  </div>`;
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
          ${c.actionIds.map((id) => s.actions[id]).filter((a) => a?.external && a.status === "done").map((a) => `<br>· ${esc(a.label)}已经发生，无法撤回`).join("")}</div>` : ""}`
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
      return `<div class="prem ${was && was !== pr.value ? "changed" : pr.confirmed ? "" : "unconf"}"><div class="lbl">共享前提 · ${esc(pr.label)}</div><div style="font-size:16px;margin-top:4px">${esc(pr.value)}${was && was !== pr.value ? `<span class="s12 muted">（原 ${esc(was)}）</span>` : ""}</div>
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
        <div class="proj" style="pointer-events:none"><div class="name"><span>新版上线</span><span class="tag warn">1 待决定</span></div><div class="s11 muted" style="margin-top:4px">3 项工作 · 共享 2 个前提</div></div></div>
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
  const needConfirm = p.status === "pending" || (p.status === "applied" && p.drafts.length > 0);
  const confirmLabel = p.status === "pending"
    ? `确认改为 ${p.change.to}${p.drafts.length ? "，更正消息待我发送" : ""}`
    : "更正消息没问题，待我发送";
  return `<div class="prop ${gone ? "gone" : ""}">
    <div class="diff"><span class="d-lbl">${esc(p.change.label)}</span><span class="d-from">${esc(p.change.from)}</span><span class="d-arr" aria-hidden="true">→</span><span class="d-to">${esc(p.change.to)}</span>${p.status === "applied" && p.source !== "user" && !p.drafts.length ? `<span class="d-tag">已更新</span>` : ""}</div>
    ${p.drafts.map((d) => { const a = d.actionId ? s.actions[d.actionId] : null; return `<div class="draft" data-quotable="1"><div class="s11 muted">拟发给 ${esc(d.to)}</div><div>${esc(d.body)}</div>
      ${done && a ? `<button class="link" data-act="copy" data-text="${esc(d.body)}">${S.copied === d.body ? "已复制" : "复制，去发送"}</button>` : ""}</div>`; }).join("")}
    ${gone ? `<div class="s11 muted">已按你的纠正处理</div>`
      : done ? `<div class="s11" style="color:var(--green)">✓ 已确认</div>`
      : needConfirm ? `<div class="prop-act"><button class="btn mint" data-act="confirm-prop" data-id="${p.id}">${esc(confirmLabel)}</button><span class="s11 faint">不对？选中那句话，在下面告诉我</span></div>`
      : `<div class="s11 faint">不对？选中那句话，在下面告诉我</div>`}
  </div>`;
}

// ---------- 材料 ----------
async function readFiles(files) {
  const out = [];
  for (const f of files) {
    if (!TEXT_EXT.test(f.name)) { toast(`暂不支持 ${f.name}，请用 txt / md / csv / json`, true); continue; }
    if (f.size > 1_000_000) { toast(`${f.name} 太大（上限 1MB）`, true); continue; }
    out.push({ title: f.name, text: await f.text() });
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
    const r = await api("/materials", { title: entry.name, text: await file.text(), source: "local_folder", ref: `${F.name}/${entry.name}`, supersedes: sib?.evidenceId });
    F.files[entry.name] = { lm: file.lastModified, size: file.size, evidenceId: r.result.evidence.id };
    reportChanges(r.result.changes, r.result.proposals);
  }
  store.set(folderKey(), JSON.stringify({ name: F.name, files: F.files })); render();
}
let folderTimer;
function folderLoop() { clearTimeout(folderTimer); folderTimer = setTimeout(async () => { if (!S.folder) return; if (!S.busy) await scanFolder().catch((e) => toast(`读取文件夹失败：${e.message}`, true)); folderLoop(); }, 4000); }

// ---------- 交互 ----------
const openCard = (id) => { S.sel = id; S.view = "card"; S.why = false; S.showCard = false; S.projMenu = false; S.candAttach = []; };
const actions = {
  async create() { const r = await api("/api/workspaces", {}); go(r.id); },
  home() { S.view = "home"; S.sel = null; S.proj = null; render(); },
  open(el) { openCard(el.dataset.id); render(); },
  project(el) { S.proj = el.dataset.id; S.view = "project"; render(); },
  demo() { S.view = "demo"; S.tour = 0; S.tourDecided = false; render(); },
  "demo-flip"() { S.demoFlip = !S.demoFlip; render(); },
  prompt(el) { S.ask = `${el.dataset.v}：`; render(); $app.querySelector('[data-keep="ask"]')?.focus(); },
  example: () => withBusy("我把例子摆好", async () => { await api("/example", {}); S.lastSeen = "2026-09-28T16:00:00+08:00"; S.view = "home"; toast("载入了 Q4 规划的例子。点「和 Alex 对齐」试试前提变化"); }),
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
  doc(el) { const id = el.dataset.id; S.openDoc.has(id) ? S.openDoc.delete(id) : S.openDoc.add(id); render(); },
  edit(el) { S.editing = el.dataset.id; S.editVal = st().premises[el.dataset.id].value; render(); },
  "edit-cancel"() { S.editing = null; render(); },
  "edit-save": (el) => withBusy("我看看这个变化会牵动哪些事", async () => { const r = await api(`/premises/${el.dataset.id}`, { value: S.editVal }); S.editing = null; if (r.result) reportChanges([r.result]); }),
  resolve: (el) => withBusy("好，按你的决定来", async () => { await api(`/decisions/${el.dataset.id}/resolve`, { kind: el.dataset.kind }); S.showCard = true; }),
  "show-card"() { S.showCard = true; render(); },
  "show-ripple"() { S.showCard = false; render(); },
  "demo-change": () => withBusy("小王发来了一份新的预算表，我看看", async () => {
    const v2 = st().evidence.ev_budget_v2;
    const r = await api("/materials", { title: "预算表 v3（小王）", text: "项目,金额（万）\nQ4 总预算,30\n留存专项,20\n拉新,5\n其他,5\n备注,小王：Q4 总预算下调，以此版为准", source: "local_folder", ref: "对齐材料/预算表-v3.csv", supersedes: v2?.id });
    if (!reportChanges(r.result.changes, r.result.proposals)) toast("材料收下了，没有改变任何前提");
  }),
  timeline() { S.view = "timeline"; S.tlEvent = null; S.rollbackNote = false; render(); },
  "tl-pick"(el) { S.tlEvent = el.dataset.id; S.rollbackNote = false; render(); },
  rollback: (el) => { if (!S.rollbackNote) { S.rollbackNote = true; render(); return; }
    return withBusy("好，我们回到那时候", async () => { await api(`/events/${el.dataset.id}/rollback`, {}); S.rollbackNote = false; S.view = "card"; S.showCard = false; }); },
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
  cal: () => withBusy("我看一眼你的日历", async () => { const r = await api("/calendar", { url: S.calUrl }); S.calUrl = ""; toast(`已连接，读到近期 ${r.result.events} 个日程`); }),
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
document.addEventListener("input", (e) => { const k = e.target.dataset?.bind; if (k) S[k] = e.target.value; });
document.addEventListener("keydown", (e) => {
  const b = e.target.dataset?.bind;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && b === "chatText") { e.preventDefault(); actions.send(); }
  if (e.key === "Enter" && !e.isComposing && b === "ask") { e.preventDefault(); actions.tell(); }
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
