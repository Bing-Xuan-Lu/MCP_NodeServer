---
name: full_deploy
description: "程式碼與資料庫一起完整部署到遠端。當使用者說「全部推」「完整部署」「程式加 DB 一起」時使用。"
---

# /full_deploy — 整合部署：程式碼 + 資料庫 + 安全檢查

你是部署流程總管，整合 remote_diff（安全閘）+ sftp_deploy（程式碼）+ DB migration（資料庫）+ smoke test（驗證），以本機開發者檔案為主，完成一次完整部署。

---

## 背景

單獨使用 `/sftp_deploy` 只傳程式碼、`/db_migration` 只管 DB，兩者分離容易漏步驟。此 Skill 將四個階段串成流水線，並在第一步強制檢查遠端是否有人改過檔案。

---

## 使用者輸入

$ARGUMENTS

**模式說明：**

| 呼叫方式 | 說明 |
|---|---|
| `/full_deploy` | 完整流程（diff → 程式碼 → DB → 驗證） |
| `/full_deploy code-only` | 只部署程式碼，跳過 DB migration |
| `/full_deploy db-only` | 只執行 DB migration，跳過程式碼 |
| `/full_deploy --skip-diff` | 跳過 remote_diff 安全閘（已確認過） |

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 本機專案 | 本機 Git 專案路徑 | `{ProjectFolder}` |
| SFTP 連線 | host / port / user / password | `192.168.1.100` |
| 遠端目錄 | 遠端 web 根目錄 | `/var/www/html_{project}` |
| 網站 URL | 測試網站網址 | `http://example.com` |
| DB 存取方式 | 直連 / 間接（SFTP+PHP） | `直連` 或 `間接` |
| DB 連線 | host / user / password / dbname | （DB 存取方式為間接時必填） |
| Migration SQL | 遷移 SQL 檔案或描述（無則跳過） | `v003_add_discount.sql` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `sftp_connect` | 建立 SFTP 連線 |
| `sftp_list` / `sftp_list_batch` | 掃描遠端目錄 |
| `sftp_upload` | 上傳程式碼 |
| `sftp_download` | 拉取遠端檔案做 diff |
| `sftp_delete` | 刪除一次性 PHP 腳本 |
| `send_http_request` | HTTP 執行 SQL 腳本 / smoke test |
| `execute_sql` | 直連 DB 執行 migration（內部測試機） |
| `execute_sql_batch` | 批次直連 SQL |
| `create_file` | 產生臨時 PHP 腳本 |
| `read_file` | 讀取 migration SQL 檔 |

---

## 執行步驟

### 步驟 1：確認部署計畫

彙整所有參數後展示：

```
━━━ 部署計畫 ━━━━━━━━━━━━━━━━━━━━━━━━
  專案：{ProjectFolder}
  目標：{user}@{host}:{remote_dir}
  網址：{site_url}

  ☐ Phase A：Remote Diff（安全閘）
  ☐ Phase B：程式碼部署（SFTP）
  ☐ Phase C：DB Migration（{直連/間接}）
  ☐ Phase D：Smoke Test

  排除清單：config.php, .env, uploads/
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

> 確認後開始部署。

---

### 步驟 2：Phase A — Remote Diff 安全閘

執行 `/remote_diff` 的核心邏輯：

```
sftp_connect → sftp_download 遠端檔案到 D:\tmp\ → git diff --no-index
→ 列出遠端被修改的檔案清單
```

**判斷邏輯：**
- 無差異 → 繼續 Phase B
- 有差異 → 列出清單，詢問：

> 遠端有 N 個檔案被修改過（可能是同事改的）。
> 1. 繼續部署（以本機為主覆蓋）
> 2. 先 merge 回本機再部署
> 3. 中止部署

若使用者選擇中止，結束流程。

---

### 步驟 3：Phase B — 程式碼部署

```
sftp_upload("{ProjectFolder}/{scope}", "{remote_dir}/{scope}")
```

**排除規則**（不上傳）：
- `config.php`、`.env`、`database.php` 等設定檔
- `uploads/`、`cache/`、`tmp/`、`logs/` 目錄
- `.git/`、`node_modules/`、`vendor/`
- `*.log`、`*.bak`

**上傳策略**：
- 預設上傳整個專案目錄（排除上述檔案）
- 使用者可指定只上傳特定子目錄或檔案

---

### 步驟 4：Phase C — DB Migration

根據 DB 存取方式分流：

**方式 A：直連（內部測試機）**

```
execute_sql("SET FOREIGN_KEY_CHECKS = 0")
execute_sql("{migration_sql}")
execute_sql("SET FOREIGN_KEY_CHECKS = 1")
```

**方式 B：間接（準測試機，SFTP + PHP）**

執行 `/remote_db_exec` 的核心邏輯：
1. 產生帶 token 的 PHP 腳本
2. `sftp_upload` 上傳
3. `send_http_request` 執行
4. `sftp_delete` 立刻刪除

**若無 migration SQL，跳過此階段。**

---

### 步驟 5：Phase D — Smoke Test

```
send_http_request("{site_url}")
→ HTTP 200 → 首頁正常
→ 非 200 → 警告，建議查看 error log

send_http_request("{site_url}/admin/")
→ HTTP 200 或 302 → 後台可存取
→ 非 200 → 警告
```

---

### 步驟 6：產出部署報告

```
✅ 部署完成！

━━━ 部署報告 ━━━━━━━━━━━━━━━━━━━━━━━━
  專案：{ProjectFolder}
  目標：{user}@{host}
  時間：{datetime}

  Phase A — Remote Diff：✅ 通過（N 個差異已確認覆蓋）
  Phase B — 程式碼：✅ 已上傳（N 個檔案）
  Phase C — DB Migration：✅ 已執行 / ⏭️ 跳過
  Phase D — Smoke Test：✅ HTTP 200

⚠️ 提醒：
  - 設定檔未上傳（config.php / .env），如有變動請手動處理
  - 建議在瀏覽器人工確認關鍵功能
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 輸出

- 遠端程式碼已更新為本機最新版
- DB migration 已執行（若有）
- Smoke test 通過確認
- 完整部署報告

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| Phase A diff 全部不同 | CRLF vs LF 換行差異 | git diff 加 `--ignore-cr-at-eol` |
| Phase B 上傳後 500 | PHP 語法錯誤 | 部署前先在本機跑 `php -l` 檢查 |
| Phase C SQL 執行失敗 | Schema 已有變更 | 用 `get_db_schema` 確認現有結構 |
| Phase D 首頁 500 | 缺少設定檔或 DB 連線失敗 | 用 `/sftp_ops` 查看 error log |

---

## 注意事項

- **本機為主**：所有程式碼以本機 Git 版本為準，遠端被覆蓋
- **Remote Diff 是強制步驟**：除非使用者明確加 `--skip-diff`，否則一定先跑
- **設定檔永不上傳**：config / .env / database 設定一律排除
- **DB 密碼安全**：間接模式的 PHP 腳本用完立刻刪除
- **不做 rollback**：此 Skill 只負責部署，回滾用 `/db_migration run rollback` + `/sftp_pull`
- 建議先在內部測試機跑過一次再推準測試機

**相關技能：**

- 只看遠端差異不部署 → `/remote_diff`
- 只上傳程式碼不管 DB → `/sftp_deploy`
- 只跑 DB migration → `/db_migration` 或 `/remote_db_exec`
- 部署後看 error log → `/sftp_ops`
