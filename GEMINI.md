# GEMINI.md - 專案核心規範與專家指令 (Foundational Mandates)

本文件定義 Gemini CLI 在 `D:\MCP_Server` 專案中的最高運作準則。所有開發、測試與維運任務必須優先遵循本規範。

## 🛡️ 安全與誠信規範 (Security & Integrity)
- **憑證保護**：絕對禁止將 API Key、資料庫密碼、SFTP 私鑰或任何敏感資訊記錄於 Log、Commit 或輸出到對話中。
- **環境隔離**：區分 `D:\MCP_Server` (本專案路徑) 與 `D:\Project\` (受控專案路徑)。
- **操作確認**：修改現有功能或執行 DDL 前，必須先說明影響範圍。

## 🧠 技能調用準則 (Expert Skill Usage)
本專案擁有強大的專家技能庫 (`Skills/commands/`)。當任務涉及以下領域時，**必須**先讀取對應的技能文件並遵循其流程：
- **PHP 開發**：參考 `Skills/commands/php_dev/` (CRUD 生成、路徑修正)。
- **資料庫規劃**：參考 `Skills/commands/db_planning/` (Schema 設計、Migration)。
- **自動化測試**：參考 `Skills/commands/testing/` (Playwright UI 測試、邏輯測試)。
- **部署運維**：參考 `Skills/commands/deploy/` (SFTP) 與 `docker/`。
- **專案管理**：參考 `Skills/commands/claude_ops/` (Skill 學習與審計)。

**調用指令範例**：若任務是「設計訂單資料表」，應先 `read_file("Skills/commands/db_planning/db_schema_designer.md")`。

## 🛠️ 開發與驗證流程 (Lifecycle & Validation)
1. **研究 (Research)**：使用 `grep_search` 理解現有邏輯，確保與現有 MCP 工具 (tools/*.js) 整合。
2. **策略 (Strategy)**：提出具體計畫，並註明將調用哪一個 Skills 專家模式。
3. **執行 (Act)**：
   - 遵循 `CLAUDE.md` 中的目錄結構與命名規範。
   - 新增技能必須放置於 `Skills/commands/{部門}/`。
   - 技能部署應使用 `save_claude_skill` 工具。
4. **驗證 (Validate)**：
   - 修改程式後必須執行 `run_php_script` 或相關測試工具。
   - UI 變更必須使用 Playwright 驗證截圖。

## 🌐 Playwright 初始化標準 (SOP)
當用戶要求在「新專案」建立測試環境時，必須遵循以下標準流程：

1. **環境初始化**：
   - 使用指令：`npm init playwright@latest -- --yes --quiet --browser=chromium --lang=TypeScript`
   - 強制使用 **TypeScript** 以提升腳本維護性。
   - 預設僅安裝 **Chromium** (節省空間)，除非用戶要求多瀏覽器。

2. **配置優化 (`playwright.config.ts`)**：
   - `use.baseURL`: 應自動偵測專案 URL (例如 http://localhost/專案名)。
   - `use.ignoreHTTPSErrors`: 預設設為 `true` (針對開發環境)。
   - `reporter`: 強制包含 `html`。

3. **目錄結構規範**：
   - 測試檔案存放在 `tests/` 目錄下。
   - 檔案命名規範：`*.spec.ts` (例如 `auth.spec.ts`)。
   - 必須建立一個 `tests/smoke.spec.ts` 作為連通性檢查。

4. **驗證步驟**：
   - 安裝完成後，必須執行一次 `npx playwright test` 確保環境可用。

## 📁 專案專屬規範
- **MCP 工具**：本專案的核心是提供 MCP 工具能力，新增工具需註冊於 `index.js`。
- **Dashboard 更新**：新增或修改技能後，**務必更新 `docs/dashboard.html`**，保持統計數字與 UI 一致。
- **路徑存取**：MCP 檔案工具預設 `basePath = D:\Project\`。存取 `D:\Project\` 以外路徑需使用 `grant_path_access`。
- **語言偏好**：所有產出的註解、Commit 訊息、報告應優先使用 **繁體中文**。

## 📜 Commit 規範
- 執行 `git commit` 前，必須參考 `Skills/commands/tooling/git_commit.md` 的標準流程。
- 提供「簡易版」與「完整版」供使用者選擇。

---
*本文件為 Gemini CLI 之最高指令，未經使用者明確授權不得修改。*
