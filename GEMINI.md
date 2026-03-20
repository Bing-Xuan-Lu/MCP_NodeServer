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
├── tools/               ← MCP 工具模組
│   ├── filesystem.js, php.js, database.js, excel.js, bookmarks.js, sftp.js, skill_factory.js, python.js, word.js, pptx.js, pdf.js, git.js
│   ├── file_to_prompt.js ← 大規模程式碼打包工具
│   └── rag.js           ← ChromaDB 向量索引與語義搜尋 (RAG)
├── skills/index.js      ← MCP Prompts 路由
└── Skills/              ← Skill MD 檔
    ├── *_agent.md       ← MCP Prompts 內容
    └── commands/        ← 斜線指令
        ├── php_dev/, migration/, testing/, spec/, db_planning/, deploy/, docker/, dev_workflow/, tooling/, claude_ops/, content/, life/
        ├── office/      ← Office 文件處理 (docx, pdf, pptx, xlsx)
        └── _internal/   ← 私有 Skill（.gitignore 排除）
```

## 🧠 技能調用與管理 (Expert Skill Usage)
本專案擁有強大的專家技能庫 (`Skills/commands/`)。任務涉及以下領域時，**必須**先讀取對應文件：
- **RAG & 語義搜尋**：處理陌生大型專案時，優先使用 `rag_query` 尋找邏輯片段。
- **PHP 開發 & 移植**：`php_dev/` (CRUD 生成、路徑修正)；`migration/`。
- **資料庫**：`db_planning/` (Schema 設計、Migration)。
- **自動化測試**：`testing/` (Playwright UI 測試、邏輯測試)；`spec/` (規格分析)。
- **UI/UX 設計**：`ui-ux-pro-max` (位於 `.claude/skills/ui-ux-pro-max/`)。
- **運維 & Docker**：`deploy/` (SFTP)、`docker/` (Compose/Relocate)。
- **流程 & 管理**：`dev_workflow/` (DDD/TDD)、`claude_ops/` (Skill 審計)。
- **Office 處理**：`office/` (Word, PDF, PPTX 內容擷取與轉換)。
- **工具與內容**：`tooling/` (系統工具)、`content/` (內容擷取)、`life/` (自動化)。

### Skills 系統規範
- **結構限制**：所有 Skill MD 必須存放在 `Skills/commands/{部門}/` 子資料夾內。
- **兩套 Skills 系統**：
    - **系統 A: MCP Prompts**：存放於 `Skills/*_agent.md`。
    - **系統 B: 斜線指令**：存放於 `Skills/commands/{dept}/*.md`，透過 `save_claude_skill` 部署。
- **Memory 整合**：優化 Skill 時應參考 `memory/feedback/` 中的過往錯誤經驗。

## 🛠️ 開發與驗證流程 (Lifecycle & Validation)
1. **研究 (Research)**：
   - 熟悉專案：執行 `rag_index` 索引，再以 `rag_query` 檢索。
   - 邏輯理解：使用 `file_to_prompt` 打包關鍵目錄提供給 LLM 分析。
2. **策略 (Strategy)**：提出具體計畫，註明調用的 Skills 部門。
3. **執行 (Act)**：遵循目錄結構進行開發。
4. **驗證與 Dashboard (Validate)**：修改後執行相關測試。

## 🧩 RAG & ChromaDB 規範
當需要進行大規模程式碼搜尋或專案分析時：
- **索引**：優先對 `src/` 或 `admin/` 目錄執行 `rag_index`。
- **查詢**：使用自然語言描述需求（如「這張表的權限檢查在哪？」）進行 `rag_query`。
- **Docker**：確保 `chromadb` 容器處於 Running 狀態。

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
- **路徑存取**：預設 `basePath = D:\Project\`。跨目錄需呼叫 `grant_path_access`。
- **環境初始化**：新機器或環境異動後，應先執行 `powershell ./setup.ps1`。
- **Memory 存取**：持續更新 `memory/MEMORY.md` 以維持 Agent 的上下文連續性。

## 📜 Commit 規範
- 執行 `git commit` 前，必須參考 `Skills/commands/tooling/git_commit.md`。提供「簡易版」與「完整版」供選擇。

---
*本文件為 Gemini CLI 之最高指令，未經使用者明確授權不得修改。*
