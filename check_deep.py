"""深度巡检：遍历全部页面与真实交互路径，抓 4xx/5xx、JS 异常、布局溢出。

用法： python check_deep.py [URL]
      MOMO_UA="MomoNative/1.0" python check_deep.py [URL]   # 模拟原生壳
"""
import os
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8123/"
IPHONE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
_UA = os.environ.get("MOMO_UA")
if _UA:
    IPHONE["user_agent"] = _UA

ROUTES = [
    ("今日", "#/today"),
    ("词书", "#/decks"),
    ("词书库", "#/books"),
    ("词库", "#/browse"),
    ("统计", "#/stats"),
    ("算法", "#/algo"),
    ("数据", "#/data"),
]

bad, errs, steps = [], [], []


def note(txt):
    steps.append(txt)
    print(txt, flush=True)


def js_click(page, sel):
    """用 JS 触发点击：绕开 Playwright 对父容器遮挡的误判，同时也验证元素确实存在。"""
    return page.evaluate(
        """s => { const e = document.querySelector(s); if (!e) return false; e.click(); return true; }""", sel
    )


def check_overflow(page, where):
    """横向溢出检测：文档宽度超过视口即视为布局问题。"""
    r = page.evaluate(
        """() => {
        const de = document.documentElement;
        const over = de.scrollWidth - de.clientWidth;
        const wide = [];
        if (over > 2) {
            document.querySelectorAll('body *').forEach(el => {
                const b = el.getBoundingClientRect();
                if (b.right > de.clientWidth + 2 && b.width > 0) {
                    wide.push((el.className || el.tagName) + ':' + Math.round(b.right));
                }
            });
        }
        return { over, wide: wide.slice(0, 5) };
    }"""
    )
    if r["over"] > 2:
        errs.append("%s 横向溢出 %dpx  %s" % (where, r["over"], r["wide"]))
        return False
    return True


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(**IPHONE)
        page = ctx.new_page()
        page.on("response", lambda r: bad.append((r.status, r.url.split("/")[-1][:46])) if r.status >= 400 else None)
        page.on("pageerror", lambda e: errs.append("JS 未捕获异常: " + str(e)[:160]))
        page.on("console", lambda m: errs.append("console.error: " + m.text[:160]) if m.type == "error" else None)

        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4500)
        note("首屏标题: " + page.title())
        note("首屏摘要: " + (page.inner_text("body") or "")[:120].replace("\n", " | "))

        # 1) 全页面遍历
        for name, h in ROUTES:
            page.evaluate("h => { location.hash = h; }", h)
            page.wait_for_timeout(1600)
            txt = (page.inner_text("#main") or "").replace("\n", " | ")
            ok = check_overflow(page, name)
            empty = "数据未就绪" in txt or "出错了" in txt
            note("[%s] %s %s" % (name, "OK" if ok and not empty else "FAIL", txt[:90]))
            if empty:
                errs.append("%s 页面渲染异常: %s" % (name, txt[:120]))

        # 2) 关键交互：从首页点「继续」进学习（历史上 404 的路径）
        page.evaluate("() => { location.hash = '#/today'; }")
        page.wait_for_timeout(1500)
        cont = page.query_selector(".book-card a.btn")
        if cont:
            js_click(page, ".book-card a.btn")
            # 线上首次要下载词单索引 + 词块，等元素出现而不是死等
            try:
                page.wait_for_selector(".answer-row button", timeout=25000)
            except Exception:  # noqa: BLE001
                pass
            body = (page.inner_text("#main") or "").replace("\n", " | ")
            note("[学习入口·继续] " + body[:110])
            # 答题：用产品原生快捷键 1-4（避免 Playwright 对父容器遮挡的误判）
            n_btn = len(page.query_selector_all(".answer-row button"))
            note("[学习页] 答题按钮数=%d" % n_btn)
            if n_btn != 4:
                errs.append("学习页答题按钮应为 4 个，实际 %d" % n_btn)
            page.keyboard.press("Space")
            page.wait_for_timeout(1200)
            revealed = (page.inner_text("#main") or "")
            if "点击这里看释义" in revealed:
                errs.append("按空格未展开释义")
            else:
                note("[展开释义] " + revealed.replace("\n", " | ")[:90])
            page.keyboard.press("3")  # 认识
            page.wait_for_timeout(2000)
            after = (page.inner_text("#main") or "").replace("\n", " | ")
            note("[答题后] " + after[:90])
            if "出错了" in after:
                errs.append("答题后页面异常: " + after[:120])
        else:
            errs.append("首页找不到「继续」按钮")

        # 3) 词书库 → 搜出有词表那本书，点「学习」
        page.evaluate("() => { location.hash = '#/books'; }")
        page.wait_for_timeout(2500)
        bq = page.query_selector("#bq")
        if bq:
            bq.fill("墨墨")
            page.keyboard.press("Enter")
            try:
                page.wait_for_selector("#blist a.btn", timeout=20000)
            except Exception:  # noqa: BLE001
                page.wait_for_timeout(2500)
        if js_click(page, "#blist a.btn"):
            try:
                page.wait_for_selector(".answer-row button", timeout=25000)
            except Exception:  # noqa: BLE001
                page.wait_for_timeout(2000)
            body = (page.inner_text("#main") or "").replace("\n", " | ")
            note("[词书库·学习] " + body[:110])
            if "出错了" in body:
                errs.append("词书库学习页异常: " + body[:120])
        else:
            errs.append("词书库搜「墨墨」后仍无「学习」按钮（404 复现路径）")

        # 4) 词书页 → 任一词单「开始」
        page.evaluate("() => { location.hash = '#/decks'; }")
        page.wait_for_timeout(2500)
        if js_click(page, ".card.deck a.btn"):
            try:
                page.wait_for_selector(".answer-row button", timeout=25000)
            except Exception:  # noqa: BLE001
                page.wait_for_timeout(2000)
            note("[词单·开始] " + (page.inner_text("#main") or "").replace("\n", " | ")[:110])

        # 5) 词库搜索 + 词详情
        page.evaluate("() => { location.hash = '#/browse'; }")
        page.wait_for_timeout(2200)
        sq = page.query_selector("#sq")
        if sq:
            sq.fill("abandon")
            page.keyboard.press("Enter")
            try:
                page.wait_for_selector("#mb", timeout=15000)
                note("[搜索弹窗] " + (page.inner_text("#mb") or "").replace("\n", " | ")[:80])
            except Exception:  # noqa: BLE001
                errs.append("搜索 abandon 未弹出结果窗")
            page.keyboard.press("Escape")
            page.wait_for_timeout(600)
            if page.query_selector("#mb"):
                errs.append("Escape 未能关闭搜索弹窗")
            if js_click(page, "#wlist .wrow[data-id]"):
                try:
                    page.wait_for_selector("#mb", timeout=15000)
                except Exception:  # noqa: BLE001
                    page.wait_for_timeout(1500)
                page.wait_for_timeout(800)
                box = page.query_selector("#mb")
                detail = (box.inner_text() if box else "") or ""
                note("[词详情] " + detail.replace("\n", " | ")[:130])
                if not box:
                    errs.append("点击词条未弹出详情弹窗 #mb")
                elif "搜索结果" in detail:
                    errs.append("词详情弹窗显示的仍是搜索结果")
                n_mb = len(page.query_selector_all("#mb"))
                if n_mb != 1:
                    errs.append("弹窗叠加：同时存在 %d 个 #mb" % n_mb)
                page.keyboard.press("Escape")
                page.wait_for_timeout(600)
            else:
                errs.append("词库列表无词条行")
        else:
            errs.append("词库页找不到搜索框 #sq")

        # 5.5) 字母切换：分片文件名是小写，Linux 静态托管区分大小写，
        #      界面按钮给的是大写字母，这里必须逐个大写验证一次
        page.evaluate("() => { location.hash = '#/browse'; }")
        page.wait_for_timeout(2200)
        for L in ("B", "S", "Z"):
            page.evaluate(
                """l => { const b = [...document.querySelectorAll('.alpha button')]
                         .find(x => x.dataset.l === l); if (b) b.click(); }""",
                L,
            )
            page.wait_for_timeout(2600)
            n = len(page.query_selector_all("#wlist .wrow"))
            note("[字母 %s] 列表行数=%d" % (L, n))
            if n == 0:
                errs.append("字母 %s 无结果（分片文件名大小写导致 404？）" % L)

        # 6) 统计页点某天
        page.evaluate("() => { location.hash = '#/stats'; }")
        page.wait_for_timeout(2800)
        if js_click(page, "#calGrid .cal-day:not(.off)"):
            page.wait_for_timeout(2200)
            note("[统计·点某天] " + (page.inner_text("#main") or "").replace("\n", " | ")[:110])
        else:
            errs.append("统计页找不到日历格子")

        # 7) 数据页：导出 / 导入入口存在性
        page.evaluate("() => { location.hash = '#/data'; }")
        page.wait_for_timeout(2000)
        has_exp = bool(page.query_selector("#exp"))
        has_imp = bool(page.query_selector("#imp"))
        has_rst = bool(page.query_selector("#rst"))
        note("[数据页] 导出=%s 导入=%s 重置=%s" % (has_exp, has_imp, has_rst))
        if not (has_exp and has_imp and has_rst):
            errs.append("数据页按钮缺失")

        # 导出真的能下载
        if has_exp:
            try:
                with page.expect_download(timeout=20000) as dl:
                    js_click(page, "#exp")
                d = dl.value
                note("[导出] 文件名=%s" % d.suggested_filename)
                path = d.path()
                import json
                import os

                data = json.load(open(path, encoding="utf-8"))
                note("[导出] reviews=%d daily=%d total_words=%s"
                     % (len(data.get("reviews") or []), len(data.get("daily") or []), data.get("total_words")))
                if not data.get("reviews"):
                    errs.append("导出的 reviews 为空")
                if os.path.getsize(path) < 1024:
                    errs.append("导出文件过小：%d 字节" % os.path.getsize(path))

                # 把刚导出的文件再导入一次：验证合并链路与幂等
                page.evaluate("() => { location.hash = '#/data'; }")
                page.wait_for_timeout(1200)
                page.set_input_files("#file", path)
                page.wait_for_timeout(900)
                tt = (page.inner_text("#toast") or "") if page.query_selector("#toast") else ""
                note("[导入回灌] toast=%s" % tt[:70])
                if "合并完成" not in tt:
                    errs.append("导入未返回成功提示: " + tt[:100])
                elif "新增 0" not in tt:
                    errs.append("同文件重复导入不幂等: " + tt[:100])
            except Exception as exc:  # noqa: BLE001
                errs.append("导出下载失败: " + str(exc)[:140])

        # 8) 离线重载：原生壳里资源全在 assets，没有 SW 也不需要断网能力，
        #    这种情况跳过（MOMO_UA 带 MomoNative 时）
        if _UA and "MomoNative" in _UA:
            note("[离线] 跳过：原生壳不依赖 Service Worker，资源随包")
        else:
            ctx.set_offline(True)
            try:
                page.reload(wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(4000)
                txt = (page.inner_text("body") or "").replace("\n", " | ")
                note("[离线] " + txt[:110])
                if "数据未就绪" in txt or not txt.strip():
                    errs.append("离线重载后页面空白")
            except Exception as exc:  # noqa: BLE001
                errs.append("离线重载失败: " + str(exc)[:140])
            finally:
                ctx.set_offline(False)

        page.screenshot(path="D:/re-targets/maimemo/platform/shot_mobile.png")
        b.close()

    print("\n=== 4xx/5xx ===")
    print("\n".join("%s %s" % (s, u) for s, u in bad[:25]) if bad else "无")
    print("\n=== 问题 ===")
    print("\n".join(errs[:25]) if errs else "无")


if __name__ == "__main__":
    main()
