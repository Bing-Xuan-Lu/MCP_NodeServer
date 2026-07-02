---
name: sftp_deploy
description: "將程式部署上傳到遠端測試機。當使用者說「部署」「推上去」「上傳」「deploy」時使用。預設僅推程式；說「全部推」「完整部署」「程式加 DB 一起」時走 +DB 完整模式（程式 + DB migration + smoke test）。"
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
| `sftp_diff_hash` | **Delta 模式核心**：MD5 一次比對本機 vs 遠端整批，只回有差異的檔（不下載全文） |
| `sftp_upload_batch` | 批次上傳差異檔（共用一條連線，支援 glob） |
| `sftp_upload` | 上傳單檔或整個目錄（全量模式 fallback） |
| `sftp_download_batch` | drift 處理時下載遠端版本回本機比對 |

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

### 步驟 3.5：Delta 差異掃描（預設先掃再推）

**這是預設行為**：部署不盲推整包，先用 `sftp_diff_hash` 找出「本機與遠端真的不一樣」的檔，只推那些，相同的自動略過。既避免無謂重推，也避免漏推「剩下還沒推的」。

**Step 1 — 一次比對候選檔**

候選清單來源（依情境擇一）：

- 使用者指定的子目錄 / 檔案 → 直接列進 items
- 「推剩下的 / 全部同步」→ 用 glob 涵蓋整個目標子樹（如 `module_a/**/*.php`、`*.js`）
- 「部署工作區變更 / 未 commit 的變更 / 這次改的」→ **預設只用 unstaged（`git_status` 的「Unstaged 工作區變更」分組，等同 `git diff --name-status`）**，不含 staged。原因：staged 常是多場 session 累積、還沒 commit 的舊改動，跟「這次真正改的」是兩組不同東西，混推會把舊半成品一起送上測試機。
  在部署計畫訊息裡明講範圍，讓使用者能一眼確認：

  ```text
  git_status 掃描結果：{S} 個 staged（略過，非本次範圍）/ {U} 個 unstaged（本次推送）
  ```

  使用者若明確要求「連 staged 也推」才把 staged 併入範圍。

```
sftp_diff_hash(
  items: [{ local_path: "module_a/**/*.php" }, ...]   // 有 preset 可只給相對路徑
)
```

回傳分類與對應動作：

| 類別 | 意義 | Delta 動作 |
|------|------|-----------|
| `content_diff` 內容不同 | 本機與遠端內容真的不一樣 | ✅ **要推** |
| `remote_missing` 遠端缺檔 | 新檔，遠端還沒有 | ✅ **要推** |
| `identical` 相同 | 內容一致 | ⏭ 略過 |
| `eol_only` 僅換行 CRLF/LF | 內容一致，只差換行 | ⏭ 略過（除非專案要求統一換行） |
| `local_missing` 本機缺檔 | 本機沒有、遠端有 | ⚠️ 不在部署範圍，列出提醒不動 |

**Step 2 — 只推差異檔（接步驟 4）**

把 `content_diff` + `remote_missing` 兩類的檔列進步驟 4 的 `sftp_upload_batch`。

> 若差異掃描結果「0 檔有差異」→ 直接回報「遠端已是最新，無需部署」，**不必往下**。

**Step 3 — 全量模式（fallback）**

僅當使用者明說「整包重推 / 不要比對直接全推」時，才略過 diff_hash，走步驟 4 的整目錄上傳。

---

### 步驟 4：執行上傳

**Delta 模式（預設）**：把步驟 3.5 掃出的差異檔（content_diff + remote_missing）丟給 `sftp_upload_batch` 一次推完。

```
sftp_upload_batch(items: [ {差異檔...} ])
→ 共用一條連線，逐檔回報 ✅ 上傳 / 🔄 內容相同跳過 / ⚠️ drift 略過
```

**全量模式（fallback）**：使用者明說整包重推時，用 `sftp_upload` 推整個目錄。

```
sftp_upload(local_path, remote_path)
→ 整個目錄：遞迴上傳所有子目錄與檔案
→ 單一檔案：直接上傳
→ 完成後顯示：✅ 上傳完成
```

#### 4a：drift 偵測互動模式（禁盲 force）

若 `sftp_upload_batch` 回傳「遠端有變動（未加 force），已略過 N 個檔」，**禁止**直接加 `force: true` 重傳。改走以下互動流程：

