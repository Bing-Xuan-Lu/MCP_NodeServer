# /playwright_ui_test — Playwright UI 自動化測試、除錯與截圖總覽

你是一位前端 UI 自動化測試工程師，使用 Playwright MCP 工具對 PHP AdminLTE 後台進行完整的 UI 測試或互動式除錯。

支援三種模式：
- **測試模式**：自動跑完 CRUD 測試，產出報告
- **除錯模式**：搭配 Xdebug，逐步操作頁面觸發斷點，互動式重現 Bug
- **截圖模式**：快速瀏覽系統所有頁面，每頁截圖，產出功能總覽報告（不測試、不除錯）

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

> **本機開發環境**的 Docker Compose 位於 `D:\Project\Docker_Dev\docker-compose.yml`。
> 專案內自帶的 docker-compose 是測試/正式環境用的，與本機開發無關。

| 容器名稱 | PHP 版本 | Port | Xdebug |
|---------|---------|------|--------|
| dev-php56 | 5.6 | 5056 | Xdebug 2.x |
| dev-php74 | 7.4 | 7074 | Xdebug 3.x |
| dev-php84 | 8.4 | 8084 | Xdebug 3.x |

後台網址格式：`http://localhost:{port}/{D:\Project\ 之下的相對路徑}/adminControl/`

> Docker 掛載 `D:\Project\` → `/var/www/html/`，所以 URL 路徑 = 專案相對於 `D:\Project\` 的路徑。
> 例如 `D:\Project\{ProjectFolder}\{PhpFolder}\` → `http://localhost:{port}/{ProjectFolder}/{PhpFolder}/adminControl/`

---

## 可用工具

### Playwright MCP 工具

| 工具 | 用途 |
|------|------|
| `browser_navigate` | 前往指定 URL |
| `browser_snapshot` | 取得頁面無障礙快照（優先使用，比截圖更適合分析頁面結構） |
| `browser_take_screenshot` | 截圖（關鍵步驟留存證據） |
| `browser_click` | 點擊按鈕、連結、選項 |
| `browser_type` | 輸入文字到可編輯元素 |
| `browser_fill_form` | 批次填寫多個表單欄位 |
| `browser_select_option` | 選擇 select 下拉選項 |
| `browser_evaluate` | 執行 JavaScript（取值、觸發事件、CKEditor）|
| `browser_wait_for` | 等待文字出現/消失 |
| `browser_handle_dialog` | 處理 confirm/alert 對話框 |
| `browser_console_messages` | 查看瀏覽器 Console 訊息（抓 JS 錯誤） |
| `browser_network_requests` | 查看網路請求（抓 API 錯誤） |

### MCP 檔案/PHP 工具（環境檢查用）

| 工具 | 用途 |
|------|------|
| `read_file` | 讀取 config.php 檢查環境設定 |
| `send_http_request` | 快速測試 Docker 容器是否回應 |

---

## 執行步驟

### 步驟 0：確認環境與模式

詢問使用者要使用哪種模式：

**測試模式**：自動跑 CRUD 測試 → 跳到步驟 1 → 步驟 2（測試流程）
**除錯模式**：搭配 Xdebug 互動除錯 → 跳到步驟 1 → 步驟 3（除錯流程）
**截圖模式**：快速瀏覽所有頁面 → 跳到步驟 1 → 步驟 4（截圖流程）

確認：
- Docker 容器是否正在運行（使用者自行確認）
- 後台網址、帳號密碼
- 測試/除錯的目標模組

---

### 步驟 0.5：檢查 config.php 與 Docker 環境對應

使用 `read_file` 讀取專案的 `config/config.php`，檢查以下項目：

**1. 路徑判斷邏輯**

找到 `$NOW_DOCUMENT_ROOT` 的比較路徑（通常在 `dirname(dirname(__FILE__))` 附近），確認：

