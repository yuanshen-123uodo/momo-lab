#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py — 零依赖本地服务：SQLite + REST + 静态前端
启动：python server.py   →  http://127.0.0.1:8765
"""
import json, os, sqlite3, sys, threading, datetime, urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, "data", "momo.db")
WEB = os.path.join(BASE, "web")
PORT = int(os.environ.get("MOMO_PORT", 8899))

FVI = {1: 1, 2: 3, 3: 5, 4: 7, 5: 15, 6: 30, 7: 60, 8: 90, 9: 180, 10: 360, 100: 36500}
DVI = {1: -3, 2: -4, 3: -5, 4: -6, 5: -7, 6: -8, 7: -9, 8: -10, 9: -11, 10: -12}
TAG_NAMES = {1: "人名", 2: "地名", 3: "国家地区", 4: "词组短语", 5: "缩写符号",
             6: "基础词汇", 7: "常用表达", 8: "一般词汇", 9: "专有名词", 10: "学术搭配", 11: "拓展词"}

_local = threading.local()


def conn():
    if not hasattr(_local, "c"):
        _local.c = sqlite3.connect(DB, timeout=20)
        _local.c.row_factory = sqlite3.Row
        _local.c.execute("PRAGMA journal_mode=WAL")
    return _local.c


def today():
    return datetime.date.today().isoformat()


def meta_get(k, default=None):
    r = conn().execute("select v from meta where k=?", (k,)).fetchone()
    return r[0] if r else default


def meta_set(k, v):
    c = conn()
    c.execute("insert or replace into meta values(?,?)", (k, str(v)))
    c.commit()


# ---------------- 调度算法 ----------------
def load_matrix():
    raw = meta_get("matrix")
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            pass
    return None


def schedule(fm, difficulty, response, has_history=True, matrix_mode="calibrated"):
    """response: 1=认识 2=模糊 3=忘记 4=太简单/斩"""
    fm = fm or 1
    difficulty = difficulty or 5
    if response == 4:
        return dict(fm=100, difficulty=difficulty, interval=36500, mastered=True)
    if response == 1:
        fm = min(fm + 1, 10)
        difficulty = max(1, difficulty - 1)
    elif response == 3:
        fm = max(fm - 1, 1)
        difficulty = min(10, difficulty + 1)
    # response==2 模糊：因子与难度都不动

    if matrix_mode == "calibrated":
        m = load_matrix()
        if m:
            base = m["base"].get(str(fm)) or FVI.get(fm, 1)
            ratio = m["ratio"].get(str(difficulty), 1.0)
            iv = base * ratio
        else:
            iv = FVI.get(fm, 1)
    else:
        iv = FVI.get(fm, 1) + (DVI.get(difficulty, -7) if has_history else 0)
    if not has_history:          # 生词首答不叠加难度惩罚
        iv = FVI.get(fm, 1)
    return dict(fm=fm, difficulty=difficulty, interval=max(1, int(round(iv))), mastered=False)


# ---------------- 业务 ----------------
def overview():
    c = conn()
    t = today()
    due = c.execute("select count(*) from reviews where blocked=0 and next_date<=? and next_date<>''", (t,)).fetchone()[0]
    total = c.execute("select count(*) from words").fetchone()[0]
    studied = c.execute("select count(*) from reviews where first_study<>'' or review_count>0").fetchone()[0]
    mastered = c.execute("select count(*) from reviews where fm>=100").fetchone()[0]
    learning = c.execute("select count(*) from reviews where fm<100").fetchone()[0]
    days = c.execute("select count(*) from daily").fetchone()[0]
    done_today = c.execute("select count(*) from reviews where last_study=?", (t,)).fetchone()[0]
    # 连续打卡
    rows = [r[0] for r in c.execute("select date from daily where total_cnt>0 order by date desc")]
    streak = 0
    d = datetime.date.today()
    rs = set(rows)
    while True:
        if d.isoformat() in rs:
            streak += 1
            d -= datetime.timedelta(days=1)
        elif d == datetime.date.today():
            d -= datetime.timedelta(days=1)
        else:
            break
    book = c.execute("select b.id,b.name,b.voc_count from books b join deck_words dw on dw.deck_id='book:'||b.id group by b.id").fetchone()
    bookinfo = None
    if book:
        n = c.execute("select count(*) from book_words where book_id=?", (book[0],)).fetchone()[0]
        ok = c.execute("select count(*) from book_words bw join reviews r on r.voc_id=bw.voc_id where bw.book_id=?", (book[0],)).fetchone()[0]
        bookinfo = dict(id="book:%s" % book[0], name=book[1], total=n, started=ok)
    today_row = c.execute("select new_cnt,review_cnt,total_cnt,seconds from daily where date=?", (t,)).fetchone()
    return dict(
        due=due, total_words=total, studied=studied, mastered=mastered, learning=learning,
        days=days, streak=streak, done_today=done_today, book=bookinfo,
        settings=json.loads(meta_get("settings", "{}") or "{}"),
        today=dict(today_row) if today_row else dict(new_cnt=0, review_cnt=0, total_cnt=0, seconds=0),
    )


def decks():
    c = conn()
    out = []
    for r in c.execute("select id,name,kind,note,total from decks order by case kind when 'book' then 0 when 'freq' then 1 when 'exam' then 2 else 3 end, total desc"):
        n = c.execute("select count(*) from deck_words dw join reviews r on r.voc_id=dw.voc_id "
                      "where dw.deck_id=?", (r[0],)).fetchone()[0]
        out.append(dict(id=r[0], name=r[1], kind=r[2], note=r[3], total=r[4], started=n))
    return out


def word_row(r, rev=None):
    d = dict(id=r["id"], w=r["spelling"], ph=r["phonetic"], phus=r["phonetic_us"],
             tr=r["translation"], df=r["definition"], pos=r["pos"], ex=r["exchange"],
             col=r["collins"], ox=r["oxford"], frq=r["frq"], tags=r["tags"], rel=r["related"])
    if rev:
        d["st"] = dict(fm=rev["fm"], diff=rev["difficulty"], next=rev["next_date"],
                       iv=rev["last_interval"], resp=rev["last_response"],
                       cnt=rev["review_count"], wrong=rev["wrong_count"],
                       starred=rev["starred"], blocked=rev["blocked"])
    return d


def queue(deck, mode, limit):
    c = conn()
    t = today()
    limit = max(1, min(int(limit or 20), 200))
    where_deck, params = "", []
    if deck and deck != "all":
        where_deck = " and w.id in (select voc_id from deck_words where deck_id=?)"
        params.append(deck)
    cols = ("w.*, r.fm, r.difficulty, r.next_date, r.last_interval, r.last_response, "
            "r.review_count, r.wrong_count, r.starred, r.blocked")

    def pack(r, m):
        rev = r if ("fm" in r.keys() and r["fm"] is not None) else None
        return dict(word_row(r, rev), mode=m)

    out = []
    if mode in ("review", "mixed"):
        for r in c.execute(
            "select " + cols + " from words w join reviews r on r.voc_id=w.id "
            "where r.blocked=0 and r.next_date<>'' and r.next_date<=?" + where_deck +
                " order by r.next_date limit ?", [t] + params + [limit]):
            out.append(pack(r, "review"))
    if mode in ("new", "mixed") and len(out) < limit:
        need = limit - len(out)
        if deck and deck != "all":
            rows = c.execute(
                "select " + cols + " from words w left join reviews r on r.voc_id=w.id "
                "where w.id in (select voc_id from deck_words where deck_id=?) and r.voc_id is null "
                "order by (select ord from deck_words where deck_id=? and voc_id=w.id) limit ?",
                (deck, deck, need)).fetchall()
        else:
            rows = c.execute(
                "select " + cols + " from words w left join reviews r on r.voc_id=w.id "
                "where r.voc_id is null and w.frq>0 order by w.frq limit ?", (need,)).fetchall()
        for r in rows:
            out.append(pack(r, "new"))
    return out


def answer(body):
    c = conn()
    vid = int(body["voc_id"])
    resp = int(body["response"])
    elapsed = int(body.get("elapsed") or 0)
    r = c.execute("select * from reviews where voc_id=?", (vid,)).fetchone()
    # 从墨墨导入的记录 review_count 为 0，但确实学过——有首次学习日期就算有历史
    has_hist = bool(r) and (r["review_count"] > 0 or (r["first_study"] or "") != "")
    fm = r["fm"] if r else 1
    diff = r["difficulty"] if r else 5
    settings = json.loads(meta_get("settings", "{}") or "{}")
    res = schedule(fm, diff, resp, has_hist, settings.get("matrix", "calibrated"))
    t = today()
    nd = (datetime.date.today() + datetime.timedelta(days=res["interval"])).isoformat()
    if r:
        correct = 1 if resp in (1, 4) else 0
        c.execute("""update reviews set fm=?,difficulty=?,last_interval=?,next_date=?,last_response=?,
            review_count=review_count+1, wrong_count=wrong_count+?, last_study=?, blocked=? where voc_id=?""",
                  (res["fm"], res["difficulty"], res["interval"], nd, resp,
                   0 if correct else 1, t, 1 if res["mastered"] else 0, vid))
        first = r["first_study"]
    else:
        correct = 1 if resp in (1, 4) else 0
        c.execute("""insert into reviews(voc_id,fm,difficulty,last_interval,next_date,last_response,
            review_count,wrong_count,first_study,last_study,blocked,source)
            values(?,?,?,?,?,?,1,?,?,?,?,'local')""",
                  (vid, res["fm"], res["difficulty"], res["interval"], nd, resp,
                   0 if correct else 1, t, t, 1 if res["mastered"] else 0))
        first = t
    # 当日统计
    kinds = {4: "well", 1: "familiar", 2: "uncertain", 3: "forget"}
    slot = kinds.get(resp, "familiar")
    c.execute("""insert into daily(date,new_cnt,review_cnt,total_cnt,correct,wrong,seconds,source,
          well,familiar,uncertain,forget)
        values(?,?,?,?,?,?,?,'local',?,?,?,?)
        on conflict(date) do update set
          new_cnt=new_cnt+excluded.new_cnt, review_cnt=review_cnt+excluded.review_cnt,
          total_cnt=total_cnt+excluded.total_cnt, correct=correct+excluded.correct,
          wrong=wrong+excluded.wrong, seconds=seconds+excluded.seconds,
          well=well+excluded.well, familiar=familiar+excluded.familiar,
          uncertain=uncertain+excluded.uncertain, forget=forget+excluded.forget""",
              (t, 0 if has_hist else 1, 1 if has_hist else 0, 1, correct, 1 - correct, elapsed,
               1 if slot == "well" else 0, 1 if slot == "familiar" else 0,
               1 if slot == "uncertain" else 0, 1 if slot == "forget" else 0))
    c.execute("insert or replace into day_words(date,voc_id,kind) values(?,?,?)",
              (t, vid, "review" if has_hist else "new"))
    c.commit()
    return dict(fm=res["fm"], difficulty=res["difficulty"], interval=res["interval"],
                next_date=nd, mastered=res["mastered"], label=fmt_interval(res["interval"]))


def fmt_interval(d):
    if d >= 36500:
        return "不再复习"
    if d >= 365:
        return f"{d/365:.1f} 年后"
    if d >= 30:
        return f"{d/30:.1f} 个月后"
    return f"{d} 天后"


def word_detail(vid):
    c = conn()
    r = c.execute("select * from words where id=?", (vid,)).fetchone()
    if not r:
        return None
    rev = c.execute("select * from reviews where voc_id=?", (vid,)).fetchone()
    d = word_row(r, rev)
    d["tags_cn"] = [dict(tag=t[0], name=TAG_NAMES.get(t[0], "")) for t in c.execute(
        "select tag from word_tags where voc_id=? limit 8", (vid,))]
    d["decks"] = [x[0] for x in c.execute(
        "select d.name from deck_words dw join decks d on d.id=dw.deck_id where dw.voc_id=? limit 5", (vid,))]
    return d


def search(q, limit=40):
    c = conn()
    q = (q or "").strip()
    if not q:
        return []
    rows = c.execute("select w.*, r.fm, r.difficulty, r.next_date, r.last_interval, r.last_response,"
                     " r.review_count, r.wrong_count, r.starred, r.blocked from words w "
                     "left join reviews r on r.voc_id=w.id where w.spelling like ? "
                     "order by length(w.spelling), w.frq limit ?", (q + "%", limit)).fetchall()
    if len(rows) < 5:
        rows += c.execute("select w.*, r.fm, r.difficulty, r.next_date, r.last_interval, r.last_response,"
                          " r.review_count, r.wrong_count, r.starred, r.blocked from words w "
                          "left join reviews r on r.voc_id=w.id where w.spelling like ? "
                          "order by length(w.spelling), w.frq limit ?", ("%" + q + "%", limit)).fetchall()
    seen, out = set(), []
    for r in rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        out.append(word_row(r, r))
    return out[:limit]


def browse(letter, sort, page, q):
    c = conn()
    page = max(0, int(page or 0))
    size = 60
    where, params = [], []
    if letter and letter != "all":
        where.append("w.spelling like ?")
        params.append(letter.lower() + "%")
    if q:
        where.append("w.spelling like ?")
        params.append("%" + q + "%")
    w = (" where " + " and ".join(where)) if where else ""
    order = {"alpha": "case when w.spelling glob '[A-Za-z]*' then 0 else 1 end, w.spelling",
             "frq": "case when w.frq=0 then 1 else 0 end, w.frq",
             "len": "length(w.spelling)"}.get(sort, "w.spelling")
    total = c.execute("select count(*) from words w" + w, params).fetchone()[0]
    rows = c.execute("select w.*, r.fm, r.difficulty, r.next_date, r.last_interval, r.last_response,"
                     " r.review_count, r.wrong_count, r.starred, r.blocked from words w "
                     "left join reviews r on r.voc_id=w.id" + w +
                     " order by " + order + " limit ? offset ?",
                     params + [size, page * size]).fetchall()
    return dict(total=total, page=page, size=size,
                items=[word_row(r, r if r["fm"] is not None else None) for r in rows])


def stats():
    c = conn()
    days = [dict(r) for r in c.execute(
        "select date,new_cnt,review_cnt,total_cnt,correct,wrong,seconds,"
        "well,familiar,uncertain,forget from daily order by date")]
    active = [d for d in days if (d["total_cnt"] or 0) > 0]
    tot = dict(new=0, review=0, total=0, seconds=0, well=0, familiar=0, uncertain=0, forget=0)
    keymap = dict(new="new_cnt", review="review_cnt", total="total_cnt")
    for d in active:
        for k in tot:
            tot[k] += d.get(keymap.get(k, k)) or 0
    first = active[0]["date"] if active else None
    last = active[-1]["date"] if active else None
    span = 0
    if first and last:
        span = (datetime.date.fromisoformat(last) - datetime.date.fromisoformat(first)).days + 1

    def _streaks(dates):
        s = sorted(set(dates))
        if not s:
            return 0, 0
        best = run = 1
        for a, b in zip(s, s[1:]):
            d1, d2 = datetime.date.fromisoformat(a), datetime.date.fromisoformat(b)
            run = run + 1 if (d2 - d1).days == 1 else 1
            best = max(best, run)
        # 当前连续：从今天或昨天往回数
        cur, d = 0, datetime.date.today()
        ss = set(s)
        if d.isoformat() not in ss:
            d -= datetime.timedelta(days=1)
        while d.isoformat() in ss:
            cur += 1
            d -= datetime.timedelta(days=1)
        return cur, best

    cur_streak, best_streak = _streaks([d["date"] for d in active])
    best_day = max(active, key=lambda d: d["total_cnt"]) if active else None
    studied = "where first_study<>'' or review_count>0"
    fm = dict(c.execute("select fm,count(*) from reviews %s group by fm" % studied).fetchall())
    diff = dict(c.execute("select difficulty,count(*) from reviews %s group by difficulty order by 1"
                          % studied).fetchall())
    decks_top = [dict(r) for r in c.execute(
        "select d.name, count(*) n from deck_words dw join decks d on d.id=dw.deck_id "
        "join reviews r on r.voc_id=dw.voc_id group by d.id order by n desc limit 6")]
    return dict(
        daily=days, totals=tot, first=first, last=last, today=today(), span_days=span,
        active_days=len(active), avg_day=round(tot["total"] / len(active)) if active else 0,
        best_day=best_day, streak=dict(cur=cur_streak, best=best_streak),
        fm={str(k): v for k, v in fm.items()}, diff={str(k): v for k, v in diff.items()},
        resp=dict(well=tot["well"], familiar=tot["familiar"],
                  uncertain=tot["uncertain"], forget=tot["forget"]),
        decks=decks_top, seeded=int(meta_get("seeded", 0)))


def day_detail(date):
    """某一天的完整明细：计数、作答分布、当天新学的词、当天复习过的词。"""
    c = conn()
    r = c.execute("select date,new_cnt,review_cnt,total_cnt,correct,wrong,seconds,"
                  "well,familiar,uncertain,forget from daily where date=?", (date,)).fetchone()
    d = dict(r) if r else None
    cols = ("w.id,w.spelling,w.phonetic,w.translation,w.pos,r.fm,r.difficulty,r.last_response,"
            "r.next_date,r.review_count")
    new_words = [dict(x) for x in c.execute(
        "select " + cols + " from reviews r join words w on w.id=r.voc_id "
        "where r.first_study=? order by w.spelling limit 120", (date,))]
    seen = {x["id"] for x in new_words}
    reviewed = []
    for x in c.execute(
            "select " + cols + " from day_words dw join words w on w.id=dw.voc_id "
            "join reviews r on r.voc_id=w.id where dw.date=? and dw.kind='review' "
            "order by r.fm limit 120", (date,)):
        if x["id"] not in seen:
            reviewed.append(dict(x))
    # 历史数据没有逐条明细，用「最后一次复习发生在当天」的词兜底
    if not reviewed and not new_words:
        for x in c.execute(
                "select " + cols + " from reviews r join words w on w.id=r.voc_id "
                "where r.last_study=? order by r.fm limit 60", (date,)):
            reviewed.append(dict(x))
    return dict(date=date, daily=d, new_words=new_words, reviewed=reviewed)


def algo():
    m = load_matrix()
    return dict(fvi=FVI, dvi=DVI, matrix=m, settings=json.loads(meta_get("settings", "{}") or "{}"),
                seeded=int(meta_get("seeded", 0)), built=meta_get("built_at"))


def books(q, page, sort, only_loaded):
    c = conn()
    page = max(0, int(page or 0))
    size = 40
    where, params = ["1=1"], []
    if q:
        where.append("(name like ? or author like ? or publisher like ?)")
        params += ["%" + q + "%"] * 3
    order = {"count": "voc_count desc", "name": "name"}.get(sort, "voc_count desc")
    total = c.execute("select count(*) from books where " + " and ".join(where), params).fetchone()[0]
    rows = c.execute("select * from books where " + " and ".join(where) + " order by " + order +
                     " limit ? offset ?", params + [size, page * size]).fetchall()
    loaded = {r[0] for r in c.execute("select distinct book_id from book_words")}
    items = []
    for r in rows:
        items.append(dict(id=r["id"], name=r["name"], count=r["voc_count"], author=r["author"],
                          publisher=r["publisher"], isbn=r["isbn"], version=r["version"],
                          loaded=r["id"] in loaded))
    publishers = [dict(name=a, n=b) for a, b in c.execute(
        "select publisher,count(*) c from books where publisher<>'' group by 1 order by c desc limit 12")]
    return dict(total=total, page=page, size=size, items=items, publishers=publishers,
                loaded_count=len(loaded))


def settings(body):
    cur = json.loads(meta_get("settings", "{}") or "{}")
    cur.update(body or {})
    meta_set("settings", json.dumps(cur, ensure_ascii=False))
    return cur


# 导出/导入用的列顺序，必须与 web/store.js 的 REV_COLS / DAY_COLS 一致
REV_COLS = ("voc_id", "fm", "difficulty", "last_interval", "next_date",
            "last_response", "review_count", "wrong_count",
            "first_study", "last_study", "starred", "blocked")
DAY_COLS = ("date", "new_cnt", "review_cnt", "total_cnt", "correct", "wrong",
            "seconds", "well", "familiar", "uncertain", "forget")


def export_progress():
    """导出成与 seed.json 同构的紧凑格式，桌面版与手机版互相吃得下。"""
    c = conn()
    total = c.execute("select count(*) from words").fetchone()[0]
    rv = [list(r) for r in c.execute("select %s from reviews" % ",".join(REV_COLS))]
    dy = [list(r) for r in c.execute("select %s from daily order by date" % ",".join(DAY_COLS))]
    cur = json.loads(meta_get("settings", "{}") or "{}")
    return dict(v=1, app="momo-lab",
                exported_at=datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
                total_words=total, reviews=rv, daily=dy,
                settings={k: cur.get(k) for k in ("matrix", "new_limit", "mode") if k in cur})


def import_progress(data):
    """合并导入：同一词保留 last_study 更新的那条，本地没学过的直接补进来。"""
    c = conn()
    added = updated = days = 0
    for row in data.get("reviews") or []:
        rec = dict(zip(REV_COLS, row))
        vid = rec["voc_id"]
        if not vid:
            continue
        cur = c.execute("select last_study from reviews where voc_id=?", (vid,)).fetchone()
        if cur is None:
            added += 1
        else:
            if (rec["last_study"] or "") <= (cur[0] or ""):
                continue
            updated += 1
        c.execute("insert into reviews(%s) values(%s) "
                  "on conflict(voc_id) do update set %s"
                  % (",".join(REV_COLS), ",".join(["?"] * len(REV_COLS)),
                     ",".join("%s=excluded.%s" % (k, k) for k in REV_COLS if k != "voc_id")),
                  tuple(rec[k] for k in REV_COLS))
    for row in data.get("daily") or []:
        rec = dict(zip(DAY_COLS, row))
        if not rec["date"]:
            continue
        days += 1
        c.execute("insert into daily(%s) values(%s) "
                  "on conflict(date) do update set %s"
                  % (",".join(DAY_COLS), ",".join(["?"] * len(DAY_COLS)),
                     ",".join("%s=excluded.%s" % (k, k) for k in DAY_COLS if k != "date")),
                  tuple(rec[k] for k in DAY_COLS))
    if data.get("settings"):
        settings(data["settings"])
    c.commit()
    return dict(ok=True, added=added, updated=updated, days=days,
                total=c.execute("select count(*) from reviews").fetchone()[0])


def reset_progress():
    """恢复出厂：回到母库导入时的基线（reviews_origin / daily_origin 快照）。"""
    c = conn()
    c.execute("delete from reviews")
    c.execute("delete from daily")
    c.execute("delete from day_words")
    for t in ("reviews", "daily"):
        try:
            c.execute("insert into %s select * from %s_origin" % (t, t))
        except sqlite3.OperationalError:
            pass
    c.commit()
    return dict(ok=True, total=c.execute("select count(*) from reviews").fetchone()[0],
                days=c.execute("select count(*) from daily").fetchone()[0])


def toggle(vid, key):
    c = conn()
    r = c.execute("select %s from reviews where voc_id=?" % key, (vid,)).fetchone()
    if not r:
        c.execute("insert into reviews(voc_id,fm,difficulty,next_date,%s) values(?,1,5,?,1)" % key, (vid, today()))
        val = 1
    else:
        val = 1 - (r[0] or 0)
        c.execute("update reviews set %s=? where voc_id=?" % key, (val, vid))
    c.commit()
    return dict(ok=True, value=val)


# ---------------- HTTP ----------------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p, qs = u.path, urllib.parse.parse_qs(u.query)
        g = lambda k, d=None: (qs.get(k) or [d])[0]
        try:
            if p == "/api/overview":
                return self._json(overview())
            if p == "/api/decks":
                return self._json(decks())
            if p == "/api/queue":
                return self._json(queue(g("deck"), g("mode", "mixed"), g("limit", 20)))
            if p == "/api/word":
                d = word_detail(int(g("id")))
                return self._json(d or {}, 200 if d else 404)
            if p == "/api/search":
                return self._json(search(g("q"), int(g("limit", 40))))
            if p == "/api/browse":
                return self._json(browse(g("letter", "all"), g("sort", "alpha"), g("page", 0), g("q")))
            if p == "/api/stats":
                return self._json(stats())
            if p == "/api/day":
                return self._json(day_detail(g("date", today())))
            if p == "/api/algo":
                return self._json(algo())
            if p == "/api/books":
                return self._json(books(g("q", ""), g("page", 0), g("sort", "count"), g("loaded")))
            if p == "/api/today":
                return self._json(dict(date=today()))
            if p == "/api/export":
                return self._json(export_progress())
        except Exception as e:
            import traceback
            traceback.print_exc()
            return self._json(dict(error=str(e)), 500)
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            body = {}
        try:
            if u.path == "/api/answer":
                return self._json(answer(body))
            if u.path == "/api/settings":
                return self._json(settings(body))
            if u.path == "/api/star":
                return self._json(toggle(int(body["voc_id"]), "starred"))
            if u.path == "/api/block":
                return self._json(toggle(int(body["voc_id"]), "blocked"))
            if u.path == "/api/import":
                return self._json(import_progress(body))
            if u.path == "/api/reset":
                return self._json(reset_progress())
        except Exception as e:
            import traceback
            traceback.print_exc()
            return self._json(dict(error=str(e)), 500)
        return self._json(dict(error="not found"), 404)


def ensure_schema():
    """兼容旧库：补齐日历/明细用到的表与列。"""
    c = conn()
    c.execute("create table if not exists day_words(date text, voc_id int, kind text, "
              "primary key(date, voc_id))")
    cols = {r[1] for r in c.execute("pragma table_info(daily)")}
    for col in ("well", "familiar", "uncertain", "forget"):
        if col not in cols:
            c.execute("alter table daily add column %s integer default 0" % col)
    # 「恢复出厂」的基线快照：首次启动时把母库导入后的状态固化下来，之后不再动
    for t in ("reviews", "daily"):
        has = c.execute("select 1 from sqlite_master where type='table' and name=?",
                        (t + "_origin",)).fetchone()
        if not has:
            c.execute("create table %s_origin as select * from %s" % (t, t))
    c.commit()


if __name__ == "__main__":
    if not os.path.exists(DB):
        print("!! 缺少数据文件，请先运行 build_db.py")
        sys.exit(1)
    ensure_schema()
    os.chdir(BASE)

    class Srv(ThreadingHTTPServer):
        allow_reuse_address = False
        daemon_threads = True

    srv = None
    PORT_USE = PORT
    for p in range(PORT, PORT + 25):
        try:
            srv = Srv(("127.0.0.1", p), Handler)
            PORT_USE = p
            break
        except OSError:
            continue
    if srv is None:
        print("!! 没有可用端口")
        sys.exit(1)
    print(f"\n  墨 · 单词实验室  →  http://127.0.0.1:{PORT_USE}\n", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
