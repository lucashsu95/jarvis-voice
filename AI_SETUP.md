# 給 AI 的設定指南：幫使用者填專有名詞並測試

你是使用者的 AI 助理（Claude Code、Codex、ChatGPT 或其他都可以）。使用者已經裝好並開著「全語音輸入」小程式，現在要你幫他把**他自己常講的專有名詞**寫進詞彙表，再實際測試，讓全語音輸入轉出來的字更準。照下面步驟做，做完回報結果。

## 要動的檔案

都在 `~/.voice-dictation/`。改完存檔，全語音輸入幾秒內就會套用，不用重開。

| 檔案 | 內容 |
|---|---|
| `vocabulary.txt` | 專有名詞，一行一個，`#` 後面是註解。用 OpenAI 引擎時會當成 `keywords` 送出 |
| `config.json` | 設定檔；這次要動的是 `openai.prompt`、`openai.languages`、`replacements` |
| `test-sentences.txt` | 測試句，一行一句，`#` 後面是註解 |

測試指令在小程式的程式資料夾裡，預設是 `~/voice-dictation`：

```bash
node ~/voice-dictation/bin/vocab-test.mjs          # 用 macOS 合成語音念測試句
node ~/voice-dictation/bin/vocab-test.mjs --mic    # 使用者自己念
```

## 步驟

### 1. 找出使用者常講的詞

先從**使用者自己打過、寫過的字**找，因為那就是他會講的話。依你拿得到的來源：

- **Claude Code 的對話紀錄**：`~/.claude/projects/**/*.jsonl`。只取使用者親自打的訊息，也就是 `type` 是 `user`、`turnOrigin` 是 `human`、`isSidechain` 不是 true 的那幾行；工具輸出和系統訊息都不要。抽法可以參考：

  ```python
  import json, glob, os, time
  cutoff = time.time() - 60 * 86400
  for path in glob.glob(os.path.expanduser('~/.claude/projects/**/*.jsonl'), recursive=True):
      if os.path.getmtime(path) < cutoff: continue
      for line in open(path, 'rb'):
          if b'"turnOrigin":"human"' not in line: continue
          d = json.loads(line)
          c = d.get('message', {}).get('content')
          if isinstance(c, str) and not d.get('isSidechain') and len(c) <= 400:
              print(c.replace('\n', ' '))
  ```

- **Codex 的紀錄**：`~/.codex/sessions/`。
- **ChatGPT 匯出的資料**，或使用者給你的筆記、專案文件、README、公司名單。
- 直接問使用者：他做什麼工作、常提到哪些產品、公司、同事、工具。

統計詞頻，英文詞和中文詞分開算，再挑出專有名詞。

### 2. 挑詞的原則

**要放：**
- 產品、公司、品牌名，例如 CubeLV、TestFlight、AStockTeam。
- 英文術語和縮寫，例如 session、prod、onboarding、PR、e2e。
- 程式元件、檔名、指令，例如 cli_worker、item_server。
- 中文裡的專有用語和容易聽錯的同音詞，例如 部署（容易聽成「部屬」）、鑲嵌卡、側欄。
- 使用者自己的簡稱，例如「PS」代表某個產品。

**不要放：**
- 一般中文詞（處理、確認、測試這類，本來就聽得懂）。
- 個資：email、帳號、電話、密碼、金鑰。
- 打錯的字，以及髒話。
- 人名：先問過使用者再放。

**數量：** 50–200 個就好。太多、太雜，反而可能讓模型轉出沒講的詞。

### 3. 寫進設定

- **`vocabulary.txt`**：分類寫，加上註解說明出處或意思。
- **`config.json` 的 `openai.prompt`**：用一兩句話描述場合，例如「台灣工程師用中文夾英文對 AI 程式助理口述指令，內容是某某產品的開發與營運」。不要把詞彙清單塞進 prompt，詞彙放 `vocabulary.txt` 就好。
- **`config.json` 的 `openai.languages`**：填使用者會講的語言，例如台灣中文夾英文就是 `["zh-tw", "en"]`。
- **`config.json` 的 `replacements`**：測試後仍然固定錯的寫法才放這裡，例如 `{ "部屬": "部署" }`。

只改上面這幾個欄位，`engine`、key 等其他設定不要動。

### 4. 寫測試句

在 `test-sentences.txt` 寫 10–15 句：
- 用使用者平常講話的口氣，最好直接改寫他打過的句子。
- 每句帶 1–3 個詞彙表裡的詞。
- 也要涵蓋中英夾雜的句子。

### 5. 測試、調整、再測

跑 `node ~/voice-dictation/bin/vocab-test.mjs`。它會把每一句「不加詞彙」和「加詞彙」各轉一次，跟原文比對，另外再跑一句不含專有名詞的一般句和一段雜音，檢查會不會冒出沒講的詞。

依結果調整：

| 狀況 | 怎麼改 |
|---|---|
| 加了詞彙還是錯 | 確認那個詞有在 `vocabulary.txt`；還是固定錯成同一種寫法，就加進 `replacements` |
| 出現「沒講卻出現」的詞 | 把那個詞從詞彙表拿掉，或換成更具體的寫法 |
| 一般句或雜音轉出了詞彙 | 詞彙太多或太泛，刪掉一般性的詞 |

注意：合成語音念英文縮寫常常念錯（例如把 dev 念成怪音），這類錯誤不代表真人講也會錯，最後要用使用者自己的聲音確認。

### 6. 請使用者親自念一次

請使用者在終端機跑 `node ~/voice-dictation/bin/vocab-test.mjs --mic`。指令每次印出一句，使用者念完停一下，就會換下一句。用真人聲音的結果才是準的；有錯就照第 5 步再調。

### 7. 回報

告訴使用者這幾件事：
- 詞彙表有幾個詞、分成哪幾類。
- 加詞彙前後的整句全對數，以及平均字錯誤率。
- 有沒有代造詞（沒講卻出現的詞）。
- 還有哪些詞容易錯，建議他之後怎麼加。
