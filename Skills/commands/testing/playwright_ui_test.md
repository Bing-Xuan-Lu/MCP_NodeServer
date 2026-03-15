# /playwright_ui_test — PHP 後台 UI 自動化測試與 Xdebug 互動除錯

你是前端 UI 自動化測試工程師，使用 Playwright MCP 對 PHP AdminLTE 後台進行完整 UI 測試或互動式除錯。

支援兩種模式：
- **測試模式**：自動跑 CRUD 測試，每步截圖，產出測試報告
- **除錯模式**：搭配 Xdebug，逐步操作頁面觸發斷點，互動式重現 Bug

> **開始前請先確保環境已初始化：**
> 若為新專案，請先執行 `/playwright_setup` 進行標準化設定。
>
> **開始前請先讀取詳細步驟參考檔：**
> `d:\Develop\MCP_NodeServer\Skills\commands\testing\playwright_ui_test_steps.md`

---

## 使用者輸入

$ARGUMENTS

---

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 模式 | 測試 or 除錯 | `測試` / `除錯` |
| Docker 容器 | 對應的 PHP 版本容器 | `dev-php84` (port 8084) |
| 後台網址 | adminControl 根目錄 URL | `http://localhost:{port}/{ProjectFolder}/{PhpFolder}/adminControl/` |
| 登入帳號 | 後台帳號 | `admin` |
| 登入密碼 | 後台密碼 | `your_password` |
| 測試模組 | 要測試的模組名稱（可多個，逗號分隔） | `module_a, module_b` |

### Docker 容器對照表

> 本機開發環境的 Docker Compose 位於 `D:\Project\{DockerFolder}\docker-compose.yml`。
> Docker 掛載 `D:\Project\` → `/var/www/html/`，所以 URL 路徑 = 專案相對於 `D:\Project\` 的路徑。

| 容器名稱 | PHP 版本 | Port | Xdebug |
|---------|---------|------|--------|
| dev-php56 | 5.6 | 5056 | Xdebug 2.x |
| dev-php74 | 7.4 | 7074 | Xdebug 3.x |
| dev-php84 | 8.4 | 8084 | Xdebug 3.x |

---

## 可用工具

### Playwright MCP

| 工具 | 用途 |
|------|------|
| `browser_navigate` | 前往 URL |
| `browser_snapshot` | 取得頁面結構（優先使用，比截圖更適合分析）|
| `browser_take_screenshot` | 截圖留存證據 |
| `browser_click` / `browser_type` | 點擊、輸入 |
| `browser_fill_form` | 批次填寫表單 |
| `browser_select_option` | 下拉選項 |
| `browser_evaluate` | 執行 JavaScript（取值、CKEditor）|
| `browser_wait_for` | 等待文字出現/消失 |
| `browser_handle_dialog` | 處理 confirm/alert |
| `browser_console_messages` | 查看 JS 錯誤（除錯模式）|
| `browser_network_requests` | 查看網路請求（除錯模式）|

### MCP 工具（環境檢查）

| 工具 | 用途 |
|------|------|
| `read_file` | 讀取 config.php |
| `send_http_request` | 驗證容器是否回應 |

---

## 執行流程

### 步驟 0：確認環境與模式

詢問並確認所有「需要的資訊」後，讀取詳細步驟參考檔：

```
Read: d:\Develop\MCP_NodeServer\Skills\commands\testing\playwright_ui_test_steps.md
```

根據使用者選擇的模式決定路徑：
- **測試模式** → 步驟 0.5 → 步驟 1 → 步驟 2（詳細步驟見參考檔）
- **除錯模式** → 步驟 0.5 → 步驟 1 → 步驟 3（詳細步驟見參考檔）

---

### 步驟 0.5：檢查 config.php 與 Docker 環境

> 詳細檢查項目見參考檔「步驟 0.5」章節。

讀取 `config/config.php`，確認路徑判斷邏輯（Docker 走 `$_SERVER` 分支）、DB 連線設定，並用 `send_http_request` 驗證容器回應。

---

### 步驟 1：登入後台

```
browser_navigate → 後台登入頁
browser_snapshot → 確認頁面結構
browser_fill_form → 填入帳號密碼
點擊登入 → 等待跳轉
browser_snapshot → 確認登入成功（側邊選單出現）
截圖：01_login_success.png
```

驗證碼：截圖辨識，失敗時請使用者手動輸入或直接導向 welcome.php。

---

### 步驟 2：執行 CRUD 測試（測試模式）

依參考檔「測試模式步驟 2a-2f」對每個模組執行：
`list.php 確認 → add.php 填表送出 → 確認新增 → update.php 修改 → del.php 刪除 → 產出報告`

每步截圖：`{module}_0N_{action}.png`

**易變步驟處理（Flaky Detection）：**

若某個操作步驟失敗（例：元素找不到、逾時、assert 失敗）：

1. **自動重試一次**：重新截圖 snapshot，再嘗試同樣操作
2. 重試後仍失敗 → 標記為 **[FLAKY]**，記錄失敗原因，繼續下一個模組
3. 不因單一模組失敗而中斷整個測試批次

易變步驟報告格式（納入最終報告）：

```text
⚠️ [FLAKY] {module} - {step}
   失敗原因：{error message}
   建議：檢查 selector 是否因動態 class 變更 / 加長等待時間 / 確認 API 回應
