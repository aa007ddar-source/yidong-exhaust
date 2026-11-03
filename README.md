# 毅東工程 Exhaust

Cloudflare Pages 網站（exhaust 派點核准查詢、每日施工、已完工機台、會勘紀錄）。

- `index.html`：前端單頁
- `core.js`：截圖文字解析、族譜索引、核對狀態
- `_worker.js`：`/api/*` 資料 API（需要 KV 綁定 `DB`、Workers AI 綁定 `AI`、機密變數 `EDIT_PASSWORD`）
- `data.json`、`img/`：初始資料與核准截圖

推送到 `main` 後 Cloudflare Pages 會自動部署（不需建置指令，輸出目錄為根目錄）。
