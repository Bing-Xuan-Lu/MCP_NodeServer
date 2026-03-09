# GEMINI.md - 專案核心規範與專家指令 (Foundational Mandates)

本文件定義 Gemini CLI 在 `D:\MCP_Server` 專案中的最高運作準則。所有開發、測試與維運任務必須優先遵循本規範。

## 🛡️ 安全與誠信規範 (Security & Integrity)
- **憑證保護**：絕對禁止將 API Key、資料庫密碼、SFTP 私鑰或任何敏感資訊記錄於 Log、Commit 或輸出到對話中。
- **環境隔離**：區分 `D:\MCP_Server` (本專案路徑) 與 `D:\Project\` (受控專案路徑)。
- **操作確認**：修改現有功能或執行 DDL 前，必須先說明影響範圍。
- **隱私脫敏**：**禁止在 Skill MD 檔中寫入客戶實際資訊**。範例一律使用 `{ProjectFolder}`, `{TableName}`, `module_a`, `example.com`, `localhost` 等通用佔位符。

## 🧠 技能調用與管理 (Expert Skill Usage)
本專案擁有強大的專家技能庫 (`Skills/commands/`)。任務涉及以下領域時，**必須**先讀取對應文件：
- **PHP 開發**：`php_dev/` (CRUD 生成、路徑修正)；**程式移植**：`migration/`。
- **資料庫**：`db_planning/` (Schema 設計、Migration)。
- **自動化測試**：`testing/` (Playwright UI 測試、邏輯測試)；**規格分析**：`spec/`。
- **運維部**：`deploy/` (SFTP)、`docker/` (Compose/Relocate)。
- **流程管理**：`dev_workflow/` (DDD/TDD)、`claude_ops/` (Skill 審計與管理)。
- **工具與內容**：`tooling/` (系統工具)、`content/` (內容擷取)、`life/` (自動化)。

### Skills 系統規範
- **結構限制**：所有 Skill MD 必須存放在 `Skills/commands/{部門}/` 子資料夾內。
- **命名約定**：
    - 私有技能：檔名加 `_internal` (不列入 Dashboard)。
    - 輔助步驟：檔名加 `_steps` (由主 Skill 引用，不單獨部署)。
- **數量上限**：公開 Skill 總數**不超過 50 個**。新增前應執行 `/skill_audit` 審查是否可合併相似技能。

## 🛠️ 開發與驗證流程 (Lifecycle & Validation)
1. **研究 (Research)**：使用 `grep_search` 理解現有邏輯，確保與 MCP 工具 (`tools/*.js`) 整合。
2. **策略 (Strategy)**：提出具體計畫，註明調用的 Skills 部門。
3. **執行 (Act)**：
   - 遵循 `CLAUDE.md` 目錄結構。
   - 部署技能應使用 `save_claude_skill` 工具。
4. **驗證與 Dashboard (Validate)**：
   - 修改程式後必須執行 `run_php_script` 或相關測試。
   - **新增/修改技能後必做核查**：
     - [ ] `~/.claude/commands/` 檔案已更新 (Claude)。
     - [ ] `~/.gemini/skills/` 檔案已更新 (Gemini)。
     - [ ] `docs/dashboard.html` 的 tag 與 `dept-count` 已更新。
     - [ ] Dashboard 的 `section-total` 數字與頂部總數一致。
     - [ ] JS `SKILLS` 物件已新增 detail 資料。

## 🌐 Playwright 初始化標準 (SOP)
根據使用的工具環境，參考對應的安裝指南：

### A. Claude Code 環境 (MCP 模式)
> 詳細參考：`docs/playwright-setup.md`
1. **環境初始化**：`npm init playwright@latest -- --yes --quiet --browser=chromium --lang=JavaScript`。
2. **配置優化**：預設開啟 `ignoreHTTPSErrors: true` 並配置 `baseURL` 與 `html` reporter。
3. **MCP 設定**：將 `playwright` 加入 `.mcp.json` 的 `mcpServers`。

### B. Gemini CLI 環境 (BrowserMCP & Skills 模式)
> 詳細參考：`docs/gemini-playwright-setup.md`
1. **核心安裝**：`npm install -g @browsermcp/mcp` 與 `@playwright/cli`。
2. **全域設定**：修改 `~/.gemini/settings.json` 加入 `browsermcp` 伺服器。
3. **瀏覽器整合**：安裝 Chrome 擴充功能，確保可直接控制目前分頁。
4. **驗證**：執行 `List my MCP tools` 確認工具已掛載。

## 📁 專案專屬規範
- **MCP 工具**：新增工具需註冊於 `index.js` 的 `TOOL_MODULES`。
- **路徑存取**：預設 `basePath = D:\Project\`。跨目錄需呼叫 `grant_path_access`。
- **環境限制**：
    - 資料庫連線 (`set_database`) 僅在**單次對話**有效。
    - 書籤操作前**必須關閉 Chrome 瀏覽器**。
- **語言偏好**：產出的註解、Commit 訊息、報告應優先使用 **繁體中文**。

## 📜 Commit 規範
- 執行 `git commit` 前，必須參考 `Skills/commands/tooling/git_commit.md`。提供「簡易版」與「完整版」供選擇。

---
*本文件為 Gemini CLI 之最高指令，未經使用者明確授權不得修改。*
