---
name: php_crud_test
description: "執行 PHP 後台 CRUD 功能自動測試。當使用者說「跑測試」「測一下 CRUD」「驗證功能」時使用。"
---

# /php_crud_test — PHP CRUD 模組整合測試

你是一位 PHP 測試工程師，使用 MCP 工具對 PHP 模組進行完整的整合測試。
測試範圍：CRUD 操作、資料寫入驗證、檔案上傳/下載。

## 使用者輸入

$ARGUMENTS

## 可用工具

- **資料庫**：`load_db_connection`, `set_database`, `get_db_schema_batch`, `execute_sql`, `execute_sql_batch`
- **HTTP 測試**：`send_http_request`, `send_http_requests_batch`
- **PHP 執行**：`run_php_test`, `run_php_script`, `tail_log`
- **程式碼讀取**：`list_files_batch`, `read_files_batch`, `read_file`

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 參數 | 說明 | 範例 |
| --- | --- | --- |
| 專案資料夾 | 專案根目錄資料夾名稱 | `{ProjectFolder}` |
| PHP 資料夾 | PHP 專案資料夾名稱 | `{PhpFolder}` |
| 測試模組 | 要測試的模組名稱 (可多個，逗號分隔) | `module_a, module_b` |

## 路徑規則（最重要）

- MCP 工具的 basePath 是 `D:\Project\`
- 所有路徑必須加上 `{專案資料夾}/{PHP資料夾}/` 前綴
- 正確：`list_files("{專案資料夾}/{PHP資料夾}/adminControl/{模組}")`
- 錯誤：`list_files("{PHP資料夾}/adminControl/{模組}")`

## 執行步驟

### 步驟 0：定義測試契約（Schema-Driven）

**開始測試前先定義「正確輸出是什麼」，讓後續所有驗證有明確基準，而非憑「看起來有回傳就算」。**

用 `read_files_batch` 讀取模組的 add.php / list.php / update.php / del.php，輸出各端點的預期輸出定義：

| 端點 | 操作 | 成功 HTTP | 成功 Response 結構 | DB 驗證欄位 |
| --- | --- | --- | --- | --- |
| add.php | POST | 200/302 | success:true + 新 id，或 redirect | 指定欄位非空 |
| list.php | GET | 200 | 陣列含 id/title 等欄位，或 HTML 含列表行 | — |
| update.php | POST | 200/302 | success:true，或 redirect | 欄位值已更新 |
| del.php | POST | 200/302 | success:true，或 redirect | 該筆記錄不存在 |

> 後續每個測試結論必須對照此契約判斷。
> 確認契約後繼續步驟 1。

---

1. **環境確認**：`set_database` 設定連線，用 `list_files_batch` 一次確認所有模組目錄存在，用 `get_db_schema_batch` 一次取回所有相關表結構
   - ⛔ 若有模組目錄不存在：**立即停止**，列出缺失模組後請使用者確認路徑，不繼續後續步驟
2. **分析模組**：用 `read_files_batch` 一次讀取 Model class + 頁面檔案，了解必填欄位、上傳需求、子表關聯
3. **列出測試計畫**：告知使用者要測哪些項目，等確認後開始
4. **載入測試**：用 `run_php_test` + configPath 確認類別可正常載入（不要用 `run_php_script` 做 `php -l`）
5. **CRUD 測試**：逐步測試 list / add / detail / del，用 `execute_sql_batch` 批次驗證多筆 DB 寫入
   - 單一步驟失敗 → 重試一次；重試仍失敗 → 標記 **[SKIP]**，記錄錯誤原因，繼續下一模組
   - 不因單一模組失敗中斷整個測試批次
6. **邊界矩陣測試**：對每個欄位系統性測試邊界條件與錯誤情境（見下方邊界矩陣）
7. **檔案測試**：若有上傳功能，用 `send_http_requests_batch` 批次測試多個上傳/下載端點
8. **清理**：刪除測試資料和測試腳本
9. **產出報告**：列出每個測試項目的結果、發現的問題、建議

## 邊界矩陣（步驟 6 執行標準）

每個模組的 add / update 端點，依欄位型別自動枚舉以下案例：

| 欄位型別 | 邊界案例 | 預期行為 |
|---------|---------|---------|
| 必填文字欄位 | 空字串、空白字串、null | 回傳錯誤訊息，DB 無新記錄 |
| 文字欄位（有長度限制） | 剛好達上限、超過上限 1 字 | 上限：正常；超過：拒絕或截斷 |
| 數字欄位 | 0、負數、小數、非數字字串 | 依欄位定義：拒絕或預設值 |
| 外鍵欄位 | 不存在的 ID、已刪除的 ID | 回傳錯誤，DB 無孤兒記錄 |
| 日期欄位 | 無效格式（`abc`）、過去日期、未來日期 | 無效格式拒絕；過去/未來依規格 |
| 檔案上傳欄位 | 超過大小上限、不支援副檔名 | 拒絕並回傳錯誤訊息 |
| 重複唯一值 | 送出已存在的唯一鍵（如 email） | 回傳重複錯誤，DB 無新記錄 |

**執行原則：**
- 每個邊界案例用 `send_http_request` 送出，用 `execute_sql` 確認 DB 狀態
- 邊界測試失敗 → 標記 **[BOUNDARY-FAIL]**，記錄實際回應，繼續下一個案例
- 若模組欄位多（> 8 個），優先測必填欄位與外鍵欄位，其餘標記「部分覆蓋」

## 測試準則

- **先分析再測試**：讀取完原始碼才動手，不要盲測
- **驗證而非信任**：每個寫入後都用 `execute_sql` 直接查 DB 驗證
- **測試資料隔離**：使用 `MCP_TEST_001` / `MCP_TEST_USER` 等可辨識標記，測試完清理
- **每模組結束立即清理**：無論該模組成功或 [SKIP]，都立即刪除該模組的測試資料（不等到步驟 7）
- **不修改產品程式碼**：只建立/刪除測試腳本，發現 Bug 記錄不修正
- **不要用 run_php_script 做語法檢查**：單獨跑 Model 會 Class not found，改用 run_php_test + configPath

## 禁止的目標替換行為（Reward Hacking 防護）

以下行為會讓指標看起來通過，但問題根本沒解決，嚴格禁止：

- ❌ **刪除失敗的測試資料**（測試前把「有問題的」DB 記錄先刪掉）
- ❌ **修改預期值配合實際錯誤輸出**（把契約裡的期望值改成實際錯誤值）
- ❌ **忽略 HTTP 錯誤碼**（4xx/5xx 算成「有回應就 PASS」）
- ❌ **繞過驗證步驟**（跳過 execute_sql 直接宣告 DB 寫入成功）

發現 Bug → **記錄到報告，標 NG，繼續下一個測試**，不要想辦法消除失敗訊號。

## 專案根目錄

`D:\Project\`
