---
name: project_rag_chromadb
description: RAG 系統架構決策：ChromaDB Docker + 每專案 collection + 共用 collection
type: project
---

RAG 系統使用 ChromaDB（Docker），為選用元件，不影響其他 MCP 工具。

**Why:** 使用者痛點是「專案太大，不知道該讀哪些檔案」，需要語意搜尋快速定位相關程式碼。

**How to apply:**
- ChromaDB Docker compose 在 `d:\MCP_Server\chromadb\docker-compose.yml`（port 8010，因 8000 被 XAMPP Apache 佔用）
- 使用者私人 Docker 開發環境在 `D:\Project\Docker_Dev\`（MariaDB、PHP 5.6/7.4/8.4、MailPit）
- Collection 策略：每專案獨立 `rag_{project}`（如 `rag_PG_dbox3`）+ 共用 `rag_shared`
- ChromaDB 版本：`1.5.5`（docker-compose.yml 鎖定版本號，禁用 `:latest`）
- 持久化路徑：`D:/Project/ChromaDB` → 容器 `/data`
- Embedding：由 ChromaDB 伺服器端處理（per-collection 指定 `paraphrase-multilingual-MiniLM-L12-v2` 多語言模型），Node.js 不載入 ONNX 模型
- 需額外 npm 套件：`chromadb`（已移除 `@chroma-core/default-embed`，省 ~500MB RAM）
- ChromaDB 不跑時 rag_* 工具回傳提示，其他 44+ 工具不受影響
