---
name: PHP 檔批次 regex 禁止砍逗號
description: 批次 regex 對 PHP 檔做「欄位名,」「,欄位名」替換會誤切函式參數列，禁用
type: feedback
originSessionId: b30dbfac-282c-42d4-a7db-a38e0710b93b
---
批次 regex pattern `\b欄位名\s*,` / `,\s*\b欄位名\b`（砍逗號）**禁止直接對 PHP 檔套用**，只能限制在 SQL 字串（heredoc / 雙引號）內。

**Why：** 本輪拔 `confidential_fee` / `secret` / `sender_*` 欄位時，砍逗號 regex 連帶吃掉函式參數列的逗號和 `if(...){` 開頭，產生 `$$payment`（雙 dollar）、孤立 `}`、孤立 `endif`。錯誤不會立刻被 parser 發現，要等 Playwright 撞到 500 才現形，debug 成本極高。

**How to apply：**
- 對 PHP 檔做結構化替換時，**先 Grep 定位每處上下文，再用 apply_diff 精確改**
- 必須大量批次時，用 PHP AST 工具（php-parser / nikic/php-parser）操作，不走 regex
- 批次 regex 只能用在 pure SQL / JSON / 設定檔，或限制在字串 literal 內
- 批次替換後 llm-judge.js PostToolUse 會自動跑 `php -l`；但不應依賴它做安全網，寫法先避開才是王道
