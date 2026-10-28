#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_db.py — 把墨墨离线数据包 + ECDICT 合成一个可查询的 SQLite 学习库
数据源（三项都可用环境变量覆盖，默认取项目上一级目录）：
  <root>/dataset/*.csv            墨墨 v5.6.10 静态包
  <root>/appdata/momo.v425.db     运行库（真实学习记录，可选）
  <root>/ecdict/ecdict.csv        ECDICT 开源词典（释义/音标/词频）
输出：
  data/momo.db

环境变量：MOMO_DATASET / MOMO_RUNTIME / MOMO_ECDICT / MOMO_DB
"""
import csv, json, os, sqlite3, sys, time, re

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)


def _pick(env_key, *candidates):
    """环境变量优先；否则依次探测候选路径，命中第一个真实存在的。"""
    v = os.environ.get(env_key)
    if v:
        return v
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]


# 仓库内 ./sources/ 优先，其次是项目外部（本机原始布局）
DATASET = _pick("MOMO_DATASET",
                os.path.join(BASE, "sources", "dataset"),
                os.path.join(ROOT, "dataset"))
RUNTIME = _pick("MOMO_RUNTIME",
                os.path.join(BASE, "sources", "momo.v425.db"),
                os.path.join(ROOT, "appdata", "momo.v425.db"))
ECDICT = _pick("MOMO_ECDICT",
               os.path.join(BASE, "sources", "ecdict.csv"),
               os.path.join(ROOT, "ecdict", "ecdict.csv"))
OUT = os.environ.get("MOMO_DB") or os.path.join(BASE, "data", "momo.db")

TAGS = {1: "人名", 2: "地名", 3: "国家地区", 4: "词组短语", 5: "缩写符号",
        6: "基础词汇", 7: "常用表达", 8: "一般词汇", 9: "专有名词", 10: "学术搭配", 11: "拓展词"}

EXAMS = [
    ("cet4", "大学英语四级", "cet4"),
    ("cet6", "大学英语六级", "cet6"),
    ("ky",   "考研英语",     "ky"),
    ("toefl", "托福 TOEFL",  "toefl"),
    ("ielts", "雅思 IELTS",  "ielts"),
    ("gre",  "GRE",          "gre"),
]


def log(*a):
    print(*a, flush=True)


def clean(s):
    return (s or "").strip()


def iso_day(s):
    """'20261124000000' → '2026-11-24'；空值 / 全零 → ''"""
    s = (s or "").strip()[:8]
    if len(s) == 8 and s.isdigit() and s[:4] != "0000":
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return ""


def _median(xs):
    xs = sorted(xs)
    n = len(xs)
    if not n:
        return None
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def fit_matrix():
    """用真实复习记录拟合：log(间隔) ≈ a[fm] + b[difficulty]
    base[fm] = exp(a)，ratio[d] = exp(b - 中位)，两者相乘即预测间隔。"""
    if not os.path.exists(RUNTIME):
        return None
    con = sqlite3.connect("file:%s?mode=ro" % RUNTIME, uri=True)
    rows = con.execute("select lsr_fm, lsr_last_difficulty, lsr_last_real_interval, lsr_last_interval "
                       "from LSR_TB where lsr_fm between 1 and 10 and lsr_is_new=0").fetchall()
    import math
    recs, by_fm = [], {}
    for fm, d, ri, li in rows:
        iv = ri if ri and ri > 0 else (li or 0)
        if iv and iv > 0:
            d = max(1, min(10, d or 5))
            recs.append((fm, d, math.log(iv)))
            by_fm.setdefault(fm, []).append(math.log(iv))
    if len(known := {fm: _median(v) for fm, v in by_fm.items() if len(v) >= 8}) < 2:
        return None

    # a[fm]：按 fm 的中位数，缺失值做几何插值 / 外推
    fms = sorted(known)
    a = {}
    for fm in range(1, 11):
        if fm in known:
            a[fm] = known[fm]
            continue
        prev = [f for f in fms if f < fm]
        nxt = [f for f in fms if f > fm]
        if prev and nxt:
            x, y = prev[-1], nxt[0]
            a[fm] = known[x] + (known[y] - known[x]) * (fm - x) / (y - x)
        elif prev:
            a[fm] = known[prev[-1]] + (fm - prev[-1]) * 0.37
        else:
            a[fm] = known[nxt[0]] - (nxt[0] - fm) * 0.37
    for fm in range(2, 11):
        a[fm] = max(a[fm], a[fm - 1] + 0.06)
    # 平滑 + 限速：原始中位数在不同算法版本间有断层，压掉不合理的跳变
    sm = dict(a)
    for fm in range(2, 10):
        sm[fm] = 0.25 * a[fm - 1] + 0.5 * a[fm] + 0.25 * a[fm + 1]
    a = sm
    for fm in range(2, 11):
        a[fm] = min(max(a[fm], a[fm - 1] + 0.06), a[fm - 1] + 0.916)

    # b[d]：残差的中位数，强制随难度单调递减
    b = {}
    for d in range(1, 11):
        res = [lv - a[fm] for fm, dd, lv in recs if dd == d]
        b[d] = _median(res) if res else 0.0
    for d in range(2, 11):
        b[d] = min(b[d], b[d - 1] - 0.02)
    mid = b[5]
    base = {fm: math.exp(a[fm] + mid) for fm in a}
    ratio = {d: math.exp(b[d] - mid) for d in b}
    ratio = {d: max(0.25, min(2.2, v)) for d, v in ratio.items()}
    return {"base": {str(k): round(v, 1) for k, v in base.items()},
            "ratio": {str(k): round(v, 4) for k, v in ratio.items()},
            "n": len(recs)}


def build():
    if os.path.exists(OUT):
        os.remove(OUT)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    db = sqlite3.connect(OUT)
    c = db.cursor()
    c.executescript("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE words(
      id INTEGER PRIMARY KEY, spelling TEXT NOT NULL, phonetic TEXT, phonetic_us TEXT,
      translation TEXT, definition TEXT, pos TEXT, exchange TEXT,
      collins INTEGER DEFAULT 0, oxford INTEGER DEFAULT 0, bnc INTEGER DEFAULT 0, frq INTEGER DEFAULT 0,
      tags TEXT, mm_freq REAL DEFAULT 0, mm_diff REAL DEFAULT 0, ack REAL DEFAULT 0,
      related TEXT, src TEXT
    );
    CREATE TABLE books(id INTEGER PRIMARY KEY, name TEXT, voc_count INT, author TEXT,
      publisher TEXT, isbn TEXT, version TEXT, hidden INT DEFAULT 0);
    CREATE TABLE chapters(id INTEGER PRIMARY KEY, book_id INT, title TEXT, ord INT);
    CREATE TABLE book_words(book_id INT, voc_id INT, chapter_id INT, ord REAL);
    CREATE TABLE word_tags(tag INT, voc_id INT);
    CREATE TABLE decks(id TEXT PRIMARY KEY, name TEXT, kind TEXT, note TEXT, total INT DEFAULT 0);
    CREATE TABLE deck_words(deck_id TEXT, voc_id INT, ord INT);
    CREATE TABLE reviews(voc_id INTEGER PRIMARY KEY, fm INT DEFAULT 1, difficulty INT DEFAULT 5,
      last_interval INT DEFAULT 0, next_date TEXT, last_response INT DEFAULT 0,
      review_count INT DEFAULT 0, wrong_count INT DEFAULT 0, first_study TEXT, last_study TEXT,
      starred INT DEFAULT 0, blocked INT DEFAULT 0, source TEXT DEFAULT 'local');
    CREATE TABLE daily(date TEXT PRIMARY KEY, new_cnt INT DEFAULT 0, review_cnt INT DEFAULT 0,
      total_cnt INT DEFAULT 0, correct INT DEFAULT 0, wrong INT DEFAULT 0, seconds INT DEFAULT 0,
      source TEXT, well INT DEFAULT 0, familiar INT DEFAULT 0, uncertain INT DEFAULT 0,
      forget INT DEFAULT 0);
    CREATE TABLE day_words(date TEXT, voc_id INT, kind TEXT, PRIMARY KEY(date, voc_id));
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
    """)

    # ---------- 1. ECDICT ----------
    dict_rows = {}
    if os.path.exists(ECDICT):
        t0 = time.time()
        with open(ECDICT, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                w = (r.get("word") or "").strip()
                if not w or len(w) > 60:
                    continue
                dict_rows[w.lower()] = r
        log(f"[ECDICT] {len(dict_rows)} 条  用时 {time.time()-t0:.1f}s")
    else:
        log("[ECDICT] 缺失，释义将留空")

    # ---------- 2. 墨墨词汇 ----------
    words = []
    with open(os.path.join(DATASET, "words.csv"), encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            wid = int(r["origin_id"])
            sp = clean(r["spelling"])
            if sp:
                words.append((wid, sp))
    log(f"[words] {len(words)}")

    # 运行库里补充的词条元数据（音标 / 词频 / 难度 / 变形）
    mm_meta = {}
    if os.path.exists(RUNTIME):
        con = sqlite3.connect("file:%s?mode=ro" % RUNTIME, uri=True)
        for row in con.execute("select origin_id,phonetic_uk,phonetic_us,frequency,difficulty_bm,"
                               "acknowledge_rate,related_words from VOC_TB where frequency>0 or phonetic_uk<>''"):
            mm_meta[row[0]] = row
        log(f"[VOC_TB] 有元数据 {len(mm_meta)} 条")

    def lookup_one(w):
        w = w.lower().strip()
        d = dict_rows.get(w)
        if d:
            return d
        # 变体尝试：去掉 ... / sth. / sb. 占位与冠词
        t = re.sub(r"\.{2,}", " ", w)
        t = re.sub(r"\b(sth|sb|oneself)\b\.?", " ", t)
        t = re.sub(r"\b(to|be|a|an|the)\b", " ", t)
        t = re.sub(r"[^\w\-' ]", " ", t)
        t = re.sub(r"\s+", " ", t).strip()
        if t and t != w:
            d = dict_rows.get(t)
            if d:
                return d
        return None

    def first_sense(d, limit=26):
        t = clean(d.get("translation") or "")
        t = t.replace("\\n", "\n").split("\n")[0]
        t = re.split(r"[；;]", t)[0].strip()
        return t[:limit]

    def compose(sp):
        """短语：用组成词的释义拼一个可读的解释"""
        toks = [x for x in re.split(r"[^\w\-']+", sp.lower()) if x and x not in ("to", "a", "an", "the", "sth", "sb", "one")]
        if len(toks) < 2:
            return ""
        parts, hit = [], 0
        for t in toks:
            d = dict_rows.get(t)
            if d and clean(d.get("translation")):
                hit += 1
                parts.append(f"{t} {first_sense(d, 18)}")
        if hit / len(toks) < 0.6:
            return ""
        return " · ".join(parts)

    rows, covered, comp = [], 0, 0
    for wid, sp in words:
        d = lookup_one(sp)
        mm = mm_meta.get(wid)
        phonetic = phonetic_us = ""
        if mm:
            phonetic, phonetic_us = clean(mm[1]), clean(mm[2])
        if d:
            covered += 1
            if not phonetic:
                phonetic = clean(d.get("phonetic"))
                if phonetic and not phonetic.startswith("/"):
                    phonetic = "/%s/" % phonetic
                phonetic_us = phonetic
        trans = clean(d.get("translation")) if d else ""
        trans = trans.replace("\\n", "\n")
        src = "ecdict" if trans else ""
        if not trans and " " in sp:
            trans = compose(sp)
            if trans:
                comp += 1
                src = "compose"
        defi = clean(d.get("definition")) if d else ""
        defi = defi.replace("\\n", "\n")
        rows.append((
            wid, sp, phonetic, phonetic_us, trans, defi,
            clean(d.get("pos")) if d else "", clean(d.get("exchange")) if d else "",
            int(clean(d.get("collins")) or 0) if d and clean(d.get("collins")).isdigit() else 0,
            int(clean(d.get("oxford")) or 0) if d and clean(d.get("oxford")).isdigit() else 0,
            int(clean(d.get("bnc")) or 0) if d and clean(d.get("bnc")).isdigit() else 0,
            int(clean(d.get("frq")) or 0) if d and clean(d.get("frq")).isdigit() else 0,
            clean(d.get("tag")) if d else "",
            mm[3] if mm else 0, mm[4] if mm else 0, mm[5] if mm else 0,
            clean(mm[6]) if mm else "", src,
        ))
    c.executemany("insert into words values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    have = covered + comp
    log(f"[words] 词典命中 {covered}（{covered/len(words)*100:.1f}%）· 短语组合释义 {comp}"
        f" · 合计有释义 {have}/{len(words)} = {have/len(words)*100:.1f}%")

    # ---------- 3. 词书 ----------
    books = []
    with open(os.path.join(DATASET, "books.csv"), encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            books.append((
                int(r["origin_id"]), clean(r["name"]), int(clean(r["voc_count"]) or 0),
                clean(r["author"]), clean(r["publisher"]), clean(r["isbn"]),
                clean(r["version"]), int(clean(r["hidden"]) or 0)))
    c.executemany("insert or replace into books values(?,?,?,?,?,?,?,?)", books)
    log(f"[books] {len(books)}")

    # ---------- 4. 词书词条 / 章节（仅运行库中已下载的那本） ----------
    deck_rows = []
    if os.path.exists(RUNTIME):
        con2 = sqlite3.connect("file:%s?mode=ro" % RUNTIME, uri=True)
        bw = con2.execute("select book_origin_id,voc_origin_id,chapter_origin_id,\"order\" from BK_VOC_TB").fetchall()
        c.executemany("insert into book_words values(?,?,?,?)", bw)
        chs = con2.execute("select id,book_origin_id,title from BK_CHAPTER_TB").fetchall()
        c.executemany("insert into chapters values(?,?,?,?)", [(a, b, t, i) for i, (a, b, t) in enumerate(chs)])
        log(f"[book_words] {len(bw)}  [chapters] {len(chs)}")

        if bw:
            bid = bw[0][0]
            bk = c.execute("select name from books where id=?", (bid,)).fetchone()
            dname = bk[0] if bk else "已加载词书"
            ordered = sorted(bw, key=lambda x: (x[3] or 0))
            c.execute("insert into decks values(?,?,?,?,?)",
                      (f"book:{bid}", dname, "book", "来自你的账号 · 词序与章节完整保留", len(ordered)))
            c.executemany("insert into deck_words values(?,?,?)",
                          [(f"book:{bid}", v[1], i) for i, v in enumerate(ordered)])
            deck_rows.append(f"book:{bid}")

    # ---------- 5. 标签 ----------
    tag_rows = []
    with open(os.path.join(DATASET, "tag_voc.csv"), encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            tag_rows.append((int(r["tag"]), int(r["voc_origin_id"])))
    c.executemany("insert into word_tags values(?,?)", tag_rows)
    log(f"[word_tags] {len(tag_rows)}")
    for t, name in TAGS.items():
        n = c.execute("select count(*) from word_tags where tag=?", (t,)).fetchone()[0]
        if n:
            c.execute("insert into decks values(?,?,?,?,?)",
                      (f"tag:{t}", f"词类 · {name}", "tag", "墨墨词类标签筛选", n))
            c.executemany("insert into deck_words values(?,?,?)",
                          [(f"tag:{t}", v, i) for i, (v,) in enumerate(
                              c.execute("select voc_id from word_tags where tag=? order by voc_id", (t,)))])
            deck_rows.append(f"tag:{t}")

    # ---------- 6. 考试词单（ECDICT 考试标签 ∩ 墨墨词库） ----------
    for did, name, key in EXAMS:
        vocab = c.execute("select id from words where tags like ? order by collins desc, frq desc",
                          (f"%{key}%",)).fetchall()
        if not vocab:
            continue
        c.execute("insert into decks values(?,?,?,?,?)",
                  (did, name, "exam", "ECDICT 考试词表 × 墨墨词库交集", len(vocab)))
        c.executemany("insert into deck_words values(?,?,?)",
                      [(did, v[0], i) for i, v in enumerate(vocab)])
        log(f"[deck] {name} {len(vocab)}")

    # ---------- 7. 词频分段 ----------
    for did, name, limit in [("f1000", "高频 · 前 1000", 1000), ("f3000", "高频 · 前 3000", 3000),
                             ("f5000", "高频 · 前 5000", 5000), ("f10000", "高频 · 前 10000", 10000)]:
        vocab = c.execute("select id from words where frq>0 and tags not like '%name%' "
                          "order by frq asc limit ?", (limit,)).fetchall()
        if not vocab:
            continue
        c.execute("insert into decks values(?,?,?,?,?)",
                  (did, name, "freq", "按 ECDICT 词频排序（越靠前越常用）", len(vocab)))
        c.executemany("insert into deck_words values(?,?,?)",
                      [(did, v[0], i) for i, v in enumerate(vocab)])

    # ---------- 8. 学习记录 ----------
    seeded = 0
    if os.path.exists(RUNTIME):
        con3 = sqlite3.connect("file:%s?mode=ro" % RUNTIME, uri=True)
        recs = []
        for r in con3.execute("""select lsr_voc_id, lsr_fm, lsr_last_difficulty, lsr_last_interval,
              lsr_next_study_date, lsr_last_response, lsr_first_study_date, lsr_last_study_date,
              lsr_blocked_code, lsr_is_new, lsr_last_real_interval from LSR_TB"""):
            vid, fm, diff, last_i, nxt, resp, fs, ls, blocked, isnew, real_i = r
            # fm=100 才是「斩」掉的词；blocked_code 只表示已排进当天 DSR 队列
            status = 1 if fm == 100 else 0
            nxt = iso_day(nxt)
            # fm=0 且没有任何作答：只是「已加入词书、还没开始学」，
            # 它的 first/last_study 是 App 写入的快照日，不能当成学习记录
            if not fm and not resp:
                fs = ls = ""
            recs.append((vid, fm or 1, diff or 5, real_i or last_i or 0, nxt, resp or 0,
                         0, 1 if resp in (3,) else 0, iso_day(fs), iso_day(ls), 0, status, "maimemo"))
        c.executemany("""insert or replace into reviews(voc_id,fm,difficulty,last_interval,next_date,
              last_response,review_count,wrong_count,first_study,last_study,starred,blocked,source)
              values(?,?,?,?,?,?,?,?,?,?,?,?,?)""", recs)
        seeded = sum(1 for r in recs if r[8])
        log(f"[reviews] 导入真实学习记录 {seeded}（另有 {len(recs)-seeded} 个已加入未学习）")

        hist = con3.execute("""select ssr_date, ssr_count_today_new, ssr_count_today_revision,
              ssr_count_today_total, ssr_today_study_time,
              ssr_count_today_well_familiar, ssr_count_today_familiar,
              ssr_count_today_uncertain, ssr_count_today_forget
              from SSR_TB where ssr_count_today_total>0 order by ssr_date""").fetchall()
        drows = []
        for d, new, rev, tot, sec, well, fam, unc, forg in hist:
            date = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
            well, fam, unc, forg = (x or 0 for x in (well, fam, unc, forg))
            drows.append((date, new or 0, rev or 0, tot or 0, well + fam, unc + forg,
                          sec or 0, "maimemo", well, fam, unc, forg))
        c.executemany("insert or ignore into daily values(?,?,?,?,?,?,?,?,?,?,?,?)", drows)
        log(f"[daily] 历史 {len(drows)} 天")

        # 历史答题分布（很熟悉 / 熟悉 / 模糊 / 忘记）
        h = con3.execute("select sum(ssr_count_today_well_familiar),sum(ssr_count_today_familiar),"
                         "sum(ssr_count_today_uncertain),sum(ssr_count_today_forget) from SSR_TB").fetchone()
        hist = [x or 0 for x in h]
        if sum(hist) > 0:
            c.execute("insert into meta values('resp_hist',?)",
                      (json.dumps(dict(well=hist[0], familiar=hist[1], uncertain=hist[2], forget=hist[3])),))
            log(f"[resp] 很熟悉 {hist[0]} · 熟悉 {hist[1]} · 模糊 {hist[2]} · 忘记 {hist[3]}")

    # ---------- 9. 用真实记录拟合「间隔矩阵」 ----------
    matrix = fit_matrix()
    if matrix:
        c.execute("insert into meta values('matrix',?)", (json.dumps(matrix, ensure_ascii=False),))
        log(f"[matrix] base={matrix['base']} ratio={ {k: round(v,2) for k,v in matrix['ratio'].items()} }")

    c.execute("insert into meta values('built_at',?)", (time.strftime("%Y-%m-%d %H:%M:%S"),))
    c.execute("insert into meta values('seeded',?)", (str(seeded),))
    c.execute("insert into meta values('settings',?)", (json.dumps(
        {"matrix": "calibrated", "new_limit": 10, "mode": "mixed"}, ensure_ascii=False),))
    c.executescript("""
    CREATE INDEX idx_dw ON deck_words(deck_id, ord);
    CREATE INDEX idx_wt ON word_tags(tag);
    CREATE INDEX idx_rv ON reviews(next_date);
    CREATE INDEX idx_sp ON words(spelling);
    CREATE INDEX idx_bw ON book_words(book_id);
    """)
    db.commit()
    db.execute("VACUUM")
    db.close()
    log(f"\n完成 → {OUT}  {os.path.getsize(OUT)/1e6:.1f} MB")


if __name__ == "__main__":
    build()
