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
import json, os, shutil, sqlite3, sys, time

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
        shutil.rmtree(SITE)
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
    log("[lex]  %d 词 → %d 个首字母分片 %s，扩展片 %s"
        % (total_words, len(buckets), kb(lex_total), kb(x_total)))

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
        decks.append(dict(id=did, name=d["name"], kind=d["kind"], count=len(ids)))
        log("       词单 %-16s %6d 词 / %2d 块" % (did, len(ids), nblocks))
    log("[deck] %d 个词单，id 表 + 分块共 %s" % (len(decks), kb(dw_total)))

    # ---------- 3. 书目 ----------
    books = []
    loaded = {r[0] for r in con.execute("select distinct book_id from book_words")}
    for r in con.execute("select id,name,voc_count,author,publisher from books order by voc_count desc"):
        books.append([r["id"], r["name"], r["voc_count"] or 0, r["author"] or "",
                      r["publisher"] or "", 1 if r["id"] in loaded else 0])
    bsz = jdump(os.path.join(OUT, "books.json"), books)
    log("[book] %d 本（%d 本含词表），%s" % (len(books), len(loaded), kb(bsz)))

    # ---------- 4. 算法参数 ----------
    meta = dict(con.execute("select k,v from meta").fetchall())
    matrix = json.loads(meta.get("matrix", "{}") or "{}")
    algo = dict(fvi=FVI, dvi=DVI, matrix=matrix,
                settings=json.loads(meta.get("settings", "{}") or "{}"),
                tag_names=TAG_NAMES)
    jdump(os.path.join(OUT, "algo.json"), algo)

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

    # ---------- 6. 复制 web 资源 ----------
    for f in ("index.html", "style.css", "app.js", "store.js", "sw.js",
              "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-mask.png"):
        src = os.path.join(WEB, f)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(SITE, f))
    log("[site] → " + SITE)
    log("完成，用时 %.1fs" % (time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
