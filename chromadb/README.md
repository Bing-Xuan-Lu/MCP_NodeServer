# ChromaDB — 本機 RAG 向量資料庫

本目錄包含 ChromaDB 及其 Admin UI 的 Docker Compose 設定。
為選用元件，不啟用時 MCP Server 的其他工具完全不受影響。

---

## 啟動 / 停止

```bash
cd chromadb

# 啟動（背景執行）
docker compose up -d

# 停止
docker compose down
```

---

## 服務一覽

| 服務 | 對外 Port | 用途 |
|------|-----------|------|
| ChromaDB API | `http://localhost:8010` | MCP 工具 `rag_index` / `rag_query` 呼叫此端點 |
| Admin UI | `http://localhost:3100` | 瀏覽器管理介面，查看 collections / 搜尋向量 |

資料持久化路徑：`D:\Project\ChromaDB`（掛載到容器 `/data`）

---

## Admin UI 初次設定（localhost:3100/setup）

首次開啟 Admin UI 時會顯示連線設定頁，填寫方式如下：

| 欄位 | 填入值 | 說明 |
|------|--------|------|
| **ChromaDB URL** | `http://chromadb:8000` | Docker 內部網路名稱，Admin UI 容器透過此名稱連線到 ChromaDB |

> 注意：不要填 `localhost:8010`，那是從宿主機存取的 Port，Admin UI 容器在 Docker 網路內部，要用服務名稱 `chromadb:8000`。

填完點 **Save / Connect**，成功後會顯示現有的 collections 清單。

---

## 啟動狀態說明

執行 `docker compose up -d` 後的正常輸出範例：

```
✔ Image chromadb/chroma:1.5.5             Pulled
✔ Image fengzhichao/chromadb-admin:latest Pulled
✔ Network chromadb_default                Created
✔ Container dev-chromadb                  Created
✔ Container dev-chromadb-admin            Created
! chromadb-admin  The requested image's platform (linux/arm64/v8) does not match...
```

**最後那個 `!` 警告是正常的**，代表 `chromadb-admin` image 是為 ARM 架構打包，
在 x86 主機上透過模擬執行。Admin UI 仍可正常使用，僅首次啟動可能稍慢。

ChromaDB 本體（`dev-chromadb`）無此問題，正常 x86 image。

---

## 驗證是否正常運作

```bash
# 確認容器狀態
docker ps | grep dev-chroma

# 測試 API 是否回應（應回傳版本資訊 JSON）
curl http://localhost:8010/api/v2/version
```

---

## 什麼時候需要 ChromaDB？

ChromaDB 是**語義向量搜尋**，讓你用自然語言描述找程式碼，而不是靠關鍵字。

| 工具 | 適用場景 |
| ---- | ------- |
| **Grep** | 知道函式名、變數名、關鍵字 |
| **RAG / ChromaDB** | 不知道在哪個檔案，只知道「這段邏輯做什麼事」 |

典型情境：大型 PHP legacy 專案（幾百個檔案、命名混亂），先用 `rag_index` 索引整個專案，
之後下「找處理訂單折扣的邏輯」就能直接定位，不用漫無目的翻檔案。

### MCP_NodeServer 本身需要嗎？

**不需要。** 這個專案檔案少、目錄結構清晰、工具模組命名直觀，Grep 就夠用。

RAG 的真正目標是透過這個 MCP Server 服務的**客戶 PHP 專案**（`D:\Project\...`），不是 MCP Server 本身。
可以先不啟動 ChromaDB，等在某個大型 PHP 專案遇到「找不到邏輯在哪」的痛點時再開。

---

## 與 MCP 工具的關係

MCP 工具 `rag_index` / `rag_query` / `rag_status` 預設連線到 `http://localhost:8010`。
ChromaDB 未啟動時這三個工具會回傳錯誤，但不影響其他 MCP 工具正常運作。

使用時機（建議）：
- 開發 / 調整程式碼完成後、執行測試 Skill 前（`/php_crud_test`、`/project_qc` 等）
- 索引範圍精確指定子目錄，不可整個根目錄一把抓
- 詳細使用規則見主專案 `CLAUDE.md` 的「RAG 使用規則」章節
