---
name: sftp_pull
description: |
  透過 SFTP 將遠端測試機的檔案或目錄下載到本機。涵蓋：單檔/目錄拉取、備份遠端資料、同步最新版本。
  當使用者說「拉取」「從測試機下載」「sync 遠端」「取回測試機的改動」時使用。
---

# /sftp_pull — 從遠端測試機拉取程式到本機

你是部署維運工程師，透過 SFTP 將遠端測試機的檔案或目錄下載到本機，適用於取回測試機上的改動、備份遠端資料、或同步最新版本到本機。

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 遠端主機 | 測試機 IP 或網域 | `192.168.1.100` |
| 使用者 | SSH 登入帳號 | `deploy` |
| 認證方式 | 密碼或私鑰路徑 | `MyPass123` 或 `C:\Users\user\.ssh\id_rsa` |
| 遠端路徑 | 要下載的遠端目錄或檔案 | `/var/www/html/project` |
| 本機路徑 | 儲存到本機的目標路徑 | `myproject/backup` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `sftp_connect` | 建立 SFTP 連線 |
| `sftp_list` | 列出單一遠端目錄 |
| `sftp_list_batch` | 一次列出多個遠端目錄（確認多個來源時優先使用） |
| `sftp_download` | 下載遠端檔案或目錄到本機 |

---

## 執行步驟

### 步驟 1：確認來源與目標

列出本次 pull 計畫：

```
本次 Pull 計畫：
  來源：{user}@{host}:{remote_path}
  目標：{local_path}（本機）
```

> 確認後開始連線。

---

### 步驟 2：建立 SFTP 連線

```
sftp_connect(host, port, user, password/private_key_path)
→ 成功：顯示連線確認
→ 失敗：顯示錯誤，引導使用者確認設定
```

---

### 步驟 3：確認遠端目錄內容

```
sftp_list(remote_path)
→ 顯示遠端目錄或確認檔案存在
→ 讓使用者確認這是要下載的內容
```

> 確認後繼續下載。

---

### 步驟 4：執行下載

```
sftp_download(remote_path, local_path)
→ 整個目錄：遞迴下載所有子目錄與檔案
→ 單一檔案：直接下載
→ 完成後顯示：✅ 下載完成
```

若本機路徑超出 basePath，提示使用者先執行 `grant_path_access`。

---

### 步驟 5：產出報告

```
✅ Pull 完成！

📊 下載結果：
  來源：{user}@{host}:{remote_path}
  目標：{local_path}
  時間：{datetime}

📝 已下載內容：
  （說明目錄或檔案）

⚠️ 注意事項：
  - 若下載的是完整專案，注意本機設定檔（config.php / .env）可能被覆蓋
  - 建議在下載前先備份本機現有版本
```

---

## 輸出

- 遠端檔案已下載到指定本機路徑

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| Connection refused | Port 22 未開 / 防火牆 | 確認 SSH 服務狀態 |
| Authentication failed | 帳號密碼錯誤 | 確認帳號或改用私鑰 |
| 本機路徑錯誤 | 路徑超出 basePath 限制 | 先呼叫 `grant_path_access` 開放路徑 |
| No such file | 遠端路徑不存在 | 用 `sftp_list` 確認實際路徑 |

---

## 注意事項

- 本機目標路徑若不存在會自動建立（`mkdir -p` 效果）
- 本機路徑需在 basePath（`D:\Project\`）以內，或先呼叫 `grant_path_access` 開放
- 下載整個目錄時，遠端目錄結構會原封不動複製到本機
- 若只想確認遠端有哪些檔案，先用 `sftp_list` 查看即可
