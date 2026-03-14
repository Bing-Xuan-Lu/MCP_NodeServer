---
name: sftp_ops
description: |
  透過 SFTP 連線到遠端主機進行即時除錯與環境檢查。涵蓋：讀取 error log、檢查設定檔、確認目錄結構與檔案權限。
  當使用者說「看遠端 log」「查測試機錯誤」「檢查遠端設定」「確認遠端環境」，或 UI 測試失敗需查後端報錯時使用。
---

# /sftp_ops — 透過 SFTP 連線遠端主機進行即時除錯與環境檢查

你是遠端環境除錯工程師，透過 SFTP 連線到測試主機，讀取 error log、檢查設定檔內容、確認目錄結構，協助快速定位後端問題。

---

## 背景

現有的 `/sftp_deploy`（上傳）和 `/sftp_pull`（下載）處理檔案傳輸，但不涵蓋「連上去看 log / 查環境」的遠端除錯場景。本技能填補此缺口：連線後保持 session，可反覆查詢 log 和檔案，不需每次重新連線。

---

## 使用者輸入

$ARGUMENTS

格式：`[除錯目標描述]`

範例：
- `/sftp_ops 看 PHP error log` — 連線後讀取 PHP 錯誤日誌
- `/sftp_ops 檢查 config.php 設定` — 查看遠端設定檔內容
- `/sftp_ops 確認上傳的檔案是否存在` — 檢查遠端目錄結構

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 遠端主機 | 測試機 IP 或網域 | `192.168.1.100` |
| 使用者 | SSH 登入帳號 | `deploy` |
| 認證方式 | 密碼或私鑰路徑 | `MyPass123` 或 `~/.ssh/id_rsa` |
| 除錯目標 | 要查什麼（log / config / 目錄） | `PHP error log` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `sftp_connect` | 建立 SFTP 連線（後續操作需先連線） |
| `sftp_list` | 列出單一遠端目錄 |
| `sftp_list_batch` | 一次列出多個遠端目錄（比對多個路徑時優先使用） |
| `sftp_download` | 下載遠端檔案到本機查看 |
| `read_file` | 讀取已下載的單一檔案 |
| `read_files_batch` | 一次讀取多個已下載的檔案 |
| `tail_log` | 即時讀取遠端 log 檔尾端內容 |

---

## 執行步驟

### 步驟 1：建立 SFTP 連線

```
sftp_connect(host, username, password/privateKeyPath)
→ 成功：顯示連線資訊
→ 失敗：檢查 IP/帳號/密碼是否正確，確認主機是否可達
```

---

### 步驟 2：根據除錯目標執行對應操作

依使用者描述，選擇以下操作模式：

**模式 A：讀取 Error Log**

```
1. 確認 log 路徑（常見位置）：
   - PHP error log: /var/log/php_errors.log 或 /var/log/apache2/error.log
   - Apache access log: /var/log/apache2/access.log
   - 應用 log: {ProjectFolder}/logs/
2. tail_log(path, lines=100)
→ 讀取最後 100 行，過濾出最近的錯誤
3. 分析錯誤訊息，列出：
   - 錯誤類型（Fatal / Warning / Notice）
   - 發生時間
   - 相關檔案與行號
   - 可能原因與建議修復方式
```

**模式 B：檢查設定檔**

```
1. sftp_list 確認設定檔位置
2. sftp_download 下載設定檔到本機暫存
3. read_file 讀取內容
4. 比對關鍵設定：
   - DB 連線（host / port / database / user）
   - 路徑設定（是否符合容器內路徑）
   - 環境變數（開發/測試/正式）
```

**模式 C：確認目錄結構與檔案**

```
1. sftp_list(remotePath) 列出目標目錄
2. 確認：
   - 檔案是否存在（部署是否成功）
   - 檔案大小是否合理（非 0 byte）
   - 目錄結構是否符合預期
```

---

### 步驟 3：產出診斷報告

```
🔍 遠端除錯報告

📡 連線資訊：
  主機：{host}
  路徑：{remotePath}

📊 檢查結果：
  - 檢查項目 1：結果
  - 檢查項目 2：結果

⚠️ 發現問題：
  - 問題描述 + 建議修復方式

✅ 建議下一步：
  - 具體動作（如：修正 config 後重新部署）
```

---

## 輸出

- 遠端環境狀態報告
- 錯誤日誌摘要（含時間、類型、檔案位置）
- 設定檔關鍵項目比對結果
- 問題原因分析與建議修復方式

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| 連線逾時 | 主機不可達或防火牆阻擋 | 確認 IP 與 port 22 是否開放 |
| Permission denied | 帳號權限不足 | 確認帳號是否有讀取 log 目錄的權限 |
| Log 檔案為空 | Log 路徑不正確或 Docker volume 未映射 | 先用 `sftp_list` 搜尋實際 log 位置 |
| 設定檔路徑不存在 | 容器內路徑 vs 主機路徑不同 | Docker 環境注意 volume mount 的對應關係 |

---

## 注意事項

- 本技能為唯讀操作，不修改遠端任何檔案
- Docker 環境中 log 可能在容器內，需透過 volume mount 路徑存取
- 下載到本機的暫存檔案在檢查完畢後提醒使用者清理
- 若需要修改遠端檔案，請改用 `/sftp_deploy` 上傳修正後的版本
- 連線 session 可重複使用，不需每次操作都重新連線

**相關技能：**

- 要推送新版程式到遠端 → 改用 `/sftp_deploy`
- 要把遠端檔案下載到本機 → 改用 `/sftp_pull`
