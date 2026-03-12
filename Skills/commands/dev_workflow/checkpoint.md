# /checkpoint — 建立或驗證工作流程安全點

你是工作流程檢查點管理員，在長任務執行過程中建立 git 快照與日誌記錄，出問題時可快速回溯。

---

## 使用者輸入

$ARGUMENTS

格式：`create <name>` | `verify <name>` | `list` | `clear`

---

## 執行步驟

### 步驟 1：解析操作指令

依 `$ARGUMENTS` 判斷操作模式：

| 指令 | 動作 |
|------|------|
| `create <name>` | 建立命名檢查點 |
| `verify <name>` | 驗證與指定檢查點的差異 |
| `list` | 列出所有檢查點 |
| `clear` | 清除舊檢查點（保留最新 5 筆） |
| 無參數 | 詢問使用者選擇操作 |

---

### 步驟 2a：建立檢查點（create）

1. 確認目前 git 狀態：

```
git_status
→ 若有未提交的變更，提示使用者
```

2. 建立快照（依使用者選擇）：
   - 有意義的階段完成 → `git_stash_ops push -m "checkpoint: <name>"`
   - 或直接 commit 當前狀態

3. 取得當前 commit SHA：

```
git_log limit=1
→ 取得 short SHA
```

4. 寫入日誌到 `.claude/checkpoints.log`（若目錄不存在先建立）：

```
格式：YYYY-MM-DD HH:MM | <name> | <git-sha> | <摘要說明>
```

5. 回報結果：

```
✅ 檢查點已建立：<name>
   SHA：<short-sha>
   時間：<timestamp>
   狀態：<檔案異動摘要>
```

---

### 步驟 2b：驗證檢查點（verify）

1. 讀取 `.claude/checkpoints.log` 找到目標檢查點
2. 取得目標 SHA
3. 比較差異：

```
git_diff base=<checkpoint-sha>
→ 列出異動檔案數量與摘要
```

4. 輸出比較報告：

```
CHECKPOINT COMPARISON: <name>
================================
基準 SHA：<sha> (<timestamp>)
目前 SHA：<current-sha>

檔案異動：+N 新增 / ~N 修改 / -N 刪除
主要變更：
  - <file1>：修改 +X/-Y 行
  - <file2>：新增

建議動作：
  → 若變更符合預期，可建立新檢查點記錄進度
  → 若有意外變更，考慮 git_stash_ops 暫存後回溯
```

---

### 步驟 2c：列出檢查點（list）

讀取 `.claude/checkpoints.log`，格式化輸出：

```
# 檢查點清單

| # | 名稱 | 時間 | SHA | 說明 |
|---|------|------|-----|------|
| 1 | feature-start | 2026-03-12 10:00 | abc1234 | 開始實作前 |
| 2 | core-done | 2026-03-12 14:30 | def5678 | 核心邏輯完成 |
```

若日誌不存在，提示「尚無檢查點記錄」。

---

### 步驟 2d：清除舊記錄（clear）

保留最新 5 筆，刪除舊記錄：

```
讀取 .claude/checkpoints.log
→ 保留最後 5 行
→ 寫回檔案
→ 回報「已清除 N 筆舊記錄，保留 5 筆」
```

---

## 典型使用流程

```
任務開始 → /checkpoint create "task-start"
     ↓
階段完成 → /checkpoint create "phase1-done"
     ↓
測試完成 → /checkpoint verify "phase1-done"（確認沒有意外回退）
     ↓
重構完成 → /checkpoint create "refactor-done"
     ↓
PR 前    → /checkpoint verify "task-start"（確認全部變更）
```

---

## 注意事項

- `.claude/checkpoints.log` 位於專案根目錄下，應加入 `.gitignore`
- `create` 操作不強制 commit，只記錄當前 HEAD SHA
- `verify` 僅比較 git diff，不會自動回溯任何變更
- 若 git 工具回傳錯誤，提示使用者確認是否在 git repo 內
