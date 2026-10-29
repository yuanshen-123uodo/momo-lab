# 墨 · 单词实验室

复刻**墨墨背单词**调度算法的交互式背单词平台。

三套形态，共用一套前端：

| 形态 | 入口 | 适用场景 |
|---|---|---|
| 本地服务版 | `python server.py` → http://127.0.0.1:8899 | 桌面，功能最全 |
| 手机版（PWA） | `export_static.py` → `site/`，可部署到任意静态托管 | 手机添加到主屏幕，离线可背 |
| 手机版（APK） | `build_apk.py` → `dist/momo-words-1.0.apk` | 装上即用，**完全不需要网络**，不受托管速度影响 |

---

## 快速开始

```bash
# 1. 准备数据源（见下方「数据来源」）
# 2. 构建查询库
python build_db.py          # → data/momo.db（约 33 MB）

# 桌面版
python server.py            # 端口被占会自动往后找
# 或直接双击 start.bat

# 手机版（PWA）
python gen_icons.py         # 生成 PWA 图标（需要 playwright）
python export_static.py     # → site/（纯静态，可直接部署）

# 手机版（APK）：先 export_static.py，再打包
python build_apk.py         # → dist/momo-words-1.0.apk（约 16 MB）
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
check_deep.py      手机视口全流程巡检（7 页 + 学习 + 导出导入 + 离线，抓 4xx/JS 异常）
check_pwa.py       PWA 安装条件检查（manifest / Service Worker / 离线重载）
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
| `data/meta.json` | 全局信息 + 22 个词单清单 + 每字母块数 | 4 KB |
| `data/deck/<id>.json` | 词单的词 id 有序表 | 10–390 KB |
| `data/dw/<id>/<块>.json` | 词单分块，每块 800 词的完整数据 | ~90 KB |
| `data/lex/<字母>/<块>.json` | 词库分块，每块 800 词（浏览 / 详情） | ~97 KB |
| `data/x/<字母>/<块>.json` | 英文释义/词形/相关词（打开详情才拉） | ~39 KB |
| `data/bkt/<块>.json` | id → (字母, 块号) 稀疏反查索引 | ~9 KB |
| `data/sx/<前两字母>.json` | 前缀搜索桶，搜 `aban` 直接命中 | ~6 KB |
| `data/sxa/<0-7>.json` | 全库紧凑词典，仅用于"片段搜索"兜底 | ~287 KB |
| `data/seed.json` | 母库导出的真实学习记录（首次打开继承） | 93 KB |

实测：进 App 选一个词单，**总传输约 106 KB**；打开词库页只拉 1 个 97 KB 分片；
点开一个词的详情约 0.85 秒（此前整片加载需要 24 秒）。

搜索分两级：先查前缀桶（几 KB，毫秒级），前缀一个都没命中时才拉 8 份全库词典做
包含式匹配 —— 所以 `bandon` 也能找到 `abandon`。

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

## 安卓 APK（完全不联网）

PWA 依赖 Service Worker 缓存，首次仍要联网拉 40 MB 分片，清缓存就丢；
托管速度在国内也不稳定。APK 把整站放进 `assets/`，装上就是完整的：

```bash
python export_static.py     # 先产出 site/
python build_apk.py         # → dist/momo-words-1.0.apk（16.3 MB）
```

实现要点：

- **不用 `file://`**：file 协议下 `fetch`、IndexedDB 都受同源限制，而数据层完全依赖
  `fetch` 读 JSON 分片。壳里用 `https://appassets.momo.local/` 这个假域名，
  `shouldInterceptRequest` 直接把请求接到 `AssetManager`，不会真的出网，也就没有证书问题。
- **不申请任何权限**，Manifest 里连 `INTERNET` 都没有。
- **APK 里不注册 Service Worker**（UA 带 `MomoNative` 时页面自动跳过），资源本就在本地，
  多一层缓存没有意义。
- 进度仍存 WebView 的 IndexedDB（应用私有目录），卸载才丢；数据页的导出/导入照常可用。

工具链是便携解压的，不写注册表：JDK 17 + Android build-tools 34 + platform android-35，
放在 `../toolchain/`（可用 `MOMO_TOOLCHAIN` 指定）。构建走
`aapt2 → javac → d8 → zip → zipalign → apksigner` 手工链，不需要 Gradle。

签名证书是 `android/momo.keystore`（自签名，口令 `momolab`）。
**升级安装必须用同一个证书**，换证书只能卸载重装、进度会丢 —— 这个文件要一起备份。

---

## 数据备份与迁移

首页右上角「数据」→ `#/data`，三种操作：

| 操作 | 行为 |
|---|---|
| **导出** | 下载 `momo-progress-YYYY-MM-DD.json`，含全部词的学习状态 + 每日统计 + 设置 |
| **导入** | 选文件后**合并**，不覆盖：同一个词比较 `last_study`，较新的一方胜出 |
| **恢复初始** | 清空本机记录，重新回到种子状态（PWA）或首次导入状态（桌面） |

手机版和桌面版的文件格式**完全相同**，可以互相导入：

```bash
# 手机背了一周，想把进度搬回电脑
# 手机 → 数据 → 导出 → 把 json 传到电脑 → 电脑 → 数据 → 导入
```

导出的结构（紧凑数组，字段顺序固定，见 `server.py` 的 `REV_COLS` / `DAY_COLS`）：

```json
{
  "v": 1, "app": "momo-lab", "exported_at": "2026-10-29 12:50",
  "total_words": 129927,
  "reviews": [[voc_id, fm, difficulty, last_interval, next_date, last_response,
               review_count, wrong_count, first_study, last_study, starred, blocked], ...],
  "daily":   [[date, new_cnt, review_cnt, total_cnt, correct, wrong, seconds,
               well, familiar, uncertain, forget], ...],
  "settings": { "matrix": "fit", "new_limit": 20 }
}
```

没有云端，就没有「两台设备自动同步」。跨设备时手动导一次；同一个词在两边都背过，
导入后保留最后学习时间较晚的那条状态。

---

## 已知限制

- ECDICT 直接命中 60%，短语靠「组成词释义拼接」补到 **96.7%** 有释义
- 2086 本词书里**只有 1 本**带完整词表（`SIX_LEVEL_DEEP` 1934 词）。
  词表在墨墨服务端按需下发，本地库 `BK_VOC_TB` 只留你实际打开过的那些 ——
  想在本地多几本可背的书，只能在 App 里把这些书加入计划并打开一次，再重新导库
- `interpretations.csv` 里 2623 条官方释义是加密的（`MMEncipher.d()`，dex 内 Java 实现），
  仅占全库 2.0%，未做逆向；这些词的释义回落到 ECDICT
- PWA 版随包带一份母库导出的学习记录快照（`seed.json`），手机首次打开即继承；
  它公开在静态文件里，介意的话可以不导出这份种子（注释掉 `export_static.py` 的 4.5 节）
- 桌面版会导入墨墨运行库里的真实记录，与 PWA 的种子同源
- 搜索按**拼写**匹配，不搜中文释义（中文要全库倒排索引，体积不划算）
