# MCP NodeServer — 程式設計師的私人 AI 助理員工

Node.js MCP Server，為 Claude Code 提供 **41 個 Skill 指令** 與 **49 個 MCP 工具**，讓 AI 直接讀寫檔案、操作 DB、執行 PHP、部署 SFTP。

> 📊 **[查看技能儀表板 →](https://bing-xuan-lu.github.io/MCP_NodeServer/dashboard.html)**

---

## 前置條件

| 工具 | 版本 | 說明 |
|------|------|------|
| [Node.js](https://nodejs.org/) | 18+ | 執行 MCP Server 必需 |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | 最新版 | Python 容器（`run_python_script`）+ ChromaDB（RAG，選用） |
| [Git](https://git-scm.com/) | 任意版 | Clone 專案 |

### RAG 選用元件的硬體需求

RAG 索引過程會在 CPU 執行 Embedding 模型（paraphrase-multilingual-MiniLM-L12-v2，470MB），對系統資源有額外需求：

| 項目 | 最低需求 | 建議 |
|------|----------|------|
| RAM | 8GB | 16GB+（索引大型專案時 Node.js + ChromaDB 合計約 2-4GB） |
| 磁碟空間 | 1GB | 2GB+（Docker image + 索引資料） |
| CPU | 任意 | 多核心可加速索引（Embedding 為 CPU 密集運算） |

若電腦資源有限，可不安裝 RAG，其他 46 個工具完全不受影響。

---

## 快速開始

```bash
git clone https://github.com/Bing-Xuan-Lu/MCP_NodeServer.git
cd MCP_NodeServer
setup.bat          # 一鍵初始化（npm install + Python 容器 + 部署 Skills）
```

設定 `~/.claude/mcp_settings.json` 或專案根目錄的 `.mcp.json`：

```json
{
  "mcpServers": {
    "project-migration-assistant-pro": {
      "type": "stdio",
      "command": "node",
      "args": ["{YourProjectPath}\\index.js"]  // 請填入 index.js 的絕對路徑
    }
  }
}
```

重啟 Claude Code 後，在對話輸入 `/skill-name` 即可觸發 Skill。

### RAG 向量檢索（選用）

ChromaDB 提供語意搜尋，讓 `rag_query` 從大量檔案中找出最相關的程式碼片段。
不啟用時其他工具完全不受影響。

```bash
# 啟動 ChromaDB 容器（port 8010，restart: unless-stopped 自動常駐）
cd chromadb && docker compose up -d
```

為專案建立索引（首次完整掃描，之後增量）：

```text
rag_index { project: "{ProjectFolder}", paths: ["{ProjectFolder}/"] }
```

查詢：

```text
rag_query { project: "{ProjectFolder}", query: "自然語言描述" }
```

---

## 目錄結構

```text
MCP_NodeServer/
├── index.js             ← MCP Server 主程式
├── config.js            ← resolveSecurePath (預設 basePath 為 D:\Project\)
├── tools/               ← MCP 工具模組
│   ├── filesystem.js    ← list_files, read_file, create_file, apply_diff, *_batch
│   ├── php.js           ← run_php_script, run_php_test, send_http_request, tail_log, *_batch
│   ├── database.js      ← set_database, load_db_connection, get_db_schema, execute_sql, *_batch
│   ├── excel.js         ← get_excel_values_batch, trace_excel_logic, simulate_excel_change
│   ├── bookmarks.js     ← Chrome 書籤管理 (12 工具)
│   ├── sftp.js          ← sftp_connect/upload/download/list/delete, sftp_list_batch
│   ├── python.js        ← run_python_script (via Docker python_runner)
│   ├── word.js          ← read_word_file, read_word_files_batch (.docx → Markdown/HTML/Text)
│   ├── pptx.js          ← read_pptx_file, read_pptx_files_batch (.pptx → Markdown/Text + 圖片)
│   ├── pdf.js           ← read_pdf_file, read_pdf_files_batch (.pdf → Markdown/Text)
│   ├── git.js           ← git_status, git_diff, git_log, git_stash_ops
│   ├── file_to_prompt.js ← file_to_prompt, file_to_prompt_preview
│   ├── rag.js           ← rag_index, rag_query, rag_status（選用，需 ChromaDB）
│   └── skill_factory.js ← save/list/delete_claude_skill, grant/list/revoke_path_access
├── skills/index.js      ← MCP Prompts 路由
├── Skills/commands/     ← Skill MD 檔（12 個部門子資料夾）
├── python/              ← Python Docker 環境（python_runner 容器）
├── chromadb/            ← ChromaDB Docker 環境（RAG 選用）
├── docs/                ← 技能儀表板 (dashboard.html / style.css / script.js)
├── setup.bat            ← 一鍵環境初始化
└── deploy-commands.bat  ← 部署所有 Skills 到 ~/.claude/commands/
```

詳細開發規範見 [CLAUDE.md](CLAUDE.md)。

---

## 第三方依賴與授權

### npm 套件

| 套件 | 授權 | 用途 |
|------|------|------|
| `@modelcontextprotocol/sdk` | MIT | MCP 協議 SDK |
| `mysql2` | MIT | MySQL/MariaDB 連線 |
| `turndown` | MIT | HTML → Markdown 轉換 |
| `mammoth` | BSD-2-Clause | .docx 讀取 |
| `dotenv` | BSD-2-Clause | 環境變數載入 |
| `glob` | BlueOak-1.0.0 | 檔案 pattern 匹配 |
| `chromadb` | Apache-2.0 | ChromaDB 客戶端（RAG） |
| `@chroma-core/default-embed` | Apache-2.0 | ChromaDB Embedding Function |
| `pdfjs-dist` | Apache-2.0 | PDF 讀取 |
| `ssh2-sftp-client` | Apache-2.0 | SFTP 連線 |
| `xlsx` | Apache-2.0 | Excel 讀取 |
| `jszip` | MIT / GPL-3.0 | ZIP 解壓（.pptx 讀取用） |
| `hyperformula` | GPL-3.0 | Excel 公式計算引擎 |

### Docker 映像檔

| 映像檔 | 授權 | 用途 |
|--------|------|------|
| `python:3.12-slim` | PSF License | Python 執行環境 |
| `chromadb/chroma` | Apache-2.0 | RAG 向量資料庫 |
| `fengzhichao/chromadb-admin` | MIT | ChromaDB Admin UI（選用） |

### Embedding 模型

| 模型 | 授權 | 用途 |
|------|------|------|
| `paraphrase-multilingual-MiniLM-L12-v2` | Apache-2.0 | RAG 多語言向量化（免費、本地執行） |
