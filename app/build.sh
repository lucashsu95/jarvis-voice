#!/usr/bin/env bash
# 把 app/main.js 包成選單列小程式（osacompile，macOS 內建，不用 Xcode）。
# 用法：app/build.sh <輸出的 .app 路徑> <repo 路徑> <node 路徑> <狀態資料夾>
set -euo pipefail

APP="$1"
REPO="$2"
NODE="$3"
STATE="$4"
BUNDLE_ID="com.urusa.voice-dictation"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 路徑用 JSON 填進去，空白、引號都不會壞
node -e '
const fs = require("fs");
const [src, out, node, repo, state] = process.argv.slice(1);
const build = JSON.stringify({ node, repo, state });
fs.writeFileSync(out, fs.readFileSync(src, "utf8").replace("__BUILD__", build));
' "$REPO/app/main.js" "$TMP/main.js" "$NODE" "$REPO" "$STATE"

rm -rf "$APP"
mkdir -p "$(dirname "$APP")"
osacompile -l JavaScript -s -o "$APP" "$TMP/main.js"

PLIST="$APP/Contents/Info.plist"
set_key() {
  /usr/libexec/PlistBuddy -c "Set :$1 $3" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 $2 $3" "$PLIST"
}
set_key CFBundleIdentifier string "$BUNDLE_ID"
set_key CFBundleName string "全語音輸入"
set_key CFBundleDisplayName string "全語音輸入"
set_key LSUIElement bool true
set_key NSMicrophoneUsageDescription string "全語音輸入要用麥克風聽你講話，轉成文字貼進游標所在的輸入框。"
set_key NSAppleEventsUsageDescription string "全語音輸入要送出貼上（Cmd+V），把字放進游標所在的輸入框。"

# 本機簽名：麥克風、輔助使用權限才會認得同一個 app
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
