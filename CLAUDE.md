# CLAUDE.md — MCP_NodeServer 專案指引

Node.js MCP Server，提供 Claude Code 工具能力與 Agent Skills。
名稱：`project-migration-assistant-pro` v5.1.0

---

## 目錄結構

```text
MCP_NodeServer/
├── index.js             ← MCP Server 主程式（工具路由 + Skills 路由）
├── config.js            ← resolveSecurePath()，basePath = D:\Project\
├── .mcp.json            ← MCP Server 設定（Claude Code 自動讀取）
├── tools/               ← MCP 工具模組（各自匯出 definitions + handle）
│   ├── filesystem.js    ← list_files, read_file, create_file, apply_diff, read_files_batch, list_files_batch
│   ├── php.js           ← run_php_script, run_php_test, send_http_request, tail_log, send_http_requests_batch
│   ├── database.js      ← set_database, load_db_connection, get_current_db, get_db_schema, execute_sql, get_db_schema_batch, execute_sql_batch
│   ├── excel.js         ← get_excel_values_batch, trace_excel_logic, simulate_excel_change
│   ├── bookmarks.js     ← Chrome 書籤管理（12 個工具）
│   ├── sftp.js          ← sftp_connect, sftp_upload, sftp_download, sftp_list, sftp_delete, sftp_list_batch
│   ├── skill_factory.js ← save/list/delete_claude_skill, grant/list/revoke_path_access
│   ├── python.js        ← run_python_script (Docker)
│   ├── word.js          ← read_word_file, read_word_files_batch (.docx → Markdown/HTML/Text)
│   ├── pptx.js          ← read_pptx_file, read_pptx_files_batch (.pptx → Markdown/Text + 圖片)
│   ├── pdf.js           ← read_pdf_file, read_pdf_files_batch (.pdf → Markdown/Text)
│   ├── git.js           ← git_status, git_diff, git_log, git_stash_ops
│   ├── file_to_prompt.js ← file_to_prompt, file_to_prompt_preview
│   └── rag.js            ← rag_index, rag_query, rag_status（需 ChromaDB Docker，選用）
├── chromadb/             ← ChromaDB Docker 環境（RAG 選用，docker-compose.yml）
├── skills/index.js      ← MCP Prompts 路由（注意：小寫 skills，不是 Skills）
└── Skills/              ← Skill MD 檔
    ├── *_agent.md       ← MCP Prompts 內容
    └── commands/        ← 斜線指令（部署到 ~/.claude/commands/，flat）
        ├── _skill_template.md  ← 撰寫新 Skill 前必讀
        ├── php_dev/     ← PHP 開發部
        ├── migration/   ← 程式移植部
        ├── testing/     ← 測試品管部
        ├── spec/        ← 規格分析部
        ├── db_planning/ ← 資料庫規劃部
        ├── deploy/      ← 部署維運部（sftp）
        ├── docker/      ← Docker 維運部
        ├── dev_workflow/← 開發流程部
        ├── tooling/     ← 系統工具部
        ├── claude_ops/  ← Claude 維運部（Skill 管理、MCP 維護）
        ├── content/     ← 內容擷取部
        ├── life/        ← 生活自動化部（n8n, youtube）
        └── _internal/   ← 私有 Skill（.gitignore 排除，不進版控）
```

---

## 重要限制

- MCP 檔案工具 basePath = `D:\Project\`（路徑相對此目錄，不加磁碟路徑）
- 存取其他路徑：先呼叫 `grant_path_access`（重啟後清空）
- DB 連線（`set_database`）只在當次對話有效，重啟後需重新設定
- 書籤操作前需先關閉 Chrome

---

## Docker 選用元件

以下元件皆為選用，不啟用時其他工具完全不受影響。需先確認 Docker Desktop 執行中。

### Python 執行環境（`run_python_script` 工具）

```bash
# 啟動 Python 容器（一次性）
cd D:\MCP_Server\python && docker compose up -d

