# 全語音輸入（macOS）

<img src="design/icon-big.png" width="96" alt="全語音輸入的選單列圖示：循環箭頭包住三條聲波">

開著就自動收音：你講完一句（停頓約 0.85 秒），那句就貼進游標所在的輸入框。不管是 Claude、ChatGPT、瀏覽器、LINE、備忘錄，在哪裡講，字就進哪裡。只貼不送出，要送自己按 Enter。

分三層，後兩層從選單打開：

1. **全語音輸入**：講完一句就貼。
2. **AI 整理**（像 [Typeless](https://www.typeless.com)）：一段話講完，帶上游標前後的字、app、視窗、網址交給 AI，整理成你本來想打的字再寫進去（去贅字、改口只留結果、條列、依 app 調語氣、專有名詞）。AI 可以選 OpenAI、DeepSeek、Claude。
3. **不用先點輸入框**：游標不在輸入框時，自動挑對的輸入框寫進去；講「進到台積電的個股頁」這類指令，直接操作 app。決策用 [Jev](https://typesafe.ai)（沒有 Jev 就改問 AI）。

架構與實測數字見 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 兩個步驟

**第一步：裝好、打開小程式**

```bash
git clone https://github.com/urusaqqrun/voice-dictation.git ~/voice-dictation
cd ~/voice-dictation
./install.sh openai   # 用 OpenAI 轉寫（最準）；不想花錢就用 ./install.sh local
```

裝完選單列會出現麥克風圖示。第一次用要給兩個權限，都只要一次：

1. **麥克風**：跳出「全語音輸入想要取用麥克風」時按允許。
2. **輔助使用**（貼上要用）：第一次講話時會跳出詢問，到「系統設定 → 隱私權與安全性 → 輔助使用」打開「全語音輸入」。

用 `openai` 要給 key：在 `~/.voice-dictation/config.json` 的 `openai` 裡加上 `"apiKey": "sk-..."`，或用 `"apiKeyFile"` 指向放 key 的檔案。

**第二步：請你的 AI 填專有名詞並測試**

每個人常講的產品名、英文縮寫、公司內部用語都不一樣，這些詞最容易被聽錯。打開你常用的 AI（Claude Code、Codex、ChatGPT 都可以），把這句話貼給它：

> 請照 ~/voice-dictation/AI_SETUP.md 幫我設定全語音輸入的專有名詞，並跑測試給我看結果。

AI 會從你打過的字裡找出常講的詞，寫進 `~/.voice-dictation/vocabulary.txt`，然後跑測試，比較加詞彙前後的準度。實測 4 句中英夾雜的開發用語：不加詞彙整句全對 1/4，加了 4/4（「平行沙河」變回「平行沙盒」、「香芹卡」變回「鑲嵌卡」）。

## 平常怎麼用

- **選單列圖示**：一個循環箭頭包住三條聲波（自動＋聲音）。固定寬度、跟其他選單列圖示同色，只換箭頭裡面的東西：
  - 三條聲波：收音中。
  - 聲波變高：聽到你講話。
  - 打勾：剛貼好。
  - 叉叉：游標不在輸入框，這句沒貼。
  - 聲波變淡：待命（最前面的 app 不收音）。
  - ‖：暫停。
  - 驚嘆號：出錯，點開選單看原因。
- **只貼進輸入框**：游標不在輸入框時（例如在看網頁本身、在 Finder 選檔案）不會貼，圖示會短暫變成叉叉。這時可以點選單的「複製上一句」把那句拿回來。
- **開會時不收音**：Zoom、Teams、FaceTime、Webex 在最前面時不收音。旁邊有人講話、在放影片，就按選單的「暫停收音」。
- **選單**：暫停／繼續、複製上一句、換回原文、AI 整理（關／OpenAI／DeepSeek／Claude）、自動找輸入框、語音指令、編輯專有名詞、編輯設定檔、說明、結束。

## AI 整理（第二層）

選單「AI 整理」選一家就開，選「關」就回到一句一句貼。開著時：

- **一段一段整理**：停超過 1.8 秒算一段講完，停下後約 3 秒出字。
- **整理內容**：
  - 去掉「嗯、那個、然後然後」。
  - 「三點，不對，四點」只留四點。
  - 講「第一、第二」排成條列；講「換行」就換行。
  - 補標點、台灣正體，英文照英文寫，不翻譯。
  - 專有名詞照詞彙檔的寫法。
- **看游標前後**：接在半句話後面就接下去，後面還有字就不加句號。
- **依 app 調語氣**：聊天口語、email 正式、給 AI 的指令精準、文件精簡。可以用 `ai.styles` 改。
- **改選取的字**：選起來講「改正式一點」「縮短」「翻成英文」。
- **用講的修正**：講「刪掉剛剛那句」「換回原文」，或點選單「換回原文」，把上一段換回轉寫原稿。
- **自動學詞**：貼上後你自己改掉的專有名詞，會自動加進詞彙檔的「自動學到」區。
- **歷史**：存在 `~/.voice-dictation/history.jsonl`，只在你的電腦。
- **送給 AI 的內容**：游標前後各 400 字、選取的字、app、視窗標題、網址。密碼欄和密碼管理 app 不送。

| 選項 | 預設模型 | 速度（實測中位數） | 費用 |
|---|---|---|---|
| DeepSeek | `deepseek-flash` | 0.75 秒 | 每段約 0.00004 美元（平日台灣 9–12、14–18 點加倍） |
| Claude | `claude-haiku-5-5` | 0.85 秒 | 每段約 0.00004 美元 |
| OpenAI | `gpt-6-luna` | 1.1 秒 | 每段約 0.00003 美元 |

一天口述 1 小時，AI 整理一個月不到 1 美元。

## 自動找輸入框、語音指令（第三層）

- **自動找輸入框**：游標不在輸入框時，挑視窗裡要寫的輸入框，對焦後寫進去。搜尋框、密碼框、網址列不選；分不出要寫哪個就不寫。
- **語音指令**（要先開 AI 整理）：游標不在輸入框時講「進到台積電的個股頁」「打開設定」「搜尋鴻海」，直接操作最前面的 app：
  - 每一步列出畫面上的按鈕、連結、輸入框，由決策器挑要點哪個、填哪裡、按 Enter。
  - 刪除、送出、付款、下單、登出這類按鈕不會點。
  - 不確定就停下來。
  - 開頭講「指令，……」時，游標在輸入框裡也當指令。
- **決策器**：
  - 有 Jev key（`jev`）就用 Jev，一次約 0.2 秒。
  - 沒有就改問 AI 整理那家，一次約 1 秒。

## 轉寫引擎

| 引擎 | 準度 | 費用 | 聲音送去哪 |
|---|---|---|---|
| `openai`（`gpt-transcribe`，預設） | 最準，吃專有名詞 | 每分鐘 0.0045 美元；一天講 1 小時、一個月約 7.4 美元 | OpenAI |
| `openai`（`gpt-live-transcribe`） | 稍差 | 每分鐘 0.017 美元 | OpenAI |
| `local`（SenseVoice-Small） | 中文不錯，英文較弱，不吃專有名詞 | 免費 | 不離開你的電腦 |
| `parallelsandbox` | 同 `gpt-live-transcribe` | 依平行沙盒的方案 | 平行沙盒，再轉給 OpenAI |

只有判定是人聲的片段才會送去轉寫，安靜時什麼都不送。費用已經算進每句前後多帶的約 1.25 秒。換引擎就跑 `./install.sh <引擎>`，或直接改設定檔，存檔後幾秒內就會套用。

## 設定檔

位置在 `~/.voice-dictation/config.json`，沒寫的欄位照預設：

```json
{
  "engine": "openai",
  "output": "traditional",
  "replacements": { "部屬": "部署" },
  "openai": {
    "apiKeyFile": "~/secrets/openai.env",
    "model": "gpt-transcribe",
    "languages": ["zh-tw", "en"],
    "prompt": "台灣工程師用中文夾英文口述，內容是軟體開發與產品營運。"
  }
}
```

| 欄位 | 說明 |
|---|---|
| `engine` | `openai`、`local`、`parallelsandbox` |
| `apps` | 只在這些 app 收音（bundle id），預設 `["*"]` 全部 |
| `excludeApps` | 這些 app 在最前面時不收音，預設是開會、通話用的 app |
| `output` | `traditional`（台灣正體）、`simplified`、`original` |
| `replacements` | 轉出來的字固定替換，給測試後仍然固定錯的寫法用 |
| `openai.model` | `gpt-transcribe`（預設，整句送出）或 `gpt-live-transcribe`（即時） |
| `openai.apiKey`／`openai.apiKeyFile` | key 本身，或放 key 的檔案（整個檔案就是 key，或含 `OPENAI_API_KEY=` 的 .env）；都沒有就讀環境變數 `OPENAI_API_KEY` |
| `openai.languages` | 預期的語言，例如 `["zh-tw", "en"]` |
| `openai.prompt` | 一兩句話描述場合，不要塞詞彙清單 |
| `openai.vocabularyFile` | 專有名詞檔，預設 `~/.voice-dictation/vocabulary.txt`，一行一個詞 |
| `local.language` | `auto` 或 `zh`、`en`、`yue`、`ja`、`ko` |
| `ai.enabled`／`ai.provider` | AI 整理開關；`deepseek`（預設）、`openai`、`claude`。選單可以直接切 |
| `ai.keys`／`ai.keyFiles`／`ai.keyCommands` | 各家的 key、放 key 的檔案、或拿 key 的指令（例如 `aws ssm get-parameter ...`，key 不落地）。都沒有就讀環境變數 `DEEPSEEK_API_KEY`、`ANTHROPIC_API_KEY`；OpenAI 沿用 `openai` 的 key |
| `ai.models` | 換模型，例如 `{ "openai": "gpt-4.1-mini" }` |
| `ai.segmentPauseMs` | 停多久算一段講完，預設 1800 |
| `ai.styles` | 各 app（bundle id）或網站（網域）的語氣，例如 `{ "com.tinyspeck.slackmacgap": "口語、簡短" }` |
| `ai.skipApps` | 不讀上下文、不送 AI 的 app，預設是密碼管理 |
| `ai.history`／`ai.learn` | 本機歷史、自動學詞，預設都開 |
| `autoFocus` | 游標不在輸入框時自動找輸入框 |
| `commands` | 語音指令 |
| `jev.apiKey`／`jev.apiKeyFile`／`jev.apiKeyCommand` | TypeSafe 的 key（環境變數 `TYPESAFE_API_KEY` 也可以） |

## 疑難排解

- **選單列沒有圖示**：打開 `~/Applications/全語音輸入.app`。macOS 26 可以到「系統設定 → 選單列」確認它被允許顯示。
- **圖示是三角形**：點開選單看第一行寫的原因。
- **字沒貼進去**：先確認游標在輸入框裡，再確認「輔助使用」裡有打開「全語音輸入」。
- **看詳細記錄**：`~/.voice-dictation/listen.log`。
- **重新安裝或更新**：`git pull && ./install.sh`。外殼 `app/main.js` 或打包設定沒變就不會重包，權限不用重給；有變的話系統會再問一次麥克風，輔助使用要到設定裡把「全語音輸入」關掉再打開。

## 怎麼運作

- `app/main.js`：選單列小程式的外殼，用 macOS 內建的 `osacompile` 包成 `全語音輸入.app`，不用 Xcode。麥克風與輔助使用權限都算在它頭上。
- `app/ui.js`：選單列的介面，以及帶起常駐程式的邏輯。外殼啟動時才讀進來，所以改它不用重包 app、權限也不用重給；改完從選單「結束」再打開就生效。
- `bin/listen.mjs`：常駐程式。它看哪個 app 在最前面，用 ffmpeg 收音、在本機切句，交給轉寫引擎；AI 整理開著就分段交給 AI，再寫進輸入框或執行指令。
- `bin/engines/`：`batch.mjs`（OpenAI 一般轉寫）、`realtime.mjs`（即時轉寫，OpenAI 或平行沙盒）、`local.mjs`（sherpa-onnx 跑 SenseVoice）。
- `bin/ax-agent.js`：常駐的「輔助使用」小幫手（JXA）。讀上下文、找輸入框、對焦、貼上（暫存剪貼簿 → Cmd+V → 還原，只送給最前面的 app）、選回剛貼的字、列出畫面上的按鈕並操作。
- `bin/editor.mjs`：AI 整理。`bin/decide.mjs`：第三層的決策（Jev）。`bin/commander.mjs`：語音指令。`bin/targeter.mjs`：挑輸入框的規則。`bin/learn.mjs`：自動學詞。
- `bin/vocab-test.mjs`：專有名詞測試（見 [AI_SETUP.md](AI_SETUP.md)）。

## 開發

```bash
npm install
npm test
```

## 解除安裝

```bash
./uninstall.sh
```

設定、詞彙、模型會留在 `~/.voice-dictation`，不要了就自己刪掉。

## 授權

程式碼採 MIT 授權。本機模型由 `install.sh` 從 [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 下載，沒有放在這個 repo 裡；模型授權見 [FunASR 的模型授權條款](https://github.com/modelscope/FunASR?tab=readme-ov-file#license)。
