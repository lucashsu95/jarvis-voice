# Claude Code 語音自動輸入

不用按任何按鈕。Claude 在最前面時自動收音，你講完一句（停頓約 0.85 秒），那句就貼進游標所在的輸入框：你在哪個 session，字就進哪個 session，新開的 session 也一樣。只貼不送出，要送自己按 Enter。

- **自動收音、自動切句**：本機判斷有沒有人聲，安靜時什麼都不送。Claude 不在最前面時麥克風直接關掉。
- **三種轉寫引擎，隨時可換**
  - `local`（預設）：本機跑 [SenseVoice-Small](https://github.com/FunAudioLLM/SenseVoice)，免費，聲音不離開你的電腦。
  - `openai`：用你自己的 OpenAI API key 直連 OpenAI 即時轉寫。
  - `parallelsandbox`：用[平行沙盒](https://parallelsandbox.com)帳號的轉寫。
- **錄音標示**：Claude 視窗標題列正中間會浮一個小標籤，顯示「錄音中」「說話中」「已貼上」；Claude 不在最前面時收起來。
- **狀態列**：每個 session 的輸入框上方有一行狀態（用哪個引擎、聽著還是待命），可以一鍵暫停或繼續。
- **中文整理**：簡體自動轉台灣正體，常錯的專有名詞可以寫進固定替換表。

## 需求

- macOS（Apple 晶片或 Intel）
- [Claude Code](https://docs.claude.com/claude-code)：桌面版 Code 分頁，或終端機版（見[在終端機用](#在終端機裡的-claude-code-用)）
- Node.js 22 以上（`brew install node`）
- ffmpeg（`brew install ffmpeg`）

## 安裝

```bash
git clone https://github.com/urusaqqrun/claude-voice-dictation.git ~/.claude-voice-dictation
cd ~/.claude-voice-dictation
./install.sh
```

`install.sh` 會裝套件、下載本機模型（約 155 MB），並把 plugin 註冊進 Claude Code（使用者範圍）。裝完：

1. 開一個新的 Claude Code session，送一句話。之後每個 session 都會自動載入。
2. 第一次收音時，macOS 會問「Claude Code」能不能使用麥克風，按允許。
3. 第一次貼上時，會跳出「輔助使用」權限的詢問：系統設定 → 隱私權與安全性 → 輔助使用，打開 Claude Code。

之後只要 Claude 在最前面，直接講話就好。

> 常駐程式由任一個開著的 Claude Code session 帶起來。Claude 重開後，要先在任一個 session 送過一句話才會開始收音。

## 換引擎

```bash
./install.sh local             # 本機辨識
./install.sh openai            # 自己的 OpenAI key（有設 OPENAI_API_KEY 會順手寫進設定檔）
./install.sh parallelsandbox   # 平行沙盒
```

也可以直接改設定檔，存檔後幾秒內就會套用新的引擎，不用重開。

## 設定檔

位置在 `~/.claude/voice-dictation/config.json`，沒寫的欄位照預設：

```json
{
  "engine": "local",
  "apps": ["com.anthropic.claudefordesktop"],
  "output": "traditional",
  "replacements": { "部屬": "部署", "Cube LV": "CubeLV" },
  "local": { "language": "auto", "threads": 2 },
  "openai": { "apiKey": "sk-...", "model": "gpt-live-transcribe", "language": "" },
  "parallelsandbox": { "apiKey": "" }
}
```

| 欄位 | 說明 |
|---|---|
| `engine` | `local`、`openai`、`parallelsandbox` |
| `apps` | 這些 app 在最前面時才收音（bundle id）。預設只有 Claude 桌面版 |
| `output` | `traditional`（台灣正體）、`simplified`、`original` |
| `replacements` | 轉出來的字固定替換，給常錯的專有名詞用 |
| `local.language` | `auto` 或 `zh`、`en`、`yue`、`ja`、`ko`；中英夾雜建議用 `auto` |
| `openai.apiKey` | 沒寫就讀環境變數 `OPENAI_API_KEY` |
| `openai.language` | 指定辨識語言（例如 `zh`），空白讓模型自己判斷 |
| `parallelsandbox.apiKey` | 沒寫就讀 `~/.claude.json` 裡 parallelsandbox MCP 的 key |

想暫停，按狀態列的「暫停」，或建立 `~/.claude/voice-dictation/paused` 這個檔案；刪掉這個檔案就繼續收音。

## 費用與隱私

| 引擎 | 費用 | 聲音送去哪 |
|---|---|---|
| `local` | 免費 | 不離開你的電腦 |
| `openai` | 照實際講話的時間計費，記在你自己的 OpenAI 帳號 | OpenAI |
| `parallelsandbox` | 依平行沙盒的方案 | 平行沙盒，再轉給 OpenAI |

不管用哪個引擎，只有判定是人聲的片段才會送去轉寫。不過人聲判斷的門檻不高：Claude 在最前面時，旁邊有人講話、你在開會、或在放影片和音樂，也可能被送出去，轉出來的字還會貼進輸入框。這些時候請按暫停，或切到別的 app。

## 辨識率參考

本機引擎 SenseVoice-Small 在 SenseVoice 論文公布的字錯誤率（越低越好）：

| 測試資料 | SenseVoice-Small | Whisper large-v3 |
|---|---|---|
| AISHELL-1（清楚朗讀的普通話） | 2.96% | 5.14% |
| WenetSpeech 會議錄音 | 7.44% | 18.87% |
| Common Voice 中文 | 10.78% | 12.55% |
| Common Voice 英文（詞錯誤率） | 14.71% | 9.39% |

這些是中國大陸普通話測試集的數字。實際遇到台灣口音、中文夾英文技術名詞時會差一些，英文短句也比雲端引擎弱。常錯的詞可以寫進 `replacements`，在意英文準度就用 `openai`。在 M4 Max 上，本機辨識一句話約 0.15–0.3 秒。

## 在終端機裡的 Claude Code 用

把終端機的 bundle id 加進 `apps`，例如：

```json
{ "apps": ["com.anthropic.claudefordesktop", "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty"] }
```

在終端機裡用的話，麥克風和輔助使用權限要給那個終端機 app，而不是 Claude Code。

## 疑難排解

- **狀態列和標籤都沒出現**：那個 session 要先送過一句話。可以看 `cat ~/.claude/voice-dictation/status.json` 確認常駐程式的狀態。
- **標籤顯示「麥克風開不起來」**：系統設定 → 隱私權與安全性 → 麥克風，打開 Claude Code。
- **字沒貼進去**：系統設定 → 隱私權與安全性 → 輔助使用，打開 Claude Code。另外，游標要在輸入框裡。
- **想看詳細輸出**：先停掉常駐程式（`kill $(cat ~/.claude/voice-dictation/listener.lock)`），再手動跑 `node bin/listen.mjs --always --dry-paste`。這樣只會印出要貼的字、不會真的貼；開著的 Claude Code session 會在 20 秒內把常駐程式重新帶起來。

## 怎麼運作

- `hooks/register.tsx`：Claude Code 的 mod（function hooks），每個 session 載入一份。它負責確認常駐程式在跑（沒有就帶起來），並在輸入框上方畫狀態列。
- `bin/listen.mjs`：常駐程式，整台電腦只跑一份（用鎖檔控制）。它看哪個 app 在最前面，用 ffmpeg 收音、在本機切句，交給轉寫引擎，再把定稿交給 `bin/paste.js`。
- `bin/engines/`：`local.mjs`（sherpa-onnx 跑 SenseVoice）、`realtime.mjs`（OpenAI Realtime 轉寫，直連或經平行沙盒）。
- `bin/paste.js`：先暫存剪貼簿，放進字後送 Cmd+V，再把剪貼簿還原。
- `bin/hud.js`：錄音標籤，是一個不搶焦點、不擋點擊的浮動小視窗。

## 開發

```bash
npm install
npm test                 # 常駐程式的零件測試
claude plugin test .     # mod 的測試
claude plugin validate .
```

Claude Code 的 mod（function hooks）介面目前是 early access，Claude Code 更新時可能需要跟著調整。

## 解除安裝

```bash
./uninstall.sh
```

設定檔和模型會留在 `~/.claude/voice-dictation`，不要了就自己刪掉。

## 授權

程式碼採 MIT 授權。本機模型由 `install.sh` 從 [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 下載，沒有放在這個 repo 裡；模型授權見 [FunASR 的模型授權條款](https://github.com/modelscope/FunASR?tab=readme-ov-file#license)。