# 安裝額外套件（視需要）
docker exec python_runner pip install 套件名稱
```

容器名稱：`python_runner`（Python 3.12-slim），設為 `restart: unless-stopped`。

### RAG 向量檢索（`rag_index` / `rag_query` / `rag_status` 工具）

ChromaDB 提供語意搜尋能力，讓 `rag_query` 從大量檔案中找出最相關的程式碼片段。
**不啟用時其他工具完全不受影響。**

- **ChromaDB 版本**：`1.5.5`（docker-compose.yml 已鎖定，禁止用 `:latest`）
- **Embedding**：由 ChromaDB 伺服器端處理（per-collection 指定 `paraphrase-multilingual-MiniLM-L12-v2` 多語言模型），Node.js 不載入 ONNX 模型
- **持久化路徑**：`D:/Project/ChromaDB` → 容器 `/data`（1.0.0 版路徑）

### 首次設定（一次性）

```bash
# 1. 啟動 ChromaDB 容器（port 8010）
cd D:\MCP_Server\chromadb && docker compose up -d

# 2. 確認連線
curl http://localhost:8010/api/v2/heartbeat
```

容器設為 `restart: unless-stopped`，Docker Desktop 執行中即自動啟動。

### Admin UI（瀏覽 collections 內容）

開啟 http://localhost:3100/setup ，填入以下設定後按 Connect：

| 欄位 | 值 |
|------|------|
| Chroma connection string | `http://chromadb:8000` |
| Tenant | `default_tenant`（預設） |
| Database | `default_database`（預設） |
| Authentication Type | No Auth（預設） |

連線後可瀏覽所有 collections、查看切片內容與 metadata。

### 為專案建立索引

```
rag_index { project: "{ProjectFolder}", paths: ["{ProjectFolder}/"] }
```

- 首次索引會掃描整個專案目錄，依副檔名過濾（.php, .js, .ts 等）
- 之後再跑同一指令為**增量索引**，僅處理有變更的檔案
- 強制全部重建：加 `force: true`
- 每個專案一個 collection（`rag_{ProjectFolder}`），另有 `rag_shared` 供跨專案共用

### 索引內容與搭配工具

程式碼與規格書應**一起索引到同一個 collection**，RAG 會透過 `file_path` metadata 自動區分來源：

| 內容類型 | 索引方式 | 說明 |
|----------|----------|------|
| PHP/JS/CSS 等程式碼 | `rag_index` 直接掃描專案目錄 | 自動依副檔名過濾 |
| 規格書（`.md` 快照） | `rag_index` 索引 spec `.md` 檔 | 先用 `/axshare_spec_index` 爬取產生 `.md`，再索引 |
| XD/Figma 設計稿 | **不索引**（視覺內容，無文字可切片） | 用 `/design_diff` 截圖比對 |
| Word/PDF 文件 | 目前不支援直接索引 | 用 `read_word_file` / `read_pdf_file` 即時讀取 |

**典型工作流程（以含規格書的專案為例）：**

1. **首次**：`/axshare_spec_index` 爬規格書 → 產出 `spec_reference.md`
2. **索引**：`rag_index` 一次索引程式碼 + 規格 `.md`
3. **開發中**：Claude 用 `rag_query` 同時搜尋程式碼和規格，直接比對是否一致
4. **規格更新時**：重跑 `/axshare_spec_index` → 再跑 `rag_index`（增量，只處理變更）

### 索引時機

**開發或功能調整結束後、執行測試 Skill 之前**，應先執行增量索引以確保 RAG 資料與程式碼同步。
Claude 在進入測試階段前（如 `/php_crud_test`、`/project_qc`、`/playwright_ui_test` 等）應主動呼叫 `rag_index`。
**若 ChromaDB 未安裝或未啟動，直接跳過索引步驟，不報錯、不阻斷流程。**

### 索引範圍評估（重要）

`rag_index` 前**必須先評估索引範圍**，不可整個專案根目錄一把抓：