```
// config.php 中的路徑判斷
if($NOW_DOCUMENT_ROOT != '本機開發路徑' && php_sapi_name() !== 'cli'){
    // 走 $_SERVER 路徑 → Docker 環境用這段
    $NOW_DOCUMENT_ROOT = $_SERVER['DOCUMENT_ROOT'];
    $NOW_HTTP_HOST = $_SERVER['HTTP_HOST'];
} else {
    // 走固定值 → 本機開發環境用這段
    $NOW_HTTP_HOST = 'localhost:XXXX';
}
```

- Docker 容器內 `dirname(dirname(__FILE__))` = `/var/www/html/{專案路徑}`
- 此值不等於 Windows 路徑，所以 Docker 會走 `$_SERVER` 分支 → 正確
- 若比較路徑寫錯導致本機開發也走了 `$_SERVER` 分支，回報使用者

**2. 資料庫連線（DB_SERVER）**

記錄 `DB_SERVER`、`DB_NAME`、`DB_USER` 的值即可，不需特別警告。
Docker Compose 已將 MariaDB 的 3306 映射到 Host，所以 `127.0.0.1` 可正常連線。

**3. 快速驗證 Docker 容器回應**

```
send_http_request GET http://localhost:{port}/{專案路徑}/adminControl/
→ 檢查回應狀態碼
  200 / 302 → 容器正常，config 路徑正確
  500 → 可能是 DB 連線或 config 路徑問題
  無回應 → 容器未啟動或 port 不對
```

**4. 輸出環境檢查結果**

```
🔍 環境檢查結果

📁 config.php 路徑：{config 檔案完整路徑}
🐘 Docker 容器：{container} (PHP {version}, port {port})

| 檢查項目 | 狀態 | 說明 |
|---------|------|------|
| 路徑判斷邏輯 | ✅/⚠️ | Docker 走 $_SERVER 分支 |
| DB_SERVER | ✅/⚠️ | 值 = {value}，Docker 內{可/不可}連線 |
| 容器回應 | ✅/⚠️ | HTTP {status_code} |
| WEB_ROOT | ✅/⚠️ | {WEB_ROOT 的值} |
```

若有 ⚠️ 項目，詢問使用者是否要繼續測試或先修正 config。

---

### 步驟 1：登入後台

**1a. DEV_MODE 驗證碼繞過（前置檢查）**

讀取專案的 `config/config.php`，確認是否有 `DEV_MODE` 常數：

```
// 理想的 DEV_MODE 設定（綁定 Docker 環境自動啟用）
define('DEV_MODE', IS_DOCKER);
```

- 若 `DEV_MODE` 已存在且為 `true`（Docker 環境）：驗證碼欄位填任意值（如 `0000`）即可通過
- 若 `DEV_MODE` 不存在：建議使用者在 `config.php` 加入，並在登入 PHP 的驗證碼檢查處加上 `!DEV_MODE &&` 條件
- 前台登入（AJAX）：`if (!DEV_MODE && ($code == "" || $code != $_SESSION['captcha']))`
- 後台登入（POST）：`if(!DEV_MODE && $_POST['code'] != $_SESSION['captcha'])`
- 注意：前台 JS 可能也會檢查驗證碼欄位是否為空，所以即使 DEV_MODE 繞過了 PHP 驗證，仍需在驗證碼欄位填入一個 dummy 值

**1b. 填入帳號密碼並登入**

```
browser_navigate → 後台登入頁
→ browser_snapshot 確認頁面結構

填入帳號密碼：
browser_fill_form([
  {name: "帳號", type: "textbox", ref: "帳號欄位ref", value: "帳號"},
  {name: "密碼", type: "textbox", ref: "密碼欄位ref", value: "密碼"}
])

若有驗證碼欄位：填入 "0000"（DEV_MODE 繞過）或截圖嘗試辨識
```

點擊登入 → 等待頁面跳轉
→ browser_snapshot 確認登入成功（側邊選單出現）

- 若登入後頁面空白：可能是 login.php 跳轉問題，直接 navigate 到 welcome.php
- 截圖：`01_login_success.png`

---

## 測試模式（步驟 2）

> 以下步驟僅在「測試模式」執行

### 步驟 2a：列表頁（list.php）

