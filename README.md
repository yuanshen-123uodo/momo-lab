# 墨 · 单词实验室

复刻**墨墨背单词**调度算法的交互式背单词平台。

两套形态，共用一套前端：

| 形态 | 入口 | 适用场景 |
|---|---|---|
| 本地服务版 | `python server.py` → http://127.0.0.1:8899 | 桌面，功能最全 |
| 手机版（PWA） | `export_static.py` → `site/`，可部署到任意静态托管 | 手机添加到主屏幕，离线可背 |

---

## 快速开始

```bash
# 1. 准备数据源（见下方「数据来源」）
# 2. 构建查询库
python build_db.py          # → data/momo.db（约 33 MB）

# 桌面版
python server.py            # 端口被占会自动往后找
# 或直接双击 start.bat

# 手机版
python gen_icons.py         # 生成 PWA 图标（需要 playwright）
python export_static.py     # → site/（纯静态，可直接部署）
```

---

## 数据来源

三项：墨墨随包静态数据、墨墨运行库、ECDICT 开源词典。
默认探测仓库内 `sources/`，其次项目上级目录，也可用环境变量直接指定：

| 环境变量 | 内容 |
|---|---|
| `MOMO_DATASET` | 墨墨 v5.6.10 静态包导出的 CSV 目录 |
| `MOMO_RUNTIME` | 墨墨运行库 `momo.v425.db`（真实学习记录，可选） |
| `MOMO_ECDICT` | ECDICT 的 `ecdict.csv` |
| `MOMO_DB` | 输出的 SQLite 路径 |

ECDICT 从 skywind3000/ECDICT 获取，国内可走 `gh-proxy.com` 前缀加速。

**这些数据体积大且涉及版权，不入库**——仓库只含源码，见 `.gitignore`。

---

## 目录结构

```
build_db.py        墨墨数据 + ECDICT → SQLite
server.py          标准库 HTTP 服务 + REST API（零依赖）
export_static.py   SQLite → 静态分片（PWA 数据管线）
gen_icons.py       Chromium 渲染 PWA 图标
web/
  index.html       单页骨架
  app.js           7 个页面 + hash 路由（服务端/离线双用）
  store.js         离线数据层：IndexedDB + 分片按需加载
  style.css
  sw.js            Service Worker
  manifest.webmanifest
start.bat          Windows 一键启动
```

`app.js` 通过 `window.MOMO.offline` 判断走网络还是本地，两种形态共用同一份代码。

### 静态分片设计

手机上首屏只下载几 KB，用到才拉：

| 文件 | 用途 | 单份大小 |
|---|---|---|
| `data/meta.json` | 全局信息 + 22 个词单清单 | 3 KB |
| `data/deck/<id>.json` | 词单的词 id 有序表 | 10–390 KB |
| `data/dw/<id>/<块>.json` | 词单分块，每块 800 词的完整数据 | ~90 KB |
| `data/lex/<a-z>.json` | 全库按首字母分片（浏览/搜索） | ~500 KB |
| `data/x/<a-z>.json` | 英文释义/词形/相关词（打开详情才拉） | ~350 KB |
| `data/bkt.json` | id → 字母片 反查索引 | 1.2 MB |
| `data/seed.json` | 母库导出的真实学习记录（首次打开继承） | 93 KB |

实测：进 App 选一个词单，**总传输约 106 KB**；之后 Service Worker 全缓存，断网也能背。

---

## 调度算法

墨墨用「记忆因子 fm（1–10）」+「个人难度（1–10）」决定下次复习间隔。

仓库里保存两套口径，可在算法页对比：

1. **官方基线**：`FVI`（fm → 天数）+ `DVI`（难度 → 增减天数）
2. **拟合矩阵**（默认）：用你自己的真实复习记录，在对数空间拟合 `fm → 基线天数` 与
   `难度 → 倍率`，再做单调平滑

为什么要拟合：随包 FVI 与真实间隔差一个量级（fm=6 官方 30 天，你实际中位数 55 天），
且 DVI 是直接做减法，套到 fm=1~3 上会把间隔压成负数——所以生词首答不叠加难度惩罚。

`build_db.py` 里的 `fit_matrix()` 就是拟合过程，换数据源会自动重跑。

---

## 部署到 GitHub Pages

`site/` 是纯静态目录，直接推到 `gh-pages` 分支即可（仓库里已保留该分支）：

```bash
cd site
git init && git checkout -b gh-pages
git add -A && git commit -m "deploy"
git remote add origin https://github.com/<你>/momo-lab.git
git push -u origin gh-pages
```

然后仓库 **Settings → Pages → Build and deployment**，Source 选 `Deploy from a branch`，
Branch 选 `gh-pages` / `/ (root)`，保存。几分钟后 https://\<你\>.github.io/momo-lab/ 生效。

注意：API 方式建仓 / 改 Pages 需要额外的 token 权限，网页上点两下最省事。

---

## 手机上怎么用

1. 手机浏览器打开部署好的链接（扫 `qr.png` 也行）
2. iOS：Safari 分享 → 添加到主屏幕
   Android：Chrome 菜单 → 添加到主屏幕 / 安装应用
3. 之后从桌面图标进入，全屏、离线、有独立图标

**首次打开会继承母库进度**：`data/seed.json` 里是母库导出的 1441 条学习状态 +
94 个学习日统计。本地 IndexedDB 为空时才导入一次，之后就是你自己的数据，互不覆盖。

进度存在浏览器 IndexedDB，不上传服务器。想恢复出厂：清站点数据即可，下次打开会重新导入种子。

---

## 已知限制

- ECDICT 直接命中 60%，短语靠「组成词释义拼接」补到 **96.7%** 有释义
- 2086 本词书中只有 1 本带完整词表（离线包限制），其余靠 ECDICT 考试标签补出 22 个可背词单
- PWA 版随包带一份母库导出的学习记录快照（`seed.json`），手机首次打开即继承；
  它公开在静态文件里，介意的话可以不导出这份种子（注释掉 `export_static.py` 的 4.5 节）
- 桌面版会导入墨墨运行库里的真实记录，与 PWA 的种子同源
