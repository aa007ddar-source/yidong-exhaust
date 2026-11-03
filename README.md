# 毅東工程 Exhaust

Cloudflare Pages 網站（exhaust 派點核准查詢、每日施工、已完工機台、會勘紀錄）。

Cloudflare Workers（含靜態檔案）網站：https://yidong-exhaust.aa007ddar.workers.dev

- `_worker.js`：`/api/*` 資料 API，其餘交給靜態檔案
- `public/index.html`：前端單頁
- `public/core.js`：截圖文字解析、族譜索引、核對狀態
- `public/data.json`、`public/img/`：初始資料與核准截圖
- `wrangler.jsonc`：綁定 KV `DB`、Workers AI `AI`；機密 `EDIT_PASSWORD` 在 Cloudflare 後台設定

推送到 `main` 後 Workers Builds 會自動執行 `npx wrangler deploy`。
