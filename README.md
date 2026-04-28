# MCP NodeServer — 程式設計師的私人 AI 助理員工

Node.js MCP Server，為 Claude Code 打造私人 AI 工具鏈，讓 AI 直接讀寫檔案、操作 DB、執行 PHP、部署 SFTP。詳見 [技能儀表板](https://bing-xuan-lu.github.io/MCP_NodeServer/dashboard/)。

> 📊 **[查看技能儀表板 →](https://bing-xuan-lu.github.io/MCP_NodeServer/dashboard/)**

---

## 前置條件

| 工具 | 版本 | 說明 |
|------|------|------|
| [Node.js](https://nodejs.org/) | 18+ | 執行 MCP Server 必需 |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | 最新版 | Python 容器（`run_python_script`，選用） |
| [Git](https://git-scm.com/) | 任意版 | Clone 專案 |

---

## 快速開始（首次安裝）

```bash
git clone https://github.com/Bing-Xuan-Lu/MCP_NodeServer.git
cd MCP_NodeServer
.\setup.ps1        # 一鍵初始化（npm install + Python 容器 + 部署 Skills）
```

安裝完成後，依下方「新專案掛載」將 MCP Server 接上你的專案，重啟 Claude Code 即可使用。

---

## 新專案掛載

MCP Server 安裝一次即可，每個需要使用的專案只要掛上連線設定。有兩種方式：

### 方式 A：全域設定（推薦）

設定一次，所有專案自動共用，不需逐個專案設定。

編輯 `~/.claude/mcp_settings.json`（不存在則新建）：

```json
{
  "mcpServers": {
    "project-migration-assistant-pro": {
      "type": "stdio",
      "command": "node",
      "args": ["{MCP_NodeServer安裝路徑}\\index.js"]
    }
  }
}
```

> 將 `{MCP_NodeServer安裝路徑}` 替換為 `index.js` 的實際絕對路徑，例如 `D:\\MCP_NodeServer\\index.js`。

### 方式 B：單專案設定

只在特定專案啟用 MCP Server。在該專案的**根目錄**建立 `.mcp.json`：

```json
{
  "mcpServers": {
    "project-migration-assistant-pro": {
      "type": "stdio",
      "command": "node",
      "args": ["{MCP_NodeServer安裝路徑}\\index.js"]
    }
  }
}
```

### 掛載後注意事項

| 項目 | 說明 |
|------|------|
| 重啟 | 設定完成後需**重啟 Claude Code** 才會生效 |
| 路徑存取 | MCP 檔案工具預設只能存取 `D:\Project\` 下的檔案；專案不在此路徑的話，每次對話需先呼叫 `grant_path_access` 授權 |
| DB 連線 | `set_database` 只在當次對話有效，每次新對話需重新設定 |
| Skills | 全域已部署的 `/skill-name` 指令自動可用，不需額外設定 |
| 驗證 | 重啟後在對話中輸入任意 `/skill-name`，能觸發即代表掛載成功 |

### Session Hooks（全域自動生效）

已在 `~/.claude/settings.json` 全域設定，所有專案對話自動觸發：

| Hook | 事件 | 功能 |
| ---- | ---- | ---- |
| `session-start.js` | SessionStart | 對話開場載入 MEMORY.md 摘要、上次 session 快照、24h 內更新的記憶檔、近期踩坑紀錄、CLAUDE.md 老化偵測 |
| `pre-compact.js` | PreCompact | Context 壓縮前自動存快照到 `~/.claude/sessions/`，偵測重試/失敗/大量修改模式並存踩坑紀錄，GC 清舊紀錄 |
| `write-guard.js` | PreToolUse (Write\|Edit) | 依 `risk-tiers.json` 分級警告（🔴 高風險 / 🟡 中風險）、敏感檔案保護、Prompt Injection 偵測（非阻擋式） |
| `llm-judge.js` | PostToolUse (Write\|Edit) | Write/Edit 後依風險層級注入自我審查清單，PHP 非測試檔自動提醒「事故→測試」習慣 |

Hook 腳本存放於 `hooks/` 目錄，設定在全域 `~/.claude/settings.json` 的 `hooks` 欄位。

**全域 vs 專案 Hooks：**

| 設定位置 | 檔案 | 適用範圍 |
| ---- | ---- | ---- |
| 全域 | `~/.claude/settings.json` → `hooks` | 所有專案對話自動觸發 |
| 專案 | `{project}/.claude/settings.json` → `hooks` | 僅該專案對話觸發 |
| 專案本地 | `{project}/.claude/settings.local.json` → `hooks` | 同上，不進版控 |

本專案的 3 個 hooks 設定在**全域**，因為 session 記憶載入與敏感檔案防護不限於特定專案。
若需要專案專屬 hook（如特定專案的 lint 檢查），可在該專案的 `.claude/settings.json` 另行設定。

---

## 目錄結構

```text
MCP_NodeServer/
├── index.js             ← MCP Server 主程式
├── config.js            ← resolveSecurePath (預設 basePath 為 D:\Project\)
├── tools/               ← MCP 工具模組
│   ├── filesystem.js    ← list_files, read_file, create_file, apply_diff, apply_diff_batch, *_batch (read_files/list_files/create_file)（PROTECTED_PATTERNS 防寫入測試檔 + audit log）
│   ├── php.js           ← run_php_script, run_php_code, run_php_test, send_http_request, tail_log, *_batch (http_requests/php_script)（PHP 執行 + tail_log 支援 container 參數走 Docker）
│   ├── database.js      ← set_database, load_db_connection, get_db_schema, execute_sql（危險語句攔截 + confirm + audit log + ER_* 錯誤摘要）, *_batch, schema_diff, mysql_log_tail
│   ├── excel.js         ← get_excel_values_batch, trace_excel_logic, simulate_excel_change
│   ├── bookmarks.js     ← Chrome 書籤管理 (12 工具)
│   ├── sftp.js          ← sftp_connect/upload/download/list/delete, sftp_*_batch (list/upload/download/delete), sftp_preset
│   ├── python.js        ← run_python_script (via Docker python_runner)
│   ├── word.js          ← read_word_file, read_word_files_batch (.docx → Markdown/HTML/Text)
│   ├── pptx.js          ← read_pptx_file, read_pptx_files_batch (.pptx → Markdown/Text + 圖片)
│   ├── pdf.js           ← read_pdf_file, read_pdf_files_batch (.pdf → Markdown/Text)
│   ├── images.js        ← read_image, read_images_batch（圖片讀取 + 縮放，支援 PNG/JPG/WebP/GIF/SVG）
│   ├── git.js           ← git_status, git_diff, git_log, git_stash_ops（支援 container 參數走 Docker）
│   ├── dom_compare.js   ← dom_compare（批次比對兩個 URL 的 CSS/HTML/JS 差異，需 Playwright）
│   ├── playwright_tools.js ← browser_interact, page_audit, css_inspect, element_measure, style_snapshot, css_coverage, browser_save_session, browser_restore_session（自帶 headless 瀏覽器，需 Playwright）
│   ├── image_diff.js    ← image_diff（設計稿 vs 截圖像素級比對，產生 diff 圖）
│   ├── image_transform.js ← image_transform（圖片 resize / 背景色 / 圓形裁切 / 合成）
│   ├── agent_coord.js   ← agent_coord（多 Agent 協調：post/poll/status/delete/archive，JSON 檔案持久化）
│   ├── file_to_prompt.js ← file_to_prompt, file_to_prompt_preview
│   ├── css_tools.js     ← css_specificity_check, css_computed_winner（CSS specificity 分析與活頁面規則勝出查詢）
│   ├── php_class.js     ← class_method_lookup（PHP class/method 原始碼直接定位，自動解析 use Trait）
│   ├── php_symbol.js    ← symbol_index, find_usages, find_hierarchy, find_dependencies, trace_logic（PHP AST 符號索引、交叉引用、邏輯追蹤）
│   └── skill_factory.js ← save/list/delete_claude_skill, grant/list/revoke_path_access
├── skills/index.js      ← MCP Prompts 路由
├── Skills/commands/     ← Skill MD 檔（12 個部門子資料夾）
├── python/              ← Python Docker 環境（python_runner 容器）
├── hooks/               ← Claude Code Session Hooks（全域生效）
│   ├── session-start.js ← SessionStart：對話開場自動載入記憶與上次摘要
│   ├── pre-compact.js   ← PreCompact：context 壓縮前存快照 + 踩坑偵測 + GC
│   ├── write-guard.js   ← PreToolUse(Write|Edit)：risk-tiers 分級警告 + Prompt Injection 偵測
│   └── llm-judge.js     ← PostToolUse(Write|Edit)：自我審查清單觸發器
├── docs/                ← 舊版技能儀表板 (備份)
├── dashboard/           ← 新版動態技能儀表板 (index.html / js / style.css)
├── setup.ps1            ← 一鍵環境初始化
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
| `pdfjs-dist` | Apache-2.0 | PDF 讀取 |
| `ssh2-sftp-client` | Apache-2.0 | SFTP 連線 |
| `xlsx` | Apache-2.0 | Excel 讀取 |
| `jszip` | MIT / GPL-3.0 | ZIP 解壓（.pptx 讀取用） |
| `hyperformula` | GPL-3.0 | Excel 公式計算引擎 |
| `php-parser` | BSD-3-Clause | PHP AST 解析（符號索引） |

### Docker 映像檔

| 映像檔 | 授權 | 用途 |
|--------|------|------|
| `python:3.12-slim` | PSF License | Python 執行環境 |

### Embedding 模型

| 模型 | 授權 | 用途 |
|------|------|------|
| `paraphrase-multilingual-MiniLM-L12-v2` | Apache-2.0 | RAG 多語言向量化（免費、本地執行） |

---

## License

MIT License © 2024 Bing-Xuan Lu

詳見 [LICENSE](LICENSE)。