1. **paths 精確指定子目錄**：`paths: ["{ProjectFolder}/cls/", "{ProjectFolder}/ajax/"]`，不可省略專案名前綴
2. **先跑 `rag_status`** 確認 collection 是否乾淨（無其他專案檔案混入）
3. **高價值目錄優先索引**：Model（商業邏輯）、AJAX（API 端點）、JS（前台互動）、spec（規格文件）
4. **低價值目錄不索引**：CRUD 模板目錄（後台管理頁面結構可預測，用 Grep 定位更快）、CSS（Grep 找 selector 更有效）、上傳目錄、第三方套件
5. **大型專案分批索引**：`rag.js` 內建自動分批（`AUTO_BATCH_LIMIT = 80`），超過 80 檔自動拆批並在批次間暫停 GC
6. **chunk 參數調整**：PHP legacy 專案函式較長，建議 `chunk_lines: 120`（預設 60 太碎）

### 搜尋策略（RAG vs Grep）

| 場景 | 工具 | 範例 |
|------|------|------|
| 不確定功能在哪個檔案 | `rag_query` | `query: "購物車加入商品邏輯"` |
| 知道具體函式名/變數名 | `Grep` | `pattern: "addReadyCart"` |
| 後台 CRUD 頁面 | 直接 `Read` | `adminControl/{module}/list.php` |
| RAG 結果不相關 | 改用 `Grep` | RAG distance > 0.5 = 不相關 |

**RAG 有用的參數**：`filter_path`（限縮目錄）、`filter_language`（限縮語言）、`n_results`（回傳數量）

### 查詢與狀態

```
rag_query  { project: "{ProjectFolder}", query: "自然語言描述" }
rag_status { project: "{ProjectFolder}" }   # 查看索引統計
rag_status {}                                # 列出所有 collections
```

---

## 環境變數（Git Bash）

Claude Code 在 Windows 上透過 Git Bash 執行指令，部分工具不在預設 PATH 中，需手動補充（已寫入 `~/.bashrc`）：

| 工具 | 路徑 | 用途 |
|------|------|------|
| `gh` | `/c/Program Files/GitHub CLI` | GitHub CLI（PR、Issue、API 操作） |

如遇 `command not found`，先檢查 `~/.bashrc` 是否有對應的 `export PATH` 設定。

---

## 兩套 Skills 系統

**系統 A：MCP Prompts**（較少用）

- 存放：`Skills/*_agent.md`，需在 `skills/index.js` 登記後重啟

**系統 B：斜線指令**（主要）

- 存放：`Skills/commands/{dept_folder}/*.md`（必須放在對應部門子資料夾，不可放根目錄）
- 部署：呼叫 `save_claude_skill` 工具（自動儲存＋部署）或執行 `deploy-commands.bat`
- 觸發：在 Claude Code 輸入 `/skill-name`
- **上限：公開 Skill 總數不超過 60 個**，超過前先用 `/skill_audit` 審查並合併相似技能

**Skills 清單**：見 `docs/dashboard.html` 或對話開始時的 system-reminder。

---

## 新增 Skill 流程

1. 先讀 `Skills/commands/_skill_template.md`（格式規範）
2. 將 MD 檔寫入對應子資料夾（如 `Skills/commands/deploy/sftp_deploy.md`）
3. 部署到 `~/.claude/commands/`（flat，不含子資料夾路徑）：
   - 單檔：`cp Skills/commands/subfolder/skill.md ~/.claude/commands/skill.md`
   - 全部：重跑 `deploy-commands.bat`（自動發現所有公開 Skill）
   - 使用 `save_claude_skill` 工具時**步驟 3 自動完成**，但步驟 4 仍需手動執行
4. 更新 `docs/dashboard.html`（**必做**，不可遺漏）：
   - 在對應部門加入 tag、更新 `dept-count`
   - 更新 section-total 數字與頂部總能力數
   - 在 JS `SKILLS` 物件中新增 click-to-detail 資料
   - **`_internal` Skill 不寫入 dashboard.html**（不加 tag、不計入數字）
5. 重啟 Claude Code

**完成後自我核對（每次新增/修改 Skill 後必做）：**

```text
☐ ~/.claude/commands/skill.md 存在？
☐ dashboard.html tag 已新增？
☐ dept-count 數字已更新？
☐ section-total（skills 數）已更新？
☐ JS SKILLS 物件已新增條目？
☐ Skills/SKILL_INDEX.md 已同步更新？
```

