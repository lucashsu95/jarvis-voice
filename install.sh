#!/usr/bin/env bash
# Claude Code 語音自動輸入：安裝或更新。
#   ./install.sh                 用設定檔現在的引擎（第一次裝是 local）
#   ./install.sh local           本機辨識（免費，聲音不離開這台電腦）
#   ./install.sh openai          自己的 OpenAI key（OPENAI_API_KEY 有設就順手寫進設定檔）
#   ./install.sh parallelsandbox 平行沙盒帳號
# 重跑會：裝套件、補模型、改引擎、把 plugin 註冊進 Claude Code、重開常駐程式。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${VOICE_DICTATION_STATE_DIR:-$HOME/.claude/voice-dictation}"
CONFIG="$STATE/config.json"
MODEL_NAME="sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$MODEL_NAME.tar.bz2"
MARKETPLACE="claude-voice-dictation"
PLUGIN="voice-dictation"
ENGINE="${1:-}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

case "$ENGINE" in ''|local|openai|parallelsandbox) ;; *) fail "引擎只能是 local、openai、parallelsandbox。" ;; esac

say "檢查環境"
[[ "$(uname -s)" == Darwin ]] || fail "目前只支援 macOS。"
command -v node >/dev/null || fail "需要 Node.js 22 以上：brew install node，或到 https://nodejs.org 下載。"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || fail "Node.js 太舊（$(node -v)），需要 22 以上。"
FFMPEG=""
for p in /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg "$(command -v ffmpeg || true)"; do
  [[ -n "$p" && -x "$p" ]] && { FFMPEG="$p"; break; }
done
[[ -n "$FFMPEG" ]] || fail "需要 ffmpeg 收音：brew install ffmpeg"
command -v claude >/dev/null || fail "需要 Claude Code 的 claude 指令：https://docs.claude.com/claude-code"
note "node $(node -v)、ffmpeg $FFMPEG、claude $(claude --version 2>/dev/null | head -1)"

say "安裝套件"
(cd "$DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

mkdir -p "$STATE"
if [[ -z "$ENGINE" ]]; then
  if [[ -f "$CONFIG" ]]; then
    ENGINE="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).engine||"local")}catch{process.stdout.write("local")}' "$CONFIG")"
  else
    ENGINE="local"
  fi
fi

if [[ "$ENGINE" == local ]]; then
  if [[ -f "$STATE/models/$MODEL_NAME/model.int8.onnx" ]]; then
    say "本機模型已經在了"
  else
    say "下載本機辨識模型 SenseVoice-Small（約 155 MB，來源 k2-fsa/sherpa-onnx）"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    curl -fL --retry 3 --progress-bar -o "$TMP/model.tar.bz2" "$MODEL_URL"
    mkdir -p "$STATE/models"
    tar -xjf "$TMP/model.tar.bz2" -C "$STATE/models"
    [[ -f "$STATE/models/$MODEL_NAME/model.int8.onnx" ]] || fail "模型解開後找不到 model.int8.onnx。"
  fi
fi

say "設定檔：$CONFIG（引擎 $ENGINE）"
node - "$CONFIG" "$ENGINE" <<'EOF'
const fs = require('fs');
const [file, engine] = process.argv.slice(2);
let config = {};
try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
config.engine = engine;
if (engine === 'openai' && process.env.OPENAI_API_KEY && !config.openai?.apiKey) {
  config.openai = { ...config.openai, apiKey: process.env.OPENAI_API_KEY };
}
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
EOF
if [[ "$ENGINE" == openai ]] && ! grep -q '"apiKey": "sk-' "$CONFIG"; then
  note "還沒有 OpenAI key：在 $CONFIG 加上 \"openai\": { \"apiKey\": \"sk-...\" }"
fi

say "註冊到 Claude Code"
if grep -q "$DIR" "$HOME/.claude/settings.json" 2>/dev/null || [[ "${CLAUDE_CODE_PLUGIN_DIRS:-}" == *"$DIR"* ]]; then
  note "這個資料夾已經用 CLAUDE_CODE_PLUGIN_DIRS 載入，略過註冊。"
else
  if claude plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE"; then
    claude plugin marketplace update "$MARKETPLACE" >/dev/null
  else
    claude plugin marketplace add "$DIR" >/dev/null
  fi
  if claude plugin list 2>/dev/null | grep -q "$PLUGIN@$MARKETPLACE"; then
    note "已經裝過，讀的就是這個資料夾。"
  else
    claude plugin install "$PLUGIN@$MARKETPLACE" --scope user >/dev/null
  fi
  note "$PLUGIN@$MARKETPLACE（使用者範圍）"
fi

if [[ -f "$STATE/listener.lock" ]]; then
  PID="$(cat "$STATE/listener.lock" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && ps -p "$PID" -o command= 2>/dev/null | grep -q listen.mjs; then
    kill -TERM "$PID" 2>/dev/null || true
    note "常駐程式已重開，20 秒內會用新設定接手。"
  fi
fi

say "完成"
cat <<EOF
  1. 開一個新的 Claude Code session，送一句話（之後每個 session 都會自動載入）。
  2. 第一次收音時 macOS 會問「Claude Code」能不能用麥克風，按允許。
  3. 第一次貼上時會問「輔助使用」權限：系統設定 → 隱私權與安全性 → 輔助使用，打開 Claude Code。
  之後 Claude 在最前面時直接講話，講完一句就貼進游標所在的輸入框。
EOF
