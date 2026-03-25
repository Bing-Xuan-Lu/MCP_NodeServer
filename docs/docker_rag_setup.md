# Docker 選用元件 — 設定參考

## Python 執行環境

```bash
# 啟動 Python 容器（一次性）
cd D:\MCP_Server\python && docker compose up -d

# 安裝額外套件
docker exec python_runner pip install 套件名稱
```

容器名稱：`python_runner`（Python 3.12-slim），`restart: unless-stopped`。

---

## RAG 向量檢索（ChromaDB）

- **版本**：`1.5.5`（docker-compose.yml 已鎖定，禁止用 `:latest`）
- **Embedding**：ChromaDB 伺服器端處理（`paraphrase-multilingual-MiniLM-L12-v2`），Node.js 不載入 ONNX
- **持久化路徑**：`D:/Project/ChromaDB` → 容器 `/data`

### 首次設定

```bash
cd D:\MCP_Server\chromadb && docker compose up -d
curl http://localhost:8010/api/v2/heartbeat
```

### Admin UI（http://localhost:3100/setup）

| 欄位 | 值 |
|------|------|
| Chroma connection string | `http://chromadb:8000` |
| Tenant | `default_tenant` |
| Database | `default_database` |
| Authentication Type | No Auth |

### 索引指令

```
rag_index  { project: "{ProjectFolder}", paths: ["{ProjectFolder}/cls/", "{ProjectFolder}/ajax/"] }
rag_query  { project: "{ProjectFolder}", query: "自然語言描述" }
rag_status { project: "{ProjectFolder}" }
rag_status {}   # 列出所有 collections
```

- 再跑同一 `rag_index` = 增量索引（只處理變更）
- 強制全部重建：加 `force: true`
- 每個專案一個 collection（`rag_{ProjectFolder}`），另有 `rag_shared` 跨專案共用

### 索引內容對照

| 內容類型 | 做法 |
|----------|------|
| PHP/JS/CSS 程式碼 | `rag_index` 直接掃描 |
| 規格書（`.md` 快照） | 先 `/axshare_spec_index` → 再 `rag_index` |
| XD/Figma 設計稿 | 不索引，用 `/design_diff` |
| Word/PDF 文件 | 不支援，用 `read_word_file` / `read_pdf_file` |

### 典型工作流程（含規格書）

1. `/axshare_spec_index` 爬規格書 → 產出 `spec_reference.md`
2. `rag_index` 一次索引程式碼 + 規格 `.md`
3. 開發中：`rag_query` 同時搜尋程式碼和規格
4. 規格更新時：重跑步驟 1 → 增量 `rag_index`

### 有用參數

`filter_path`（限縮目錄）、`filter_language`（限縮語言）、`n_results`（回傳數量）
