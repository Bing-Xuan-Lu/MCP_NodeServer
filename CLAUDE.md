# CLAUDE.md — MCP_NodeServer 專案指引

Node.js MCP Server，提供 Claude Code 工具能力與 Agent Skills。
名稱：`project-migration-assistant-pro` v5.1.0

---

## 目錄結構

```
MCP_NodeServer/
├── index.js             ← MCP Server 主程式（工具路由 + Skills 路由）
├── config.js            ← resolveSecurePath()，basePath = D:\Project\
├── .mcp.json            ← MCP Server 設定（Claude Code 自動讀取）
├── tools/               ← MCP 工具模組（各自匯出 definitions + handle）
│   ├── filesystem.js    ← list_files, read_file, create_file, apply_diff
│   ├── php.js           ← run_php_script, run_php_test, send_http_request, tail_log
│   ├── database.js      ← set_database, get_current_db, get_db_schema, execute_sql
│   ├── excel.js         ← get_excel_values_batch, trace_excel_logic, simulate_excel_change
│   ├── bookmarks.js     ← Chrome 書籤管理（12 個工具）
│   └── skill_factory.js ← save/list/delete_claude_skill, grant/list/revoke_path_access
├── skills/index.js      ← MCP Prompts 路由（注意：小寫 skills，不是 Skills）
└── Skills/              ← Skill MD 檔
    ├── *_agent.md       ← MCP Prompts 內容
    └── commands/        ← 斜線指令（部署到 ~/.claude/commands/）
        ├── _skill_template.md  ← 撰寫新 Skill 前必讀
        └── *.md
```

---

## 重要限制

- MCP 檔案工具 basePath = `D:\Project\`（路徑相對此目錄，不加磁碟路徑）
- 存取其他路徑：先呼叫 `grant_path_access`（重啟後清空）
- DB 連線（`set_database`）只在當次對話有效，重啟後需重新設定
- 書籤操作前需先關閉 Chrome

---

## 兩套 Skills 系統

**系統 A：MCP Prompts**（較少用）

- 存放：`Skills/*_agent.md`，需在 `skills/index.js` 登記後重啟

**系統 B：斜線指令**（主要）

- 存放：`Skills/commands/*.md`
- 部署：呼叫 `save_claude_skill` 工具（自動儲存＋部署）或執行 `deploy-commands.bat`
- 觸發：在 Claude Code 輸入 `/skill-name`

**Skills 清單**：見 `docs/dashboard.html` 或對話開始時的 system-reminder。

---

## 新增 Skill 流程

1. 先讀 `Skills/commands/_skill_template.md`（格式規範）
2. 呼叫 `save_claude_skill` 工具撰寫並部署
3. 更新 `docs/dashboard.html` 計數
4. 重啟 Claude Code

私有 Skill：檔名加 `_internal`（.gitignore 已排除），部署用 `deploy-commands-internal.bat`

---

## 新增 MCP 工具模組

1. 建立 `tools/my_module.js`（匯出 `definitions` + `handle(name, args)`）
2. 在 `index.js` import 並加入 `TOOL_MODULES` 陣列
3. 重啟 MCP Server

---

## 注意事項

- `skills/index.js`（小寫）= MCP Prompts 路由；`Skills/`（大寫）= MD 檔目錄，兩者不同
- 新增 Skill 後只需更新 `docs/dashboard.html`，**不需修改此檔**
- Playwright MCP：`npm install -g @playwright/mcp@latest`
