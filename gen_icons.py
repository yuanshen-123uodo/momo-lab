#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gen_icons.py — 用 Chromium 把 SVG 图标渲染成 PWA 需要的 PNG
产出 web/icon-192.png / icon-512.png / icon-mask.png
"""
import asyncio, os, sys

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

TPL = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{width:{s}px;height:{s}px;background:#16343a;display:flex;flex-direction:column;
  align-items:center;justify-content:center;overflow:hidden}}
.wrap{{transform:scale({scale});display:flex;flex-direction:column;align-items:center}}
.seal{{width:{box}px;height:{box}px;border-radius:{r}px;background:#1e6f5c;
  display:flex;align-items:center;justify-content:center;
  box-shadow:0 {sh}px {sh2}px rgba(0,0,0,.25)}}
.seal b{{font-family:"Songti SC","SimSun","STSong",serif;color:#f7f5f0;
  font-size:{fs}px;font-weight:700;letter-spacing:0}}
.t{{margin-top:{gap}px;color:#f7f5f0;font-size:{ts}px;letter-spacing:{ls}px;
  font-family:"PingFang SC","Microsoft YaHei",sans-serif;opacity:.85}}
</style></head><body>
<div class="wrap">
  <div class="seal"><b>墨</b></div>
  <div class="t">单词实验室</div>
</div>
</body></html>"""


def html(size, scale):
    return TPL.format(
        s=size, scale=scale,
        box=int(396 * scale), r=int(74 * scale),
        sh=int(6 * scale), sh2=int(18 * scale),
        fs=int(250 * scale), gap=int(30 * scale),
        ts=int(44 * scale), ls=int(8 * scale))


async def main():
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("!! 需要 playwright：pip install playwright && playwright install chromium")
        return 1
    os.makedirs(WEB, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for size, scale, name in ((192, 192 / 512, "icon-192.png"),
                                  (512, 1, "icon-512.png"),
                                  (512, 0.62, "icon-mask.png")):
            pg = await b.new_page(viewport={"width": size, "height": size})
            await pg.set_content(html(size, scale))
            await pg.wait_for_timeout(150)
            await pg.screenshot(path=os.path.join(WEB, name))
            await pg.close()
            print("icon", name, size, os.path.getsize(os.path.join(WEB, name)), "bytes")
        await b.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