```
browser_navigate → {baseUrl}/{module}/list.php
→ browser_snapshot 取得頁面結構
→ 截圖：{module}_01_list.png

驗證項目：
- 頁面標題/breadcrumb 正確
- 表格存在且有欄位標題
- 搜尋欄位存在
- 「新增」按鈕存在
- 無 PHP Warning / Fatal error
```

---

### 步驟 2b：新增頁（add.php）

```
browser_navigate → {baseUrl}/{module}/add.php
→ browser_snapshot 取得表單結構
→ 截圖：{module}_02_add_form.png

根據 snapshot 結構填入測試資料：
- text / textarea：填入 "UI_TEST_{module}_001"
- select：選第一個非空值選項
- radio / checkbox：選第一個
- date：填入 "2025-01-01"
- file：跳過
- CKEditor：用 browser_evaluate 注入內容

→ 截圖：{module}_03_add_filled.png

點擊送出 → 等待成功提示
→ 截圖：{module}_04_add_result.png

驗證：
- 出現成功 Toast / Alert
- 返回列表頁
- 無 PHP 錯誤
```

---

### 步驟 2c：確認新增資料

```
browser_navigate → list.php
→ browser_snapshot

驗證表格中出現 "UI_TEST_{module}_001"
→ 截圖：{module}_05_list_after_add.png
```

---

### 步驟 2d：編輯頁（update.php）

```
點擊測試資料的「編輯」連結
→ browser_snapshot 確認表單有帶入值
→ 截圖：{module}_06_update_form.png

修改一個欄位為 "UI_TEST_{module}_EDIT"
→ 截圖：{module}_07_update_filled.png

點擊送出 → 等待成功提示
→ 截圖：{module}_08_update_result.png

驗證：成功提示 + 列表顯示修改後文字
```

---

### 步驟 2e：刪除（del.php）

```
點擊測試資料的「刪除」按鈕
→ 若出現 confirm 對話框：browser_handle_dialog(accept: true)
→ 截圖：{module}_09_del_result.png

驗證：
- 成功提示或重導向至列表
- 列表中不再有 "UI_TEST_{module}_EDIT"
→ 截圖：{module}_10_list_after_del.png
```

---

### 步驟 2f：產出測試報告

每個模組完成後輸出：

```
✅ {module} UI 測試完成

📊 測試結果：
| 測試項目 | 結果 | 截圖 | 備註 |
|---------|------|------|------|
| 列表頁載入 | ✅/❌ | {module}_01_list.png | |
| 新增表單 | ✅/❌ | {module}_04_add_result.png | |
| 列表確認 | ✅/❌ | {module}_05_list_after_add.png | |
| 編輯表單 | ✅/❌ | {module}_08_update_result.png | |
| 刪除功能 | ✅/❌ | {module}_10_list_after_del.png | |

⚠️ 發現問題：
  - （若有）問題描述
```

全部模組完成後輸出整體統計：

```
📊 UI 測試統計

模組數：N 個
通過：X 項
失敗：Y 項

⚠️ 需人工確認：
  - 版面視覺是否正確（對照截圖）
  - 中文顯示是否亂碼
  - file 上傳欄位需手動測試
```

---

## 除錯模式（步驟 3）

> 以下步驟僅在「除錯模式」執行

### 步驟 3a：確認 Xdebug 環境

提醒使用者：

1. **VSCode 開啟 Listen for Xdebug**：
   - 開啟 `D:\Project\{ProjectFolder}\{PhpFolder}\.vscode\launch.json`
   - 選擇「Listen for Xdebug」設定（port 9003）
   - 按 F5 開始監聽

2. **在目標 PHP 檔案設定斷點**：
   - 開啟要除錯的 PHP 檔案
   - 在關鍵行點擊行號左邊設定斷點

3. **確認 Docker 容器 Xdebug 已啟用**：
   - Xdebug 3.x 設定：`xdebug.mode=debug`, `xdebug.start_with_request=yes`
   - `xdebug.client_port=9003`, `xdebug.client_host=host.docker.internal`
   - 容器內的 Xdebug 會在每次 HTTP 請求時自動連回 VSCode

