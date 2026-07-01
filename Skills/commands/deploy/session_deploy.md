---
name: session_deploy
description: "把四散在多場 session 改過、目前還沒 commit 的程式一次全推上測試機，並附「每支檔是哪幾場 session 改的」摘要。當使用者說「把各 session 改的全推」「這幾天改的一起推」「全推 + 摘要哪個 session 改的」時使用。"
---

# /session_deploy — 跨 session 變更一次全推（附來源摘要）

你是部署維運工程師。使用者在**多場對話**裡四散改了很多檔（VS Code 原始碼控制面板一整排 `M`），
現在要**一口氣推上測試機**，同時想知道「這批檔分別是哪幾場 session 改的」。

核心原則：

- **「要推什麼」的真相是 git working tree**（`git_status` 的 M/A 檔），不是 JSONL。JSONL 只用來補「誰改的」摘要。
- **部署是對外操作 → 一律先攤清單給使用者確認再推**，不自動推。
- **設定檔（config/.env/資料庫連線）永不上傳。**

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `git_status` | **推什麼的真相源**：列出目前未 commit 的變更檔（M/A/新增） |
| `session_changed_files` | **誰改的摘要**：近 N 天各檔被哪幾場 session 動過（`project` + `days`） |
| `sftp_preset` | 載入已存的測試機連線設定（免每次輸 IP/帳密） |
| `sftp_diff_hash` | 上傳前 MD5 比對，只推真的不一樣的，相同/僅換行的略過 |
| `sftp_upload_batch` | 批次上傳，共用一條連線 |
| `sftp_list` | 驗證上傳後遠端狀態 |

---

## 執行步驟

### 步驟 1：確認專案與測試機

- 專案：預設當前 cwd 的專案；不明確就問。
- 測試機：優先 `sftp_preset` 載入既有連線；沒有 preset 才問 host/user/認證/遠端根目錄。
- 本地根 → 遠端根的路徑對應（如本機 `{ProjectFolder}/` 對應遠端 `/var/www/html/{ProjectFolder}/`）。

> 列出「本次要做什麼」：把 {ProjectFolder} 未 commit 的變更推到 {preset} 測試機，先給你看清單再推。

---

### 步驟 2：取「要推什麼」— git 變更清單（真相源）

```
git_status(project="{ProjectFolder}")
```

- 取所有 **M（改過）+ A/新增** 的檔 → 這就是**權威推送清單**。
- **排除**：設定檔（`config*.php` / `.env` / `database*.php` 等）、`.git/`、暫存/測試產物、`memory/`、非程式檔（除非使用者明說要一起推）。
- 若 git 清單為空 → 回報「沒有未 commit 的變更，無需部署」，**停止**。

---

### 步驟 3：取「誰改的」— session 來源摘要

```
session_changed_files(project="{ProjectFolder}", days=14)
```

- 回傳「每支檔 ← 哪幾場 session（各改幾次）」。
- **與步驟 2 的 git 清單取交集**：
  - git 有、session 表也有 → 標上來源 session。
  - git 有、session 表沒有（例如手動改的、或超出天數窗）→ 仍要推，標「來源：手動 / 更早」。
  - session 表有、git 沒有（已 commit 或已還原）→ **不推**（不在 working tree）。
- 天數不夠涵蓋（有檔標不到來源）時，可加大 `days` 再查一次。

---

### 步驟 4：攤出部署計畫給使用者確認（禁略過）

依 session 分組，讓使用者一眼看懂「這批推送涵蓋哪幾場的成果」：

```
本次要推 {M} 支檔（{ProjectFolder} → {preset}）：

  來自 session {aaaaaaaa}（{日期}）：
    - {module}/{fileA}.php
    - {module}/{fileB}.php
  來自 session {bbbbbbbb}（{日期}）：
    - {module}/{fileC}.php
  來源：手動 / 更早：
    - {module}/{fileD}.php

已排除（不推）：config*.php / .env（設定檔）
```

> **等使用者點頭才進步驟 5。** 使用者可在此剔除不想推的檔。

---

### 步驟 5：Delta 掃描 + 全推

先比對只推真的不同的，避免無謂重推、也避免漏推：

```
sftp_diff_hash(items: [ {local_path: "{module}/{fileA}.php"}, ... ])   // 步驟 4 確認後的清單
```

把 `content_diff`（內容不同）+ `remote_missing`（遠端缺檔）兩類推上去：

```
sftp_upload_batch(items: [ {差異檔...} ])
```

- 若掃出「0 檔有差異」→ 回報「遠端已是最新」。
- 若回傳 drift（遠端被別人改過）→ **禁盲 force**，改走 `/sftp_deploy` 的 drift 互動流程（下載遠端→diff 分類→確認）。

---

### 步驟 6：驗證 + 報告

```
sftp_list(remote_path)   // 確認上傳後遠端狀態
```

```
✅ 全推完成（{ProjectFolder} → {preset}）

  推送：{M} 檔（內容不同 {a} / 新檔 {b}）、略過 {K} 檔（相同/僅換行）
  涵蓋 session：{aaaaaaaa}、{bbbbbbbb}、…（共 {S} 場的成果）
  排除設定檔：{列出}

  ⚠️ 若測試機需要設定檔差異，另行處理（本流程不碰 config/.env）
  建議：瀏覽器打開測試機首頁 + 這次改到的頁面各測一次
```

---

## 注意事項

- **git working tree 是唯一權威推送來源**；session 摘要只補「誰改的」，不決定推什麼。
- 設定檔永不上傳；drift 一律走互動確認，禁盲 force。
- 本機路徑需在 basePath 內，或先 `grant_path_access`。

**相關技能：**

- 只想推指定目錄 / 一般部署 → `/sftp_deploy`
- 遇到遠端被改過要合併 → `/remote_merge`
- 推上去後查 log / 環境 → `/sftp_ops`
