# GEMINI.md - 專案核心規範與專家指令 (Foundational Mandates)

本文件定義 Gemini CLI 在 `D:\MCP_Server` 專案中的最高運作準則。所有開發、測試與維運任務必須優先遵循本規範。

## 🛡️ 安全與誠信規範 (Security & Integrity)
- **憑證保護**：絕對禁止將 API Key、資料庫密碼、SFTP 私鑰或任何敏感資訊記錄於 Log、Commit 或輸出到對話中。
- **環境隔離**：區分 `D:\MCP_Server` (本專案路徑) 與 `D:\Project\` (受控專案路徑)。
- **操作確認**：修改現有功能或執行 DDL 前，必須先說明影響範圍。
- **隱私脫敏**：**禁止在 Skill MD 檔中寫入客戶實際資訊**。範例一律使用 `{ProjectFolder}`, `{TableName}`, `module_a`, `example.com`, `localhost` 等通用佔位符。（`reports/` 目錄與 `Skills/commands/_internal/` 下的檔案不受此限）

## 📂 專案架構與目錄結構 (Directory Structure)
```text
MCP_NodeServer/
├── index.js             ← MCP Server 主程式（工具路由 + Skills 路由）
├── config.js            ← resolveSecurePath()，basePath = D:\Project\
├── .mcp.json            ← MCP Server 設定（Claude/Gemini 自動讀取）
├── tools/               ← MCP 工具模組（各自匯出 definitions + handle）
│   ├── filesystem.js, php.js, database.js, excel.js, bookmarks.js, sftp.js, skill_factory.js, python.js, word.js, pptx.js, pdf.js, git.js
├── skills/index.js      ← MCP Prompts 路由（注意：小寫 skills，不是 Skills）
└── Skills/              ← Skill MD 檔
    ├── *_agent.md       ← MCP Prompts 內容
    └── commands/        ← 斜線指令（部署目錄，flat 結構）
        ├── _skill_template.md  ← 撰寫新 Skill 前必讀
        ├── php_dev/, migration/, testing/, spec/, db_planning/, deploy/, docker/, dev_workflow/, tooling/, claude_ops/, content/, life/
        └── _internal/   ← 私有 Skill（.gitignore 排除，不進版控）
