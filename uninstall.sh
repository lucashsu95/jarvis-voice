#!/usr/bin/env bash
# 語音輸入：解除安裝。設定、詞彙、模型留在 ~/.voice-dictation，要刪自己刪。
set -euo pipefail

STATE="${VOICE_DICTATION_STATE_DIR:-$HOME/.voice-dictation}"
APP="${VOICE_DICTATION_APP:-$HOME/Applications/語音輸入.app}"
AGENT="$HOME/Library/LaunchAgents/com.urusa.voice-dictation.plist"

pkill -f "$APP/Contents/MacOS/applet" 2>/dev/null && echo "已關掉語音輸入" || true
if [[ -f "$STATE/listener.lock" ]]; then
  PID="$(cat "$STATE/listener.lock" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && ps -p "$PID" -o command= 2>/dev/null | grep -q listen.mjs; then
    kill -TERM "$PID" 2>/dev/null || true
  fi
fi
rm -f "$AGENT" && echo "已取消開機自動啟動"
rm -rf "$APP" && echo "已刪除 $APP"

echo "設定、詞彙、模型還在 $STATE；不要了就：rm -rf \"$STATE\""
echo "系統設定裡的麥克風、輔助使用項目可以自己移除。"
