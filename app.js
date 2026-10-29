/* 墨 · 单词实验室  —  前端应用（零依赖） */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const fmt = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + " 万" : String(n ?? 0));

// PWA 形态由 store.js 在 head 中先行加载，这里判断一次即可
const OFFLINE = !!(window.MOMO && window.MOMO.offline);

/* 路由序号：切页就 +1。慢请求返回时若序号已变，说明这次渲染已经过期，
   必须丢弃，否则旧页面会把新页面覆盖掉（线上慢网下真的会发生）。 */
let ROUTE_SEQ = 0;
class StaleError extends Error {
  constructor() {
    super("stale");
    this.stale = true;
  }
}
// 事件处理器里触发的 api 若因切页作废，抛出的 StaleError 不应冒到控制台
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason && e.reason.stale) e.preventDefault();
});

async function api(path, opt) {
  const seq = ROUTE_SEQ;
  const data = await (window.MOMO && window.MOMO.offline
    ? MOMO.api(path, opt)
    : fetch("/api/" + path, opt).then((r) => {
        if (!r.ok) throw new Error("API " + r.status + " " + path);
        return r.json();
      }));
  if (seq !== ROUTE_SEQ) throw new StaleError();
  return data;
}
const post = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* ---------------- 图标 ---------------- */
const IC = {
  today: '<path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 016.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
  func: '<path d="M4 20c3 0 3-16 7-16 2 0 3 2 3 4"/><path d="M3 12h9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  vol: '<path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
};
const svg = (p, w = 17) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" width="${w}" height="${w}">${p}</svg>`;

/* ---------------- 状态 ---------------- */
const S = { ov: null, decks: null, settings: {}, route: "", study: null };

const NAV = [
  { id: "today", name: "今日", icon: "today", href: "#/today" },
  { id: "decks", name: "词书", icon: "grid", href: "#/decks" },
  { id: "books", name: "词书库", icon: "book", href: "#/books" },
  { id: "browse", name: "词库", icon: "search", href: "#/browse" },
  { id: "stats", name: "统计", icon: "chart", href: "#/stats" },
  { id: "algo", name: "算法", icon: "func", href: "#/algo" },
];

function renderNav(active) {
  $("#nav").innerHTML = NAV.map(
    (n) => `<a class="nav-item ${active === n.id ? "on" : ""}" href="${n.href}">
      ${svg(IC[n.icon])}<span>${n.name}</span>
      ${n.id === "today" && S.ov && S.ov.due
        ? `<em class="badge" title="${S.ov.due} 词待复习">${S.ov.due > 99 ? "99+" : S.ov.due}</em>`
        : ""}
    </a>`
  ).join("");
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("on"), 1800);
}

/* 弹窗统一入口：id="mb" 只能存在一个，否则搜索弹窗与词详情会叠成两层遮罩 */
function openModal(html) {
  const old = document.getElementById("mb");
  if (old) old.remove();
  document.body.insertAdjacentHTML("beforeend", html);
  return document.getElementById("mb");
}

/* Escape 关弹窗：捕获阶段拦下，避免学习页把它当成「退出」 */
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape") return;
    const m = document.getElementById("mb");
    if (m) {
      m.remove();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  },
  true
);

