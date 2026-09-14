#!/usr/bin/env bash
# 无 root 环境下准备 Playwright Chromium：
#  1. 安装 Playwright npm 包（如未安装）
#  2. 下载 Chromium headless shell
#  3. 若系统缺少浏览器动态库（无 root 无法 apt 安装），则以普通用户下载对应 .deb
#     并解包到项目内 .pw-libs，测试时通过 LD_LIBRARY_PATH 加载
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 下载 Playwright Chromium"
npx playwright install chromium

BIN_DIR="$(dirname "$(find "$HOME/.cache/ms-playwright" -name chrome-headless-shell -type f 2>/dev/null | head -1)")"
if [ -z "${BIN_DIR:-}" ]; then
  echo "未找到 chrome-headless-shell，跳过系统库检查"
  exit 0
fi

missing="$(ldd "$BIN_DIR/chrome-headless-shell" | grep 'not found' || true)"
if [ -z "$missing" ]; then
  echo "==> 浏览器动态库齐全，无需额外准备"
  exit 0
fi

# 若项目内 .pw-libs 已能补齐，则无需重复下载
if [ -d .pw-libs ]; then
  cand="$(find .pw-libs -type d -name '*-linux-gnu' | tr '\n' ':')"
  if [ -n "$cand" ] && [ -z "$(LD_LIBRARY_PATH="$cand" ldd "$BIN_DIR/chrome-headless-shell" 2>/dev/null | grep 'not found' || true)" ]; then
    echo "==> .pw-libs 已包含所需动态库，跳过下载"
    exit 0
  fi
fi

echo "==> 系统缺少以下库："
echo "$missing" | awk '{print "    - " $1}'

arch="$(dpkg --print-architecture)"
case "$arch" in
  arm64|amd64) ;;
  *) echo "不支持的架构 $arch（仅支持 arm64/amd64 自动准备）"; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
LISTS="$TMP/lists"; mkdir -p "$LISTS/partial"
DEBS="$TMP/debs"; mkdir -p "$DEBS"

apt-get update -o Dir::State::Lists="$LISTS" >/dev/null

# ldd 报缺什么就装对应的 deb 包（库名 -> 包名）
pkg_for() {
  case "$1" in
    libnspr4.so*) echo libnspr4 ;;
    libnss3.so*|libnssutil3.so*|libsmime3.so*|libssl3.so*) echo libnss3 ;;
    libatk-1.0.so*) echo libatk1.0-0 ;;
    libatk-bridge-2.0.so*) echo libatk-bridge2.0-0 ;;
    libatspi.so*) echo libatspi2.0-0 ;;
    libcups.so*) echo libcups2 ;;
    libdrm.so*) echo libdrm2 ;;
    libxkbcommon.so*) echo libxkbcommon0 ;;
    libXcomposite.so*) echo libxcomposite1 ;;
    libXdamage.so*) echo libxdamage1 ;;
    libXfixes.so*) echo libxfixes3 ;;
    libXrandr.so*) echo libxrandr2 ;;
    libXi.so*) echo libxi6 ;;
    libgbm.so*) echo libgbm1 ;;
    libasound.so*) echo libasound2 ;;
    libdbus-1.so*) echo libdbus-1-3 ;;
    libwayland-server.so*) echo libwayland-server0 ;;
    libpango-1.0.so*) echo libpango-1.0-0 ;;
    libcairo.so*) echo libcairo2 ;;
    libexpat.so*) echo libexpat1 ;;
    *) echo "" ;;
  esac
}

pkgs=""
collect_missing() {
  # 带上已解包目录再查一次，让二级依赖（如 libgbm→libdrm）暴露出来
  local cand
  cand="$(find "$ROOT/.pw-libs" -type d -name '*-linux-gnu' 2>/dev/null | tr '\n' ':' || true)"
  LD_LIBRARY_PATH="$cand" ldd "$BIN_DIR/chrome-headless-shell" 2>/dev/null | grep 'not found' || true
}
for round in 1 2 3; do
  newpkgs=""
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    lib="$(echo "$line" | awk '{print $1}')"
    pkg="$(pkg_for "$lib")"
    if [ -n "$pkg" ] && ! echo "$pkgs" | grep -qw "$pkg"; then
      pkgs="$pkgs $pkg"; newpkgs="$newpkgs $pkg"
    fi
  done < <(collect_missing)
  [ -z "$newpkgs" ] && break
  echo "==> 第 $round 轮下载 deb 包：$newpkgs"
  ( cd "$DEBS" && apt-get download -o Dir::State::Lists="$LISTS" $newpkgs )
  mkdir -p "$ROOT/.pw-libs"
  for d in "$DEBS"/*.deb; do dpkg-deb -x "$d" "$ROOT/.pw-libs"; done
done
pkgs="$(echo "$pkgs" | tr ' ' '\n' | sort -u | tr '\n' ' ')"

if [ -z "$pkgs" ]; then
  echo "无法自动映射缺失库，请手动安装：$(collect_missing)"
  exit 1
fi

echo "==> deb 包：$pkgs"

echo "==> 复核"
cand="$(find "$ROOT/.pw-libs" -type d -name '*-linux-gnu' | tr '\n' ':')"
still="$(LD_LIBRARY_PATH="$cand" ldd "$BIN_DIR/chrome-headless-shell" 2>/dev/null | grep 'not found' || true)"
if [ -n "$still" ]; then
  echo "仍有缺失库："; echo "$still"; exit 1
fi

# 中文字体：headless 系统通常只有 DejaVu，中文会显示为方块。无 root 时装到 ~/.fonts
zh_font="$(fc-match ':lang=zh' -f '%{family}' 2>/dev/null || true)"
if ! echo "$zh_font" | grep -qiE 'wqy|wenquanyi|noto.*cjk|zenhei|songti|hei|uming|ukai'; then
  echo "==> 未检测到中文字体（当前：$zh_font），下载文泉驿正黑到 ~/.fonts"
  FD="$TMP/fonts"; mkdir -p "$FD"
  ( cd "$FD" && apt-get download -o Dir::State::Lists="$LISTS" fonts-wqy-zenhei >/dev/null )
  mkdir -p "$HOME/.fonts"
  ttc="$(find "$FD" -name '*.ttc' -o -name '*.ttf' | head -1)"
  [ -n "$ttc" ] || { f=$(find "$FD" -name '*.deb' | head -1); dpkg-deb -x "$f" "$FD/ext"; ttc="$(find "$FD/ext" -name '*.ttc' -o -name '*.ttf' | head -1)"; }
  cp "$ttc" "$HOME/.fonts/"
  fc-cache -f "$HOME/.fonts" >/dev/null 2>&1 || true
  echo "==> 已安装：$(fc-match ':lang=zh' -f '%{family}')"
fi

echo "==> 准备完成，可运行 npm test"