```

## 🧠 技能調用與管理 (Expert Skill Usage)
本專案擁有強大的專家技能庫 (`Skills/commands/`)。任務涉及以下領域時，**必須**先讀取對應文件：
- **PHP 開發**：`php_dev/` (CRUD 生成、路徑修正)；**程式移植**：`migration/`。
- **資料庫**：`db_planning/` (Schema 設計、Migration)。
- **自動化測試**：`testing/` (Playwright UI 測試、邏輯測試)；**規格分析**：`spec/`。
- **運維部**：`deploy/` (SFTP)、`docker/` (Compose/Relocate)。
- **流程管理**：`dev_workflow/` (DDD/TDD)、`claude_ops/` (Skill 審計與管理)。
- **工具與內容**：`tooling/` (系統工具)、`content/` (內容擷取)、`life/` (自動化)。

### Skills 系統規範
- **結構限制**：所有 Skill MD 必須存放在 `Skills/commands/{部門}/` 子資料夾內（`_skill_template.md` 除外）。
- **兩套 Skills 系統**：
    - **系統 A: MCP Prompts**：存放於 `Skills/*_agent.md`，需於 `skills/index.js` 登記。
    - **系統 B: 斜線指令**：存放於 `Skills/commands/{dept}/*.md`，透過 `save_claude_skill` 部署。
- **命名與輔助**：
    - 私有技能：檔名加 `_internal` (不列入 Dashboard，.gitignore 排除)。
    - 輔助步驟：檔名加 `_steps` (由主 Skill 引用，不單獨部署)。
    - YAML Frontmatter：可於頂部加入 `name` 與 `description` 以供主動建議 (Life 部門不加，其他部門視需求選用)。
- **數量上限**：公開 Skill 總數**不超過 60 個**。超過前應執行 `/skill_audit` 審查是否可合併相似技能。

### 新增 Skill 流程
1. **讀取規範**：先讀 `Skills/commands/_skill_template.md`。
2. **撰寫文件**：將 MD 檔寫入對應子資料夾。
3. **部署技能**：優先使用 `save_claude_skill` 工具（自動處理部署）。
4. **更新 Dashboard (必做)**：
   - 更新 `docs/dashboard.html` 中的 tag、`dept-count`。
   - 更新 `section-total` 數字與頂部總能力數。
   - 在 JS `SKILLS` 物件中新增 click-to-detail 資料。
   - *(註：`_internal` Skill 不寫入 dashboard.html)*

**完成後自我核對：**
- [ ] `~/.claude/commands/` 檔案已更新 (Claude)。
- [ ] `~/.gemini/skills/` 檔案已更新 (Gemini)。
- [ ] `dashboard.html` tag 已新增且 `dept-count` 更新？
- [ ] `dashboard.html` section-total 與頂部總數一致？
- [ ] `dashboard.html` JS `SKILLS` 物件已新增條目？

## 🛠️ 開發與驗證流程 (Lifecycle & Validation)
1. **研究 (Research)**：使用 `grep_search` 理解現有邏輯，確保與 MCP 工具 (`tools/*.js`) 整合。大型 PHP 專案建議先執行 `/update_codemaps {ProjectFolder}` 產生 `codemap.md`。
2. **策略 (Strategy)**：提出具體計畫，註明調用的 Skills 部門。
3. **執行 (Act)**：遵循目錄結構與各項規範進行開發。
4. **驗證與 Dashboard (Validate)**：修改程式後必須執行 `run_php_script` 或相關測試確保功能正確。

## 🧩 新增 MCP 工具模組規範
當需要擴充 MCP Server 能力時，必須遵循以下流程：
1. **建立模組**：於 `tools/` 目錄建立 `.js` 檔，匯出 `definitions` 與 `handle`。
2. **註冊工具**：於 `index.js` import 並加入 `TOOL_MODULES`。
3. **同步文件 (必做)**：
   - **CLAUDE.md / GEMINI.md**：更新 `tools/` 目錄結構。
   - **README.md**：更新工具總覽表格與數量。
   - **dashboard.html**：更新 MCP Tools 區段、tag、數字及 JS `SKILLS` 物件中的 `tools` 陣列。
4. **驗證**：重啟 MCP Server 並測試功能。

**完成後自我核對：**
- [ ] `tools/my_module.js` 建立並匯出 definitions + handle？
- [ ] `index.js` 已 import 並加入 `TOOL_MODULES`？
- [ ] README.md 工具表格/數量已更新？
- [ ] dashboard.html 相關 tag、數字與 JS 物件已更新？

## 🌐 Playwright & Browser MCP 初始化標準 (SOP)
根據使用的工具環境，參考對應的安裝指南：

### A. Claude Code 環境 (MCP 模式)
> 詳細參考：`docs/playwright-setup.md`
1. **環境初始化**：`npm init playwright@latest -- --yes --quiet --browser=chromium --lang=JavaScript`。
2. **MCP 設定**：將 `playwright` 加入 `.mcp.json` 的 `mcpServers`。
3. **多 Playwright 實例備案**：若需雙 Agent 並行操作，在 `.mcp.json` 登記第二個 MCP，指定不同 `--port`（預設 3000，第二實例用 3001）。

### B. Gemini CLI 環境 (Standalone Browser 模式 - 推薦)
> **功能描述**：使用官方 Playwright MCP，讓 AI 具備完全自主的瀏覽器控制能力，不需手動點擊 Connect 即可進行自動化測試與截圖。
1. **環境需求**：Node.js 18 或以上版本。
2. **設定方式**：修改 `~/.gemini/settings.json` (全域) 或專案目錄下的 `.gemini/settings.json` (區域)。
3. **MCP 伺服器配置**：
   ```json
   {
     "mcpServers": {
       "playwright": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-playwright"]
       }
     }
   }
   ```
4. **安裝瀏覽器核心**：執行 `npx playwright install chromium`。
5. **驗證**：重啟 Gemini CLI，看到 `playwright - Ready` 即表示成功。您可以直接下令：「使用 playwright 導航至 localhost 並截圖」。

## 📁 專案專屬規範
- **MCP 工具**：新增工具需註冊於 `index.js` 的 `TOOL_MODULES`。
- **路徑存取**：預設 `basePath = D:\Project\`。跨目錄需呼叫 `grant_path_access`。
- **環境變數 (Git Bash)**：部分工具不在預設 PATH 中，需手動補充（如 `gh` 在 `/c/Program Files/GitHub CLI`）。
- **環境限制與連線記憶**：
    - **預設資料庫**：Host: `127.0.0.1`, User: `root`, Database: `test`。啟動後優先呼叫 `load_db_connection` 嘗試載入設定。
    - **連線持久化**：連線成功後建議開啟 `remember: true` 以維持 Session 間的一致性。
    - **SFTP 限制**：基於安全考量，SFTP 僅在**單次對話**有效，不進行持久化。
    - 書籤操作前**必須關閉 Chrome 瀏覽器**。
- **Git 操作流程**：
    - 任何修改前，應先執行 `git_status` 確認當前分支狀態。
    - 修改後、Commit 前，必須執行 `git_diff` 核對改動內容。
    - 頻繁改動或切換任務時，善用 `git_stash_ops` 保存臨時狀態。
- **語言偏好**：產出的註解、Commit 訊息、報告應優先使用 **繁體中文**。

## 📜 Commit 規範
- 執行 `git commit` 前，必須參考 `Skills/commands/tooling/git_commit.md`。提供「簡易版」與「完整版」供選擇。

---
*本文件為 Gemini CLI 之最高指令，未經使用者明確授權不得修改。*