function speak(text, rate = 0.9) {
  if (!text || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = rate;
  const v = speechSynthesis.getVoices().find((x) => /en-US|en_GB|en-GB/.test(x.lang));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

/* ---------------- 路由 ---------------- */
async function boot() {
  renderNav("today");
  try {
    S.ov = await api("overview");
    S.settings = S.ov.settings || {};
    S.decks = await api("decks");
  } catch (e) {
    $("#main").innerHTML = `<div class="page"><div class="empty"><h3>数据未就绪</h3><p>请先运行 python build_db.py</p></div></div>`;
    return;
  }
  window.addEventListener("hashchange", route);
  route();
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, "") || "today";
  const [path, qs] = h.split("?");
  return { path, q: Object.fromEntries(new URLSearchParams(qs || "")) };
}

async function route() {
  const { path, q } = parseHash();
  ROUTE_SEQ++; // 让所有在途请求作废
  const seq = ROUTE_SEQ;
  S.route = path;
  const main = $("#main");
  if (path !== "study") main.style.overflow = "auto";
  document.body.classList.toggle("studying", path === "study");
  renderNav(path);
  window.scrollTo(0, 0);
  if (path !== "study" && S.study) S.study = null;
  if (path !== "study") document.onkeydown = null;
  try {
    if (path === "today") return await viewToday();
    if (path === "decks") return await viewDecks();
    if (path === "books") return await viewBooks(q);
    if (path === "browse") return await viewBrowse(q);
    if (path === "stats") return await viewStats();
    if (path === "algo") return await viewAlgo();
    if (path === "data") return await viewData();
    if (path === "study") return await viewStudy(q);
  } catch (e) {
    if (e && e.stale) return; // 过期渲染，静默丢弃
    if (seq !== ROUTE_SEQ) return; // 报错也来自旧路由，不覆盖当前页
    main.innerHTML = `<div class="page"><div class="empty"><h3>出错了</h3><p>${esc(e.message)}</p></div></div>`;
  }
}

/* ---------------- 今日 ---------------- */
async function viewToday() {
  const ov = await api("overview");
  S.ov = ov;
  const st = await api("stats");
  renderNav("today");
  const last14 = st.daily.slice(-14);
  const max = Math.max(10, ...last14.map((d) => d.total_cnt));
  const bars = last14
    .map((d) => {
      const h = Math.max(2, Math.round((d.total_cnt / max) * 100));
      const dd = new Date(d.date);
      return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:5px" title="${d.date} · ${d.total_cnt} 词">
        <div style="width:100%;max-width:22px;height:${h}%;min-height:2px;background:${d.total_cnt ? "var(--green)" : "var(--line)"};border-radius:3px 3px 1px 1px;opacity:${0.45 + 0.55 * (d.total_cnt / max)}"></div>
        <span style="font-size:9px;color:var(--ink-4)">${dd.getMonth() + 1}/${dd.getDate()}</span></div>`;
    })
    .join("");

  const fmMax = Math.max(...Object.values(st.fm), 1);
  const fmBars = Array.from({ length: 10 }, (_, i) => {
    const v = st.fm[String(i + 1)] || 0;
    const h = Math.max(2, Math.round((v / fmMax) * 100));
    return `<i style="height:${h}%" class="${i >= 5 ? "hi" : ""}" title="fm ${i + 1} · ${v} 词"></i>`;
  }).join("");

  const book = ov.book;
  $("#main").innerHTML = `
  <div class="page">
    <div class="page-head">
      <div><div class="eyebrow">Today · ${new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" })}</div>
      <h1>${ov.due ? `今天有 ${ov.due} 个词等着你` : "今天没有到期的复习"}</h1>
      <p>${ov.streak > 0 ? `已坚持 ${ov.streak} 天 · ` : ""}累计学习 ${fmt(ov.studied)} 词 · ${ov.days} 个学习日 · 词库共 ${fmt(ov.total_words)} 条</p></div>
      <div class="row" style="gap:8px">
        <a class="btn" href="#/data">数据</a>
        <a class="btn primary" href="#/study?mode=review">${svg(IC.check, 15)} 开始复习</a>
      </div>
    </div>

    <div class="hero">
      <div class="hero-main">
        <div class="eyebrow">Review Queue</div>
        <div class="hero-num">${ov.due}<small>词待复习</small></div>
        <div class="hero-sub">今日已学 ${ov.done_today} 词 · 记忆因子 ≥ 6 的长期词 ${st.fm["6"] || 0} 个</div>
        <div class="hero-actions">
          <a class="btn w" href="#/study?mode=review">开始复习</a>
          <a class="btn o" href="#/study?mode=new">学新词</a>
          <a class="btn o" href="#/study?mode=mixed">混合模式</a>
        </div>
      </div>
      <div class="hero-side">
        <div class="stat-box">
          <div class="k">记忆因子分布</div>
          <div class="v">${st.fm["6"] ? st.fm["6"] : 0}<small>个 fm=6</small></div>
          <div class="fm-strip">${fmBars}</div>
        </div>
        <div class="stat-box">
          <div class="k">最近 14 个学习日</div>
          <div class="v">${last14.reduce((a, b) => a + b.total_cnt, 0)}<small>词次</small></div>
          <div style="display:flex;gap:4px;align-items:flex-end;height:34px;margin-top:8px">${bars}</div>
        </div>
      </div>
    </div>

    <div class="quick">
      <a href="#/decks"><div class="q-ico">${svg(IC.grid, 15)}</div><b>选词书</b><span>${fmt(S.decks?.length || 0)} 个词单</span></a>
      <a href="#/browse"><div class="q-ico">${svg(IC.search, 15)}</div><b>查词</b><span>${fmt(ov.total_words)} 条词条</span></a>
      <a href="#/stats"><div class="q-ico">${svg(IC.chart, 15)}</div><b>学习曲线</b><span>${ov.days} 天记录</span></a>
      <a href="#/algo"><div class="q-ico">${svg(IC.func, 15)}</div><b>调度算法</b><span>FVI / DVI</span></a>
    </div>

    <div class="section-title"><h2>正在学的词书</h2><a href="#/decks">全部 →</a></div>
    ${book ? `<div class="card book-card">
      <div class="book-spine">六级<br>核心</div>
      <div style="flex:1">
        <div class="row" style="justify-content:space-between"><b style="font-size:15px">${esc(book.name)}</b>
        <span class="chip green">进行中</span></div>
        <div class="small muted" style="margin:4px 0 10px">${book.started} / ${book.total} 词已开始 · 完成度 ${pct(book.started, book.total)}%</div>
        <div class="bar"><i style="width:${pct(book.started, book.total)}%"></i></div>
      </div>
      <a class="btn sm" href="#/study?deck=${encodeURIComponent(book.id)}&mode=mixed">继续</a>
    </div>` : ""}

    <div class="section-title"><h2>最近 7 天</h2><a href="#/stats">详细统计 →</a></div>
    <div class="card"><div class="booklist">
      ${st.daily.slice(-7).reverse().map((d) => `
        <div class="brow"><div class="n" style="font-family:var(--mono);font-size:12.5px">${d.date}</div>
          <div class="a" style="flex:1">新词 ${d.new_cnt} · 复习 ${d.review_cnt}</div>
          <div class="c">${d.total_cnt} 词</div></div>`).join("") || `<div class="brow"><div class="n muted">暂无记录</div></div>`}
    </div></div>
  </div>`;
}

/* ---------------- 词书 ---------------- */
async function viewDecks() {
  if (!S.decks) S.decks = await api("decks");
  const groups = { book: "我的词书", freq: "词频词单", exam: "考试词单", tag: "词类标签" };
  const html = Object.entries(groups)
    .map(([k, title]) => {
      const list = S.decks.filter((d) => d.kind === k);
      if (!list.length) return "";
      return `<div class="section-title"><h2>${title}</h2><span class="small muted">${list.length} 个</span></div>
      <div class="deck-grid">${list.map((d) => `
        <div class="card deck">
          <div class="row" style="justify-content:space-between;align-items:flex-start">
            <h3>${esc(d.name)}</h3>
            <span class="chip ${d.kind === "book" ? "green" : ""}">${fmt(d.total)}</span>
          </div>
          <div class="note">${esc(d.note || "")}</div>
          <div class="bar"><i style="width:${pct(d.started, d.total)}%"></i></div>
          <div class="deck-foot">
            <span class="small muted">${d.started} 词已学</span>
            <a class="btn sm" href="#/study?deck=${encodeURIComponent(d.id)}&mode=mixed">开始</a>
          </div>
        </div>`).join("")}</div>`;
    })
    .join("");

  $("#main").innerHTML = `
  <div class="page">
    <div class="page-head"><div><div class="eyebrow">Decks</div><h1>选一本书开始背</h1>
      <p>词单来自墨墨离线包的词类标签与 ECDICT 考试词表</p></div></div>
    ${html}
  </div>`;
}

/* ---------------- 词书库 ---------------- */
async function viewBooks(q) {
  const page = +(q.page || 0);
  const sort = q.sort || "count";
  const kw = q.q || "";
  const d = await api(`books?q=${encodeURIComponent(kw)}&page=${page}&sort=${sort}`);
  $("#main").innerHTML = `
  <div class="page">
    <div class="page-head"><div><div class="eyebrow">Library</div><h1>词书库</h1>
      <p>${fmt(d.total)} 本词书 · 离线包只带回你账号那本书的完整词表，其余需联网同步（当前可学 ${d.loaded_count} 本）</p></div></div>
    <div class="toolbar">
      <input class="input grow" id="bq" placeholder="搜索书名 / 作者 / 出版社" value="${esc(kw)}" style="max-width:340px">
      <div class="seg" id="bsort">
        <button data-s="count" class="${sort === "count" ? "on" : ""}">按词汇量</button>
        <button data-s="name" class="${sort === "name" ? "on" : ""}">按名称</button>
      </div>
      <span class="small muted" id="bcount">${fmt(d.total)} 本</span>
    </div>
    <div class="card"><div class="booklist" id="blist">
      ${d.items.map((b) => `<div class="brow">
        <div style="flex:1;min-width:0">
          <div class="n">${esc(b.name)} ${b.loaded ? '<span class="chip green" style="margin-left:6px">词表已载</span>' : ""}</div>
          <div class="a">${esc([b.author, b.publisher, b.version].filter(Boolean).join(" · ") || "作者信息缺失")}</div>
        </div>
        <div class="c">${fmt(b.count)}</div>
        ${b.loaded ? `<a class="btn sm" href="#/study?deck=book:${b.id}&mode=mixed">学习</a>` : `<span class="small muted" style="width:52px;text-align:right">—</span>`}
      </div>`).join("")}
    </div></div>
    <div class="row" style="justify-content:center;margin-top:18px;gap:8px">
      <button class="btn sm" id="prev" ${page === 0 ? "disabled" : ""}>上一页</button>
      <span class="small muted">第 ${page + 1} / ${Math.max(1, Math.ceil(d.total / d.size))} 页</span>
      <button class="btn sm" id="next" ${(page + 1) * d.size >= d.total ? "disabled" : ""}>下一页</button>
    </div>
  </div>`;

  const go = (p) => (location.hash = `#/books?q=${encodeURIComponent(kw)}&sort=${sort}&page=${p}`);
  $("#prev").onclick = () => go(Math.max(0, page - 1));
  $("#next").onclick = () => go(page + 1);
  $$("#bsort button").forEach((b) => (b.onclick = () => (location.hash = `#/books?q=${encodeURIComponent(kw)}&sort=${b.dataset.s}&page=0`)));
  let t;
  $("#bq").oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => (location.hash = `#/books?q=${encodeURIComponent(e.target.value)}&sort=${sort}&page=0`), 350);
  };
}

/* ---------------- 词库浏览 ---------------- */
async function viewBrowse(q) {
  const letter = q.letter || (OFFLINE ? "A" : "all");
  const sort = q.sort || "alpha";
  const page = +(q.page || 0);
  const d = await api(`browse?letter=${letter}&sort=${sort}&page=${page}`);
  const AZ = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  $("#main").innerHTML = `
  <div class="page">
    <div class="page-head"><div><div class="eyebrow">Browse</div><h1>词库</h1>
      <p>${OFFLINE
        ? `词库共 ${fmt((S.ov && S.ov.total_words) || d.total)} 条 · 按字母分片加载，当前 ${letter === "all" ? "A" : letter} 开头 ${fmt(d.total)} 条 · 点上方字母切换`
        : `${fmt(d.total)} 条词条 · 点击任意词查看音标、释义、词形变化与学习记录`}</p></div></div>
    <div class="toolbar">
      <input class="input grow" id="sq" placeholder="输入单词快速查（支持前缀 / 模糊）" style="max-width:420px">
      <div class="seg" id="sortseg">
        <button data-s="alpha" class="${sort === "alpha" ? "on" : ""}">字母</button>
        <button data-s="frq" class="${sort === "frq" ? "on" : ""}">词频</button>
      </div>
    </div>
    <div class="alpha">
      ${OFFLINE ? "" : `<button data-l="all" class="${letter === "all" ? "on" : ""}">全</button>`}
      ${AZ.map((c) => `<button data-l="${c}" class="${letter === c ? "on" : ""}">${c}</button>`).join("")}
    </div>
    <div class="card"><div id="wlist">
      ${d.items.map((w) => `<div class="wrow" data-id="${w.id}">
        <div class="w">${esc(w.w)}</div>
        <div class="p">${esc(w.ph || "")}</div>
        <div class="t">${esc((w.tr || "—").replace(/\n/g, " / "))}</div>
        <div class="s">${w.st ? "fm " + w.st.fm : ""}</div>
      </div>`).join("")}
    </div></div>
    <div class="row" style="justify-content:center;margin-top:18px;gap:8px">
      <button class="btn sm" id="prev" ${page === 0 ? "disabled" : ""}>上一页</button>
      <span class="small muted">第 ${page + 1} / ${Math.ceil(d.total / d.size)} 页</span>
      <button class="btn sm" id="next" ${(page + 1) * d.size >= d.total ? "disabled" : ""}>下一页</button>
    </div>
  </div>`;

  $$("#wlist .wrow").forEach((r) => (r.onclick = () => showWord(+r.dataset.id)));
  $$(".alpha button").forEach((b) => (b.onclick = () => (location.hash = `#/browse?letter=${b.dataset.l}&sort=${sort}&page=0`)));
  $$("#sortseg button").forEach((b) => (b.onclick = () => (location.hash = `#/browse?letter=${letter}&sort=${b.dataset.s}&page=0`)));
  $("#prev").onclick = () => (location.hash = `#/browse?letter=${letter}&sort=${sort}&page=${Math.max(0, page - 1)}`);
  $("#next").onclick = () => (location.hash = `#/browse?letter=${letter}&sort=${sort}&page=${page + 1}`);
  $("#sq").onkeydown = (e) => {
    if (e.key === "Enter" && e.target.value.trim()) quickSearch(e.target.value.trim());
  };
}

async function quickSearch(q) {
  const list = await api(`search?q=${encodeURIComponent(q)}&limit=30`);
  if (!list.length) return toast("没找到「" + q + "」");
  const html = `<div class="modal-bg" id="mb"><div class="modal" style="position:relative">
    <button class="btn ghost sm close" id="x">${svg(IC.x, 15)}</button>
    <div class="eyebrow">搜索结果 · ${list.length}</div>
    <div style="margin-top:10px">
    ${list.map((w) => `<div class="wrow" data-id="${w.id}" style="border-radius:8px">
      <div class="w" style="flex:0 0 170px;width:170px">${esc(w.w)}</div>
      <div class="t">${esc((w.tr || "—").replace(/\n/g, " / "))}</div></div>`).join("")}
    </div></div></div>`;
  openModal(html);
  $("#x").onclick = () => $("#mb").remove();
  $("#mb").onclick = (e) => { if (e.target.id === "mb") e.target.remove(); };
  $$("#mb .wrow").forEach((r) => (r.onclick = () => { $("#mb").remove(); showWord(+r.dataset.id); }));
}

function relText(raw) {
  try {
    const arr = JSON.parse(raw || "[]");
    return (arr || []).map((r) => (r.words || []).join("/")).filter(Boolean).join(" · ") || "—";
  } catch (e) {
    return "—";
  }
}

async function showWord(id) {  const w = await api("word?id=" + id);
  const st = w.st;
  const posList = (w.pos || "").split(/[\/,]/).filter(Boolean);
  openModal(`<div class="modal-bg" id="mb"><div class="modal" style="position:relative">
    <button class="btn ghost sm close" id="x">${svg(IC.x, 15)}</button>
    <div class="row" style="gap:10px;align-items:baseline">
      <h2>${esc(w.w)}</h2>
      <button class="speak" id="spk">${svg(IC.vol, 14)}</button>
    </div>
    <div class="phon">${esc(w.ph || "")}</div>
    <div class="trans" style="margin-top:16px">${(w.tr || "（暂无中文释义）").split("\n").map((l) => `<div>${esc(l)}</div>`).join("")}</div>
    ${w.df ? `<div class="def-en">${esc(w.df).replace(/\n/g, "<br>")}</div>` : ""}
    <div class="word-extra">
      ${posList.slice(0, 4).map((p) => `<span class="chip green">${esc(p)}</span>`).join("")}
      ${w.col ? `<span class="chip amber">柯林斯 ${w.col} 星</span>` : ""}
      ${w.ox ? `<span class="chip blue">牛津核心</span>` : ""}
      ${(w.tags || "").split(" ").filter(Boolean).slice(0, 5).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}
    </div>
    <dl class="dl">
      ${w.ex ? `<dt>词形变化</dt><dd>${esc(w.ex.split("/").join(" · "))}</dd>` : ""}
      ${w.rel ? `<dt>相关词</dt><dd>${esc(relText(w.rel))}</dd>` : ""}
      <dt>学习状态</dt><dd>${st ? `fm ${st.fm} · 难度 ${st.diff} · 已复习 ${st.cnt} 次${st.wrong ? ` · 写错 ${st.wrong} 次` : ""} · 下次 ${st.next || "—"}` : "尚未学习"}</dd>
      ${w.decks?.length ? `<dt>所属词单</dt><dd>${esc(w.decks.join(" · "))}</dd>` : ""}
    </dl>
    <div class="row" style="margin-top:22px;gap:8px">
      <button class="btn" id="mk">${svg(IC.star, 14)} ${st && st.starred ? "取消收藏" : "收藏"}</button>
      <button class="btn primary" id="go">去学习这个词单</button>
    </div>
  </div></div>`);
  const close = () => $("#mb").remove();
  $("#x").onclick = close;
  $("#mb").onclick = (e) => { if (e.target.id === "mb") close(); };
  $("#spk").onclick = () => speak(w.w);
  $("#mk").onclick = async () => {
    const r = await post("star", { voc_id: w.id });
    toast(r.value ? "已收藏" : "已取消收藏");
    close();
  };
  $("#go").onclick = () => { close(); location.hash = "#/decks"; };
  speak(w.w);
}

/* ---------------- 学习 ---------------- */
async function viewStudy(q) {
  const deck = q.deck || S.settings.lastDeck || (S.ov.book ? S.ov.book.id : "f1000");
  const mode = q.mode || "mixed";
  const uiMode = S.settings.uiMode || "ec";
  const limit = q.limit || (mode === "new" ? S.settings.new_limit || 10 : 20);

  $("#main").innerHTML = `<div class="study-wrap">
    <div class="study-top">
      <a class="btn ghost sm" href="#/today">${svg(IC.back, 15)} 退出</a>
      <div class="prog"><div class="bar"><i id="sbar" style="width:0%"></i></div></div>
      <span class="small muted" id="scount">载入中…</span>
      <div class="seg" id="mseg">
        <button data-m="ec" class="${uiMode === "ec" ? "on" : ""}">英→中</button>
        <button data-m="ce" class="${uiMode === "ce" ? "on" : ""}">中→英</button>
        <button data-m="lis" class="${uiMode === "lis" ? "on" : ""}">听音</button>
      </div>
    </div>
    <div class="study-stage" id="stage"><div class="spin"></div></div>
  </div>`;

  const list = await api(`queue?deck=${encodeURIComponent(deck)}&mode=${mode}&limit=${limit}`);
  const decks = S.decks || (S.decks = await api("decks"));
  const dk = decks.find((d) => d.id === deck);
  if (!list.length) {
    $("#stage").innerHTML = `<div class="empty"><h3>这一组已经清空</h3>
      <p>${mode === "review" ? "没有到期的复习词，去学点新词吧" : "这个词单的词都学过了"}</p>
      <div class="row" style="justify-content:center;gap:8px;margin-top:18px">
        <a class="btn primary" href="#/study?deck=${encodeURIComponent(deck)}&mode=${mode === "review" ? "new" : "review"}">换一种模式</a>
        <a class="btn" href="#/decks">选词书</a></div></div>`;
    return;
  }

  S.study = { list, i: 0, deck, deckName: dk ? dk.name : "词单", mode, uiMode, revealed: false,
              stats: { 1: 0, 2: 0, 3: 0, 4: 0 }, t0: Date.now() };
  $$("#mseg button").forEach((b) => (b.onclick = () => {
    S.study.uiMode = b.dataset.m;
    S.settings.uiMode = b.dataset.m;
    post("settings", { uiMode: b.dataset.m });
    $$("#mseg button").forEach((x) => x.classList.toggle("on", x === b));
    S.study.revealed = false;
    drawCard();
  }));
  drawCard();
  document.onkeydown = onStudyKey;
}

function onStudyKey(e) {
  const s = S.study;
  if (!s || S.route !== "study") return;
  if (e.key === " " || e.key === "Enter") {
    if (document.activeElement && document.activeElement.tagName === "INPUT") return;
    e.preventDefault();
    if (!s.revealed) { s.revealed = true; drawCard(); }
    return;
  }
  const KEYMAP = { "1": 3, "2": 2, "3": 1, "4": 4 };   // 按键 1..4 → 忘记/模糊/认识/太简单
  if (KEYMAP[e.key] && s.revealed) {
    e.preventDefault();
    answer(KEYMAP[e.key]);
  }
  if (e.key === "Escape") location.hash = "#/today";
}

function drawCard() {
  const s = S.study;
  if (!s) return;
  const w = s.list[s.i];
  const total = s.list.length;
  const n = s.i;
  $("#sbar").style.width = pct(n, total) + "%";
  $("#scount").textContent = `${n + 1} / ${total} · ${s.stats[1] + s.stats[2] + s.stats[3] + s.stats[4]} 已答`;

  const isNew = w.mode === "new" || !w.st;
  const fm = w.st?.fm ?? 1;
  const diff = w.st?.diff ?? 5;

  let front = "";
  if (s.uiMode === "ce" && !s.revealed) {
    front = `<div class="eyebrow" style="color:var(--ink-4);margin-bottom:12px">看中文，拼出英文</div>
      <div class="trans" style="font-size:19px;min-height:60px">${esc((w.tr || "").split("\n")[0] || "（无释义）")}</div>
      <div class="spell-box"><input class="input mono" id="spell" autocomplete="off" spellcheck="false"
        placeholder="在这里输入拼写，回车确认" style="text-align:center;font-size:18px;letter-spacing:2px;max-width:340px;margin:0 auto;display:block">
      <div class="small muted" style="text-align:center;margin-top:8px">输入后回车，会显示答案</div></div>`;
  } else {
    const big = w.w.length > 22 ? "small" : "";
    front = `${s.uiMode === "lis" && !s.revealed
        ? `<div class="row" style="gap:12px"><button class="speak" id="spk" style="width:52px;height:52px">${svg(IC.vol, 22)}</button>
           <span class="muted small">点击播放，听音辨词</span></div>`
        : `<div class="word-big ${big}">${esc(w.w)}</div>`}
      <div class="phon">${s.uiMode === "lis" && !s.revealed ? "· · · · · ·" : esc(w.ph || "")}
        ${s.uiMode !== "lis" ? `<button class="speak" id="spk">${svg(IC.vol, 14)}</button>` : ""}</div>`;
  }

  const revealed = s.revealed
    ? `<div class="reveal-zone">
        <div class="trans">${(w.tr || "（该词暂无中文释义）").split("\n").map((l) => `<div>${esc(l)}</div>`).join("")}</div>
        ${w.df ? `<div class="def-en">${esc(w.df).split("\n").slice(0, 3).join("\n")}</div>` : ""}
        <div class="word-extra">
          ${w.ex ? `<span class="chip">${esc(w.ex.split("/").slice(0, 4).join(" · "))}</span>` : ""}
          ${(w.tags || "").split(" ").filter(Boolean).slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}
          ${w.col ? `<span class="chip amber">柯林斯 ${w.col}</span>` : ""}
        </div>
      </div>`
    : `<div class="reveal-zone"><div class="hint-click" id="hint">${s.uiMode === "ce" ? "想不起来？点这里看答案" : '按 <b>空格</b> 或点击这里看释义'}</div></div>`;

  $("#stage").innerHTML = `<div class="study-card" id="card">
    <div class="meta">
      <div class="row" style="gap:6px">
        <span class="chip ${isNew ? "blue" : "green"}">${isNew ? "新词" : "复习"}</span>
        ${!isNew ? `<span class="chip">fm ${fm}</span><span class="chip">难度 ${diff}</span>` : ""}
      </div>
      <span class="small muted">${esc(s.deckName)}</span>
    </div>
    ${front}
    ${revealed}
    <div class="answer-row" ${s.revealed ? "" : 'style="opacity:.35;pointer-events:none"'}>
      <button class="ans a1" data-r="3"><kbd>1</kbd><b>忘记</b><span>fm −1，难度 +1</span></button>
      <button class="ans a2" data-r="2"><kbd>2</kbd><b>模糊</b><span>fm 不变</span></button>
      <button class="ans a3" data-r="1"><kbd>3</kbd><b>认识</b><span>fm +1，难度 −1</span></button>
      <button class="ans a4" data-r="4"><kbd>4</kbd><b>太简单</b><span>移出复习队列</span></button>
    </div>
    <div class="feedback" id="fb">${!s.revealed && s.uiMode === "ce" ? "先在左侧回忆拼写" : ""}</div>
  </div>`;

  const hint = $("#hint");
  if (hint) hint.onclick = () => { s.revealed = true; drawCard(); };
  const spk = $("#spk");
  if (spk) spk.onclick = () => speak(w.w);
  if (spk && s.uiMode === "lis") speak(w.w);
  if (s.uiMode === "lis" && !s.revealed && !isNew) setTimeout(() => speak(w.w), 120);

  const input = $("#spell");
  if (input) {
    input.focus();
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        const ok = input.value.trim().toLowerCase() === w.w.toLowerCase();
        s.revealed = true;
        s.ceOk = ok;
        drawCard();
        setTimeout(() => {
          const fb = $("#fb");
          if (fb) fb.innerHTML = ok ? `<b>拼写正确</b> · 建议选「认识」` : `拼错了，正确拼写是 <b>${esc(w.w)}</b>`;
        }, 10);
      }
    };
  }
  $$(".ans").forEach((b) => (b.onclick = () => answer(+b.dataset.r)));
}

