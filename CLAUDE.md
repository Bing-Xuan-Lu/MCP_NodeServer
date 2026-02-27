# CLAUDE.md — MCP_NodeServer 專案指引

本檔案幫助 AI 快速理解此專案，**每次對話開始時自動載入**。

---

## 專案用途

這是一個 **Node.js MCP (Model Context Protocol) Server**，提供 Claude Code 額外的工具能力與 Agent Skills。
MCP Server 名稱：`project-migration-assistant-pro`，版本 v5.1.0。

---

## 專案目錄結構

```
MCP_NodeServer/
├── index.js                        ← MCP Server 主程式（工具路由 + Skills 路由）
├── config.js                       ← resolveSecurePath()，BASE_PROJECT_PATH = D:\Project\
├── .mcp.json                       ← MCP Server 設定（Claude Code 自動讀取此檔）
├── tools/
│   ├── filesystem.js               ← list_files, read_file, create_file, apply_diff (4個)
│   ├── php.js                      ← run_php_script, run_php_test, send_http_request, tail_log (4個)
│   ├── database.js                 ← set_database, get_current_db, get_db_schema, execute_sql (4個)
│   ├── excel.js                    ← get_excel_values_batch, trace_excel_logic, simulate_excel_change (3個)
│   └── bookmarks.js                ← Chrome 書籤管理工具 (12個)
├── skills/
│   └── index.js                    ← MCP Prompts 路由（讀取 Skills/*.md 並回傳給 Claude）
├── Skills/                         ← Agent Skills MD 檔（兩個用途，見下方說明）
│   ├── php_crud_agent.md           ← MCP Prompt 內容
│   ├── php_upgrade_agent.md        ← MCP Prompt 內容
│   ├── dotnet_to_php_agent.md      ← MCP Prompt 內容
│   ├── php_net_to_php_test_agent.md← MCP Prompt 內容
│   ├── axshare_diff_agent.md       ← MCP Prompt 內容
│   ├── bookmark_agent.md           ← MCP Prompt 內容
│   └── commands/                   ← Claude Code 斜線指令 MD 檔（獨立系統）
│       ├── php_crud_generator.md
│       ├── php_crud_generator_internal.md  ← git-ignored（內部私用）
│       ├── php_upgrade.md
│       ├── dotnet_to_php.md
│       ├── php_net_to_php_test.md
│       ├── axshare_diff.md
│       ├── bookmark_organizer.md
│       └── playwright_ui_test.md
├── deploy-commands.bat / .sh       ← 部署 Skills/commands/ → ~/.claude/commands/
└── deploy-commands-internal.bat    ← 部署 internal Skill（git-ignored）
```

---

## 兩套 Skills 系統（重要）

### 系統 A：MCP Prompts（透過 MCP Server）

- 存放位置：`Skills/*.md`（非 commands 子目錄）
- 路由設定：`skills/index.js`（新增 Skill 需在此登記）
- 觸發方式：Claude 透過 MCP Prompts API 呼叫
- 特色：可透過 `args` 傳參並替換 MD 內的 `{{PLACEHOLDER}}`

### 系統 B：Claude Code 斜線指令（獨立於 MCP Server）

