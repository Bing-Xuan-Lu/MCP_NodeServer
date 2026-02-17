# Project Migration Assistant Pro (MCP Server)

基於 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 構建的多功能伺服器，整合檔案系統、資料庫、Excel 邏輯分析、PHP 測試以及 **Chrome 書籤管理** 等功能。

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
| `get_folder_contents` | 列出資料夾內所有書籤 (ID / Title / URL) |
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

> 書籤整理範例 Prompt 請參考 [PROMPTS.md](PROMPTS.md)

### 6. 網頁工具 (1)

| 工具 | 說明 |
|------|------|
| `fetch_page_summary` | 讀取網頁並提取摘要 (標題 + 描述 + 前 2000 字) |

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
BASE_PROJECT_PATH=D:\Project\
```

### 啟動
```bash
node index.js
```

## 整合設定

### Claude Desktop / Claude Code
在 `claude_desktop_config.json` 或 `.mcp.json` 中加入：
```json
{
  "mcpServers": {
    "project-migration-assistant-pro": {
      "command": "node",
      "args": ["d:/Develop/MCP_NodeServer/index.js"],
      "env": {
        "DB_PASSWORD": "你的密碼"
      }
    }
  }
}
```

## 技術細節

- **MCP SDK**: `@modelcontextprotocol/sdk` v1.25+
- **Excel 引擎**: HyperFormula — 解析公式、追蹤引用鏈、模擬計算
- **路徑安全**: `resolveSecurePath()` 防止目錄穿越攻擊
- **ESM 相容**: `createRequire()` 在 ES Module 中載入 CommonJS 套件 (xlsx)
- **書籤路徑**: 自動偵測 Chrome User Data 路徑，支援自訂 `profilePath`

## 注意事項

- Excel 邏輯追蹤預設深度 3 層，可透過參數調整
- 書籤操作前請先關閉 Chrome，避免檔案鎖定衝突
- `move_specific_bookmarks` 每次最多 20 個，大量搬移需分批呼叫
- SQL 指令請謹慎操作，建議先在測試環境驗證