async function answer(resp) {
  const s = S.study;
  if (!s || !s.revealed) return;
  const w = s.list[s.i];
  const elapsed = Math.round((Date.now() - s.t0) / 1000);
  s.t0 = Date.now();
  const btn = $$(".ans").find((b) => +b.dataset.r === resp);
  if (btn) btn.style.background = "var(--green-soft)";
  let r;
  try {
    r = await post("answer", { voc_id: w.id, response: resp, elapsed });
  } catch (e) {
    return toast("保存失败：" + e.message);
  }
  s.stats[resp]++;
  const row = $(".answer-row");
  if (row) {
    row.style.pointerEvents = "none";
    row.innerHTML = `<div class="verdict"><span class="v-label">下次复习</span><b>${r.label}</b>
      <span class="v-sub">fm ${r.fm} · 难度 ${r.difficulty}</span></div>`;
  }
  setTimeout(() => {
    s.i++;
    s.revealed = false;
    s.ceOk = null;
    if (s.i >= s.list.length) return finishSession(r);
    drawCard();
  }, 900);
}

function finishSession(last) {
  const s = S.study;
  const st = s.stats;
  const total = st[1] + st[2] + st[3] + st[4];
  $("#sbar").style.width = "100%";
  $("#stage").innerHTML = `<div class="study-card" style="text-align:center;padding:44px 40px">
    <div class="eyebrow">Session Complete</div>
    <div style="font-family:var(--serif);font-size:40px;margin:14px 0 6px">${total} 个词</div>
    <div class="muted small">${esc(s.deckName)} · 用时 ${Math.max(1, Math.round((Date.now() - s.t0) / 60000))} 分钟</div>
    <div class="quick" style="grid-template-columns:repeat(4,1fr);margin-top:26px;text-align:left">
      <div class="stat-box"><div class="k">忘记</div><div class="v">${st[3]}</div></div>
      <div class="stat-box"><div class="k">模糊</div><div class="v">${st[2]}</div></div>
      <div class="stat-box"><div class="k">认识</div><div class="v">${st[1]}</div></div>
      <div class="stat-box"><div class="k">太简单</div><div class="v">${st[4]}</div></div>
    </div>
    <div class="row" style="justify-content:center;gap:10px;margin-top:28px">
      <button class="btn primary" onclick="location.hash='#/study?deck=${encodeURIComponent(s.deck)}&mode=mixed'">再学一组</button>
      <button class="btn" onclick="location.hash='#/today'">回到今日</button>
    </div>
  </div>`;
  document.onkeydown = null;
  fetch("/api/overview").then((r) => r.json()).then((o) => { S.ov = o; });
}

