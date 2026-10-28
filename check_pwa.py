"""线上 PWA 可用性检查：manifest / Service Worker / 离线 / 首屏。"""
import json
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "https://momo-words-67183.app.workbuddy.host/?sharecode=PQYO6EWPEG"

IPHONE = {"width": 390, "height": 844, "deviceScaleFactor": 3, "isMobile": True, "hasTouch": True}


def main() -> None:
    bad = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport=IPHONE, device_scale_factor=3, is_mobile=True, has_touch=True)
        page = ctx.new_page()

        def on_resp(r):
            if r.status >= 400:
                bad.append((r.status, r.url.split("/")[-1][:40]))

        page.on("response", on_resp)
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(6000)

        print("=== 标题 ===")
        print(page.title())

        print("\n=== manifest 能否被解析 ===")
        print(
            page.evaluate(
                """() => {
            const l = document.querySelector('link[rel=manifest]');
            return l ? l.href : 'NO_MANIFEST_LINK';
        }"""
            )
        )

        print("\n=== Service Worker ===")
        print(page.evaluate("() => navigator.serviceWorker ? 'supported' : 'unsupported'"))
        page.wait_for_timeout(5000)
        try:
            print(
                page.evaluate(
                    """async () => {
                if (!navigator.serviceWorker) return 'none';
                const rs = await navigator.serviceWorker.getRegistrations();
                if (!rs.length) return 'NOT_REGISTERED';
                const r = rs[0];
                return JSON.stringify({
                    scope: r.scope,
                    active: r.active ? r.active.state : null,
                    waiting: !!r.waiting,
                });
            }"""
                )
            )
        except Exception as exc:  # noqa: BLE001
            print("sw check failed:", exc)

        print("\n=== 首屏内容 ===")
        print("body 文本前 200 字:", (page.inner_text("body") or "")[:200].replace("\n", " | "))

        page.screenshot(path="D:/re-targets/maimemo/platform/shot_mobile.png", full_page=False)

        print("\n=== 离线重载 ===")
        ctx.set_offline(True)
        try:
            page.reload(wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(4000)
            txt = (page.inner_text("body") or "")[:200].replace("\n", " | ")
            print("离线 body:", txt)
            page.screenshot(path="D:/re-targets/maimemo/platform/shot_offline.png")
        except Exception as exc:  # noqa: BLE001
            print("离线重载失败:", exc)
        ctx.set_offline(False)
        b.close()

    print("\n=== 4xx/5xx 响应 ===")
    if bad:
        for s, u in bad[:20]:
            print(s, u)
    else:
        print("无")


if __name__ == "__main__":
    main()
