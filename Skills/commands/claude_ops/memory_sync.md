---
name: memory_sync
description: |
  雙向同步 Git 專案 memory/ 與本機 Claude 自動記憶資料夾。涵蓋：git memory → 本機 Claude（pull）、本機 Claude → git memory（push）、差異比對（status）、全域或專案範圍選擇。
  當使用者說「同步記憶」「memory sync」「換環境」「把記憶帶過去」「更新本機記憶」時使用。
---

# /memory_sync — 同步 Git memory/ 與本機 Claude 記憶

你負責在「Git 專案 memory/ 資料夾」與「本機 Claude 自動記憶路徑」之間同步記憶檔案。

---

## 兩個記憶位置

| 名稱 | 路徑 | 說明 |
|------|------|------|
| **Git memory**（共享） | `{project_root}/memory/` | 進版控，跨機器共享 |
| **Claude 本機 memory**（project） | `~/.claude/projects/{encoded}/memory/` | 此專案的 Claude 自動記憶 |
| **Claude 本機 memory**（global） | `~/.claude/memory/` | 跨所有專案的全域記憶 |

`{encoded}` = 專案路徑的 Claude 編碼（小寫磁碟代號 + `--` 分隔各層，例：`d--Develop-MCP-NodeServer`）

---

## 執行流程

### Step 0：確認參數

若使用者未指定，詢問：

```
同步方向？
  pull  — Git memory → 本機 Claude（換電腦後更新本機）← 預設
  push  — 本機 Claude → Git memory（把本機改動存回 git）
  status — 只顯示差異，不寫入

範圍？
  project — 同步此專案的 Claude 記憶（預設）
  global  — 同步 ~/.claude/memory/（全域）
```

### Step 1：偵測路徑

**Git memory 路徑**：讀取當前工作目錄，找到 `memory/MEMORY.md`，即為根目錄。

**Claude 本機路徑（project）**：
1. 取得專案絕對路徑（如 `D:\Develop\MCP_NodeServer`）
2. 編碼規則：`D:\Develop\MCP_NodeServer` → `d--Develop-MCP-NodeServer`
   - 磁碟代號轉小寫
   - `:\` 替換為 `--`
   - `\` 替換為 `-`
3. 完整路徑：`~/.claude/projects/{encoded}/memory/`

**Claude 本機路徑（global）**：`~/.claude/memory/`（若不存在，初始化時建立）

確認兩個路徑後，用 Glob 或 list_files 列出各自的 `*.md` 清單。

### Step 2：Status（差異比對）

列出三種狀態：

```
=== Memory Sync Status ===
Git memory:       {git_path}
Claude 本機:      {local_path}

[僅 Git 有]        → pull 後會新增到本機
  - memory/feedback/xxx.md

[僅本機有]         → push 後會新增到 Git
  - memory/user/yyy.md

[兩端都有，需比對]
  - memory/MEMORY.md  ← 建議手動合併索引

總計：Git {N} 檔 / 本機 {M} 檔
```

### Step 3：執行同步

#### Pull（Git → 本機）

```
對 [僅 Git 有] 的每個檔案：
  Read 該檔案內容 → Write 到對應本機路徑

對 [兩端都有] 的檔案：
  若使用者說「強制覆蓋」→ 直接 Write
  否則跳過，列出「略過（兩端都有）：{檔案}」
  MEMORY.md 永遠跳過，最後單獨處理
```

**MEMORY.md 合併**：
兩端的 MEMORY.md 都是索引，不能直接覆蓋。執行：
1. Read 兩個 MEMORY.md
2. 找出本機有但 Git 沒有的索引行（新記憶）
3. 把差異行追加到 Git MEMORY.md 結尾（或建議使用者手動合併）

#### Push（本機 → Git）

與 Pull 邏輯相同，方向相反。Push 完成後提示：
```
記得 git add memory/ && git commit && git push 讓其他機器也能 pull
```

### Step 4：完成報告

```
同步完成（{pull/push}，{project/global}）：
  新增：X 個檔案
  略過：Y 個檔案（兩端都有）
  MEMORY.md：{已合併 / 請手動合併}
```

---

## 快速用法

```
/memory_sync              ← pull + project（預設，換環境後執行）
/memory_sync push         ← 把本機記憶存回 git
/memory_sync status       ← 只看差異
/memory_sync pull global  ← 更新全域記憶
```

---

## 注意

- `_private/` 目錄下的檔案（機敏記憶）**不同步**，永遠略過
- Git memory 路徑需是已 clone 的 repo，同步前確認 `git pull` 為最新
- 全域 memory 若目錄不存在，自動建立 `~/.claude/memory/` 並初始化空白 `MEMORY.md`
