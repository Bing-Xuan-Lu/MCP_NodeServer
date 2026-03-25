---
name: 禁止盲讀大檔案，先定位再讀
description: 不確定內容位置時禁止直接 Read 整個大檔案，必須先用 Grep/RAG/codemap 定位行號再帶 offset/limit 讀取
type: feedback
---

禁止盲讀 500+ 行的檔案。不確定內容在哪時，先定位再讀。

**Why:** 直接 Read 一個大 PHP 檔案（如 900 行的前台頁面）只為了找一個函式，會消耗大量 token 且絕大部分內容無用。

**How to apply:**
- **< 200 行**：可一次讀完
- **200-500 行**：如果只需其中一段，Grep 找行號 → `Read(offset, limit)` 只讀需要的區段
- **500+ 行**：必須先定位（Grep / rag_query / codemap）→ 再帶 offset/limit 讀取
- **2000+ 行**：禁止一次讀完，必須分段
- 有 RAG 索引時優先 `rag_query`，回傳的 chunk 已經是精準片段，不需再 Read 整檔
- 有 `codemap.md` 時直接查函式行號，跳過 Grep 步驟