- 存放位置：`Skills/commands/*.md`
- 部署方式：執行 `deploy-commands.bat` 複製到 `%USERPROFILE%\.claude\commands\`
- 觸發方式：在 Claude Code 中輸入 `/skill-name`
- 特色：不需要 MCP Server 在線，直接讀 MD 文字作為 Prompt
- 部署後才能使用，修改 MD 後需重新執行 deploy

---

## MCP 設定（.mcp.json）

```json
{
  "mcpServers": {
    "project-migration-assistant-pro": {
      "type": "stdio",
      "command": "node",
      "args": ["D:\\Develop\\MCP_NodeServer\\index.js"]
    },
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

`.mcp.json` 放在專案根目錄，Claude Code 會自動讀取。
新增 MCP Server 後需**重啟 Claude Code** 才生效。

---

## 已安裝的 MCP Server

| Server 名稱 | 用途 | 工具前綴 |
|------------|------|---------|
| `project-migration-assistant-pro` | 本專案：檔案、PHP、DB、Excel、書籤 | `mcp__project-migration-assistant-pro__` |
| `playwright` | UI 自動化測試（瀏覽器操作、截圖）| `browser_` |

---

## 可用 Skills（斜線指令）

| 指令 | 用途 | 備註 |
|------|------|------|
| `/php_crud_generator` | PHP 後台 CRUD 模組產生器（通用範本） | 公開 |
| `/php_crud_generator_internal` | PHP 後台 CRUD 模組產生器（PHP8_LTE2 專案） | 私有，git-ignored |
| `/php_upgrade` | PHP 7.x → 8.4 升級，自動修正語法 | 公開 |
| `/dotnet_to_php` | .NET C# → PHP 翻寫 Agent | 公開 |
| `/php_net_to_php_test` | PHP 後端整合測試（DB 驗證、HTTP 請求）| 公開 |
| `/playwright_ui_test` | 瀏覽器 UI 自動化測試（登入、CRUD、截圖）| 公開 |
| `/axshare_diff` | AxShare 規格書 vs 實作網站差異比對 | 公開 |
| `/bookmark_organizer` | Chrome 書籤整理 SOP 範例 | 公開 |
| `/n8n_workflow_update` | n8n 工作流安全更新 SOP（deactivate→PUT→activate） | 公開 |
| `/n8n_workflow_create` | n8n 新建工作流 SOP（create→PUT settings→activate→backup） | 公開 |
| `/learn_claude_skill` | 從對話提取模式，自動產生並部署新 Skill，同步更新文件 | 公開 |
| `/git_commit` | 分析變更自動產生繁體中文條列式 Commit 訊息並提交 | 公開 |

---

## 重要路徑限制

- MCP 檔案工具（list_files / read_file / create_file / apply_diff）的 basePath = `D:\Project\`
- `resolveSecurePath()` 在 `config.js` 中實作，防止路徑穿越
- 所有 MCP 工具呼叫路徑**相對於** `D:\Project\`，不需要加完整磁碟路徑
- 需存取 `D:\Project\` 以外的路徑時，先呼叫 `grant_path_access` 工具（需說明原因）
- Runtime 白名單在 MCP Server 重啟後自動清空，可用 `list_allowed_paths` 查詢目前狀態

## Skill Factory MCP 工具（tools/skill_factory.js）

| 工具名稱 | 功能 |
| ------- | ---- |
| `save_claude_skill` | 將 MD 內容儲存為 Skill 並自動部署到 `~/.claude/commands/` |
| `list_claude_skills` | 列出所有 Skills 及部署狀態 |
| `delete_claude_skill` | 刪除指定 Skill（來源 + 部署版本） |
| `grant_path_access` | 將路徑加入 Runtime 白名單（重啟後清空） |
| `list_allowed_paths` | 查詢目前允許存取的所有路徑 |
| `revoke_path_access` | 從白名單移除指定路徑 |

---

## 新增 Skill 流程

### 只要斜線指令（最簡單）

1. 在 `Skills/commands/` 新增 `xxx.md`
2. 執行 `deploy-commands.bat`
3. 重啟 Claude Code → 可用 `/xxx`

### 同時加入 MCP Prompts

1. 在 `Skills/` 新增 `xxx_agent.md`
2. 在 `skills/index.js` 的 `definitions` 陣列登記
3. 在 `skills/index.js` 的 `getPrompt()` 加入對應邏輯
4. 重啟 MCP Server（重啟 Claude Code）

### 私有 Skill（不推 Git）

- 檔名加 `_internal.md`，`.gitignore` 已設定自動排除 `Skills/commands/*_internal.md`
- 部署用 `deploy-commands-internal.bat`

---

## 新增 MCP 工具模組流程

1. 建立 `tools/my_module.js`（需匯出 `definitions` 和 `handle(name, args)`）
2. 在 `index.js` import 並加入 `TOOL_MODULES` 陣列
3. 重啟 MCP Server

---

## 常用指令

```bash
# 部署公開 Skills
.\deploy-commands.bat

# 部署私有 Skills
.\deploy-commands-internal.bat

# 啟動 MCP Server（通常由 Claude Code 自動啟動）
node index.js
```

---

## Git 忽略規則

| 忽略的檔案 | 原因 |
|-----------|------|
| `Skills/commands/*_internal.md` | 內部私用 Skill，不公開 |
| `deploy-commands-internal.bat` | 內部部署腳本，不公開 |
| `.env` | 環境變數（若有） |
| `node_modules/` | npm 套件 |

---

## 注意事項

- `skills/index.js`（小寫）= MCP Prompts 路由，**不是** `Skills/index.js`（大寫，不存在）
- Playwright MCP 需要 `@playwright/mcp` 全域安裝：`npm install -g @playwright/mcp@latest`
- 書籤操作前需先關閉 Chrome 瀏覽器
- DB 連線（`set_database`）只在當次對話有效，重啟後需重新設定
