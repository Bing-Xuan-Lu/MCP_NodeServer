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
│   ├── filesystem.js    ← list_files, read_file, create_file, apply_diff
│   ├── php.js           ← run_php_script, run_php_test, send_http_request, tail_log
│   ├── database.js      ← set_database, get_current_db, get_db_schema, execute_sql
│   ├── excel.js         ← get_excel_values_batch, trace_excel_logic, simulate_excel_change
│   ├── bookmarks.js     ← Chrome 書籤管理（12 個工具）
│   ├── sftp.js          ← sftp_connect, sftp_upload, sftp_download, sftp_list, sftp_delete
│   └── skill_factory.js ← save/list/delete_claude_skill, grant/list/revoke_path_access
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
        └── life/        ← 生活自動化部（n8n, youtube）
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

- 存放：`Skills/commands/{dept_folder}/*.md`（必須放在對應部門子資料夾，不可放根目錄）
- 部署：呼叫 `save_claude_skill` 工具（自動儲存＋部署）或執行 `deploy-commands.bat`
- 觸發：在 Claude Code 輸入 `/skill-name`
- **上限：公開 Skill 總數不超過 50 個**，超過前先用 `/skill_audit` 審查並合併相似技能

**Skills 清單**：見 `docs/dashboard.html` 或對話開始時的 system-reminder。

---

## 新增 Skill 流程

1. 先讀 `Skills/commands/_skill_template.md`（格式規範）
2. 將 MD 檔寫入對應子資料夾（如 `Skills/commands/deploy/sftp_deploy.md`）
3. 手動部署到 `~/.claude/commands/`（flat，不含子資料夾路徑）：
   `cp Skills/commands/subfolder/skill.md ~/.claude/commands/skill.md`（或直接重跑 `deploy-commands.bat`，會自動發現所有公開 Skill）
4. 更新 `docs/dashboard.html`（**必做**，不可遺漏）：
   - 在對應部門加入 tag、更新 `dept-count`
   - 更新 section-total 數字與頂部總能力數
   - 在 JS `SKILLS` 物件中新增 click-to-detail 資料
   - **`_internal` Skill 不寫入 dashboard.html**（不加 tag、不計入數字）
5. 重啟 Claude Code

私有 Skill：檔名加 `_internal`（.gitignore 已排除），部署用 `deploy-commands-internal.bat`，**不列入 dashboard.html**

伴隨參考檔：檔名加 `_steps`（如 `playwright_ui_test_steps.md`），由主 Skill 引用，**不獨立部署**

YAML Frontmatter（選用）：在 Skill MD 頂部加入 `name` + `description`，可讓 Claude 在對話中主動建議該 Skill；不需主動建議時可省略。格式見 `_skill_template.md`。

---

## 新增 MCP 工具模組

1. 建立 `tools/my_module.js`（匯出 `definitions` + `handle(name, args)`）
2. 在 `index.js` import 並加入 `TOOL_MODULES` 陣列
3. 重啟 MCP Server

---

## 注意事項

- `skills/index.js`（小寫）= MCP Prompts 路由；`Skills/`（大寫）= MD 檔目錄，兩者不同
- **所有 Skill MD 必須放在對應部門子資料夾**（`_skill_template.md` 例外）；部署到 `~/.claude/commands/` 才是 flat 結構
- 新增 Skill 後更新 `docs/dashboard.html`（含 JS SKILLS 物件）；**不需修改此 CLAUDE.md**（目錄結構變動除外）
- Playwright MCP：`npm install -g @playwright/mcp@latest`
- **禁止在 Skill MD 檔（`Skills/commands/*.md`）中寫入客戶實際網址、域名、專案名稱、資料表名稱、模組名稱**，範例一律使用 `{ProjectFolder}`、`{TableName}`、`module_a`、`example.com`、`localhost` 等通用佔位符。`reports/` 目錄下的執行報告不受此限。
