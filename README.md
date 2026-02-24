# Project Migration Assistant Pro (MCP Server)

基於 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 構建的多功能伺服器，整合檔案系統、資料庫、Excel 邏輯分析、PHP 測試以及 **Chrome 書籤管理** 等功能。

## 專案結構

```text
MCP_NodeServer/
├── index.js              ← 啟動 + 路由整合 (77 行)
├── config.js             ← 共用設定 + resolveSecurePath
├── tools/
│   ├── filesystem.js     ← 檔案系統工具 (4)
│   ├── php.js            ← PHP 執行工具 (4)
│   ├── database.js       ← 資料庫工具 (2)
│   ├── excel.js          ← Excel 分析工具 (3)
│   └── bookmarks.js      ← Chrome 書籤工具 (12)
├── skills/
│   └── index.js          ← Agent Skill 路由
└── Skills/
    ├── php_crud_agent.md      ← PHP CRUD 產生器 Skill
    ├── php_upgrade_agent.md   ← PHP 7.x → 8.4 升級 Skill
    └── bookmark_agent.md      ← 書籤整理範例 Prompt
```

每個 `tools/` 模組統一介面：

```js
export const definitions = [...];          // 工具 Schema 清單
export async function handle(name, args)   // 工具邏輯
```

---

## 工具總覽 (26 個)

### 1. 檔案系統 (4)

| 工具 | 說明 |
|------|------|
| `list_files` | 列出目錄內容 |
| `read_file` | 讀取檔案內容 |
| `create_file` | 建立或覆寫檔案 |
| `apply_diff` | Search & Replace 模式修改檔案 |

