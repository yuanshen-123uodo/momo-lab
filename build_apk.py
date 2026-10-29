#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_apk.py — 把 site/ 静态站打进一个完全离线的安卓 App

产物：dist/momo-words-<ver>.apk
依赖：toolchain/ 下的 JDK + Android build-tools + platform android.jar
      （见 fetch_toolchain.py；都是便携解压，不写注册表）

为什么要壳：网页版靠 Service Worker 缓存，首次仍要联网拉 40MB 分片，
清缓存还会丢；APK 把数据放进 assets，装上就是完整的，飞行模式也能背。
"""
import os
import re
import shutil
import subprocess
import sys
import zipfile

BASE = os.path.dirname(os.path.abspath(__file__))
AND = os.path.join(BASE, "android")
SITE = os.path.join(BASE, "site")
TOOL = os.path.join(os.environ.get("MOMO_TOOLCHAIN", ""), "") or \
    os.path.join(os.path.dirname(BASE), "toolchain")
DIST = os.path.join(BASE, "dist")

VER_CODE = 1
VER_NAME = "1.0"

KS = os.path.join(AND, "momo.keystore")
KS_PASS = "momolab"
KS_ALIAS = "momo"


def find_dir(parent, pattern):
    if not os.path.isdir(parent):
        return None
    for name in sorted(os.listdir(parent)):
        if re.match(pattern, name) and os.path.isdir(os.path.join(parent, name)):
            return os.path.join(parent, name)
    return None


def locate():
    jdk = find_dir(TOOL, r"^jdk")
    bt = find_dir(TOOL, r"^android-\d+$")
    pf = None
    for name in ("android-35", "android-34", "android-33"):
        p = os.path.join(TOOL, name)
        if os.path.isfile(os.path.join(p, "android.jar")):
            pf = p
            break
    if not pf and bt:
        # build-tools 目录里没有 android.jar，必须在 platforms 下找
        pf = find_dir(TOOL, r"^platform")
        if pf and not os.path.isfile(os.path.join(pf, "android.jar")):
            pf = None
    if not (jdk and bt and pf):
        log("!! 工具链不全：jdk=%s build-tools=%s platform=%s" % (jdk, bt, pf))
        log("   先跑 python fetch_toolchain.py")
        sys.exit(2)
    return jdk, bt, pf


def log(*a):
    print(*a, flush=True)


def run(cmd, env=None, quiet=False):
    r = subprocess.run(cmd, capture_output=True, text=True, env=env,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        log("!! 失败：%s" % " ".join(cmd[:3]))
        log((r.stdout or "")[-1500:])
        log((r.stderr or "")[-1500:])
        sys.exit(r.returncode)
    if not quiet and (r.stderr or "").strip():
        tail = r.stderr.strip().splitlines()[-3:]
        for t in tail:
            log("   " + t)
    return r


def make_icons(jdk, bt):
    """从站点图标生成各密度 launcher 图标"""
    from PIL import Image
    src = os.path.join(SITE, "icon-512.png")
    if not os.path.exists(src):
        src = os.path.join(SITE, "icon-192.png")
    img = Image.open(src).convert("RGBA")
    sizes = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for d, px in sizes.items():
        out = os.path.join(AND, "res", "mipmap-" + d)
        os.makedirs(out, exist_ok=True)
        img.resize((px, px), Image.LANCZOS).save(os.path.join(out, "ic_launcher.png"))
    log("[res]  图标 %d 个密度" % len(sizes))


def make_assets():
    dst = os.path.join(AND, "build", "assets")
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(dst, exist_ok=True)
    skip = {".git", "qr.png", "sw.js"}
    n = 0
    total = 0
    for root, dirs, files in os.walk(SITE):
        dirs[:] = [d for d in dirs if d not in skip]
        rel = os.path.relpath(root, SITE)
        target = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(target, exist_ok=True)
        for f in files:
            if f in skip or f.endswith(".map"):
                continue
            shutil.copy2(os.path.join(root, f), os.path.join(target, f))
            n += 1
            total += os.path.getsize(os.path.join(root, f))
    log("[assets] %d 个文件 %.1f MB" % (n, total / 1048576))
    return dst


def ensure_keystore(jdk):
    if os.path.exists(KS):
        return
    keytool = os.path.join(jdk, "bin", "keytool.exe")
    run([keytool, "-genkeypair", "-keystore", KS, "-alias", KS_ALIAS,
         "-keyalg", "RSA", "-keysize", "2048", "-validity", "10950",
         "-storepass", KS_PASS, "-keypass", KS_PASS,
         "-dname", "CN=Momo Lab, OU=Words, O=Momo, L=Beijing, C=CN"], quiet=True)
    log("[sign] 新建签名证书 %s" % os.path.basename(KS))


def main():
    jdk, bt, pf = locate()
    java = os.path.join(jdk, "bin", "java.exe")
    javac = os.path.join(jdk, "bin", "javac.exe")
    android_jar = os.path.join(pf, "android.jar")
    aapt2 = os.path.join(bt, "aapt2.exe")
    zipalign = os.path.join(bt, "zipalign.exe")

    env = dict(os.environ)
    env["JAVA_HOME"] = jdk
    env["PATH"] = os.path.join(jdk, "bin") + os.pathsep + env.get("PATH", "")

    log("工具链  %s" % os.path.basename(pf))
    log("       %s" % os.path.basename(jdk))
    log("       %s" % os.path.basename(bt))

    if not os.path.isdir(SITE) or not os.path.exists(os.path.join(SITE, "index.html")):
        log("!! 缺少 site/，先跑 python export_static.py")
        return 2

    build = os.path.join(AND, "build")
    if os.path.isdir(build):
        shutil.rmtree(build)
    os.makedirs(build, exist_ok=True)
    os.makedirs(DIST, exist_ok=True)

    make_icons(jdk, bt)
    assets = make_assets()

    # 1) 编译资源
    res_zip = os.path.join(build, "res.zip")
    run([aapt2, "compile", "--dir", os.path.join(AND, "res"), "-o", res_zip], quiet=True)
    log("[aapt2] 资源编译完成")

    # 2) 链接成基础 APK（assets 在这一步被包进去）
    base_apk = os.path.join(build, "base.apk")
    run([aapt2, "link", "-o", base_apk,
         "-I", android_jar,
         "--manifest", os.path.join(AND, "AndroidManifest.xml"),
         "-A", assets,
         "--min-sdk-version", "24",
         "--target-sdk-version", "34",
         "--version-code", str(VER_CODE),
         "--version-name", VER_NAME,
         res_zip], quiet=True)
    log("[aapt2] 链接完成 %.1f MB" % (os.path.getsize(base_apk) / 1048576))

    # 3) 编译 Java
    classes = os.path.join(build, "classes")
    os.makedirs(classes, exist_ok=True)
    srcs = []
    for root, _, files in os.walk(os.path.join(AND, "src")):
        srcs += [os.path.join(root, f) for f in files if f.endswith(".java")]
    run([javac, "-source", "8", "-target", "8", "-nowarn",
         "-encoding", "UTF-8",
         "-bootclasspath", android_jar,
         "-d", classes] + srcs, env=env)
    log("[javac] %d 个源文件" % len(srcs))

    # 4) dex
    dexdir = os.path.join(build, "dex")
    os.makedirs(dexdir, exist_ok=True)
    cls = []
    for root, _, files in os.walk(classes):
        cls += [os.path.join(root, f) for f in files if f.endswith(".class")]
    run([java, "-cp", os.path.join(bt, "lib", "d8.jar"), "com.android.tools.r8.D8",
         "--lib", android_jar, "--min-api", "24",
         "--output", dexdir] + cls, env=env)
    dex = os.path.join(dexdir, "classes.dex")
    log("[d8]   classes.dex %.0f KB" % (os.path.getsize(dex) / 1024))

    # 5) 把 dex 塞进 APK
    with_dex = os.path.join(build, "with-dex.apk")
    shutil.copy2(base_apk, with_dex)
    with zipfile.ZipFile(with_dex, "a", zipfile.ZIP_DEFLATED) as z:
        z.write(dex, "classes.dex")

    # 6) 对齐 + 签名
    aligned = os.path.join(build, "aligned.apk")
    run([zipalign, "-f", "4", with_dex, aligned], quiet=True)
    ensure_keystore(jdk)
    out = os.path.join(DIST, "momo-words-%s.apk" % VER_NAME)
    if os.path.exists(out):
        os.remove(out)
    run([java, "-jar", os.path.join(bt, "lib", "apksigner.jar"), "sign",
         "--ks", KS, "--ks-pass", "pass:" + KS_PASS,
         "--key-pass", "pass:" + KS_PASS, "--ks-key-alias", KS_ALIAS,
         "--min-sdk-version", "24",
         # v1 也一起签：部分国产 ROM 的安装器只认 JAR 签名
         "--v1-signing-enabled", "true",
         "--v2-signing-enabled", "true",
         "--out", out, aligned], env=env)
    v = run([java, "-jar", os.path.join(bt, "lib", "apksigner.jar"), "verify",
             "--min-sdk-version", "24", "--print-certs", out], env=env, quiet=True)

    size = os.path.getsize(out) / 1048576
    log("")
    log("完成  %s" % out)
    log("       %.1f MB  签名校验通过" % size)
    for line in (v.stdout or "").splitlines()[:2]:
        log("       " + line.strip()[:100])
    return 0


if __name__ == "__main__":
    sys.exit(main())