/* ---------------- 统计 ---------------- */
const ST = { st: null, dm: {}, month: "", sel: "", range: "all", maxDay: 1 };
const WD = ["一", "二", "三", "四", "五", "六", "日"];

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const pd = (s) => { const [y, m, d] = (s || "").split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const dateCn = (s) => { const d = pd(s); return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const shortCn = (s) => { const d = pd(s); return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const weekCn = (s) => "周" + WD[(pd(s).getDay() + 6) % 7];
const shiftDay = (s, n) => { const d = pd(s); d.setDate(d.getDate() + n); return ymd(d); };
const shiftMonth = (ym, n) => { const [y, m] = ym.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const oneLine = (s, n = 24) => {
  const t = (s || "").split(/\n/)[0].replace(/\s*\/\s*/g, " / ").trim();
  return t.length > n ? t.slice(0, n) + "…" : (t || "—");
};

function durText(sec) {
  sec = Math.round(sec || 0);
  if (!sec) return "0 秒";
  if (sec < 60) return sec + " 秒";
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m} 分 ${String(s).padStart(2, "0")} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function heatLevel(v) {
  if (!v) return 0;
  const c = [ST.maxDay * 0.12, ST.maxDay * 0.3, ST.maxDay * 0.55, ST.maxDay * 0.8];
  return v >= c[3] ? 4 : v >= c[2] ? 3 : v >= c[1] ? 2 : 1;
}

const RESP = [
  ["forget", "忘记", "var(--red)", "想不起来，fm 降一级，很快再考"],
  ["uncertain", "模糊", "var(--amber)", "有点印象但不确定，间隔基本不变"],
  ["familiar", "认识", "var(--green)", "想起来了，fm 升一级，间隔变长"],
  ["well", "太简单", "var(--blue)", "直接斩掉，不再进入复习队列"],
];

const FM_BUCKETS = [
  ["初识", "fm 1–2", [1, 2], "刚接触，间隔只有几天"],
  ["熟悉", "fm 3–4", [3, 4], "正在建立印象，隔一两周复习"],
  ["巩固", "fm 5–6", [5, 6], "间隔到了几周量级"],
  ["稳固", "fm 7–8", [7, 8], "几个月不复习也还记得"],
  ["长期", "fm 9–10", [9, 10], "接近永久记忆"],
  ["已斩", "fm 100", [100], "手动移出队列，不再复习"],
];

async function viewStats() {
  const st = await api("stats");
  ST.st = st;
  ST.dm = Object.fromEntries(st.daily.map((d) => [d.date, d]));
  ST.maxDay = Math.max(1, ...st.daily.map((d) => d.total_cnt || 0));
  ST.month = (st.last || st.today).slice(0, 7);
  ST.sel = st.last || st.today;

  const t = st.totals;
  const answered = t.well + t.familiar + t.uncertain + t.forget;
  const right = t.well + t.familiar;
  const acc = answered ? Math.round((right / answered) * 100) : 0;
  const cover = st.span_days ? Math.round((st.active_days / st.span_days) * 100) : 0;
  const gap = st.last ? Math.round((pd(st.today) - pd(st.last)) / 864e5) : 0;
  const best = st.best_day;
  const cuts = [0.12, 0.3, 0.55, 0.8].map((x) => Math.ceil(ST.maxDay * x));

  $("#main").innerHTML = `<div class="page">
    <div class="page-head">
      <div><div class="eyebrow">Analytics</div><h1>学习统计</h1>
        <p>${st.first ? dateCn(st.first) + " – " + dateCn(st.last) : "还没有学习记录"}
          · ${st.active_days} 个学习日 · 共 ${fmt(t.total)} 次作答</p></div>
      <div class="seg" id="rseg">
        ${[["7", "7 天"], ["30", "30 天"], ["90", "90 天"], ["all", "全部"]]
          .map(([v, l]) => `<button data-r="${v}" class="${ST.range === v ? "on" : ""}">${l}</button>`).join("")}
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="k">学习天数</div><div class="v">${st.active_days}<small>天</small></div>
        <div class="ks">从第一天到最后一天共 ${st.span_days} 天，其中 ${cover}% 有学习</div></div>
      <div class="kpi"><div class="k">累计作答</div><div class="v">${fmt(t.total)}<small>次</small></div>
        <div class="ks">新学 ${fmt(t.new)} 词 · 复习 ${fmt(t.review)} 词</div></div>
      <div class="kpi"><div class="k">平均每日</div><div class="v">${st.avg_day}<small>词</small></div>
        <div class="ks">只按有学习的 ${st.active_days} 天计算</div></div>
      <div class="kpi"><div class="k">答对率</div><div class="v">${acc}<small>%</small></div>
        <div class="ks">「认识 + 太简单」${fmt(right)} 次 / 全部 ${fmt(answered)} 次</div></div>
    </div>

    <div class="streak-line">
      <span class="chip ${st.streak.cur > 0 ? "green" : ""}">当前连续 ${st.streak.cur} 天</span>
      <span class="chip">最长连续 ${st.streak.best} 天</span>
      <span class="chip">累计用时 ${durText(t.seconds)}</span>
      ${best ? `<button class="chip" onclick="selectDay('${best.date}')">单日最高 ${best.total_cnt} 词 · ${shortCn(best.date)}</button>` : ""}
      ${gap > 0 ? `<span class="chip amber">最近一次学习 ${shortCn(st.last)}，已 ${gap} 天</span>`
                : `<span class="chip green">今天已经学过啦</span>`}
    </div>

    <div class="section-title"><h2>学习日历</h2>
      <span class="small muted">点任意一天看当天的明细 · ← → 换天，PageUp / PageDown 换月</span></div>
    <div class="cal-wrap">
      <div class="card chart-card cal-card">
        <div class="cal-head">
          <div><b id="calTitle">—</b><div class="small muted" id="calSum"></div></div>
          <div class="row" style="gap:6px">
            <button class="btn sm ghost" id="calPrev" title="上个月">‹</button>
            <button class="btn sm" id="calBack">回到最近</button>
            <button class="btn sm ghost" id="calNext" title="下个月">›</button>
          </div>
        </div>
        <div class="cal-week">${WD.map((w) => `<span>${w}</span>`).join("")}</div>
        <div class="cal-grid" id="calGrid"></div>
        <div class="cal-foot">
          <div class="lgd">少 <span>
            ${["#f1eee7", "#d7e8e1", "#a9cdc1", "#63a390", "#1e6f5c"].map((c) => `<i style="background:${c}"></i>`).join("")}
          </span> 多 · 分档 ${cuts[0]}+ / ${cuts[1]}+ / ${cuts[2]}+ / ${cuts[3]}+ 词</div>
          <div class="small muted">今天：${dateCn(st.today)} ${weekCn(st.today)}</div>
        </div>
        <div class="strip" id="strip"></div>
      </div>
      <div class="card chart-card day-card" id="dayPanel"><div class="spin" style="margin:60px auto"></div></div>
    </div>

    <div class="section-title"><h2>每日学习量</h2><span class="small muted" id="barsNote"></span></div>
    <div class="card chart-card">
      <div class="bars" id="barsWrap"></div>
      <div class="lgd" style="justify-content:flex-end">
        <span class="chip" style="background:var(--green)"></span>新学
        <span class="chip" style="background:#a8cabd"></span>复习
        <span class="chip" style="background:#eeeae3"></span>0 词
      </div>
    </div>

    <div class="grid" style="grid-template-columns:1.05fr 1fr;margin-top:16px">
      <div class="card chart-card">
        <h3>作答分布</h3><div class="sub">每次复习后按当时印象点击四档之一，算法据此调整间隔</div>
        ${RESP.map(([k, name, color, tip]) => {
          const n = t[k] || 0, p = answered ? Math.round((n / answered) * 100) : 0;
          return `<div class="resp-row" title="${tip}"><span class="rn">${name}</span>
            <div class="rtrack"><i style="width:${p}%;background:${color}"></i></div>
            <span class="rv mono">${fmt(n)}</span><span class="rp mono">${p}%</span></div>`;
        }).join("")}
        <div class="small muted" style="margin-top:12px;line-height:1.8">
          答对率 =（认识 + 太简单）÷ 全部作答 = ${acc}%。<br>
          四档对应的后果：<b>忘记</b> → 记忆因子降 1 级，很快再考；<b>模糊</b> → 基本不变；
          <b>认识</b> → 升 1 级，间隔变长；<b>太简单</b> → 直接斩掉，不再进队列。<br>
          这一栏统计的是「作答次数」，同一个词复习多次会重复计数。</div>
      </div>
      <div class="card chart-card">
        <h3>记忆阶段</h3><div class="sub">按墨墨的记忆因子 fm 分档，看 ${fmt(Object.values(st.fm).reduce((a, b) => a + b, 0))} 个学过的词分布在哪</div>
        ${FM_BUCKETS.map(([name, range, keys, tip]) => {
          const n = keys.reduce((a, k) => a + (st.fm[String(k)] || 0), 0);
          const tot = Object.values(st.fm).reduce((a, b) => a + b, 0) || 1;
          const p = Math.round((n / tot) * 100);
          return `<div class="resp-row" title="${tip}"><span class="rn">${name}</span>
            <div class="rtrack"><i style="width:${p}%;background:var(--green);opacity:${0.35 + 0.65 * (keys[0] / 10 || 0.1)}"></i></div>
            <span class="rv mono">${fmt(n)}</span><span class="rp mono">${p}%</span></div>`;
        }).join("")}
        <div class="small muted" style="margin-top:12px;line-height:1.75">
          fm 越高间隔越长：fm 1 只有 2 天左右，fm 6 约 56 天，fm 10 可达 159 天（按你的记录校准后的值）。</div>
      </div>
    </div>
  </div>
  <div class="tip" id="tip" hidden></div>`;

  $$("#rseg button").forEach((b) => (b.onclick = () => {
    ST.range = b.dataset.r;
    $$("#rseg button").forEach((x) => x.classList.toggle("on", x === b));
    renderBars();
  }));
  $("#calPrev").onclick = () => { ST.month = shiftMonth(ST.month, -1); renderCal(); };
  $("#calNext").onclick = () => { ST.month = shiftMonth(ST.month, 1); renderCal(); };
  $("#calBack").onclick = () => selectDay(ST.st.last || ST.st.today);
  $("#calGrid").onclick = (e) => {
    const c = e.target.closest(".cal-day");
    if (c) selectDay(c.dataset.d);
  };
  $("#strip").onclick = (e) => {
    const c = e.target.closest(".sc");
    if (c && c.dataset.d) selectDay(c.dataset.d);
  };
  const bw = $("#barsWrap");
  bw.addEventListener("mouseover", (e) => {
    const c = e.target.closest(".bcol");
    if (c) showTip(c);
  });
  bw.addEventListener("mouseleave", hideTip);
  bw.addEventListener("click", (e) => {
    const c = e.target.closest(".bcol");
    if (c) selectDay(c.dataset.d);
  });

  document.onkeydown = (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "ArrowLeft") { e.preventDefault(); return selectDay(shiftDay(ST.sel, -1)); }
    if (e.key === "ArrowRight") { e.preventDefault(); return selectDay(shiftDay(ST.sel, 1)); }
    if (e.key === "PageUp") { e.preventDefault(); ST.month = shiftMonth(ST.month, -1); return renderCal(); }
    if (e.key === "PageDown") { e.preventDefault(); ST.month = shiftMonth(ST.month, 1); return renderCal(); }
  };

  renderCal();
  renderStrip();
  renderBars();
  selectDay(ST.sel);
}

function renderCal() {
  const [y, m] = ST.month.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const pad = (first.getDay() + 6) % 7;
  const nDays = new Date(y, m, 0).getDate();
  const nCells = Math.ceil((pad + nDays) / 7) * 7;
  const start = new Date(y, m - 1, 1 - pad);
  const today = ST.st.today;
  let html = "";
  for (let i = 0; i < nCells; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = ymd(d);
    const rec = ST.dm[key];
    const out = d.getMonth() !== m - 1;
    const cls = ["cal-day", "lv" + heatLevel(rec ? rec.total_cnt : 0)];
    if (out) cls.push("out");
    if (key === ST.sel) cls.push("sel");
    if (key === today) cls.push("today");
    html += `<button class="${cls.join(" ")}" data-d="${key}" title="${shortCn(key)} ${weekCn(key)} · ${
      rec ? rec.total_cnt + " 词 / " + durText(rec.seconds) : "没有学习记录"}">
      <span class="dn">${d.getDate()}</span><span class="dv">${rec ? rec.total_cnt : ""}</span></button>`;
  }
  $("#calGrid").innerHTML = html;
  $("#calTitle").textContent = `${y} 年 ${m} 月`;
  const rows = ST.st.daily.filter((d) => d.date.startsWith(ST.month));
  const tot = rows.reduce((a, b) => a + (b.total_cnt || 0), 0);
  $("#calSum").textContent = rows.length
    ? `${rows.length} 个学习日 · 共 ${tot} 词 · 用时 ${durText(rows.reduce((a, b) => a + b.seconds, 0))}`
    : "这个月没有学习记录";
}

function renderStrip() {
  const st = ST.st;
  const a = pd(st.first || st.today);
  const s = new Date(a);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  const end = pd(st.today);
  const weeks = Math.ceil(((end - s) / 864e5 + 1) / 7);
  const cands = [];
  let lastM = -1;
  for (let w = 0; w < weeks; w++) {
    const wd = new Date(s.getFullYear(), s.getMonth(), s.getDate() + w * 7);
    if (wd.getMonth() !== lastM) {
      cands.push([w, wd.getMonth() === 0 ? wd.getFullYear() + " 年" : wd.getMonth() + 1 + " 月"]);
      lastM = wd.getMonth();
    }
  }
  // 从右往左保留，两个月的标签至少隔开 30px，避免互相压住
  let months = "", limit = Infinity;
  for (let i = cands.length - 1; i >= 0; i--) {
    if (cands[i][0] * 13 <= limit - 30) {
      months = `<span style="left:${cands[i][0] * 13}px">${cands[i][1]}</span>` + months;
      limit = cands[i][0] * 13;
    }
  }
  let cells = "";
  for (let w = 0; w < weeks; w++) {
    const wd = new Date(s.getFullYear(), s.getMonth(), s.getDate() + w * 7);
    for (let i = 0; i < 7; i++) {
      const d = new Date(wd.getFullYear(), wd.getMonth(), wd.getDate() + i);
      const key = ymd(d);
      if (d > end || d < a) { cells += `<i class="blank"></i>`; continue; }
      const rec = ST.dm[key];
      cells += `<i class="sc lv${heatLevel(rec ? rec.total_cnt : 0)}${key === ST.sel ? " sel" : ""}"
        data-d="${key}" title="${shortCn(key)} ${weekCn(key)} · ${rec ? rec.total_cnt + " 词" : "没有学习"}"></i>`;
    }
  }
  $("#strip").innerHTML = `<div class="strip-months">${months}</div>
    <div class="strip-body">
      <div class="strip-dows">${["一", "", "三", "", "五", "", "日"].map((x) => `<span>${x}</span>`).join("")}</div>
      <div class="strip-grid" style="grid-template-columns:repeat(${weeks},13px)">${cells}</div>
    </div>
    <div class="small muted" style="margin-top:6px">全部记录 · ${shortCn(st.first)} 起，每行一周（周一起），共 ${weeks} 周</div>`;
}

async function selectDay(date) {
  if (!date) return;
  ST.sel = date;
  ST.month = date.slice(0, 7);
  renderCal();
  renderStrip();
  $$("#calGrid .cal-day").forEach((b) => b.classList.toggle("sel", b.dataset.d === date));
  $$("#strip .sc").forEach((b) => b.classList.toggle("sel", b.dataset.d === date));
  const d = await api("day?date=" + date);
  renderDayPanel(d);
}

function renderDayPanel(d) {
  const el = $("#dayPanel");
  const rec = d.daily;
  const has = rec && rec.total_cnt > 0;
  const head = `<div class="dp-head"><div><div class="eyebrow">${dateCn(d.date)} · ${weekCn(d.date)}</div>
      <h3>${shortCn(d.date)}</h3></div>
    <div class="row" style="gap:6px">
      <button class="btn sm ghost" onclick="selectDay('${shiftDay(d.date, -1)}')" title="前一天">‹</button>
      <button class="btn sm ghost" onclick="selectDay('${shiftDay(d.date, 1)}')" title="后一天">›</button>
    </div></div>`;

  if (!has) {
    el.innerHTML = head + `<div class="dp-empty">
      <div class="dp-empty-ico">${svg(IC.today, 26)}</div>
      <h4>这天没有学习记录</h4>
      <p class="small muted">${ST.st.last ? `上一次学习是 ${shortCn(ST.st.last)}` : "还没有任何记录"}</p>
      <div class="row" style="justify-content:center;gap:8px;margin-top:6px;flex-wrap:wrap">
        ${ST.st.last ? `<button class="btn sm" onclick="selectDay('${ST.st.last}')">看最近一次</button>` : ""}
        <a class="btn sm primary" href="#/study?deck=all&mode=mixed">现在学一组</a></div></div>`;
    return;
  }

  const acc = rec.total_cnt ? Math.round(((rec.well + rec.familiar) / rec.total_cnt) * 100) : 0;
  const segs = RESP.map(([k, , color]) => [k, rec[k] || 0, color]).filter((x) => x[1] > 0);
  const segHtml = segs.map(([k, n, color]) =>
    `<i style="width:${(n / rec.total_cnt) * 100}%;background:${color}" title="${RESP.find((x) => x[0] === k)[1]} ${n}"></i>`).join("");
  const newW = d.new_words || [], revW = d.reviewed || [];

  el.innerHTML = head + `
    <div class="dp-kpis">
      <div><div class="k">新学</div><div class="v">${rec.new_cnt}</div></div>
      <div><div class="k">复习</div><div class="v">${rec.review_cnt}</div></div>
      <div><div class="k">用时</div><div class="v">${durText(rec.seconds)}</div></div>
      <div><div class="k">答对率</div><div class="v">${acc}<small>%</small></div></div>
    </div>
    <div class="dp-seg">${segHtml || ""}</div>
    <div class="dp-legend">${RESP.map(([k, name, color]) =>
      `<span><i style="background:${color}"></i>${name} <b>${rec[k] || 0}</b></span>`).join("")}</div>
    ${newW.length ? `<div class="dp-sub">当天新学 ${newW.length} 词${newW.length === rec.new_cnt ? "" : `（记录 ${rec.new_cnt}）`}</div>
      <div class="dp-words">${newW.map((w) => `<button class="wc" onclick="showWord(${w.id})">
        <b>${esc(w.spelling)}</b><span>${esc(oneLine(w.translation))}</span>
        <em>${w.fm >= 100 ? "已斩" : "fm " + w.fm}</em></button>`).join("")}</div>`
      : (rec.new_cnt ? `<div class="dp-sub muted">当天新学 ${rec.new_cnt} 词（墨墨未导出逐条明细）</div>` : "")}
    ${revW.length ? `<div class="dp-sub">当天复习过 ${revW.length} 词</div>
      <div class="dp-words">${revW.map((w) => `<button class="wc" onclick="showWord(${w.id})">
        <b>${esc(w.spelling)}</b><span>${esc(oneLine(w.translation))}</span>
        <em>${w.last_response === 4 ? "太简单" : w.last_response === 1 ? "认识" : w.last_response === 2 ? "模糊" : "忘记"}</em></button>`).join("")}</div>`
      : `<div class="dp-sub muted">复习 ${rec.review_cnt} 词${revW.length ? "" : " · 历史记录只有计数，没有逐条明细"}</div>`}`;
}

function renderBars() {
  const st = ST.st;
  let days;
  if (ST.range === "all") {
    days = st.daily.slice();
  } else {
    const n = parseInt(ST.range, 10);
    const s = pd(st.today);
    s.setDate(s.getDate() - (n - 1));
    days = [];
    for (let i = 0; i < n; i++) {
      const key = shiftDay(ymd(s), i);
      days.push(ST.dm[key] || { date: key, new_cnt: 0, review_cnt: 0, total_cnt: 0, seconds: 0 });
    }
  }
  const maxV = Math.max(10, ...days.map((d) => d.total_cnt || 0));
  const H = 148;
  const hasAny = days.some((d) => d.total_cnt > 0);
  const step = days.length > 45 ? 7 : days.length > 20 ? 5 : 2;

  const html = days.map((d, i) => {
    const hn = ((d.new_cnt || 0) / maxV) * H, hr = ((d.review_cnt || 0) / maxV) * H;
    return `<div class="bcol${d.date === ST.sel ? " sel" : ""}" data-d="${d.date}">
      <div class="btrack">
        <div class="bbar" style="height:${(hn + hr).toFixed(1)}px"><i style="height:${hn.toFixed(1)}px"></i></div>
      </div>
      ${i % step === 0 || i === days.length - 1
        ? `<span class="blab">${pd(d.date).getMonth() + 1}/${pd(d.date).getDate()}</span>` : ""}
    </div>`;
  }).join("");

  $("#barsWrap").innerHTML = `<div class="baxis"><span>${maxV}</span><span>${Math.round(maxV / 2)}</span><span>0</span></div>
    <div class="bcols" style="min-width:${Math.max(240, days.length * (days.length > 60 ? 8 : 16))}px">${html}</div>`;
  $("#barsNote").innerHTML = hasAny
    ? `${shortCn(days[0].date)} – ${shortCn(days[days.length - 1].date)} · 悬停看当天，点击在日历中选中`
    : `这段时间没有记录${st.last ? ` · 最近一次学习是 ${shortCn(st.last)}` : ""}`;
}

function showTip(c) {
  const d = ST.dm[c.dataset.d] || { date: c.dataset.d, new_cnt: 0, review_cnt: 0, total_cnt: 0, seconds: 0 };
  const t = $("#tip"), r = c.getBoundingClientRect();
  t.hidden = false;
  t.innerHTML = `<b>${shortCn(d.date)} ${weekCn(d.date)}</b>
    <span>新学 ${d.new_cnt || 0} · 复习 ${d.review_cnt || 0} · 共 ${d.total_cnt || 0} 词</span>
    <span>${d.total_cnt ? "用时 " + durText(d.seconds) : "没有学习记录"}</span>`;
  t.style.left = Math.min(Math.max(r.left + r.width / 2, 90), window.innerWidth - 90) + "px";
  t.style.top = Math.max(r.top - 10, 70) + "px";
}
function hideTip() {
  const t = $("#tip");
  if (t) t.hidden = true;
}

/* ---------------- 算法 ---------------- */
async function viewAlgo() {
  const a = await api("algo");
  const m = a.matrix;
  const fviRows = Object.entries(a.fvi).map(([k, v]) => [k, v]);
  const diff = Object.entries(a.dvi).map(([k, v]) => [k, v]);
  const calib = m ? Array.from({ length: 10 }, (_, i) => i + 1).map((fm) => {
    const base = m.base[String(fm)] || 0;
    return [fm, base, m.ratio[String(5)]];
  }) : [];

  const calcOpts = (from, to, unit = "") => Array.from({ length: to - from + 1 }, (_, i) => from + i)
    .map((n) => `<option value="${n}">${n}${unit}</option>`).join("");

  $("#main").innerHTML = `<div class="page">
    <div class="page-head"><div><div class="eyebrow">Algorithm</div><h1>复习调度是怎么算的</h1>
      <p>墨墨把「记忆因子 fm」和「个人难度」映射成下次复习的天数 · 我用你的 ${m ? m.n : "-"} 条真实记录做了拟合校准</p></div></div>

    <div class="algo-hero">
      <div class="stat-box"><div class="k">fvi_fm_to_interval_days</div><div class="v" style="font-size:19px">1→1 · 5→15 · 10→360</div></div>
      <div class="stat-box"><div class="k">dvi_difficulty_to_ext_days</div><div class="v" style="font-size:19px">1→−3 · 10→−12</div></div>
      <div class="stat-box"><div class="k">matrix_version</div><div class="v mono" style="font-size:16px">1000070</div></div>
    </div>

    <div class="row" style="gap:16px;align-items:stretch">
      <div class="card chart-card" style="flex:1.15">
        <h3>结算公式</h3><div class="sub">官方随包基线（README 第 3 节）</div>
        <div class="code"><span class="c"># 答对</span>
fm += 1            <span class="c"># 上限 10 / 100</span>
interval = FVI[fm] + DVI[difficulty]

<span class="c"># 答错</span>
fm -= 1            <span class="c"># 下限 1</span>
interval = FVI[fm]

next_date = today + interval <span class="k">天</span></div>
        <div class="small muted" style="margin-top:12px;line-height:1.75">
          DVI 是给「几十天量级」的基线做减法，直接套到 fm=1~3（1/3/5 天）上会把间隔压成负数。
          所以生词首答不叠加难度惩罚、只走 FVI，并用 <span class="mono">max(1, …)</span> 兜底；
          进入复习池之后，则优先使用下面那张由你的历史记录拟合出来的矩阵。</div>
      </div>
      <div class="card chart-card" style="flex:1">
        <h3>交互试算</h3><div class="sub">改一下 fm 与难度，看下次间隔</div>
        <div class="calc-row">
          <label class="small muted">记忆因子 fm</label><select id="cfm">${calcOpts(1, 10)}</select>
          <label class="small muted">难度</label><select id="cd">${calcOpts(1, 10)}</select>
        </div>
        <div style="margin-top:18px"><div class="calc-out" id="cout">7 天</div>
          <div class="small muted" id="cex">FVI[4] + DVI[5] = 7 − 7 = 0 → 兜底 1 天</div></div>
        <div style="margin-top:18px" class="small muted">校准版会把同一组参数算成 <b id="ccali">—</b></div>
      </div>
    </div>

    <div class="section-title"><h2>两张参数表</h2><span class="small muted">随包明文，可当作基线</span></div>
    <div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="card chart-card"><h3>FVI · fm → 间隔天数</h3>
        <table class="tbl" style="margin-top:10px"><thead><tr><th>fm</th><th>天数</th><th>fm</th><th>天数</th></tr></thead><tbody>
        ${[0, 1, 2, 3, 4, 5].map((i) => `<tr>
          <td class="num">${fviRows[i]?.[0] ?? ""}</td><td class="num">${fviRows[i]?.[1] ?? ""}</td>
          <td class="num">${fviRows[i + 6]?.[0] ?? ""}</td><td class="num">${fviRows[i + 6]?.[1] ?? ""}</td></tr>`).join("")}
        </tbody></table></div>
      <div class="card chart-card"><h3>DVI · 难度 → 天数修正</h3>
        <table class="tbl" style="margin-top:10px"><thead><tr><th>难度</th><th>修正</th><th>难度</th><th>修正</th></tr></thead><tbody>
        ${[0, 1, 2, 3, 4].map((i) => `<tr>
          <td class="num">${diff[i]?.[0] ?? ""}</td><td class="num">${diff[i]?.[1] ?? ""}</td>
          <td class="num">${diff[i + 5]?.[0] ?? ""}</td><td class="num">${diff[i + 5]?.[1] ?? ""}</td></tr>`).join("")}
        </tbody></table></div>
    </div>

    ${m ? `<div class="section-title"><h2>用真实记录校准后的矩阵</h2><span class="small muted">${m.n} 条复习记录拟合</span></div>
    <div class="card chart-card">
      <div class="sub" style="margin-bottom:14px">fm 决定基线（中位数），难度按实测倍率缩放。默认走这一套，因为它和你过去的复习节奏一致。</div>
      <table class="tbl"><thead><tr><th>fm</th><th>基线间隔（天）</th><th>难度 1</th><th>难度 3</th><th>难度 5</th><th>难度 7</th><th>难度 10</th></tr></thead><tbody>
        ${calib.map(([fm, base]) => `<tr><td class="num">${fm}</td><td class="num" style="color:var(--green);font-weight:600">${base}</td>
          ${[1, 3, 5, 7, 10].map((d) => `<td class="num">${Math.max(1, Math.round(base * (m.ratio[String(d)] || 1)))}</td>`).join("")}</tr>`).join("")}
      </tbody></table>
      <div class="small muted" style="margin-top:12px">校准模式下「忘记/模糊/认识」只改变 fm 与难度，再由矩阵换算成天数；「太简单」直接把 fm 置为 100（36500 天，等于移出队列）。</div>
    </div>` : ""}
  </div>`;

  const calc = () => {
    const fm = +$("#cfm").value, d = +$("#cd").value;
    const iv = Math.max(1, a.fvi[fm] + a.dvi[d]);
    $("#cout").textContent = (a.fvi[fm] + a.dvi[d]) <= 0 ? `兜底 ${iv} 天` : `${iv} 天`;
    $("#cex").textContent = `FVI[${fm}] + DVI[${d}] = ${a.fvi[fm]} ${a.dvi[d]} = ${a.fvi[fm] + a.dvi[d]}`;
    if (m) {
      const c = Math.max(1, Math.round((m.base[String(fm)] || a.fvi[fm]) * (m.ratio[String(d)] || 1)));
      $("#ccali").textContent = `${c} 天`;
    }
  };
  $("#cfm").onchange = calc;
  $("#cd").onchange = calc;
  calc();
}

/* ---------------- 数据备份 ---------------- */
async function viewData() {
  const ov = await api("overview");
  let est = { usage: 0, quota: 0 };
  try {
    if (navigator.storage && navigator.storage.estimate) est = await navigator.storage.estimate();
  } catch (e) { /* 部分浏览器不支持 */ }
  const mb = (n) => {
    if (!n) return "—";
    const m = n / 1048576;
    return m >= 1024 ? (m / 1024).toFixed(1) + " GB" : m.toFixed(1) + " MB";
  };
  const last = localStorage.getItem("momo.lastExport") || "从未导出";
  const offline = !!(window.MOMO && window.MOMO.offline);

  $("#main").innerHTML = `
  <div class="page">
    <div class="page-head">
      <div><div class="eyebrow">Data · 备份与迁移</div>
      <h1>你的进度，随时能带走</h1>
      <p>${offline
        ? "进度存在这台设备的浏览器里，不上传任何服务器。换手机、清缓存、卸载前先导出一份。"
        : "进度存在本地 SQLite 数据库里，不联网。换机器前先导出一份。"}</p></div>
      <a class="btn" href="#/today">${svg(IC.back, 15)} 返回</a>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px">
      <div class="stat-box"><div class="k">已学词</div><div class="v">${fmt(ov.studied)}<small>词</small></div></div>
      <div class="stat-box"><div class="k">学习日</div><div class="v">${ov.days}<small>天</small></div></div>
      <div class="stat-box"><div class="k">待复习</div><div class="v">${fmt(ov.due)}<small>词</small></div></div>
      <div class="stat-box"><div class="k">本机存储</div><div class="v">${mb(est.usage)}<small>${est.quota ? "共 " + mb(est.quota) : ""}</small></div></div>
    </div>

    <div class="section-title"><h2>导出</h2></div>
    <div class="card">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div style="flex:1;min-width:200px">
          <b style="font-size:14px">momo-progress.json</b>
          <div class="small muted" style="margin-top:4px">含 ${fmt(ov.studied)} 个词的记忆因子、难度、到期日，以及 ${ov.days} 天答题记录。手机版与桌面版格式相同，可互相导入。</div>
          <div class="small muted" style="margin-top:6px">上次导出：${esc(last)}</div>
        </div>
        <button class="btn primary" id="exp">导出到文件</button>
      </div>
    </div>

    <div class="section-title"><h2>导入 / 合并</h2></div>
    <div class="card">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div style="flex:1;min-width:200px">
          <b style="font-size:14px">从备份文件恢复</b>
          <div class="small muted" style="margin-top:4px">按「最后学习时间较新者优先」合并，不会覆盖本机更晚的进度；同一个词只保留一条。</div>
        </div>
        <button class="btn" id="imp">选择文件…</button>
        <input type="file" id="file" accept="application/json,.json" style="display:none">
      </div>
    </div>

    <div class="section-title"><h2>重置</h2></div>
    <div class="card">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div style="flex:1;min-width:200px">
          <b style="font-size:14px">恢复到初始进度</b>
          <div class="small muted" style="margin-top:4px">清空本机答题记录，回到${offline ? "随包种子状态（1441 词进度 + 94 天记录）" : "首次导入墨墨运行库时的状态"}。不可撤销，建议先导出。</div>
        </div>
        <button class="btn" id="rst">恢复初始</button>
      </div>
    </div>
  </div>`;

  $("#exp").onclick = async () => {
    try {
      const data = await api("export");
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `momo-progress-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
      localStorage.setItem("momo.lastExport", stamp);
      const el = document.querySelector("#exp").parentNode.querySelector(".small.muted:last-child");
      if (el) el.textContent = `上次导出：${stamp}`;
      toast(`已导出 ${fmt((data.reviews || []).length)} 条进度`);
    } catch (e) {
      toast("导出失败：" + e.message);
    }
  };

  $("#imp").onclick = () => $("#file").click();

  $("#file").onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    let data;
    try {
      data = JSON.parse(await f.text());
    } catch (err) {
      toast("这不是有效的 JSON 文件");
      return;
    }
    if (!data || !Array.isArray(data.reviews)) {
      toast("文件格式不对：缺少 reviews");
      return;
    }
    try {
      const r = await api("import", { method: "POST", body: JSON.stringify(data) });
      toast(`合并完成：新增 ${fmt(r.added || 0)}，更新 ${fmt(r.updated || 0)}`);
      setTimeout(() => route(), 1200);
    } catch (err) {
      toast("导入失败：" + err.message);
    }
  };

  $("#rst").onclick = async () => {
    if (!confirm("确定要清空本机答题记录、恢复到初始进度吗？此操作不可撤销。\n\n建议先点上面的「导出到文件」备份一份。")) return;
    try {
      const r = await api("reset", { method: "POST", body: "{}" });
      toast(`已恢复初始进度：${fmt(r.total || 0)} 词 / ${r.days || 0} 天`);
      setTimeout(() => route(), 1200);
    } catch (e) {
      toast("重置失败：" + e.message);
    }
  };
}

boot();