> 所有檔案操作限制在 `BASE_PROJECT_PATH` 目錄下 (預設 `D:\Project\`)。

### 2. PHP 執行 (4)

| 工具 | 說明 |
|------|------|
| `run_php_script` | 執行 PHP 腳本 (CLI 模式)，回傳 Stdout/Stderr |
| `run_php_test` | 自動建立測試環境 (模擬 `$_SESSION` / `$_POST`) 並執行 PHP |
| `send_http_request` | 發送 HTTP 請求，支援 Multipart 檔案上傳 |
| `tail_log` | 讀取檔案最後 N 行 (適用 PHP Error Log) |

### 3. 資料庫 MySQL (2)

| 工具 | 說明 |
|------|------|
| `get_db_schema` | 查看資料表結構 (欄位與型別) |
| `execute_sql` | 執行 SQL 指令 (DDL/DML) |

### 4. Excel 分析 (3)

| 工具 | 說明 |
|------|------|
| `get_excel_values_batch` | 批次讀取儲存格，支援範圍 (`A1:B10`) 或列表 (`['A1','C3']`) |
| `trace_excel_logic` | 追蹤公式邏輯鏈 — 引用來源 (Precedents) 或影響範圍 (Dependents) |
| `simulate_excel_change` | 模擬修改數值並重算結果 (不動原檔) |

> 整合 [HyperFormula](https://github.com/handsontable/hyperformula) 引擎，支援跨工作表公式解析。

### 5. Chrome 書籤管理 (12)

| 工具 | 說明 |
|------|------|
| `get_bookmark_structure` | 取得書籤資料夾樹狀結構 (僅資料夾名稱 + 書籤數量) |
| `get_folder_contents` | 列出資料夾內所有書籤 (ID / Title) |
| `create_bookmark_folder` | 在指定父資料夾下建立新資料夾 |
| `rename_bookmark_folder` | 重新命名資料夾 |
| `delete_bookmark_folder` | 刪除資料夾 (預設僅空資料夾，可強制刪除) |
| `move_bookmarks` | 整批搬移書籤/子資料夾，支援關鍵字篩選 |
| `move_specific_bookmarks` | 依 ID 精準搬移書籤 (每次上限 20 個) |
| `sort_bookmarks` | 資料夾置頂 + 名稱 A-Z / 中文筆畫排序 |
| `scan_and_clean_bookmarks` | 掃描無效連結 (404/DNS Error)，可自動移除 |
| `remove_duplicates` | 移除重複網址 (保留最早建立的) |
| `remove_chrome_bookmarks` | 依 URL 刪除特定書籤 |
| `export_bookmarks_to_html` | 匯出為 Netscape HTML 格式 (可匯入任何瀏覽器) |

**書籤工具特色：**
- 自動排除內網 IP (192.168.x / 10.x / localhost) 避免誤判
- HEAD → GET 降級策略，減少 405/403 誤報
- 每次操作自動備份原始 Bookmarks 檔案
- 支援搬移子資料夾 (不只是書籤連結)

### 6. 網頁工具 (1)

| 工具 | 說明 |
|------|------|
| `fetch_page_summary` | 讀取網頁並提取摘要 (標題 + 描述 + 前 2000 字) |

---

## Agent Skills

MCP Prompts 功能，可在 Claude 中直接呼叫完整的 Agent 技能書。

| Skill 名稱 | 說明 | MD 檔案 |
| --- | --- | --- |
| `php_crud_generator` | 根據資料表自動產生完整後台模組 (model + CRUD 頁面) | `Skills/php_crud_agent.md` |
| `php_upgrade` | PHP 7.x → 8.4 升級 Agent — 掃描資料夾、自動修正為 PHP 8.4 相容語法（13 條升遷規則） | `Skills/php_upgrade_agent.md` |
| `bookmark_organizer` | Chrome 書籤整理 SOP + 範例 Prompt 集 | `Skills/bookmark_agent.md` |

---

## 新增 Skill 步驟

### Step 1 — 撰寫技能書 MD 檔

在 `Skills/` 目錄下建立 `.md` 檔，描述 Agent 的角色、可用工具、執行流程：

```text
Skills/
└── my_new_skill.md
```

MD 檔撰寫建議：

- **角色定義**：你是什麼 Agent，能做什麼
- **可用 MCP 工具**：列出此 Skill 會用到的工具名稱
- **輸入格式**：使用者應該提供什麼資訊
- **執行流程**：Step by Step 的操作步驟
- **完成提示**：完成後要告知使用者什麼

### Step 2 — 在 `skills/index.js` 登記

```js
// 1. 在 definitions 陣列加入 Skill 描述
export const definitions = [
  // ... 現有 Skills ...
  {
    name: "my_new_skill",
    description: "這個 Skill 的簡短說明",
    arguments: [
      { name: "someParam", description: "參數說明", required: false },
    ],
  },
];

// 2. 在 getPrompt() 加入對應的讀取邏輯
export async function getPrompt(name, args = {}) {
  // ... 現有 Skills ...

  if (name === "my_new_skill") {
    const skillPath = path.join(SKILLS_DIR, "my_new_skill.md");
    const content = await fs.readFile(skillPath, "utf-8");
    // 可選：用 args 替換 MD 裡的 {{PLACEHOLDER}}
    return {
      messages: [{ role: "user", content: { type: "text", text: content } }],
    };
  }
}
```

### Step 3 — 重啟 MCP Server

重新啟動後，Claude 即可透過 Prompts 清單看到並呼叫新 Skill。

---

## 新增工具模組步驟

### Step 1 — 建立 `tools/my_module.js`

```js
import { resolveSecurePath } from "../config.js";

export const definitions = [
  {
    name: "my_tool",
    description: "工具說明",
    inputSchema: {
      type: "object",
      properties: { param: { type: "string" } },
      required: ["param"],
    },
  },
];

export async function handle(name, args) {
  if (name === "my_tool") {
    // 工具邏輯
    return { content: [{ type: "text", text: "結果" }] };
  }
}
```

### Step 2 — 在 `index.js` 加入模組

```js
import * as myModule from "./tools/my_module.js";

const TOOL_MODULES = [filesystem, php, database, excel, bookmarks, myModule]; // 加到陣列末尾
```

---

## 安裝與設定

### 前置需求
- Node.js v18+
- MySQL (選用，書籤功能不需要)
- Chrome 瀏覽器 (書籤功能)

### 安裝
```bash
npm install
```

### 環境變數 (.env)
```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的密碼
DB_NAME=pnsdb
```

### 啟動
```bash
node index.js
```

## 整合設定

### 從 Git Clone 後的完整設定步驟

#### Step 1 — 安裝依賴
```bash
npm install
```

#### Step 2 — 設定環境變數
複製 `.env.example` 並填入資料庫密碼：
```bash
cp .env.example .env
```

#### Step 3 — 連接 Claude Code（MCP Server）

將專案內的 `.mcp.json` **複製到家目錄**，讓 Claude Code 能自動啟動 MCP Server：

```bash
# Windows
copy .mcp.json %USERPROFILE%\.mcp.json

# macOS / Linux
cp .mcp.json ~/.mcp.json
```

> ⚠️ 複製後請將 `.mcp.json` 內的路徑改為你本機的實際路徑：
> ```json
> {
>   "mcpServers": {
>     "project-migration-assistant-pro": {
>       "type": "stdio",
>       "command": "node",
>       "args": ["C:\\實際路徑\\MCP_Server\\index.js"]
>     }
>   }
> }
> ```

#### Step 4 — 部署斜線指令

執行專案根目錄的部署腳本，將 `Skills/commands/` 複製到 `~/.claude/commands/`：

```bash
# Windows
.\deploy-commands.bat

# macOS / Linux
bash deploy-commands.sh
```

部署完成後可直接使用：`/php_upgrade`、`/php_crud_generator`、`/bookmark_organizer`

> 💡 **維護說明**：只需修改 `Skills/commands/` 內的 `.md` 檔，改完後重新執行部署腳本即可。

#### Step 5 — 重啟 Claude Code

完全關閉並重新開啟 Claude Code，MCP Server 會自動啟動。

之後輸入 `/skills` 即可看到所有可用 Skill 清單。

---

### 設定完成後的使用方式

| 輸入 | 效果 |
|------|------|
| `/skills` | 顯示所有可用 Skill 清單 |
| 告訴 Claude 要用哪個 Skill | Claude 自動透過 MCP 調用 |

---

### Claude Desktop 設定（選用）
若使用 Claude Desktop，在 `claude_desktop_config.json` 中加入：
```json
{
  "mcpServers": {
    "project-migration-assistant-pro": {
      "command": "node",
      "args": ["C:\\實際路徑\\MCP_Server\\index.js"]
    }
  }
}
```

---

## 技術細節

- **MCP SDK**: `@modelcontextprotocol/sdk` v1.25+
- **架構**: 模組化 — 每個工具類別獨立為 `tools/*.js`，Skills 路由在 `skills/index.js`
- **Excel 引擎**: HyperFormula — 解析公式、追蹤引用鏈、模擬計算
- **路徑安全**: `resolveSecurePath()` 防止目錄穿越攻擊，限制在 `D:\Project\` 以內
- **ESM 相容**: `createRequire()` 在 ES Module 中載入 CommonJS 套件 (xlsx, hyperformula)
- **書籤路徑**: 自動偵測 Chrome User Data 路徑，支援自訂 `profilePath`

## 注意事項

- 書籤操作前請先關閉 Chrome，避免檔案鎖定衝突
- `move_specific_bookmarks` 每次最多 20 個，大量搬移需分批呼叫
- Excel 邏輯追蹤預設深度 3 層，可透過 `depth` 參數調整
- SQL 指令請謹慎操作，建議先在測試環境驗證
- 新增 Skill 後需重啟 MCP Server 才會生效
