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

  function getLex(bk) {
    if (caches.lex.has(bk)) return Promise.resolve(caches.lex.get(bk));
    return getJSON("lex/" + bk + ".json").then(function (r) {
      lruPut(caches.lex, bk, r);
      return r;
    });
  }
  function getX(bk) {
    if (caches.x.has(bk)) return Promise.resolve(caches.x.get(bk));
    return getJSON("x/" + bk + ".json").then(function (r) {
      lruPut(caches.x, bk, r);
      return r;
    });
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
  function idbPut(store, val) {
    return tx(store, "readwrite").then(function (t) {
      t.objectStore(store).put(val);
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
  var BKT = null;           // id -> 字母片的映射（按需）
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

  /* ---------------- 启动 ---------------- */
  var BOOT = null;
  function boot() {
    if (BOOT) return BOOT;
    BOOT = (async function () {
      META = await getJSON("meta.json");
      var rs = await idbAll("reviews");
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
    // 从拼写反查字母片：先靠 bkt 索引，没有就逐个字母片找
    var bk = await bucketOfId(vid);
    if (bk == null) return null;
    var rows = await getLex(bk);
    var target = null, pos = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === vid) { target = rows[i]; pos = i; break; }
    }
    if (!target) return null;
    var d = withExt(rowFromLex(target), null);
    try {
      var xs = await getX(bk);
      if (xs[pos] && xs[pos][0] === vid) withExt(d, xs[pos]);
    } catch (e) { }
    WORDCACHE.set(vid, d);
    return attach(d);
  }

  async function bucketOfId(vid) {
    if (BKT) return findBkt(vid);
    try {
      BKT = await getJSON("bkt.json");
    } catch (e) {
      // 没有索引就退化：按字母片顺序扫
      var order = "abcdefghijklmnopqrstuvwxyz_".split("");
      for (var i = 0; i < order.length; i++) {
        try {
          var rows = await getLex(order[i]);
          for (var j = 0; j < rows.length; j++) if (rows[j][0] === vid) return order[i];
        } catch (e2) { }
      }
      return null;
    }
    return findBkt(vid);
  }
  function findBkt(vid) {
    var ids = BKT.ids, b = BKT.b, lo = 0, hi = ids.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (ids[mid] === vid) return BKT.letters[b[mid]];
      if (ids[mid] < vid) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }

  async function apiSearch(q, limit) {
    await boot();
    q = (q || "").trim().toLowerCase();
    if (!q) return [];
    limit = parseInt(limit || 30, 10);
    var rows = await getLex(bucketOf(q));
    var hits = [];
    for (var i = 0; i < rows.length && hits.length < limit * 3; i++) {
      var w = rows[i][1].toLowerCase();
      if (w.indexOf(q) === 0) hits.push({ row: rows[i], i: i, pre: 0 });
    }
    for (var j = 0; j < rows.length && hits.length < limit * 3; j++) {
      var w2 = rows[j][1].toLowerCase();
      if (w2.indexOf(q) > 0) hits.push({ row: rows[j], i: j, pre: 1 });
    }
    hits.sort(function (a, b2) { return a.pre - b2.pre || a.row[1].length - b2.row[1].length || (a.row[5] || 0) - (b2.row[5] || 0); });
    var out = hits.slice(0, limit).map(function (h) {
      var d = attach(rowFromLex(h.row));
      WORDCACHE.set(d.id, d);
      return d;
    });
    return out;
  }

  async function apiBrowse(letter, sort, page) {
    await boot();
    page = Math.max(0, parseInt(page || 0, 10));
    var size = 60;
    if (!letter || letter === "all") {
      // 全部字母：退化为按 a 开头的首屏（避免拉全库）
      letter = "a";
    }
    var rows = (await getLex(letter)).slice();
    if (sort === "frq") rows.sort(function (a, b) { return (a[5] ? 0 : 1) - (b[5] ? 0 : 1) || a[5] - b[5]; });
    else if (sort === "len") rows.sort(function (a, b) { return a[1].length - b[1].length; });
    var total = rows.length;
    var pageRows = rows.slice(page * size, page * size + size);
    return {
      total: total, page: page, size: size,
      items: pageRows.map(function (a) {
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
    exportProgress: async function () {
      await boot();
      return { reviews: Array.from(REV.values()), daily: Array.from(DAILY.values()), settings: SETTINGS };
    },
    importProgress: async function (data) {
      await boot();
      (data.reviews || []).forEach(function (r) { REV.set(r.voc_id, r); });
      (data.daily || []).forEach(function (d) { DAILY.set(d.date, d); });
      await Promise.all((data.reviews || []).map(function (r) { return idbPut("reviews", r); }));
      await Promise.all((data.daily || []).map(function (d) { return idbPut("daily", d); }));
      return true;
    }
  };
})();
