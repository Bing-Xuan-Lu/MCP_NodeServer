# playwright_ui_test — 詳細步驟參考檔

> 此檔案由 `/playwright_ui_test` 主技能在執行時讀取。
> 包含 config.php 檢查、CRUD 測試模式、除錯模式的完整步驟說明。

---

## 步驟 0.5：檢查 config.php 與 Docker 環境對應

使用 `read_file` 讀取專案的 `config/config.php`，檢查以下項目：

**1. 路徑判斷邏輯**

找到 `$NOW_DOCUMENT_ROOT` 的比較路徑，確認：

```
if($NOW_DOCUMENT_ROOT != '本機開發路徑' && php_sapi_name() !== 'cli'){
    // Docker 環境走這段 → $NOW_DOCUMENT_ROOT = $_SERVER['DOCUMENT_ROOT']
} else {
    // 本機開發走這段 → 固定值
}
```

- Docker 容器內 `dirname(dirname(__FILE__))` = `/var/www/html/{專案路徑}`
- 此值不等於 Windows 路徑 → Docker 走 `$_SERVER` 分支 ✅

**2. 資料庫連線**

記錄 `DB_SERVER`、`DB_NAME`、`DB_USER` 即可。

**3. 快速驗證容器回應**

```
send_http_request GET http://localhost:{port}/{專案路徑}/adminControl/
→ 200/302 ✅ 容器正常
→ 500 ⚠️  DB 或 config 路徑問題
→ 無回應 ❌ 容器未啟動
```

**4. 輸出環境檢查結果**

```
🔍 環境檢查結果
📁 config.php：{路徑}
🐘 容器：{container} (PHP {version}, port {port})

| 檢查項目 | 狀態 | 說明 |
| 路徑判斷邏輯 | ✅/⚠️ | Docker 走 $_SERVER 分支 |
| DB_SERVER    | ✅/⚠️ | 值 = {value} |
| 容器回應     | ✅/⚠️ | HTTP {status_code} |
```

---

## 測試模式：步驟 2 CRUD 詳細流程

> 登入成功後，對每個模組依序執行以下步驟。

### 步驟 2a：列表頁（list.php）

```
browser_navigate → {baseUrl}/{module}/list.php
browser_snapshot → 確認頁面結構
截圖：{module}_01_list.png

驗證項目：
- 頁面標題/breadcrumb 正確
- 表格存在且有欄位標題
- 搜尋欄位存在
- 「新增」按鈕存在
- 無 PHP Warning / Fatal error
```

### 步驟 2b：新增頁（add.php）

```
browser_navigate → {baseUrl}/{module}/add.php
browser_snapshot → 取得表單結構
截圖：{module}_02_add_form.png

填入測試資料（依 snapshot 結構）：
- text/textarea → "UI_TEST_{module}_001"
- select → 第一個非空值
- radio/checkbox → 第一個
- date → "2025-01-01"
- file → 跳過
- CKEditor → browser_evaluate 注入

截圖：{module}_03_add_filled.png
點擊送出 → 等待成功提示
截圖：{module}_04_add_result.png

驗證：成功 Toast/Alert + 返回列表 + 無 PHP 錯誤
```

### 步驟 2c：確認新增資料

```
browser_navigate → list.php
browser_snapshot
驗證表格中出現 "UI_TEST_{module}_001"
截圖：{module}_05_list_after_add.png
```

### 步驟 2d：編輯頁（update.php）

```
點擊測試資料的「編輯」連結
browser_snapshot → 確認表單有帶入值
截圖：{module}_06_update_form.png

修改一個欄位為 "UI_TEST_{module}_EDIT"
截圖：{module}_07_update_filled.png

點擊送出 → 等待成功提示
截圖：{module}_08_update_result.png
驗證：成功提示 + 列表顯示修改後文字
```

### 步驟 2e：刪除（del.php）

```
點擊測試資料的「刪除」按鈕
若有 confirm → browser_handle_dialog(accept: true)
截圖：{module}_09_del_result.png

驗證：
- 成功提示或重導向至列表
- 列表中不再有 "UI_TEST_{module}_EDIT"
截圖：{module}_10_list_after_del.png
```

### 步驟 2f：產出模組測試報告

```
✅ {module} UI 測試完成

📊 測試結果：
| 測試項目  | 結果   | 截圖 |
| 列表頁載入 | ✅/❌ | {module}_01_list.png |
| 新增表單   | ✅/❌ | {module}_04_add_result.png |
| 列表確認   | ✅/❌ | {module}_05_list_after_add.png |
| 編輯表單   | ✅/❌ | {module}_08_update_result.png |
| 刪除功能   | ✅/❌ | {module}_10_list_after_del.png |

⚠️ 發現問題：（若有）
```

**全部模組完成後：**

```
📊 UI 測試統計
模組數：N 個 | 通過：X 項 | 失敗：Y 項

⚠️ 需人工確認：
- 版面視覺是否正確（對照截圖）
- 中文顯示是否亂碼
- file 上傳欄位需手動測試
```

---

## 除錯模式：步驟 3 詳細流程

### 步驟 3a：確認 Xdebug 環境

提醒使用者完成以下設定：

1. **VSCode 開啟 Listen for Xdebug**：
   - 開啟專案的 `.vscode/launch.json`
   - 選擇「Listen for Xdebug」設定（port 9003）
   - 按 F5 開始監聽

2. **設定斷點**：在目標 PHP 檔案的關鍵行點擊行號左邊

3. **確認容器 Xdebug 設定**：
   - `xdebug.mode=debug`
   - `xdebug.start_with_request=yes`
   - `xdebug.client_port=9003`
   - `xdebug.client_host=host.docker.internal`

> 確認使用者完成上述設定後再繼續。

### 步驟 3b：導航到目標頁面

```
browser_navigate → {baseUrl}/{module}/{指定頁面}
browser_snapshot → 取得頁面結構
截圖記錄初始狀態

提醒使用者檢查 VSCode 是否命中斷點
```

### 步驟 3c：互動除錯循環

詢問使用者下一步操作：

> 頁面已載入，請告訴我：
> - 點擊某個按鈕/連結
> - 填寫表單欄位
> - 送出表單
> - 導航到其他頁面
> - 截圖目前畫面
> - 查看 Console/網路請求
> - 執行 JavaScript
> - 結束除錯

**每次操作後**：執行操作 → `browser_snapshot` → 回報結果 → 提醒檢查斷點 → 詢問下一步

### 步驟 3d：除錯輔助工具

```
# 查看 Console 錯誤
browser_console_messages(level: "error")

# 查看網路請求
browser_network_requests(includeStatic: false)

# 查看表單欄位值
browser_evaluate → document.querySelector('input[name="xxx"]').value

# 查看 Session/Cookie
browser_evaluate → document.cookie
```

### 步驟 3e：除錯總結

```
📋 除錯摘要
🔍 除錯目標：{module}/{頁面}
🐘 容器：{container} (PHP {version})

📝 操作記錄：
  1. 導航到 {url} → 結果
  2. 填寫表單 → 欄位值
  3. 點擊送出 → 出現錯誤 "xxx"

🐛 發現問題：（若有）
💡 建議：（若有）
```