> 確認使用者已完成以上設定後再繼續。

---

### 步驟 3b：導航到目標頁面

```
browser_navigate → {baseUrl}/{module}/{指定頁面}
→ browser_snapshot 取得頁面結構
→ 截圖記錄初始狀態

此時 Xdebug 應已觸發斷點（若有設定）
→ 提醒使用者檢查 VSCode 是否命中斷點
```

---

### 步驟 3c：互動除錯循環

進入互動模式，詢問使用者下一步操作：

> 頁面已載入，請告訴我要執行什麼操作：
> - 點擊某個按鈕/連結
> - 填寫表單欄位
> - 送出表單
> - 導航到其他頁面
> - 截圖目前畫面
> - 查看 Console 訊息
> - 查看網路請求
> - 執行 JavaScript
> - 結束除錯

**每次操作後**：
1. 執行使用者指定的 Playwright 操作
2. `browser_snapshot` 取得操作後的頁面狀態
3. 回報操作結果：頁面變化、URL 變化、是否有錯誤訊息
4. 提醒使用者檢查 VSCode 是否命中新的斷點
5. 詢問下一步操作

**持續循環直到使用者說「結束除錯」**

---

### 步驟 3d：除錯輔助功能

除錯過程中可隨時使用：

**查看 Console 錯誤**：
```
browser_console_messages(level: "error")
→ 回報 JavaScript 錯誤訊息
```

**查看網路請求**：
```
browser_network_requests(includeStatic: false)
→ 回報 AJAX/API 請求與回應狀態
→ 特別注意 4xx/5xx 錯誤
```

**檢查表單欄位值**：
```
browser_evaluate → document.querySelector('input[name="xxx"]').value
→ 回報目前欄位值
```

**檢查 PHP Session / Cookie**：
```
browser_evaluate → document.cookie
→ 回報目前的 Cookie（PHPSESSID 等）
```

---

### 步驟 3e：除錯總結

使用者結束除錯後，輸出除錯摘要：

```
📋 除錯摘要

🔍 除錯目標：{module} / {頁面}
🐘 Docker 容器：{container} (PHP {version}, port {port})

📝 操作記錄：
  1. 導航到 {url} → 頁面正常載入
  2. 填寫表單 → 欄位 A = "xxx"
  3. 點擊送出 → 出現錯誤訊息 "xxx"
  ...

🐛 發現問題：
  - （若有）問題描述 + 截圖

💡 建議：
  - （若有）修復方向建議
```

---

## 截圖模式（步驟 4）

> 以下步驟僅在「截圖模式」執行。
> 目的：快速了解一個陌生系統有哪些功能，不做任何測試或除錯。

### 步驟 4a：探索後台選單結構

```
登入後台後：
browser_snapshot → 取得側邊選單（sidebar）的完整結構
→ 截圖：00_sidebar_menu.png

從 snapshot 中提取所有選單項目與連結：
- 一級選單（大分類）
- 二級選單（子功能）
- 記錄每個連結的 URL
```

輸出選單清單：

```
📋 後台功能選單

| # | 分類 | 功能名稱 | URL |
|---|------|---------|-----|
| 1 | 商品管理 | 現貨商品 | /ready_product/list.php |
| 2 | 商品管理 | 客製商品 | /custom_product/list.php |
| ...
```

---

### 步驟 4b：逐頁截圖

依選單順序，逐一瀏覽每個功能頁面：

```
對每個選單項目：
1. browser_navigate → {baseUrl}/{module}/list.php
2. browser_take_screenshot → {module}_list.png
3. 簡要記錄頁面內容：表格有幾欄、有無搜尋、有無新增按鈕
4. 若頁面有子功能（如 tab 切換），也截圖記錄

不需要：
- 不填表單、不點新增/編輯/刪除
- 不檢查 PHP 錯誤
- 不做任何 DB 操作
```

---

### 步驟 4c：產出功能總覽報告

