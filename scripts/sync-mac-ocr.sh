#!/usr/bin/env bash
# 把 Mac 的「傳一張圖認字」（bin/vision.js＋bin/vision-ocr.js）併成一個檔案同步到別的專案（平行沙盒桌面版）：
#   ./scripts/sync-mac-ocr.sh <目標檔案>
# 檔頭寫來源 commit。要改認字設定一律回 jarvis-voice 改（AX 小幫手截視窗認字也用同一份 vision.js），再跑一次這個。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:?用法：scripts/sync-mac-ocr.sh <目標檔案>}"
SHA="$(git -C "$DIR" rev-parse --short HEAD)"
if [[ -n "$(git -C "$DIR" status --porcelain -- bin/vision.js bin/vision-ocr.js)" ]]; then
  echo "bin/vision.js、bin/vision-ocr.js 有還沒 commit 的改動，先 commit 再同步（同步出去的版本要對得上 commit）" >&2
  exit 1
fi
mkdir -p "$(dirname "$DEST")"
{
  echo "// 從 jarvis-voice@$SHA 的 bin/vision.js＋bin/vision-ocr.js 併成（https://github.com/urusaqqrun/jarvis-voice/tree/main/bin）。"
  echo "// 不要在這裡改：改 jarvis-voice 再跑 scripts/sync-mac-ocr.sh"
  cat "$DIR/bin/vision.js"
  echo
  cat "$DIR/bin/vision-ocr.js"
} > "$DEST"
echo "已同步 vision-ocr@$SHA → $DEST"
