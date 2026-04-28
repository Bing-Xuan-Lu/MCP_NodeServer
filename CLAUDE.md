# CLAUDE.md — MCP_NodeServer 專案指引

Node.js MCP Server，提供 Claude Code 工具能力與 Agent Skills。
名稱：`project-migration-assistant-pro` v5.1.0

---

## 目錄結構

```text
MCP_NodeServer/
├── index.js             ← MCP Server 主程式 v5.1.0（工具路由 + Skills 路由）
├── env.js               ← 環境變數統一載入（dotenv + 匯出常數，hooks / index.js / config.js 共用）
├── .env.example         ← 環境變數範本（進版控，複製為 .env 使用）
├── config.js            ← resolveSecurePath()，basePath 優先讀 .env
├── setup.ps1            ← 環境初始化與 PowerShell 工具鏈配置
├── .mcp.json            ← MCP Server 設定（Claude Code 自動讀取）
├── memory/              ← 長期記憶與知識庫 (MEMORY.md)
│   ├── feedback/        ← 操作回饋與最佳實踐 (playwright, qc, tooling...)
│   ├── project/         ← 專案特定知識與部署細節
│   ├── reference/       ← 靜態參考資料與外部文件連結
│   └── user/            ← 使用者偏好與設定
├── tools/               ← MCP 工具模組（分類分層，動態載入自 index.js glob pattern：tools/**/*.js）
│   ├── _shared/         ← 共用模組（工具間共享的常數、函式、資源池，不對外暴露）
│   │   ├── browser_pool.js ← Playwright browser pool factory（browser/* 共用）
│   │   └── utils.js     ← 驗證函式、錯誤處理、async 工具（全工具可用）
│   ├── file_io/         ← 檔案讀寫與文件轉換（通用 I/O）
│   │   ├── filesystem.js ← list_files, read_file, create_file, apply_diff, apply_diff_batch, read_files_batch, list_files_batch, create_file_batch
│   │   ├── excel.js     ← get_excel_values_batch, trace_excel_logic, simulate_excel_change
│   │   ├── word.js      ← read_word_file, read_word_files_batch (.docx → Markdown/HTML/Text)
│   │   ├── pptx.js      ← read_pptx_file, read_pptx_files_batch (.pptx → Markdown/Text + 圖片)
│   │   ├── pdf.js       ← read_pdf_file, read_pdf_files_batch (.pdf → Markdown/Text)
│   │   └── images.js    ← read_image, read_images_batch（圖片讀取 + 縮放，支援 PNG/JPG/WebP/GIF/SVG）
│   ├── data/            ← 資料庫（DB）
│   │   └── database.js  ← set_database, load_db_connection, get_current_db, get_db_schema, execute_sql, get_db_schema_batch, execute_sql_batch, schema_diff, mysql_log_tail
│   ├── deploy/          ← 部署與版控工具（遠端操作、DB migration）
│   │   ├── sftp.js      ← sftp_connect, sftp_upload, sftp_download, sftp_list, sftp_delete, sftp_*_batch, sftp_preset
│   │   ├── php.js       ← run_php_script, run_php_code, run_php_test, send_http_request, tail_log, send_http_requests_batch, run_php_script_batch
│   │   ├── git.js       ← git_status, git_diff, git_log, git_stash_ops
│   │   ├── skill_factory.js ← save/list/delete_claude_skill, grant/list/revoke_path_access
│   │   └── flyway.js    ← flyway_info, flyway_migrate, flyway_validate, flyway_repair, flyway_baseline（需 dev-flyway Docker，選用）
│   ├── browser/         ← 瀏覽器自動化與網頁檢查（UI testing、CSS 分析）
│   │   ├── dom_compare.js ← dom_compare（批次比對兩個 URL 的 CSS/HTML/JS 差異；使用 browser_pool）
│   │   ├── playwright_tools.js ← browser_interact, page_audit, css_inspect, element_measure, style_snapshot, css_coverage, browser_save_session, browser_restore_session
│   │   └── css_tools.js ← css_specificity_check, css_computed_winner（使用 browser_pool）
│   ├── system/          ← 系統工具（多 Agent 協調、外部程式執行、程式碼分析）
│   │   ├── python.js    ← run_python_script (Docker)
│   │   ├── bookmarks.js ← Chrome 書籤管理（12 個工具）
│   │   ├── agent_coord.js ← agent_coord（多 Agent 協調：post/poll/status/delete/archive/suggest_dispatch）
│   │   ├── file_to_prompt.js ← file_to_prompt, file_to_prompt_preview
│   │   ├── php_class.js ← class_method_lookup（PHP 原始碼直接定位，自動解析 use Trait）
│   │   └── php_symbol.js ← symbol_index, find_usages, find_hierarchy, find_dependencies, trace_logic（PHP AST 符號索引 + 邏輯追蹤）
│   └── utils/           ← 通用工具與比對
│       ├── image_diff.js ← image_diff（設計稿 vs 截圖像素級比對）
│       └── image_transform.js ← image_transform（圖片 resize / 背景色 / 圓形裁切 / 合成）
├── hooks/               ← Claude Code Session Hooks（全域 ~/.claude/settings.json 設定）
│   ├── session-start.js ← SessionStart：對話開場載入記憶與上次摘要
│   ├── repetition-detector.js ← PreToolUse：11層偵測（錯誤工具、散搜、低效、重複、同檔連修、自動修復），支援成本追蹤、Slack通知、debug模式
│   ├── refactor-advisor.js ← PreToolUse(Edit|Write|apply_diff)：PHP 程式碼品質偵測（13項 SOLID + Clean Code 規則）
│   ├── pre-compact.js   ← PreCompact：context 壓縮前存快照 + 踩坑偵測
│   ├── write-guard.js   ← PreToolUse(Write|Edit)：敏感檔案寫入警告 + JS/CSS 修改時提醒 bump version
│   ├── llm-judge.js     ← PostToolUse(Write|Edit)：高/中風險檔案自我審查清單 + PHP docker lint + JS/CSS bump version 提醒
│   ├── user-prompt-guard.js ← UserPromptSubmit：模糊指令偵測（全域強制）+ 場景缺上下文提醒（前端/後端/QC/Playwright）
│   └── skill-router.js  ← UserPromptSubmit：Skill 關鍵字偵測，依分數自動建議相關 Skill
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

不啟用時其他工具完全不受影響。

- **Python**：容器名 `python_runner`，`restart: unless-stopped`

---

## 環境變數

所有環境變數統一透過 `.env` 管理，由 `env.js` 載入後匯出給 hooks / index.js / config.js 使用。

**初次設定**：`cp .env.example .env`，再依本機環境修改。`.env` 已在 `.gitignore` 中。

### MCP Server

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `MCP_BASE_PATHS` | `D:\Project\` | 允許存取的根目錄（逗號分隔多個）；覆蓋 config.local.js |

### Hook 設定

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `CLAUDE_HOOK_DEBUG` | `0` | 啟用 hook 除錯日誌（`[hook-debug]` 標籤輸出） |
| `CLAUDE_SLACK_WEBHOOK` | _(空)_ | Slack webhook URL，用於發送阻擋告警 |
| `CLAUDE_NOTIFY_ON_BLOCK` | `1` | 僅在 block 事件時發送 Slack 通知 |
| `CLAUDE_TOKEN_FEEDBACK` | `passive` | Token 浪費回饋模式：`active`=逐次即時提醒、`passive`=定期累計摘要 |
| `CLAUDE_SUMMARY_INTERVAL` | `25` | 被動模式下每 N 次 tool call 輸出一次效率摘要 |
| `CLAUDE_DUAL_STATE_PATH_REGEX` | _(空)_ | refactor-advisor #14 觸發路徑限制 regex（空＝所有 .php 都檢查） |
| `CLAUDE_DUAL_STATE_SESSION_RE` | _(預設見 hook)_ | refactor-advisor #14 偵測 session 分支的 regex |

### Git Bash PATH 補充

Claude Code 在 Windows 上透過 Git Bash 執行指令，部分工具不在預設 PATH 中（已寫入 `~/.bashrc`）：

| 工具 | 路徑 | 用途 |
|------|------|------|
| `gh` | `/c/Program Files/GitHub CLI` | GitHub CLI（PR、Issue、API 操作） |

如遇 `command not found`，先檢查 `~/.bashrc` 是否有對應的 `export PATH` 設定。

**Hook 偵測規則**（repetition-detector 13 層 + refactor-advisor 13 項）：

| 層級 | ID | 觸發條件 | 行為 |
| --- | --- | --- | --- |
| L1 | bash_wrong_tool | 用 Bash / PowerShell 做有專用工具的事（docker mysql、cat/grep/find 等）；PHP-targeted 繞道路徑（`grep .php` / `rg --type php` / `node -e fs.read .php` / `awk\|sed .php` / `Select-String .php`）強制 BLOCK | ⚠️ 警告（PHP/destructive block） |
| L2 | bash_pattern_repeat | Bash 模式重複 2+ 次 | ⚠️ 警告 |
| L2.4 | grep_php_symbol | Grep 搜 PHP class/method（1 次提醒，2+ 次跨路徑強警告） | 💡→⚠️ 建議 AST 工具 |
| L2.4b | grep_read_same_php_file | 同一 PHP 檔 Grep+Read 拼湊 ≥ 3 次（最近 8 步） | ⚠️ 強制改用 class_method_lookup |
| L2.4c | grep_php_structural_block | Grep PHP 結構語法（function xxx / ->method( / ::method( / class xxx / extends 等）+ PHP context | ❌ 第 1 次就 BLOCK |
| L2.5 | grep_scatter_search | Grep 散搜 3+ 不同路徑 | 🧠 強制注入記憶 |
| L2.6 | grep_read_alternation | Grep↔Read 交替 3+ 次 | ⚠️ 提醒改用高效工具 |
| L2.7 | edit_batch_replace | Edit 跨檔相同替換 3+ 次 | ⚠️ 警告（5+ 次 block） |
| L2.8 | same_file_edit | 同一檔案連續 Edit/apply_diff 5+ 次 | ⚠️ 警告（8+ 次 block） |
| L2.9 | php_db_cursor_trap | PHP 寫入時 `while ($x = $db->getNext())` 外層對同一 `$db` 做 execute/execNext | ❌ block（外層 cursor 被覆蓋） |
| L2.10 | css_inspect_gate | (a) `.css` 寫入第 **1** 個 `!important` 但 session 未跑過 inspect 工具 → BLOCK；(b) 使用者回報「排版/跑版/樣式問題」設 `cssInspectRequired` flag，未 inspect 前任何 `.css` 寫入 BLOCK；(c) 已 inspect 但累計 ≥10 個 `!important` → 警告改隔離命名空間 | ❌ 強制先 css_computed_winner / css_specificity_check / css_inspect |
| L3 | same_category_repeat | 同類操作 3+ 次 | ⚠️ 警告（10+ 次 block） |
| L4 | uncommitted_accumulation | 修改 15+ 檔案未 commit | ℹ️ 提醒（大 commit 流程） |
| L5 | token_waste_detection | 8 種低效模式（重複讀檔、無過濾 Grep、頻繁截圖等） | 💰 active=逐次提醒 / passive=每 N 次摘要 |
| L6 | auto_fix_suggestion | sed/awk 可自動化操作 | ✨ 生成修復建議 |
| L7 | workload_reminder | 30+ tool calls + 4+ 工具種類 + 20%+ 修改比例 | 📋 提醒分發任務（僅一次） |

**Refactor Advisor**（refactor-advisor.js，觸發：Edit/Write/apply_diff 修改 PHP 檔案時）：

| # | 偵測項 | 嚴重度 | 說明 |
| --- | --- | --- | --- |
| 1 | file_too_large | 🔴/🟡 | 檔案 >400/800 行 |
| 2 | srp_violation | 🔴 | 單檔函式 >15 個 |
| 3 | long_function | 🟡 | 單一函式 >80 行 |
| 4 | god_class | 🔴 | 單一 class >20 方法 |
| 5 | deep_nesting | 🟡 | 巢狀 >5 層 |
| 6 | mixed_concerns | 🔴 | SQL + HTML 同檔 |
| 7 | duplicate_code | 🟡 | 連續 5 行重複 3+ 次 |
| 8 | inline_sql | 🟡 | SQL 無 class/function 封裝 |
| 9 | hardcoded_repeat | 🟡 | 單行硬編碼重複 5+ 次 |
| 10 | inline_css | 🟡 | `<style>` >30 行或 inline style >10 個 |
| 11 | short_var_names | 🟡 | 單字母變數（排除 $i/$j/$k） |
| 12 | too_many_params | 🟡 | 函式參數 >4 個 |
| 13 | magic_numbers | 🟡 | 魔術數字重複 3+ 次 |
| 14 | dual_state_session_branch | 🟡 | method 含 `if(isset($_SESSION...))` + `else` 雙分支 SQL，提醒同步維護登入/未登入兩路徑（觸發路徑與 session regex 可由 `CLAUDE_DUAL_STATE_PATH_REGEX` 與 `CLAUDE_DUAL_STATE_SESSION_RE` 覆寫） |

---

## 兩套 Skills 系統

**系統 A：MCP Prompts**（較少用）

- 存放：`Skills/*_agent.md`，需在 `skills/index.js` 登記後重啟

**系統 B：斜線指令**（主要）

- 存放：`Skills/commands/{dept_folder}/*.md`（必須放在對應部門子資料夾，不可放根目錄）
- 部署：呼叫 `save_claude_skill` 工具（自動儲存＋部署）或執行 `deploy-commands.bat`
- 觸發：在 Claude Code 輸入 `/skill-name`
- **上限：公開 Skill 總數不超過 60 個**，超過前先用 `/skill_audit` 審查並合併相似技能

**Skills 清單**：見 `dashboard/index.html` 或對話開始時的 system-reminder。

---

## 新增 Skill 流程

1. 先讀 `Skills/commands/_skill_template.md`（格式規範）
2. 將 MD 檔寫入對應子資料夾（如 `Skills/commands/deploy/sftp_deploy.md`）
3. 部署到 `~/.claude/commands/`（flat，不含子資料夾路徑）：
   - 單檔：`cp Skills/commands/subfolder/skill.md ~/.claude/commands/skill.md`
   - 全部：重跑 `deploy-commands.bat`（自動發現所有公開 Skill）
   - 使用 `save_claude_skill` 工具時**步驟 3 自動完成**，但步驟 4 仍需手動執行
4. 更新 `dashboard/index.html`（**必做**，不可遺漏）：
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

1. 將新工具 `my_module.js`（匯出 `definitions` + `handle(name, args)`）放入合適的分類資料夾：
   - `file_io/` — 檔案讀寫、文件轉換
   - `data/` — 資料庫、索引、RAG
   - `deploy/` — 遠端部署、版控、DB migration
   - `browser/` — 瀏覽器自動化、網頁檢查
   - `system/` — 系統工具、多 Agent 協調、程式碼分析
   - `utils/` — 通用比對工具
   - 若新工具需共用函式，提取至 `tools/_shared/`
2. **無需修改 index.js**——新工具會被遞迴 glob 自動載入（`tools/**/*.js` pattern）
3. 同步更新三份文件（**必做**，不可遺漏）：
   - **CLAUDE.md** — `tools/{category}/` 目錄結構中加入新工具
   - **README.md** — 工具總覽區段（數量、表格列、如有新區段則新增）
   - **dashboard.html** — MCP Tools 區段的 tag + `dept-count` + `section-total` + 頂部總數 + JS `SKILLS` 物件內各 Skill 的 `tools` 陣列
4. 重啟 MCP Server

**完成後自我核對（每次新增/修改 MCP 工具後必做）：**

```text
☐ tools/{category}/my_module.js 建立並匯出 definitions + handle？
☐ CLAUDE.md tools/ 目錄結構（對應分類下）已更新？
☐ README.md 工具表格/數量已更新？
☐ dashboard.html tag 已新增？
☐ dashboard.html dept-count 已更新？
☐ dashboard.html section-total 與頂部總數已更新？
☐ dashboard.html JS SKILLS 物件的 tools 陣列已更新？
☐ MCP Server 已重啟？
```

---

## 注意事項

- **禁止在 Bash 直接呼叫 `python`、`python3`、`pip`**：Windows 上這些命令會觸發 Microsoft Store stub，不會執行 Python。所有 Python 執行一律透過 MCP 工具 `run_python_script`（走 Docker 容器 `python_runner`）。安裝套件用 `docker exec python_runner pip install 套件名`。
- `skills/index.js`（小寫）= MCP Prompts 路由；`Skills/`（大寫）= MD 檔目錄，兩者不同
- **所有 Skill MD 必須放在對應部門子資料夾**（`_skill_template.md` 例外）；部署到 `~/.claude/commands/` 才是 flat 結構
- 新增 Skill 後更新 `dashboard/index.html`（含 JS SKILLS 物件）；**不需修改此 CLAUDE.md**（目錄結構變動除外）
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