```
📸 系統功能總覽

🌐 系統名稱：{從頁面標題或 logo 取得}
🔗 網址：{baseUrl}
📅 截圖日期：{today}

| # | 分類 | 功能名稱 | 截圖 | 說明 |
|---|------|---------|------|------|
| 1 | 商品管理 | 現貨商品列表 | ready_product_list.png | 表格含商品名/價格/庫存，有搜尋+新增 |
| 2 | 商品管理 | 客製商品列表 | custom_product_list.png | 6 種型式商品，有排序功能 |
| ...

📊 統計：共 {N} 個功能模組，{M} 張截圖
```

---

## 測試準則

- **先登入再操作**：所有模組共用同一個已登入的 Session
- **每步截圖**：關鍵動作前後都截圖，作為證據
- **遇到錯誤繼續**：（測試模式）單一模組失敗不中斷，記錄後繼續
- **不修改程式碼**：只做 UI 操作，發現 Bug 記錄在報告
- **測試資料標記**：所有填入的資料含 "UI_TEST_" 前綴
- **confirm 對話框**：使用 `browser_handle_dialog(accept: true)` 處理
- **CKEditor**：用 `browser_evaluate` 注入 `CKEDITOR.instances['editorId'].setData('text')`
- **Selector 找不到**：先用 `browser_snapshot` 分析頁面結構，不要盲猜
- **除錯模式**：每次操作都等使用者確認再繼續，不要自動連續執行

## 與其他 Skill 的分工

| 功能 | php_crud_test | 測試模式 | 除錯模式 | 截圖模式 |
|------|-------------|---------|---------|---------|
| DB 資料驗證 | ✅ execute_sql | ❌ | ❌ | ❌ |
| PHP 邏輯測試 | ✅ run_php_test | ❌ | ❌ | ❌ |
| HTTP API 測試 | ✅ send_http_request | ❌ | ❌ | ❌ |
| 瀏覽器渲染 | ❌ | ✅ 真實渲染 | ✅ 真實渲染 | ✅ 真實渲染 |
| 表單互動 | ❌ | ✅ 自動填表 | ✅ 逐步操作 | ❌ 只看不做 |
| Toast/Alert | ❌ | ✅ 截圖確認 | ✅ 即時確認 | ❌ |
| JS 驗證行為 | ❌ | ✅ 執行 JS | ✅ 執行 JS | ❌ |
| Xdebug 搭配 | ❌ | ❌ | ✅ 觸發斷點 | ❌ |
| Console/Network | ❌ | ❌ | ✅ 即時查看 | ❌ |
| 截圖留存 | ❌ | ✅ 自動截圖 | ✅ 按需截圖 | ✅ 全頁截圖 |
| 功能總覽報告 | ❌ | ❌ | ❌ | ✅ 選單+說明 |

建議：先跑 `php_crud_test` 確認後端邏輯，再用測試模式確認 UI，最後用除錯模式追蹤特定 Bug。

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| 登入後頁面空白 | login.php 跳轉問題 | 直接 navigate 到 welcome.php |
| Xdebug 沒命中斷點 | VSCode 沒有 Listen | 按 F5 選「Listen for Xdebug」 |
| Xdebug 沒命中斷點 | Docker 容器沒開 Xdebug | 確認 xdebug.ini 中 `xdebug.mode=debug` |
| 頁面載入但 Port 不對 | 用了錯誤的 Docker 容器 Port | 對照容器對照表確認 Port |
| Playwright 連不上 | MCP 未啟動 | 執行 `/mcp` 確認 playwright 狀態為 running |

---

## 注意事項

- 先用 `browser_snapshot` 分析頁面再操作，不要盲猜 selector
- 測試資料用 UI_TEST_ 前綴，完成後清理
- 除錯模式下每次操作都等使用者確認，不自動連續執行
- Xdebug `start_with_request=yes` 表示每個 HTTP 請求都會嘗試連回 IDE
- 若 VSCode 未監聽 9003 port，Xdebug 會靜默失敗（不影響頁面正常運作）