私有 Skill：統一放在 `Skills/commands/_internal/` 資料夾（檔名仍保留 `_internal` 後綴，.gitignore 排除整個資料夾），部署用 `deploy-commands-internal.bat`，**不列入 dashboard.html**

伴隨參考檔：檔名加 `_steps`（如 `playwright_ui_test_steps.md`），由主 Skill 引用，**不獨立部署**

YAML Frontmatter（選用）：在 Skill MD 頂部加入 `name` + `description`，可讓 Claude 在對話中主動建議該 Skill；不需主動建議時可省略。格式見 `_skill_template.md`。

**Frontmatter 使用規範（依部門）**：

| 部門 | Frontmatter | 原因 |
| --- | --- | --- |
| `life/`（生活自動化） | ❌ 不加 | 情境特定，由使用者手動下指令 |
| 其餘部門 | 視需求選用 | 若希望 Claude 主動建議則加 |

---

## 新增 MCP 工具模組

1. 建立 `tools/my_module.js`（匯出 `definitions` + `handle(name, args)`）
2. 在 `index.js` import 並加入 `TOOL_MODULES` 陣列
3. 同步更新三份文件（**必做**，不可遺漏）：
   - **CLAUDE.md** — `tools/` 目錄結構中加入新工具名稱
   - **README.md** — 工具總覽區段（數量、表格列、如有新區段則新增）
   - **dashboard.html** — MCP Tools 區段的 tag + `dept-count` + `section-total` + 頂部總數 + JS `SKILLS` 物件內各 Skill 的 `tools` 陣列
4. 重啟 MCP Server

**完成後自我核對（每次新增/修改 MCP 工具後必做）：**

```text
☐ tools/my_module.js 建立並匯出 definitions + handle？
☐ index.js 已 import 並加入 TOOL_MODULES？
☐ CLAUDE.md tools/ 目錄結構已更新？
☐ README.md 工具表格/數量已更新？
☐ dashboard.html tag 已新增？
☐ dashboard.html dept-count 已更新？
☐ dashboard.html section-total 與頂部總數已更新？
☐ dashboard.html JS SKILLS 物件的 tools 陣列已更新？
☐ MCP Server 已重啟？
```

---

## 注意事項

- `skills/index.js`（小寫）= MCP Prompts 路由；`Skills/`（大寫）= MD 檔目錄，兩者不同
- **所有 Skill MD 必須放在對應部門子資料夾**（`_skill_template.md` 例外）；部署到 `~/.claude/commands/` 才是 flat 結構
- 新增 Skill 後更新 `docs/dashboard.html`（含 JS SKILLS 物件）；**不需修改此 CLAUDE.md**（目錄結構變動除外）
- Playwright MCP：`npm install -g @playwright/mcp@latest`
- **多 Playwright 實例備案（雙 Agent 同時操作瀏覽器）**：在 `.mcp.json` 登記第二個 Playwright MCP，指定不同 `--port`（預設 3000，第二實例用 3001），兩個 session 互不干擾。目前環境僅單實例；如需雙 Agent 並行操作瀏覽器，工程師手動增設後重啟 Claude Code。

  ```json
  {
    "mcpServers": {
      "playwright":  { "command": "npx", "args": ["@playwright/mcp@latest", "--port", "3000"] },
      "playwright2": { "command": "npx", "args": ["@playwright/mcp@latest", "--port", "3001"] }
    }
  }
  ```
- 大型 PHP 專案建議先執行 `/update_codemaps {ProjectFolder}` 產生 `codemap.md`，再開始開發對話，可大幅降低首輪 token 消耗
- **禁止在公開 Skill MD 檔（`Skills/commands/*.md`，排除 `_internal/`）中寫入客戶實際網址、域名、專案名稱、資料表名稱、模組名稱**，範例一律使用 `{ProjectFolder}`、`{TableName}`、`module_a`、`example.com`、`localhost` 等通用佔位符。`reports/` 目錄與 `Skills/commands/_internal/` 下的檔案不受此限。
