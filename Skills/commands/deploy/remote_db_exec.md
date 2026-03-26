---
name: remote_db_exec
description: "遠端執行 SQL、準測試機跑 SQL、沒辦法直連 DB、remote db"
---

# /remote_db_exec — 透過 SFTP + PHP 間接執行遠端 SQL

你是遠端資料庫操作工程師，在無法直連 MySQL 的環境下（如準測試機只有 phpMyAdmin），透過 SFTP 上傳一次性 PHP 腳本來執行 SQL，用完立即刪除。

---

## 背景

正式主機或準測試機通常不對外開放 MySQL port，`execute_sql` 無法使用。此 Skill 的替代方案是：
1. 產生一支帶 token 驗證的 PHP 腳本
2. SFTP 上傳到 web 目錄
3. HTTP 呼叫取得結果
4. 立刻刪除腳本

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| SFTP 連線 | host / port / user / password 或 key | `192.168.1.100` |
| Web 目錄 | 腳本上傳到哪個目錄（需可被 HTTP 存取） | `/var/www/html_{project}` |
| 網站 URL | 對應的 HTTP URL | `http://example.com` |
| DB 連線 | host / user / password / dbname | `localhost / root / pass / mydb` |
| SQL 語句 | 要執行的 SQL | `SELECT * FROM users LIMIT 5` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `sftp_connect` | 建立 SFTP 連線 |
| `sftp_upload` | 上傳 PHP 腳本到遠端 |
| `sftp_delete` | 執行後立刻刪除腳本 |
| `send_http_request` | HTTP 呼叫 PHP 腳本取得結果 |
| `create_file` | 在本機產生 PHP 腳本檔案 |

---

## 執行步驟

### 步驟 1：確認連線資訊與 SQL

確認所有必要參數，並展示執行計畫：

```
遠端 SQL 執行計畫：
  目標：{user}@{host}:{web_dir}
  網址：{site_url}
  資料庫：{db_host} / {db_name}
  SQL：{sql_preview}
  模式：{SELECT = 唯讀 | DDL/DML = 寫入}
```

> 確認後開始。

---

### 步驟 2：產生 PHP 腳本

在本機 `D:\tmp\` 產生帶 token 驗證的一次性 PHP 腳本：

```php
<?php
// 一次性 SQL 執行腳本 — 用完刪除
if (($_GET['token'] ?? '') !== '{RANDOM_TOKEN}') { http_response_code(403); exit('Forbidden'); }

header('Content-Type: application/json; charset=utf-8');

$conn = new mysqli('{db_host}', '{db_user}', '{db_pass}', '{db_name}');
if ($conn->connect_error) { echo json_encode(['error' => $conn->connect_error]); exit; }
$conn->set_charset('utf8mb4');

$sql = "{ESCAPED_SQL}";
$result = $conn->query($sql);

if ($result === false) {
    echo json_encode(['error' => $conn->error]);
} elseif ($result === true) {
    echo json_encode(['affected_rows' => $conn->affected_rows]);
} else {
    $rows = [];
    while ($row = $result->fetch_assoc()) { $rows[] = $row; }
    echo json_encode(['rows' => $rows, 'count' => count($rows)]);
}
$conn->close();
```

**檔名規則**：`_mcp_exec_{timestamp}.php`（底線開頭 + 時間戳，降低被猜到的風險）

**Token 規則**：隨機產生 32 字元 hex string

---

### 步驟 3：上傳腳本

```
sftp_connect(host, port, user, password)
sftp_upload("D:/tmp/_mcp_exec_{ts}.php", "{web_dir}/_mcp_exec_{ts}.php")
```

---

### 步驟 4：HTTP 執行並取回結果

```
send_http_request("{site_url}/_mcp_exec_{ts}.php?token={TOKEN}")
→ 解析 JSON 回傳
→ SELECT：顯示查詢結果表格
→ DDL/DML：顯示 affected_rows
→ 錯誤：顯示 MySQL error message
```

---

### 步驟 5：立刻刪除腳本

```
sftp_delete("{web_dir}/_mcp_exec_{ts}.php")
→ 確認刪除成功
→ 刪除本機暫存檔 D:\tmp\_mcp_exec_{ts}.php
```

---

### 步驟 6：產出報告

```
✅ 遠端 SQL 執行完成！

📊 結果：
  目標：{user}@{host}
  資料庫：{db_name}
  SQL：{sql_preview}
  回傳：{rows_count} 筆 / affected {N} rows
  腳本存活時間：{N} 秒（已刪除）

⚠️ 注意：
  - 腳本已從遠端刪除
  - 本機暫存檔已清理
```

---

## 輸出

- SQL 執行結果（JSON 格式化呈現）
- 遠端腳本已刪除的確認

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| 403 Forbidden | Token 不正確或未帶 | 確認 URL 含 `?token=...` |
| Connection refused | PHP 連不到 MySQL | DB host 用 `localhost` 而非外部 IP |
| 404 Not Found | 上傳目錄不在 web root 下 | 確認 web 目錄路徑正確 |
| HTTP 500 | PHP 語法錯誤或 mysqli 未啟用 | 用 `/sftp_ops` 查看 error log |
| 空白回應 | PHP 未安裝 json 模組 | 確認 `php -m | grep json` |

---

## 注意事項

- **腳本存活時間越短越好**：上傳 → 執行 → 刪除，不留過夜
- **DB 密碼寫在腳本中**：因此必須立刻刪除，不可留在遠端
- **正式主機建議只跑 SELECT**：寫入操作需使用者明確確認
- **多條 SQL**：拆成多次呼叫，不要合併（避免單腳本太複雜）
- 若需批量執行多條 SQL（如 migration），可迴圈呼叫此流程

**相關技能：**

- 直連 MySQL 可用時 → 改用 `/db_migration`
- 上傳程式碼 → `/sftp_deploy`
- 程式碼 + DB 一起部署 → `/full_deploy`