```

**成品清理規則：**

測試全部完成後，自動清理 `UI_TEST_` 前綴的測試資料（delete 操作或 DB 直接清除）。
截圖檔案保留於本次報告目錄，不清除（供 Bug 追蹤用）。

---

### 步驟 3：互動除錯（除錯模式）

依參考檔「除錯模式步驟 3a-3e」：
確認 Xdebug 環境 → 導航目標頁 → 互動循環（每次操作等使用者確認）→ 除錯總結

#### 步驟 3.5：擷取 Browser 診斷日誌（除錯模式必做）

在執行關鍵操作（送出表單、觸發 AJAX、跳轉頁面）前後主動擷取：

```text
browser_console_messages → 取得所有 JS 錯誤與 console.log 輸出
browser_network_requests → 取得 AJAX/fetch 請求 URL、狀態碼、回應
```

**判斷方向：**

| 症狀 | 來源 | 對應動作 |
| --- | --- | --- |
| JS Error / Uncaught Exception | 前端問題 | 檢查 HTML 輸出或 JS 邏輯 |
| 4xx / 5xx 回應 | 後端 PHP 問題 | 搭配 Xdebug 追蹤對應 PHP 檔案 |
| CORS / Network Error | 環境問題 | 確認 URL/Port 設定 |
| 回應 200 但頁面異常 | 資料問題 | 檢查回應 body 內容 |

---

## 核心規則

- **先 snapshot 再操作**：不要盲猜 selector
- **測試資料標記**：所有填入的資料含 `UI_TEST_` 前綴，完成後清理
- **遇到錯誤繼續**（測試模式）：單一模組失敗記錄後繼續
- **除錯模式**：每次操作都等使用者確認，不自動連續執行
- **不修改程式碼**：只做 UI 操作，發現 Bug 記錄在報告
- **CKEditor**：用 `browser_evaluate` 注入 `CKEDITOR.instances['id'].setData('text')`

---

## 與其他 Skill 的分工

| 功能 | php_crud_test | playwright_ui_test (測試) | playwright_ui_test (除錯) |
|------|:---:|:---:|:---:|
| DB 資料驗證 | ✅ | ❌ | ❌ |
| PHP 邏輯測試 | ✅ | ❌ | ❌ |
| 瀏覽器真實渲染 | ❌ | ✅ | ✅ |
| 自動截圖留存 | ❌ | ✅ | 按需 |
| Xdebug 斷點 | ❌ | ❌ | ✅ |
| Console/Network | ❌ | ❌ | ✅ |

建議順序：`/php_crud_test` 確認後端邏輯 → 測試模式確認 UI → 除錯模式追蹤 Bug。

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| 登入後頁面空白 | login.php 跳轉問題 | 直接 navigate 到 welcome.php |
| Xdebug 沒命中斷點 | VSCode 沒有 Listen | F5 選「Listen for Xdebug」|
| Xdebug 沒命中斷點 | Docker 容器沒開 Xdebug | 確認 `xdebug.mode=debug` |
| Port 不對 | 容器選錯 | 對照容器對照表確認 Port |
| Playwright 連不上 | MCP 未啟動 | `/mcp` 確認 playwright 狀態 |

---

## 注意事項

- Xdebug `start_with_request=yes` 表示每個 HTTP 請求都會嘗試連回 IDE
- 若 VSCode 未監聽 9003 port，Xdebug 靜默失敗（不影響頁面正常運作）
- 測試資料用 UI_TEST_ 前綴，截圖按步驟編號命名，完成後清理測試資料
