#!/usr/bin/env bash
# Claude Code 語音自動輸入：解除安裝。設定檔與模型留在 ~/.claude/voice-dictation，要刪自己刪。
set -euo pipefail

STATE="${VOICE_DICTATION_STATE_DIR:-$HOME/.claude/voice-dictation}"
MARKETPLACE="claude-voice-dictation"
PLUGIN="voice-dictation"

claude plugin uninstall "$PLUGIN@$MARKETPLACE" >/dev/null 2>&1 && echo "已移除 plugin $PLUGIN@$MARKETPLACE" || echo "plugin 沒有裝（或已移除）"
claude plugin marketplace remove "$MARKETPLACE" >/dev/null 2>&1 && echo "已移除市集 $MARKETPLACE" || true

if [[ -f "$STATE/listener.lock" ]]; then
  PID="$(cat "$STATE/listener.lock" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && ps -p "$PID" -o command= 2>/dev/null | grep -q listen.mjs; then
    kill -TERM "$PID" 2>/dev/null || true
    echo "已停止常駐程式"
  fi
fi

echo "設定檔與模型還在 $STATE；不要了就：rm -rf \"$STATE\""
echo "已經開著的 Claude Code session 要重開才會完全卸掉。"
