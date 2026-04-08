# GEMINI.md - 專案核心規範與專家指令 (Foundational Mandates)

本文件定義 Gemini CLI 在 `D:\MCP_Server` 專案中的最高運作準則。所有開發、測試與維運任務必須優先遵循本規範。

## 🛡️ 安全與誠信規範 (Security & Integrity)
- **憑證保護**：絕對禁止將 API Key、資料庫密碼、SFTP 私鑰或任何敏感資訊記錄於 Log、Commit 或輸出到對話中。
- **環境隔離**：區分 `D:\MCP_Server` (本專案路徑) 與 `D:\Project\` (受控專案路徑)。
- **操作確認**：修改現有功能或執行 DDL 前，必須先說明影響範圍。
- **UI 優化規範**：執行 `ui-ux-pro-max` 優化時，**嚴禁刪除或簡化 HTML 中的資料內容與流程邏輯**。優化應僅限於修改 `style.css` 變數、字體與視覺裝飾。若需重構 HTML 結構，必須先取得使用者明確同意。
- **配色偏好**：優化時應優先詢問使用者配色意圖，不可強制套用 AI 預設配色。
- **隱私脫敏**：**禁止在 Skill MD 檔中寫入客戶實際資訊**。範例一律使用 `{ProjectFolder}`, `{TableName}`, `module_a`, `example.com`, `localhost` 等通用佔位符。（`reports/` 目錄、`memory/_private/` 與 `Skills/commands/_internal/` 下的檔案不受此限）

## 📂 專案架構與目錄結構 (Directory Structure)
```text
MCP_NodeServer/
├── index.js             ← MCP Server 主程式 v5.1.0（工具路由 + Skills 路由）
├── config.js            ← resolveSecurePath()，basePath = D:\Project\
├── setup.ps1            ← 環境初始化與 PowerShell 工具鏈配置
├── .mcp.json            ← MCP Server 設定（Claude/Gemini 自動讀取）
├── memory/              ← 長期記憶與知識庫 (MEMORY.md)
│   ├── feedback/        ← 操作回饋與最佳實踐 (playwright, qc, tooling...)
│   ├── project/         ← 專案特定知識與部署細節
│   ├── reference/       ← 靜態參考資料與外部文件連結
│   └── user/            ← 使用者偏好與設定
├── tools/               ← MCP 工具模組（優先使用 Batch 版本提升效率）
│   ├── filesystem.js    ← read_files_batch, list_files_batch, create_file_batch
│   ├── php.js           ← send_http_request (含 cookie_jar), run_php_script_batch
│   ├── database.js      ← execute_sql_batch, get_db_schema_batch
│   ├── sftp.js          ← sftp_*_batch (list/upload/download/delete)
├── hooks/               ← Session 鉤子：session-start (載入), pre-compact (快照), write-guard (防護)
├── skills/index.js      ← MCP Prompts 路由
└── Skills/              ← Skill MD 檔
    ├── *_agent.md       ← MCP Prompts 內容
    └── commands/        ← 斜線指令 (需符合 60 個上限與 Frontmatter 規範)
        └── _cold/       ← 冷凍技能區 (不計入上限，不自動部署，需手動啟用)

## 🧠 技能調用與管理 (Expert Skill Usage)
本專案擁有強大的專家技能庫 (`Skills/commands/`)。任務涉及以下領域時，**必須**先讀取對應文件：
- **PHP 開發 & 測試**：`php_dev/` (CRUD 生成)；使用 `send_http_request` 的 `cookie_jar` 維持登入態進行 E2E 測試。
- **自動化測試**：`testing/` (Playwright UI 測試、`project_qc` 協議、`e2e_golden_path`)。
- **技能維護**：執行 `/skill_audit` 審查冗餘技能。新增 Skill 後**必須同步更新 `docs/dashboard.html`**。

### Skills 系統規範
- **結構限制**：所有 Skill MD 必須存放在 `Skills/commands/{部門}/` 子資料夾內。
- **Cold Skills**：不再使用的低頻技能移至 `_cold/` 目錄，以節省部署空間與 token 消耗。
- **Frontmatter**：`life/` 部門不加，其餘部門視需求添加以啟用 AI 主動建議。
- **兩套 Skills 系統**：系統 A (MCP Prompts)；系統 B (斜線指令，主要，部署至 `~/.claude/commands/`)。

## 🛠️ 開發與驗證流程 (Lifecycle & Validation)
1. **研究 (Research)**：
   - 邏輯理解：使用 `file_to_prompt` 打包關鍵目錄，或用 `task_map` 標記進度。
2. **策略 (Strategy)**：提出計畫，註明調用的 Skills 部門，優先考慮批次 (Batch) 工具。
3. **執行 (Act)**：遵循目錄結構進行開發。
4. **驗證與 Dashboard (Validate)**：修改後執行 `project_qc` 或相關測試。

## 🌐 Playwright & Browser MCP 初始化標準 (SOP)
### Gemini CLI 環境 (Standalone Browser 模式)
1. **設定**：修改 `~/.gemini/settings.json` 或專案 `.gemini/settings.json`。
2. **配置**：`mcpServers` 中加入 `@modelcontextprotocol/server-playwright`。
3. **驗證**：確保 `playwright - Ready`。截圖統一存放於 `screenshots/` 且使用 `fullPage: true`。

## 📜 Commit 規範
- 執行 `git commit` 前，必須參考 `Skills/commands/tooling/git_commit.md` 並提供擬定訊息供確認。

---
*本文件為 Gemini CLI 之最高指令，未經使用者明確授權不得修改。*
