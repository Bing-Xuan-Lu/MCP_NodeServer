---
name: remote_diff
description: "比對本機與遠端的程式差異。當使用者說「遠端有人改過嗎」「部署前先 diff」「跟測試機比」時使用。"
---

# /remote_diff — 比對本機 vs 遠端 SFTP 檔案差異

你是版本差異分析師，透過 SFTP 拉取遠端主機的實際檔案，與本機 Git 專案做完整 diff，找出「同事直接 SFTP 改過的檔案」，避免部署時覆蓋他人修改。

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| SFTP 連線 | host / port / user / password 或 key | `192.168.1.100` |
| 遠端目錄 | 遠端的專案根目錄 | `/var/www/html_{project}` |
| 本機目錄 | 本機 Git 專案路徑 | `{ProjectFolder}` |
| 比對範圍 | 全部或指定子目錄 | `admin/modules/order` 或 全部 |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `sftp_connect` | 建立 SFTP 連線 |
| `sftp_list_batch` | 掃描遠端目錄結構 |
| `sftp_download` | 拉取遠端檔案到本機暫存 |
| `list_files_batch` | 掃描本機目錄結構 |
| `read_files_batch` | 讀取檔案內容做比對 |

---

## 執行步驟

### 步驟 1：確認比對計畫

```
檔案差異比對計畫：
  本機：D:\Project\{ProjectFolder}\{scope}
  遠端：{user}@{host}:{remote_dir}/{scope}
  範圍：{全部 / 指定目錄}
  暫存：D:\tmp\{ProjectFolder}_remote\
```

> 確認後開始掃描。

---

### 步驟 2：連線並掃描遠端目錄

```
sftp_connect(host, port, user, password)
sftp_list_batch(["{remote_dir}/admin", "{remote_dir}/includes", ...])
→ 遞迴取得遠端所有 .php / .js / .css / .html 檔案清單
→ 排除非程式碼檔案（圖片、上傳檔、cache 目錄）
```

**排除清單**（不比對）：
- `uploads/`、`cache/`、`tmp/`、`logs/`
- `.jpg`、`.png`、`.gif`、`.pdf`、`.zip`
- `node_modules/`、`vendor/`

---

### 步驟 3：拉取遠端檔案到暫存目錄

```
sftp_download("{remote_dir}", "D:/tmp/{ProjectFolder}_remote/")
→ 保持目錄結構
→ 顯示下載進度
```

---

### 步驟 4：執行 diff 比對

使用 `git diff --no-index` 比對本機 vs 遠端拉回的檔案：

```bash
git diff --no-index --stat "D:/Project/{ProjectFolder}" "D:/tmp/{ProjectFolder}_remote"
```

分類比對結果：

| 分類 | 說明 | 標記 |
|------|------|------|
| 遠端被修改 | 本機有、遠端也有，但內容不同 | ✏️ |
| 遠端新增 | 遠端有但本機沒有（同事新增的） | 🆕 |
| 遠端缺少 | 本機有但遠端沒有（尚未部署的新功能） | 📦 |
| 設定檔差異 | config / .env 等設定檔不同 | ⚙️ |

---

### 步驟 5：產出差異報告

```
📋 遠端差異報告
━━━━━━━━━━━━━━━━━━━━━━━
  目標：{user}@{host}:{remote_dir}
  比對時間：{datetime}
  比對範圍：{scope}

✏️ 遠端被修改的檔案（同事改過的）：
  - admin/modules/order/list.php     (+3 -1)
  - includes/functions.php           (+12 -0)

🆕 遠端多出的檔案（同事新增的）：
  - admin/quick_fix.php
  - includes/hotfix_20260320.php

📦 本機有但遠端沒有（待部署）：
  - admin/modules/report/dashboard.php
  - admin/modules/report/export.php

⚙️ 設定檔差異（不應覆蓋）：
  - includes/config.php
  - .env

━━━━━━━━━━━━━━━━━━━━━━━
  總計：N 個檔案有差異
  其中 N 個是遠端被修改（部署會覆蓋）
```

---

### 步驟 6：詢問後續動作

> 要如何處理？
>
> 1. **Merge 回本機** — 把遠端修改的檔案複製到本機，你自己 git commit
> 2. **僅看 diff 細節** — 顯示特定檔案的逐行差異
> 3. **略過直接部署** — 以本機為主覆蓋遠端（確認不會蓋到重要修改）
> 4. **結束** — 報告留著參考，不做動作

若選擇 Merge：
- 複製遠端修改的檔案到本機對應位置
- **不自動 commit**，讓使用者自行 review 後決定
- 設定檔（config / .env）只提示，不覆蓋

---

## 輸出

- 本機 vs 遠端的完整差異報告
- 暫存目錄 `D:\tmp\{ProjectFolder}_remote\` 保留供參考
- （若選擇 Merge）遠端修改已複製到本機

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| 下載超時 | 檔案太多或網路慢 | 縮小比對範圍，指定子目錄 |
| diff 結果全部不同 | 換行符號差異 (CRLF vs LF) | 加 `--ignore-cr-at-eol` 參數 |
| Permission denied | SFTP 帳號無讀取權限 | 確認帳號有目標目錄的讀取權 |

---

## 注意事項

- **暫存目錄用完可刪**：`D:\tmp\{ProjectFolder}_remote\` 不會自動清理
- **設定檔一律不覆蓋**：config.php / .env / database 設定，只報告差異不做動作
- **大型專案建議指定子目錄**：全站掃描可能拉取大量檔案
- 此 Skill 是**唯讀分析**，不會修改遠端任何檔案
- 被 `/full_deploy` 在部署前自動呼叫，作為安全閘

**相關技能：**

- 確認差異後要部署 → `/full_deploy`
- 只上傳程式碼不管 DB → `/sftp_deploy`
- 查遠端 error log → `/sftp_ops`
