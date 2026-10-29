#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
export_static.py — 把 data/momo.db 导出成纯静态站点（PWA）需要的分片数据

产物结构（输出到 site/）：
  site/data/meta.json          全局信息 + 22 个词单清单
  site/data/algo.json          墨墨算法参数（FVI / DVI / 拟合矩阵）
  site/data/books.json         2048 本书目
  site/data/lex/<a-z>.json     全库按首字母的精简词条（浏览 / 搜索用）
  site/data/deck/<id>.json     词单的词 id 有序表
  site/data/dw/<id>/<b>.json   词单分块的完整词数据（学习用，按需加载）

设计要点：手机上首屏只下载 meta + 一个词单 id 表（几十 KB），
学哪个词单才拉哪个词单的分块，浏览哪个字母才拉哪个字母片。
"""
import json, os, shutil, sqlite3, sys, time, hashlib

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.environ.get("MOMO_DB") or os.path.join(BASE, "data", "momo.db")
WEB = os.path.join(BASE, "web")
SITE = os.path.join(BASE, "site")
OUT = os.path.join(SITE, "data")

BLOCK = 800          # 每个词单分块包含的词数
TR_LEX = 120         # lex 片里释义截断长度
TR_FULL = 220        # 分块里释义截断长度
DF_FULL = 200        # 英文释义截断长度

TAG_NAMES = {1: "人名", 2: "地名", 3: "国家地区", 4: "词组短语", 5: "缩写符号",
             6: "基础词汇", 7: "常用表达", 8: "一般词汇", 9: "专有名词",
             10: "学术搭配", 11: "拓展词"}

FVI = {1: 1, 2: 3, 3: 5, 4: 7, 5: 15, 6: 30, 7: 60, 8: 90, 9: 180, 10: 360, 100: 36500}
DVI = {1: -3, 2: -4, 3: -5, 4: -6, 5: -7, 6: -8, 7: -9, 8: -10, 9: -11, 10: -12}


def log(*a):
    print(*a, flush=True)


def jdump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    return os.path.getsize(path)


def cut(s, n):
    s = (s or "").strip()
    return s if len(s) <= n else s[:n] + "…"


def kb(n):
    return "%.0fKB" % (n / 1024) if n < 1024 * 1024 else "%.1fMB" % (n / 1048576)


def safe(s):
    return str(s).replace(":", "_")


def main():
    if not os.path.exists(DB):
        log("!! 缺少 " + DB + "，请先运行 build_db.py")
        return 1
    t0 = time.time()
    if os.path.isdir(SITE):
        # 保留 site/.git：发布分支的历史不被重建冲掉
        for name in os.listdir(SITE):
            if name == ".git":
                continue
            p = os.path.join(SITE, name)
            if os.path.isdir(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
    os.makedirs(OUT, exist_ok=True)

    con = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
    con.row_factory = sqlite3.Row

    # ---------- 1. 词库：按首字母分片 ----------
    lex_total = x_total = 0
    # 词条标签 / 所属词单，先读进来供分片与分块共用
    tagmap = {}
    for r in con.execute("select voc_id,tag from word_tags"):
        tagmap.setdefault(r["voc_id"], []).append(r["tag"])
    deckmap = {}
    for r in con.execute("select voc_id,deck_id from deck_words"):
        deckmap.setdefault(r["voc_id"], []).append(r["deck_id"])

    letter_count = {}
    buckets = {}
    for r in con.execute("select id,spelling,phonetic,translation,pos,frq,collins,oxford,tags,"
                         "definition,exchange,related from words"):
        sp = r["spelling"] or ""
        vid = r["id"]
        L = sp[:1].lower() if sp[:1].isalpha() else "_"
        if not sp[:1].isascii():
            L = "_"
        base = [vid, sp, r["phonetic"] or "", cut(r["translation"], TR_LEX),
                r["pos"] or "", r["frq"] or 0, r["collins"] or 0,
                r["oxford"] or 0, r["tags"] or ""]
        ext = [vid, cut(r["definition"], DF_FULL), r["exchange"] or "",
               cut(r["related"], 160), tagmap.get(vid, [])[:6], deckmap.get(vid, [])[:4]]
        buckets.setdefault(L, []).append((base, ext))
    for L in sorted(buckets):
        pairs = buckets[L]
        pairs.sort(key=lambda p: p[0][1].lower())
        letter_count[L] = len(pairs)
        lex_total += jdump(os.path.join(OUT, "lex", L + ".json"), [p[0] for p in pairs])
        x_total += jdump(os.path.join(OUT, "x", L + ".json"), [p[1] for p in pairs])
    total_words = sum(letter_count.values())
    # id → 字母片 反查索引（详情弹层按 id 找词用），ids 升序便于二分
    letters = sorted(buckets)
    lpos = {L: i for i, L in enumerate(letters)}
    idx = []
    for L in letters:
        for p in buckets[L]:
            idx.append((p[0][0], L))
    idx.sort()
    bsz = jdump(os.path.join(OUT, "bkt.json"),
                dict(letters=letters, ids=[a for a, _ in idx], b=[lpos[b] for _, b in idx]))
    log("[lex]  %d 词 → %d 个首字母分片 %s，扩展片 %s，反查索引 %s"
        % (total_words, len(buckets), kb(lex_total), kb(x_total), kb(bsz)))

    # ---------- 2. 词单：id 表 + 分块词数据 ----------
    wmap = {}
    for r in con.execute("select id,spelling,phonetic,translation,pos,collins,oxford,frq from words"):
        wmap[r["id"]] = r
    log("[load] 词表 %d 条入内存" % len(wmap))

    decks = []
    dw_total = 0
    for d in con.execute("select * from decks order by kind desc, total desc"):
        did = d["id"]
        ids = [r[0] for r in con.execute(
            "select voc_id from deck_words where deck_id=? order by ord", (did,))]
        if not ids:
            continue
        nblocks = (len(ids) + BLOCK - 1) // BLOCK
        dw_total += jdump(os.path.join(OUT, "deck", safe(did) + ".json"),
                          dict(id=did, ids=ids, block=BLOCK, blocks=nblocks))
        for b in range(nblocks):
            part = ids[b * BLOCK:(b + 1) * BLOCK]
            rows = []
            for vid in part:
                w = wmap.get(vid)
                if not w:
                    continue
                rows.append([
                    vid, w["spelling"] or "", w["phonetic"] or "",
                    cut(w["translation"], TR_FULL), w["pos"] or "",
                    w["collins"] or 0, w["oxford"] or 0, w["frq"] or 0,
                ])
            dw_total += jdump(os.path.join(OUT, "dw", safe(did), str(b) + ".json"), rows)
        decks.append(dict(id=did, name=d["name"], kind=d["kind"],
                          note=d["note"] or "", count=len(ids)))
        log("       词单 %-16s %6d 词 / %2d 块" % (did, len(ids), nblocks))
    log("[deck] %d 个词单，id 表 + 分块共 %s" % (len(decks), kb(dw_total)))

    # ---------- 3. 书目 ----------
    books = []
    loaded = {r[0] for r in con.execute("select distinct book_id from book_words")}
    for r in con.execute("select id,name,voc_count,author,publisher,isbn,version "
                         "from books order by voc_count desc"):
        books.append([r["id"], r["name"], r["voc_count"] or 0, r["author"] or "",
                      r["publisher"] or "", r["isbn"] or "", r["version"] or "",
                      1 if r["id"] in loaded else 0])
    bsz = jdump(os.path.join(OUT, "books.json"), books)
    log("[book] %d 本（%d 本含词表），%s" % (len(books), len(loaded), kb(bsz)))

    # ---------- 4. 算法参数 ----------
    meta = dict(con.execute("select k,v from meta").fetchall())
    matrix = json.loads(meta.get("matrix", "{}") or "{}")
    algo = dict(fvi=FVI, dvi=DVI, matrix=matrix,
                settings=json.loads(meta.get("settings", "{}") or "{}"),
                tag_names=TAG_NAMES)
    jdump(os.path.join(OUT, "algo.json"), algo)

    # ---------- 4.5 学习进度种子：手机首次打开继承真实进度 ----------
    seed_rev = []
    for r in con.execute("select voc_id,fm,difficulty,last_interval,next_date,last_response,"
                         "review_count,wrong_count,first_study,last_study,starred,blocked "
                         "from reviews"):
        seed_rev.append([r["voc_id"], r["fm"], r["difficulty"], r["last_interval"],
                         r["next_date"] or "", r["last_response"] or 0,
                         r["review_count"] or 0, r["wrong_count"] or 0,
                         r["first_study"] or "", r["last_study"] or "",
                         r["starred"] or 0, r["blocked"] or 0])
    seed_day = []
    for r in con.execute("select date,new_cnt,review_cnt,total_cnt,correct,wrong,seconds,"
                         "well,familiar,uncertain,forget from daily order by date"):
        seed_day.append([r["date"], r["new_cnt"] or 0, r["review_cnt"] or 0, r["total_cnt"] or 0,
                         r["correct"] or 0, r["wrong"] or 0, r["seconds"] or 0,
                         r["well"] or 0, r["familiar"] or 0, r["uncertain"] or 0,
                         r["forget"] or 0])
    seed_sz = jdump(os.path.join(OUT, "seed.json"),
                    dict(reviews=seed_rev, daily=seed_day, built_at=meta.get("built_at", "")))
    log("[seed] %d 条进度 / %d 个学习日，%s" % (len(seed_rev), len(seed_day), kb(seed_sz)))

    # ---------- 5. 全局 meta ----------
    meta_sz = jdump(os.path.join(OUT, "meta.json"), dict(
        total_words=total_words,
        letters=letter_count,
        decks=decks,
        loaded_books=len(loaded),
        built_at=meta.get("built_at", ""),
        block=BLOCK,
    ))
    log("[meta] %s" % kb(meta_sz))

    # ---------- 6. 组装站点 ----------
    # 缓存名由「外壳文件内容」决定：内容一变版本就变，手机 SW 才会换上新的 app.js。
    # 只按小时取时间戳会漏更新——同一小时内多次导出拿到的是同一个缓存名。
    h = hashlib.md5()
    for f in ("index.html", "app.js", "store.js", "style.css", "manifest.webmanifest"):
        p = os.path.join(WEB, f)
        if os.path.exists(p):
            with open(p, "rb") as fh:
                h.update(fh.read())
    ver = time.strftime("%Y%m%d%H") + "-" + h.hexdigest()[:8]
    sw_src = os.path.join(WEB, "sw.js")
    if os.path.exists(sw_src):
        with open(sw_src, encoding="utf-8") as f:
            sw = f.read()
        with open(os.path.join(SITE, "sw.js"), "w", encoding="utf-8", newline="") as f:
            f.write(sw.replace("__VER__", ver))

    html_src = os.path.join(WEB, "index.html")
    if os.path.exists(html_src):
        with open(html_src, encoding="utf-8") as f:
            html = f.read()
        head = ('<meta name="theme-color" content="#f7f5f0">\n'
                '<link rel="manifest" href="manifest.webmanifest">\n'
                '<meta name="apple-mobile-web-app-capable" content="yes">\n'
                '<meta name="apple-mobile-web-app-status-bar-style" content="default">\n'
                '<meta name="apple-mobile-web-app-title" content="墨墨单词">\n'
                '<link rel="apple-touch-icon" href="icon-192.png">\n'
                '<script src="store.js"></script>\n')
        tail = ('<script>if("serviceWorker" in navigator){addEventListener("load",function(){'
                'navigator.serviceWorker.register("sw.js").catch(function(){})});}</script>\n')
        html = html.replace("</head>", head + "</head>").replace("</body>", tail + "</body>")
        with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8", newline="") as f:
            f.write(html)

    for f in ("style.css", "app.js", "store.js", "manifest.webmanifest",
              "icon-192.png", "icon-512.png", "icon-mask.png"):
        src = os.path.join(WEB, f)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(SITE, f))
    log("[site] → " + SITE + "  (sw 版本 " + ver + ")")
    log("完成，用时 %.1fs" % (time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
