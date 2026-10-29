/* store.js — 离线数据层（PWA）
 *
 * 把 server.py + momo.db 的全部能力搬到浏览器里：
 *   词库    → 静态分片（字母片 / 词单分块），按需 fetch
 *   进度    → IndexedDB，改动即写回
 *   调度算法 → 与后端逐行等价的实现
 * 对外暴露 MOMO.api(path, opt)，签名与 fetch("/api/...") 一致，
 * 所以 app.js 不用改一行。
 */
(function () {
  "use strict";

  /* ---------------- 路径与日期 ---------------- */
  var BASE = (function () {
    var p = location.pathname;
    return p.charAt(p.length - 1) === "/" ? p : p.slice(0, p.lastIndexOf("/") + 1);
  })();
  var DATA = BASE + "data/";
  var VER = "v1";

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function todayStr() { return iso(new Date()); }
  function addDays(s, n) {
    var d = new Date(s + "T00:00:00");
    d.setDate(d.getDate() + n);
    return iso(d);
  }
  function dayDiff(a, b) {
    return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
  }
  function fmtInterval(d) {
    if (d >= 36500) return "不再复习";
    if (d >= 365) return (d / 365).toFixed(1) + " 年后";
    if (d >= 30) return (d / 30).toFixed(1) + " 个月后";
    return d + " 天后";
  }
  function bucketOf(sp) {
    var ch = (sp || "").charAt(0);
    return /[a-zA-Z]/.test(ch) ? ch.toLowerCase() : "_";
  }
  function safe(s) { return String(s).replace(/:/g, "_"); }

  /* ---------------- 静态分片：请求去重 + LRU ---------------- */
  var inflight = new Map();
  var caches = { lex: new Map(), x: new Map(), dw: new Map(), deck: new Map() };
  var LRU_MAX = 8;

  function lruPut(map, k, v) {
    map.delete(k);
    map.set(k, v);
    if (map.size > LRU_MAX) map.delete(map.keys().next().value);
  }

  function getJSON(rel) {
    var abs = DATA + rel;
    if (inflight.has(abs)) return inflight.get(abs);
    var p = fetch(abs, { cache: "force-cache" }).then(function (r) {
      if (!r.ok) throw new Error("load " + rel + " " + r.status);
      return r.json();
    });
    inflight.set(abs, p);
    p.catch(function () { }).then(function () { inflight.delete(abs); });
    return p;
  }

  /* 分片文件名一律小写。界面上的字母按钮给的是大写 "B"，而 GitHub Pages /
     Linux 的静态托管区分大小写，直接拼会 404（Windows 上测不出来）。
     词库本身也分块（LEXBLK 词/块），按 (字母, 块号) 取，不再一次拉整个字母。 */
  function lexPath(L, b) {
    return String(L || "").toLowerCase() + "/" + (b || 0);
  }
  function getLex(L, b) {
    var k = lexPath(L, b);
    if (caches.lex.has(k)) return Promise.resolve(caches.lex.get(k));
    return getJSON("lex/" + k + ".json").then(function (r) {
      lruPut(caches.lex, k, r);
      return r;
    });
  }
  function getX(L, b) {
    var k = lexPath(L, b);
    if (caches.x.has(k)) return Promise.resolve(caches.x.get(k));
    return getJSON("x/" + k + ".json").then(function (r) {
      lruPut(caches.x, k, r);
      return r;
    });
  }
  /* 分块参数来自 meta.json（lex_block），拿不到时按 800 兜底 */
  function lexBlock() {
    return (META && META.lex_block) || 800;
  }
  function letterInfo(L) {
    var m = META && META.lex && META.lex[L];
    if (m) return m;
    var n = (META && META.letters && META.letters[L]) || 0;
    return { n: n, blocks: Math.ceil(n / lexBlock()) };
  }

  /* ---------------- IndexedDB ---------------- */
  var DB = null;
  var STORES = ["reviews", "daily", "daylog", "kv"];

  function openDB() {
    if (DB) return Promise.resolve(DB);
    return new Promise(function (res, rej) {
      var rq = indexedDB.open("momo", 1);
      rq.onupgradeneeded = function (e) {
        var db = e.target.result;
        db.createObjectStore("reviews", { keyPath: "voc_id" });
        db.createObjectStore("daily", { keyPath: "date" });
        var lg = db.createObjectStore("daylog", { keyPath: "id", autoIncrement: true });
        lg.createIndex("date", "date");
        db.createObjectStore("kv");
      };
      rq.onsuccess = function (e) { DB = e.target.result; res(DB); };
      rq.onerror = function () { rej(rq.error); };
    });
  }

  function tx(store, mode) { return openDB().then(function (db) { return db.transaction(store, mode); }); }

  function idbAll(store) {
    return tx(store, "readonly").then(function (t) {
      return new Promise(function (res, rej) {
        var rq = t.objectStore(store).getAll();
        rq.onsuccess = function () { res(rq.result || []); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function idbPut(store, val, key) {
    return tx(store, "readwrite").then(function (t) {
      // kv 是 out-of-line key 的存储，必须显式给 key；
      // reviews / daily 有 keyPath，传 key 反而会抛 DataError。
      if (key === undefined) t.objectStore(store).put(val);
      else t.objectStore(store).put(val, key);
      return new Promise(function (res, rej) {
        t.oncomplete = res; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); };
      });
    });
  }
  function idbGet(store, key) {
    return tx(store, "readonly").then(function (t) {
      return new Promise(function (res, rej) {
        var rq = t.objectStore(store).get(key);
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function idbDel(store, key) {
    return tx(store, "readwrite").then(function (t) {
      t.objectStore(store).delete(key);
      return new Promise(function (res) { t.oncomplete = res; });
    });
  }
  function idbIndexAll(store, idxName, key) {
    return tx(store, "readonly").then(function (t) {
      return new Promise(function (res, rej) {
        var rq = t.objectStore(store).index(idxName).getAll(key);
        rq.onsuccess = function () { res(rq.result || []); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }

  /* ---------------- 内存镜像 ---------------- */
  var META = null;          // 全局 meta
  var ALGO = null;          // 算法参数
  var BOOKS = null;         // 书目
  var REV = new Map();      // voc_id -> 学习状态
  var DAILY = new Map();    // date -> 当日统计
  var DECKIDS = new Map();  // deck_id -> [voc_id...]
  var WORDCACHE = new Map();// voc_id -> 词条（学习卡片用）
  var BKT_BLOCKS = new Map(); // 见 bucketOfId
  var SETTINGS = { matrix: "calibrated", new_limit: 10, mode: "mixed" };

  function stOf(vid) {
    var r = REV.get(vid);
    if (!r) return null;
    return {
      fm: r.fm, diff: r.difficulty, next: r.next_date, iv: r.last_interval,
      resp: r.last_response, cnt: r.review_count, wrong: r.wrong_count,
      starred: r.starred, blocked: r.blocked
    };
  }

  function rowFromLex(a) {
    return { id: a[0], w: a[1], ph: a[2], phus: a[2], tr: a[3], df: "", pos: a[4], ex: "", col: a[6], ox: a[7], frq: a[5], tags: a[8], rel: "" };
  }
  function rowFromDw(a) {
    return { id: a[0], w: a[1], ph: a[2], phus: a[2], tr: a[3], df: "", pos: a[4], ex: "", col: a[5], ox: a[6], frq: a[7], tags: "", rel: "" };
  }
  function withExt(d, e) {
    if (e) {
      d.df = e[1] || "";
      d.ex = e[2] || "";
      d.rel = e[3] || "";
      d.tags_cn = (e[4] || []).map(function (t) { return { tag: t, name: (ALGO && ALGO.tag_names && ALGO.tag_names[t]) || "" }; });
      d.decks = (e[5] || []).map(deckName);
    }
    return d;
  }
  function attach(d) {
    var s = stOf(d.id);
    if (s) d.st = s;
    return d;
  }

  function deckName(id) {
    if (!META) return id;
    for (var i = 0; i < META.decks.length; i++) if (META.decks[i].id === id) return META.decks[i].name;
    return id;
  }

  /* ---------------- 学习进度种子 ----------------
   * 站点自带的真实学习记录（seed.json），只在本地库为空时导入一次，
   * 这样手机首次打开就继承母库的进度，而不是从 0 开始。
   */
  var REV_COLS = ["voc_id", "fm", "difficulty", "last_interval", "next_date",
                  "last_response", "review_count", "wrong_count",
                  "first_study", "last_study", "starred", "blocked"];
  var DAY_COLS = ["date", "new_cnt", "review_cnt", "total_cnt", "correct", "wrong",
                  "seconds", "well", "familiar", "uncertain", "forget"];

  function rowsFrom(arr, cols) {
    return (arr || []).map(function (a) {
      var o = {};
      for (var i = 0; i < cols.length; i++) o[cols[i]] = a[i];
      if (o.date) o.source = o.source || "maimemo";
      return o;
    });
  }

  async function seedOnce() {
    var s;
    try { s = await getJSON("seed.json"); } catch (e) { return []; }
    if (!s || !s.reviews || !s.reviews.length) return [];
    var rv = rowsFrom(s.reviews, REV_COLS);
    var dy = rowsFrom(s.daily, DAY_COLS);
    var t = await tx("reviews", "readwrite");
    var os = t.objectStore("reviews");
    rv.forEach(function (r) { os.put(r); });
    await new Promise(function (res, rej) {
      t.oncomplete = res; t.onerror = function () { rej(t.error); };
      t.onabort = function () { rej(t.error); };
    });
    if (dy.length) {
      var t2 = await tx("daily", "readwrite");
      var os2 = t2.objectStore("daily");
      dy.forEach(function (d) { os2.put(d); });
      await new Promise(function (res) { t2.oncomplete = res; t2.onerror = res; t2.onabort = res; });
    }
    // 标记写入失败不阻断：进度已经落库，最多下次启动时重复导入（幂等）
    try { await idbPut("kv", s.built_at || "1", "seeded"); } catch (e) { }
    return rv;
  }

  /* ---------------- 进度导出 / 导入 ----------------
   * 紧凑行格式（列名顺序见 REV_COLS / DAY_COLS），与 seed.json 同构，
   * 所以桌面版导出的文件能直接喂给手机版，反之亦然。
   */
  function packRows(map, cols) {
    var out = [];
    map.forEach(function (o) {
      out.push(cols.map(function (c) { return o[c] == null ? "" : o[c]; }));
    });
    return out;
  }

  function apiExport() {
    return {
      v: 1, app: "momo-lab",
      exported_at: new Date().toISOString().slice(0, 16).replace("T", " "),
      total_words: META ? META.total_words : 0,
      reviews: packRows(REV, REV_COLS),
      daily: packRows(DAILY, DAY_COLS),
      settings: { matrix: SETTINGS.matrix, new_limit: SETTINGS.new_limit, mode: SETTINGS.mode }
    };
  }

  function waitTx(t) {
    return new Promise(function (res, rej) {
      t.oncomplete = res;
      t.onerror = function () { rej(t.error); };
      t.onabort = function () { rej(t.error); };
    });
  }

  async function writeRows(storeName, rows) {
    if (!rows.length) return;
    var t = await tx(storeName, "readwrite");
    var os = t.objectStore(storeName);
    rows.forEach(function (r) { os.put(r); });
    await waitTx(t);
  }

  async function clearStore(storeName) {
    var t = await tx(storeName, "readwrite");
    t.objectStore(storeName).clear();
    await waitTx(t);
  }

  /* 恢复出厂：清掉本地进度，再重新导入随包种子（不是清空成 0） */
  async function apiReset() {
    await boot();
    await clearStore("reviews");
    await clearStore("daily");
    await clearStore("daylog");
    REV.clear(); DAILY.clear();
    var rs = await seedOnce();
    rs.forEach(function (r) { REV.set(r.voc_id, r); });
    var ds = await idbAll("daily");
    ds.forEach(function (d) { DAILY.set(d.date, d); });
    return { ok: true, total: REV.size, days: DAILY.size };
  }

  /* 合并导入：同一词保留 last_study 更新的那条，本地没学过的直接补进来 */
  async function apiImport(data) {
    await boot();
    var rv = rowsFrom(data && data.reviews, REV_COLS);
    var dy = rowsFrom(data && data.daily, DAY_COLS);
    var added = 0, updated = 0, days = 0;
    var toWrite = [];
    rv.forEach(function (r) {
      if (!r.voc_id) return;
      var cur = REV.get(r.voc_id);
      if (!cur) { added++; }
      else if ((r.last_study || "") <= (cur.last_study || "")) { return; }
      else { updated++; }
      toWrite.push(r); REV.set(r.voc_id, r);
    });
    var dayRows = [];
    dy.forEach(function (d) {
      if (!d.date) return;
      days++; DAILY.set(d.date, d); dayRows.push(d);
    });
    await writeRows("reviews", toWrite);
    await writeRows("daily", dayRows);
    if (data && data.settings) {
      SETTINGS = Object.assign(SETTINGS, data.settings);
      try { await idbPut("kv", SETTINGS, "settings"); } catch (e) { }
    }
    return { ok: true, added: added, updated: updated, days: days, total: REV.size };
  }

  /* ---------------- 启动 ---------------- */
  var BOOT = null;
  function boot() {
    if (BOOT) return BOOT;
    BOOT = (async function () {
      META = await getJSON("meta.json");
      var rs = await idbAll("reviews");
      if (!rs.length) {
        var seeded = await idbGet("kv", "seeded");
        if (!seeded) rs = await seedOnce();
      }
      rs.forEach(function (r) { REV.set(r.voc_id, r); });
      var ds = await idbAll("daily");
      ds.forEach(function (d) { DAILY.set(d.date, d); });
      var s = await idbGet("kv", "settings");
      if (s) SETTINGS = Object.assign(SETTINGS, s);
      return META;
    })();
    return BOOT;
  }

  async function ensureAlgo() {
    if (!ALGO) ALGO = await getJSON("algo.json");
    return ALGO;
  }
  async function ensureBooks() {
    if (!BOOKS) BOOKS = await getJSON("books.json");
    return BOOKS;
  }

  async function deckIds(did) {
    if (DECKIDS.has(did)) return DECKIDS.get(did);
    var d = await getJSON("deck/" + safe(did) + ".json");
    DECKIDS.set(did, d.ids);
    return d.ids;
  }
  /* 一次性把所有词单的 id 表装进来（约 1MB，之后常驻） */
  async function allDeckIds() {
    if (DECKIDS.size || !META) return;
    var arr = await Promise.all(META.decks.map(function (d) {
      return getJSON("deck/" + safe(d.id) + ".json");
    }));
    arr.forEach(function (d, i) { DECKIDS.set(META.decks[i].id, d.ids); });
  }

  /* 按词单下标取一组词的完整数据 */
  async function loadByIndex(did, idxs) {
    var ids = await deckIds(did);
    var block = (META && META.block) || 800;
    var need = new Set();
    idxs.forEach(function (i) { need.add(Math.floor(i / block)); });
    var out = new Map();
    await Promise.all(Array.from(need).map(async function (b) {
      var key = did + "/" + b;
      var rows;
      if (caches.dw.has(key)) rows = caches.dw.get(key);
      else { rows = await getJSON("dw/" + safe(did) + "/" + b + ".json"); lruPut(caches.dw, key, rows); }
      for (var k = 0; k < rows.length; k++) out.set(ids[b * block + k], rows[k]);
    }));
    return out;
  }

  /* ---------------- 调度算法（与 server.py 等价） ---------------- */
  function schedule(fm, difficulty, response, hasHistory, matrixMode) {
    fm = fm || 1;
    difficulty = difficulty || 5;
    if (response === 4) return { fm: 100, difficulty: difficulty, interval: 36500, mastered: true };
    if (response === 1) { fm = Math.min(fm + 1, 10); difficulty = Math.max(1, difficulty - 1); }
    else if (response === 3) { fm = Math.max(fm - 1, 1); difficulty = Math.min(10, difficulty + 1); }
    var iv;
    if (matrixMode === "calibrated" && ALGO && ALGO.matrix) {
      var base = ALGO.matrix.base[String(fm)] || (ALGO.fvi[String(fm)] || 1);
      var ratio = ALGO.matrix.ratio[String(difficulty)];
      if (ratio == null) ratio = 1;
      iv = base * ratio;
    } else {
      iv = (ALGO ? ALGO.fvi[String(fm)] || 1 : 1) +
        (hasHistory ? ((ALGO && ALGO.dvi[String(difficulty)]) || -7) : 0);
    }
    if (!hasHistory) iv = ALGO ? (ALGO.fvi[String(fm)] || 1) : 1;
    return { fm: fm, difficulty: difficulty, interval: Math.max(1, Math.round(iv)), mastered: false };
  }

  /* ---------------- 各接口 ---------------- */
  async function apiOverview() {
    await boot();
    var t = todayStr();
    var due = 0, mastered = 0, learning = 0, doneToday = 0;
    REV.forEach(function (r) {
      if (!r.blocked && r.next_date && r.next_date <= t) due++;
      if (r.fm >= 100) mastered++; else learning++;
      if (r.last_study === t) doneToday++;
    });
    // 连续打卡
    var days = [];
    DAILY.forEach(function (d) { if ((d.total_cnt || 0) > 0) days.push(d.date); });
    var set = new Set(days), streak = 0, cur = new Date();
    while (true) {
      var k = iso(cur);
      if (set.has(k)) { streak++; cur.setDate(cur.getDate() - 1); }
      else if (k === t) { cur.setDate(cur.getDate() - 1); }
      else break;
    }
    var book = null;
    for (var i = 0; i < META.decks.length; i++) {
      if (META.decks[i].kind !== "book") continue;
      var dk = META.decks[i];
      var ids = await deckIds(dk.id);
      var started = 0;
      for (var j = 0; j < ids.length; j++) if (REV.has(ids[j])) started++;
      book = { id: dk.id, name: dk.name, total: dk.count, started: started };
      break;
    }
    var td = DAILY.get(t) || { date: t, new_cnt: 0, review_cnt: 0, total_cnt: 0, seconds: 0 };
    return {
      due: due, total_words: META.total_words, studied: REV.size, mastered: mastered,
      learning: learning, days: DAILY.size, streak: streak, done_today: doneToday,
      book: book, settings: SETTINGS,
      today: { new_cnt: td.new_cnt || 0, review_cnt: td.review_cnt || 0, total_cnt: td.total_cnt || 0, seconds: td.seconds || 0 }
    };
  }

  async function apiDecks() {
    await boot();
    await allDeckIds();
    var order = { book: 0, freq: 1, exam: 2 };
    var list = META.decks.slice().sort(function (a, b) {
      var o = (order[a.kind] == null ? 3 : order[a.kind]) - (order[b.kind] == null ? 3 : order[b.kind]);
      return o !== 0 ? o : b.count - a.count;
    });
    return list.map(function (d) {
      var ids = DECKIDS.get(d.id) || [];
      var n = 0;
      for (var i = 0; i < ids.length; i++) if (REV.has(ids[i])) n++;
      return { id: d.id, name: d.name, kind: d.kind, note: d.note, total: d.count, started: n };
    });
  }

  async function apiQueue(deck, mode, limit) {
    await boot();
    await ensureAlgo();
    limit = Math.max(1, Math.min(parseInt(limit || 20, 10), 200));
    var t = todayStr();
    var ids = null;
    if (deck && deck !== "all") ids = await deckIds(deck);

    var revIds = [], newIds = [], newIdx = [];
    if (ids) {
      for (var i = 0; i < ids.length; i++) {
        var r = REV.get(ids[i]);
        if (!r) { if (newIds.length < 400) { newIds.push(ids[i]); newIdx.push(i); } }
        else if (!r.blocked && r.next_date && r.next_date <= t) revIds.push(ids[i]);
        if (revIds.length >= limit && newIds.length >= limit) break;
      }
    } else {
      REV.forEach(function (r, vid) {
        if (!r.blocked && r.next_date && r.next_date <= t && revIds.length < limit) revIds.push(vid);
      });
    }

    var picked = [];
    if (mode === "review") picked = revIds.slice(0, limit).map(function (v) { return [v, "review"]; });
    else if (mode === "new") picked = newIds.slice(0, limit).map(function (v) { return [v, "new"]; });
    else {
      var a = revIds.slice(0, Math.ceil(limit / 2)).map(function (v) { return [v, "review"]; });
      var b = newIds.slice(0, limit - a.length).map(function (v) { return [v, "new"]; });
      picked = a.concat(b);
    }
    if (!picked.length) return [];

    // 取出词数据：优先缓存，否则按分块加载
    var out = [];
    if (ids) {
      var idxMap = new Map();
      for (var i2 = 0; i2 < ids.length; i2++) idxMap.set(ids[i2], i2);
      var idxs = picked.map(function (p) { return idxMap.get(p[0]); });
      var loaded = await loadByIndex(deck, idxs);
      picked.forEach(function (p) {
        var row = loaded.get(p[0]);
        if (!row) return;
        var d = attach(rowFromDw(row));
        d.mode = p[1];
        WORDCACHE.set(d.id, d);
        out.push(d);
      });
    } else {
      await Promise.all(picked.map(async function (p) {
        var d = await apiWordId(p[0]);
        if (d) { d.mode = p[1]; out.push(d); }
      }));
    }
    return out;
  }

  async function apiWordId(vid) {
    await boot();
    await ensureAlgo();
    vid = parseInt(vid, 10);
    if (WORDCACHE.has(vid)) {
      var c = WORDCACHE.get(vid);
      if (c && c.df !== undefined && c.tags_cn) return attach(c);
    }
    // 从拼写反查所在分块：先靠 bkt 索引，没有就逐块找
    var loc = await bucketOfId(vid);
    if (!loc) return null;
    var rows = await getLex(loc.L, loc.b);
    var target = null, pos = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === vid) { target = rows[i]; pos = i; break; }
    }
    if (!target) return null;
    var d = withExt(rowFromLex(target), null);
    // 弹窗先用 lex 块里的拼写/音标/中文释义秒开；
    // 英文释义、词形变化、相关词在 x 片（同块对齐），异步补进来，
    // 不再让用户对着空白等十几秒。
    WORDCACHE.set(vid, d);
    getX(loc.L, loc.b)
      .then(function (xs) {
        if (xs[pos] && xs[pos][0] === vid) withExt(d, xs[pos]);
      })
      .catch(function () { /* 补不到就保持基础信息 */ });
    return attach(d);
  }

  /* id → {L, b}：索引按 20000 个 id 分块，块内是稀疏记录
     {s: 起始 id, i: [块内偏移...], c: ["a3"...]}，
     点一个词只拉对应那块（约 9KB）。 */
  var BKT_CHUNK = 20000;
  var BKT_BLOCKS = new Map();

  async function bucketOfId(vid) {
    var k = Math.floor(vid / BKT_CHUNK);
    var c = BKT_BLOCKS.get(k);
    if (c === undefined) {
      try {
        c = await getJSON("bkt/" + k + ".json");
      } catch (e) {
        c = null;
      }
      BKT_BLOCKS.set(k, c);
    }
    if (c) {
      var code = null;
      if (typeof c.b === "string" && vid >= c.s && vid - c.s < c.b.length) {
        // 兼容老结构：定长串，"." 表示空位
        var ch = c.b.charAt(vid - c.s);
        if (ch && ch !== ".") code = ch + "0";
      } else if (c.i) {
        var lo = 0, hi = c.i.length - 1, off = vid - c.s;
        while (lo <= hi) {
          var mid = (lo + hi) >> 1;
          if (c.i[mid] === off) { code = c.c[mid]; break; }
          if (c.i[mid] < off) lo = mid + 1; else hi = mid - 1;
        }
      }
      if (code) return { L: code.charAt(0), b: parseInt(code.slice(1), 16) || 0 };
    }
    // 索引缺失时退化：逐字母逐块找（慢，但不会白屏）
    var order = "abcdefghijklmnopqrstuvwxyz_".split("");
    for (var i = 0; i < order.length; i++) {
      var info = letterInfo(order[i]);
      for (var b = 0; b < info.blocks; b++) {
        try {
          var rows = await getLex(order[i], b);
          for (var j = 0; j < rows.length; j++) {
            if (rows[j][0] === vid) return { L: order[i], b: b };
          }
        } catch (e2) { /* 该块不存在就跳过 */ }
      }
    }
    return null;
  }

  /* 全库搜索：前缀桶给即时结果，全局紧凑词典兜底"包含式"匹配。
     以前的实现只能在当前字母片里找，搜 bandon 找不到 abandon。 */
  var SX_PARTS = 8;
  var SX_ALL = null;

  async function ensureAllWords() {
    if (SX_ALL) return SX_ALL;
    var parts = [];
    for (var i = 0; i < SX_PARTS; i++) parts.push(i);
    var res = await Promise.all(parts.map(function (i) {
      return getJSON("sxa/" + i + ".json").catch(function () { return []; });
    }));
    SX_ALL = [];
    res.forEach(function (arr) { if (arr && arr.length) SX_ALL = SX_ALL.concat(arr); });
    return SX_ALL;
  }

  async function apiSearch(q, limit) {
    await boot();
    q = (q || "").trim().toLowerCase();
    if (!q) return [];
    limit = parseInt(limit || 30, 10);

    var key = (q.length >= 2 ? q.slice(0, 2) : q.charAt(0) + "_")
      .replace(/[^a-z0-9_]/g, "_");
    var bucket = [];
    try {
      bucket = await getJSON("sx/" + key + ".json");
    } catch (e) {
      bucket = [];
    }

    var pre = [], mid = [], seen = new Set();
    (bucket || []).forEach(function (r) {
      if (!r || !r[1]) return;
      var w = String(r[1]).toLowerCase(), at = w.indexOf(q);
      if (at < 0) return;
      seen.add(r[0]);
      (at === 0 ? pre : mid).push(r);
    });

    // 前缀一个都没命中时才拉全库做"包含式"搜索（8 份共约 0.9MB，只发生一次）。
    // 前缀有结果就直接用，不让常见查询背上全库下载的代价。
    if (pre.length === 0) {
      try {
        var all = await ensureAllWords();
        all.forEach(function (r) {
          if (seen.has(r[0])) return;
          var w = String(r[1] || "").toLowerCase();
          if (w.indexOf(q) > 0) { seen.add(r[0]); mid.push(r); }
        });
      } catch (e) { /* 兜底索引不可用就只给前缀结果 */ }
    }

    var ord = function (a, b) {
      return a[1].length - b[1].length || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    };
    pre.sort(ord);
    mid.sort(ord);
    var picked = pre.slice(0, limit).concat(mid.slice(0, Math.max(0, limit - pre.length)));

    // 补释义：同前缀的词通常落在同一个 lex 块里，getLex 有缓存，开销很小
    var out = [];
    for (var i = 0; i < picked.length; i += 8) {
      var chunk = await Promise.all(picked.slice(i, i + 8).map(function (r) {
        return apiWordId(r[0]).catch(function () { return null; });
      }));
      chunk.forEach(function (d) { if (d) out.push(d); });
    }
    return out;
  }

  async function apiBrowse(letter, sort, page) {
    await boot();
    page = Math.max(0, parseInt(page || 0, 10));
    var size = 60;
    var L = (!letter || letter === "all") ? "a" : String(letter).toLowerCase();
    var info = letterInfo(L);
    var blk = lexBlock();

    // 词频排序要整个字母参与才准确，只能全量加载（块级缓存，第二次就快）
    if (sort === "frq") {
      var all = [];
      for (var b = 0; b < (info.blocks || 0); b++) {
        var part = await getLex(L, b).catch(function () { return []; });
        if (part.length) all = all.concat(part);
      }
      all.sort(function (x, y) { return (x[5] ? 0 : 1) - (y[5] ? 0 : 1) || x[5] - y[5]; });
      var slice = all.slice(page * size, page * size + size);
      return {
        total: all.length, page: page, size: size, letter: L,
        items: slice.map(function (a) {
          var d = attach(rowFromLex(a));
          WORDCACHE.set(d.id, d);
          return d;
        })
      };
    }

    // 字母序：块内天然有序，一页只拉覆盖到的 1-2 块（首屏约 60KB，不是 1.1MB）
    var total = info.n || 0;
    var start = page * size;
    var end = Math.min(start + size, total);
    var rows = [];
    if (end > start) {
      var b0 = Math.floor(start / blk), b1 = Math.floor((end - 1) / blk);
      for (var bb = b0; bb <= b1; bb++) {
        var chunk = await getLex(L, bb).catch(function () { return []; });
        if (chunk.length) rows = rows.concat(chunk);
      }
      var from = start - b0 * blk;
      rows = rows.slice(from, from + (end - start));
    }
    return {
      total: total, page: page, size: size, letter: L,
      items: rows.map(function (a) {
        var d = attach(rowFromLex(a));
        WORDCACHE.set(d.id, d);
        return d;
      })
    };
  }

  async function apiBooks(q, page, sort) {
    await boot();
    var bs = await ensureBooks();
    page = Math.max(0, parseInt(page || 0, 10));
    var size = 40;
    q = (q || "").trim();
    var items = bs;
    if (q) {
      var k = q.toLowerCase();
      items = bs.filter(function (b) {
        return (b[1] + b[3] + b[4]).toLowerCase().indexOf(k) >= 0;
      });
    }
    if (sort === "name") items = items.slice().sort(function (a, b) { return a[1].localeCompare(b[1], "zh"); });
    var total = items.length;
    var pageItems = items.slice(page * size, page * size + size).map(function (b) {
      return { id: b[0], name: b[1], count: b[2], author: b[3], publisher: b[4], isbn: b[5], version: b[6], loaded: !!b[7] };
    });
    var pubs = [];
    return { total: total, page: page, size: size, items: pageItems, publishers: pubs, loaded_count: META.loaded_books };
  }

  async function apiStats() {
    await boot();
    await allDeckIds();
    var days = [];
    DAILY.forEach(function (d) { days.push(d); });
    days.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var active = days.filter(function (d) { return (d.total_cnt || 0) > 0; });
    var tot = { new: 0, review: 0, total: 0, seconds: 0, well: 0, familiar: 0, uncertain: 0, forget: 0 };
    active.forEach(function (d) {
      tot.new += d.new_cnt || 0; tot.review += d.review_cnt || 0; tot.total += d.total_cnt || 0;
      tot.seconds += d.seconds || 0; tot.well += d.well || 0; tot.familiar += d.familiar || 0;
      tot.uncertain += d.uncertain || 0; tot.forget += d.forget || 0;
    });
    var first = active.length ? active[0].date : null;
    var last = active.length ? active[active.length - 1].date : null;
    var span = first && last ? dayDiff(first, last) + 1 : 0;
    var dates = active.map(function (d) { return d.date; });
    var best = 1, run = 1;
    for (var i = 1; i < dates.length; i++) {
      if (dayDiff(dates[i - 1], dates[i]) === 1) run++; else run = 1;
      if (run > best) best = run;
    }
    var ss = new Set(dates), cur = 0, cd = new Date();
    if (!ss.has(iso(cd))) cd.setDate(cd.getDate() - 1);
    while (ss.has(iso(cd))) { cur++; cd.setDate(cd.getDate() - 1); }
    var bestDay = active.length ? active.reduce(function (a, b) { return (b.total_cnt || 0) > (a.total_cnt || 0) ? b : a; }) : null;

    var fm = {}, diff = {};
    REV.forEach(function (r) {
      if (!r.first_study && !r.review_count) return;
      fm[r.fm] = (fm[r.fm] || 0) + 1;
      diff[r.difficulty] = (diff[r.difficulty] || 0) + 1;
    });
    var decksTop = META.decks.map(function (d) {
      var ids = DECKIDS.get(d.id) || [], n = 0;
      for (var i2 = 0; i2 < ids.length; i2++) if (REV.has(ids[i2])) n++;
      return { name: d.name, n: n };
    }).filter(function (d) { return d.n > 0; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 6);

    return {
      daily: days, totals: tot, first: first, last: last, today: todayStr(), span_days: span,
      active_days: active.length, avg_day: active.length ? Math.round(tot.total / active.length) : 0,
      best_day: bestDay, streak: { cur: cur, best: best },
      fm: fm, diff: diff,
      resp: { well: tot.well, familiar: tot.familiar, uncertain: tot.uncertain, forget: tot.forget },
      decks: decksTop, seeded: 0
    };
  }

  async function apiDay(date) {
    await boot();
    var d = DAILY.get(date) || null;
    var logs = await idbIndexAll("daylog", "date", date);
    var news = [], revs = [];
    for (var i = 0; i < logs.length; i++) {
      var w = await apiWordId(logs[i].voc_id);
      if (!w) continue;
      var item = {
        id: w.id, spelling: w.w, phonetic: w.ph, translation: w.tr, pos: w.pos,
        fm: w.st ? w.st.fm : 0, difficulty: w.st ? w.st.diff : 5,
        last_response: w.st ? w.st.resp : 0, next_date: w.st ? w.st.next : "",
        review_count: w.st ? w.st.cnt : 0
      };
      (logs[i].kind === "new" ? news : revs).push(item);
    }
    return { date: date, daily: d, new_words: news, reviewed: revs };
  }

  async function apiAlgo() {
    await boot();
    await ensureAlgo();
    return {
      fvi: ALGO.fvi, dvi: ALGO.dvi, matrix: ALGO.matrix, settings: SETTINGS,
      seeded: 0, built: META.built_at
    };
  }

  async function apiAnswer(body) {
    await boot();
    await ensureAlgo();
    var vid = parseInt(body.voc_id, 10);
    var resp = parseInt(body.response, 10);
    var elapsed = parseInt(body.elapsed || 0, 10);
    var t = todayStr();
    var r = REV.get(vid);
    var hasHist = !!r && (r.review_count > 0 || !!r.first_study);
    var res = schedule(r ? r.fm : 1, r ? r.difficulty : 5, resp, hasHist, SETTINGS.matrix);
    var nd = addDays(t, res.interval);
    var correct = resp === 1 || resp === 4 ? 1 : 0;
    var rec = {
      voc_id: vid, fm: res.fm, difficulty: res.difficulty, last_interval: res.interval,
      next_date: nd, last_response: resp,
      review_count: (r ? r.review_count : 0) + 1,
      wrong_count: (r ? r.wrong_count : 0) + (correct ? 0 : 1),
      first_study: r && r.first_study ? r.first_study : t,
      last_study: t, starred: r ? r.starred : 0, blocked: res.mastered ? 1 : 0
    };
    REV.set(vid, rec);
    await idbPut("reviews", rec);

    var slot = { 4: "well", 1: "familiar", 2: "uncertain", 3: "forget" }[resp] || "familiar";
    var day = DAILY.get(t) || {
      date: t, new_cnt: 0, review_cnt: 0, total_cnt: 0, correct: 0, wrong: 0,
      seconds: 0, well: 0, familiar: 0, uncertain: 0, forget: 0
    };
    day.new_cnt += hasHist ? 0 : 1;
    day.review_cnt += hasHist ? 1 : 0;
    day.total_cnt += 1;
    day.correct += correct;
    day.wrong += 1 - correct;
    day.seconds += elapsed;
    day[slot] += 1;
    DAILY.set(t, day);
    await idbPut("daily", day);
    await idbPut("daylog", { date: t, voc_id: vid, kind: hasHist ? "review" : "new", resp: resp });

    return {
      fm: res.fm, difficulty: res.difficulty, interval: res.interval,
      next_date: nd, mastered: res.mastered, label: fmtInterval(res.interval)
    };
  }

  async function apiToggle(vid, key) {
    await boot();
    var r = REV.get(vid);
    if (!r) return { ok: 0 };
    r[key] = r[key] ? 0 : 1;
    REV.set(vid, r);
    await idbPut("reviews", r);
    return { ok: 1, value: r[key] };
  }

  /* ---------------- 路由 ---------------- */
  async function api(path, opt) {
    await boot();
    var seg = path.split("?");
    var u = seg[0].replace(/^\/+/, "");
    var q = {};
    (seg[1] || "").split("&").forEach(function (kv) {
      if (!kv) return;
      var p = kv.split("=");
      q[p[0]] = decodeURIComponent((p[1] || "").replace(/\+/g, " "));
    });
    var body = null;
    if (opt && opt.body) { try { body = JSON.parse(opt.body); } catch (e) { body = null; } }

    if (u === "overview") return apiOverview();
    if (u === "decks") return apiDecks();
    if (u === "queue") return apiQueue(q.deck, q.mode, q.limit);
    if (u === "word") return apiWordId(q.id);
    if (u === "search") return apiSearch(q.q, q.limit);
    if (u === "browse") return apiBrowse(q.letter, q.sort, q.page);
    if (u === "books") return apiBooks(q.q, q.page, q.sort);
    if (u === "stats") return apiStats();
    if (u === "day") return apiDay(q.date);
    if (u === "algo") return apiAlgo();
    if (u === "today") return { date: todayStr() };
    if (u === "answer") return apiAnswer(body || {});
    if (u === "star") return apiToggle(parseInt(body.voc_id, 10), "starred");
    if (u === "export") return apiExport();
    if (u === "import") return apiImport(body || {});
    if (u === "reset") return apiReset();
    if (u === "settings") {
      SETTINGS = Object.assign(SETTINGS, body || {});
      await idbPut("kv", SETTINGS, "settings");
      return SETTINGS;
    }
    throw new Error("unknown api " + u);
  }

  /* 供 app.js 判断当前是不是离线模式 */
  window.MOMO = {
    api: api,
    offline: true,
    version: VER,
    reset: function () {
      return openDB().then(function (db) {
        return new Promise(function (res) {
          var t = db.transaction(STORES, "readwrite");
          STORES.forEach(function (s) { t.objectStore(s).clear(); });
          t.oncomplete = function () { location.reload(); };
        });
      });
    },
    // 导出成与 seed.json 同构的紧凑格式，桌面版与手机版互相吃得下
    exportProgress: async function () { await boot(); return apiExport(); },
    importProgress: async function (data) { return apiImport(data); }
  };
})();
