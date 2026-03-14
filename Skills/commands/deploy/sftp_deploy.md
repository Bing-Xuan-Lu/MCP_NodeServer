---
name: sftp_deploy
description: |
  透過 SFTP 將本機 PHP 專案部署到遠端測試機。涵蓋：整個目錄或指定檔案上傳、部署前確認清單、自動備份。
  當使用者說「部署」「deploy」「上傳到測試機」「推到遠端」時使用。
---

# /sftp_deploy — 將本機 PHP 專案部署到遠端測試機

你是部署維運工程師，透過 SFTP 將本機 PHP 專案推送到遠端測試機，支援整個目錄或指定檔案的上傳，並在部署前確認清單。

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 遠端主機 | 測試機 IP 或網域 | `192.168.1.100` |
| 使用者 | SSH 登入帳號 | `deploy` |
| 認證方式 | 密碼或私鑰路徑 | `MyPass123` 或 `C:\Users\user\.ssh\id_rsa` |
| 本機路徑 | 要上傳的本機目錄 | `myproject/backend` |
| 遠端路徑 | 測試機的目標目錄 | `/var/www/html/project` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `sftp_connect` | 建立 SFTP 連線 |
| `sftp_list` | 列出遠端目錄，確認目前狀態 |
| `sftp_upload` | 上傳本機檔案或目錄 |

---

## 執行步驟

### 步驟 1：確認連線資訊

詢問使用者未提供的資訊，並列出本次部署計畫：

```
本次部署計畫：
  本機：{local_path}
  遠端：{user}@{host}:{remote_path}
  方式：{密碼 / 私鑰}
```

> 確認後開始連線。

---

### 步驟 2：建立 SFTP 連線

```
sftp_connect(host, port, user, password/private_key_path)
→ 成功：顯示連線確認
→ 失敗：顯示錯誤，引導使用者確認 IP / 帳號 / 防火牆
```

---

### 步驟 3：確認遠端目前狀態

```
sftp_list(remote_path)
→ 顯示遠端目錄現有檔案清單
→ 讓使用者確認這是正確的部署目標
```

> 確認目標目錄正確後繼續。

---

### 步驟 4：執行上傳

```
sftp_upload(local_path, remote_path)
→ 整個目錄：遞迴上傳所有子目錄與檔案
→ 單一檔案：直接上傳
→ 完成後顯示：✅ 上傳完成
```

---

### 步驟 5：驗證部署結果

```
sftp_list(remote_path)
→ 確認上傳後的遠端目錄內容
→ 對比上傳前的清單，確認差異符合預期
```

---

### 步驟 6：產出報告

```
✅ 部署完成！

📊 部署結果：
  來源：{local_path}
  目標：{user}@{host}:{remote_path}
  時間：{datetime}

📝 遠端目錄結構（上傳後）：
  （sftp_list 結果）

⚠️ 注意事項：
  - 若為 PHP 正式機，請確認設定檔（config.php / .env）是否需要另外處理
  - 上傳後建議在瀏覽器測試一次首頁是否正常
```

---

## 輸出

- 遠端伺服器收到最新的 PHP 程式碼
- 部署前後的遠端目錄對比

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| Connection refused | Port 22 未開 / 防火牆 | 確認伺服器 SSH 服務狀態 |
| Authentication failed | 帳號密碼錯誤 | 確認帳號，或改用私鑰認證 |
| 本機路徑不存在 | 路徑超出 basePath 限制 | 先呼叫 `grant_path_access` 開放路徑 |
| Remote path not exist | 遠端目錄不存在 | 先在遠端建立目錄或改正路徑 |

---

## 注意事項

- `config.php` / `.env` / 資料庫設定檔通常測試機與正式機不同，上傳時需確認不會覆蓋
- 本機路徑需在 basePath（`D:\Project\`）以內，或先呼叫 `grant_path_access` 開放
- 每次操作後連線會關閉，不需手動斷線

**相關技能：**

- 上傳後想查 log 或確認環境 → 改用 `/sftp_ops`
- 要從測試機下載檔案回本機 → 改用 `/sftp_pull`