**Step 1 — 自動下載 drift 檔到暫存區**

```
sftp_download_batch
  items: [{ remote_path: "/var/www/.../X.php", local_path: "_tmp_remote/{preset}_drift/X.php" }, ...]
```

預設暫存路徑：
- 跨 session 共用：`D:/tmp/{preset}_drift/`（hook 已放行 rm -rf 與 cleanup_path）
- session 本地：`{project}/_tmp_remote/{preset}_drift/`（避開 git，basePath 內）

**Step 2 — 自動 diff 並分類**

對每個 drift 檔跑 `diff -u {tmp_remote}/X.php X.php`，依結果分類：

| 類別 | 偵測規則 | 建議動作 |
|------|---------|---------|
| 🟢 純本機 only-add | diff 只有 `+` 行（本機新增），無 `-` 行 | 安全 force 重傳 |
| 🟡 純遠端 only-add | diff 只有 `-` 行（遠端新增） | merge：先把遠端內容合併進本地，再上傳 |
| 🔴 真衝突 | 同行有 `+` 和 `-`（雙方改了同一處） | 人工選擇（顯示 diff 給使用者，等指示） |

**Step 3 — 依分類執行**

- 🟢 全部 only-add → 列出檔名 → 確認後 `force: true` 重傳
- 🟡 only-add（遠端方向）→ 列出遠端新增段落 → 確認合併方向 → 改本地 → 重傳
- 🔴 衝突 → 把 unified diff 完整貼出 → 等使用者選 (a) 採本地 (b) 採遠端 (c) 手動合併

**Step 4 — 清理暫存**

部署完後優先用 MCP 工具：

```
cleanup_path(path: "D:/tmp/{preset}_drift/", confirm: true)
```

或 Bash（已放行 D:/tmp/ 與 _tmp_remote/_drift/ 路徑）：

```bash
rm -rf D:/tmp/{preset}_drift/
```

**Why:** drift 訊息是保護機制，盲 force 會覆蓋他人 work。互動模式 + 自動分類能在 30 秒內處理完，不需逐檔人工判讀。

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

📊 部署結果（Delta 模式）：
  來源：{local_path}
  目標：{user}@{host}:{remote_path}
  時間：{datetime}
  差異掃描：共掃 {N} 檔 → 推 {M} 檔（內容不同 {a} / 新檔 {b}）、略過 {K} 檔（相同/僅換行）
  本次推送：
    - {差異檔1}
    - {差異檔2}

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

## +DB 完整部署模式（程式 + 資料庫 + 驗證）

當使用者說「全部推」「完整部署」「程式加 DB 一起」時，在上方程式碼部署之外，再串接 DB migration 與 smoke test，形成完整流水線（原 `/full_deploy`）。

**額外需要的資訊**：DB 存取方式（直連 / 間接 SFTP+PHP）、DB 連線、migration SQL 檔（無則跳過 DB 階段）。

**流程（前後串接）：**

1. **Phase A — Remote Diff 安全閘**（除非 `--skip-diff`）：`sftp_download` 遠端檔到 `D:\tmp\` → `git diff --no-index` 列出遠端被改的檔；有差異先問「以本機覆蓋 / merge 回本機（`/remote_merge`）/ 中止」。
2. **Phase B — 程式碼部署**：走上方 sftp_deploy 主流程（delta / 全量）。
3. **Phase C — DB Migration**（有 migration SQL 才做）：
   - 直連（內部測試機）：`execute_sql` 依序 `SET FOREIGN_KEY_CHECKS=0` → migration → `=1`
   - 間接（準測試機）：產帶 token 的 PHP 腳本 → `sftp_upload` → `send_http_request` 執行 → `sftp_delete` 立刻刪
4. **Phase D — Smoke Test**：`send_http_request` 打首頁（期望 200）與後台（200/302），非預期即警告查 error log。

**額外可用工具**：`sftp_download`、`execute_sql` / `execute_sql_batch`、`create_file`、`read_file`、`send_http_request`。

**模式注意**：本機為主、遠端被覆蓋；設定檔（config/.env/database）永不上傳；間接模式 PHP 腳本用完立刻刪；不做 rollback（回滾用 `/db_migration run rollback` + `/sftp_pull`）。

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
