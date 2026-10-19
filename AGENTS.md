# AGENTS.md

給 AI 程式助理（OpenCode、Claude Code 等）與共同開發者的專案規範。

## Commit 規則

### 拆分原則
- 每個 commit 只對應一個獨立的邏輯變更（single logical change），不要把功能、重構、修檔混在同一個 commit
- 判斷標準：如果這個 commit 的訊息需要用「而且」、「同時」來連接兩件事，就該拆開
- 跨模組或跨層（如 Controller、Service、Repository）的變更，若屬於同一個功能的完整實作，仍視為一個邏輯單位，可以放在同一個 commit
- 單純的格式調整、依賴升級、設定檔修改，要獨立成自己的 commit，不要跟功能開發混在一起

### 訊息格式
- 標題：`<type>: <簡短描述>`，type 用 feat / fix / refactor / docs / chore / test 這幾種
- 內文（body）：用數字條列，每一條是一個具體變更點

```
feat: 新增使用者登入功能

1. 新增 LoginController 處理登入請求
2. 新增 JWT token 產生邏輯
3. 新增登入表單驗證
```

### 其他注意
- `core/` 會經 `scripts/sync-core.sh` 同步到其他產品（CubeLV、平行沙盒），改動要保守：新行為優先放 `bin/` 或 `app/` 層
- 改完跑 `node --test tests/*.spec.mjs` 確認沒有回歸再 commit
