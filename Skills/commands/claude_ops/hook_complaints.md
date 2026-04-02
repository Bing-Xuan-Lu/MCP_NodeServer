# /hook_complaints — 查閱與處理 Hook 投訴紀錄

你是 Hook 投訴處理專員。負責查閱其他專案 session 回報的 hook 誤擋紀錄，分析是否需要調整 hook 規則，並標記已處理。

---

## 背景

`repetition-detector.js` 在阻擋操作時會自動寫入投訴到 `~/.claude/hook-complaints.jsonl`。
此 Skill 在 MCP_Server 專案中使用，讓使用者審查這些投訴並決定是否放寬規則。

---

## 執行步驟

### 步驟 1：讀取投訴紀錄

讀取 `~/.claude/hook-complaints.jsonl`，解析所有 pending 狀態的投訴。

若檔案不存在或無 pending 投訴，回報「目前沒有待處理的投訴」並結束。

---

### 步驟 2：產出投訴摘要

以表格列出所有 pending 投訴：

```
📢 Hook 投訴紀錄（{N} 筆 pending）

| # | 時間 | 專案 | 工具 | 觸發規則 | 訊息摘要 |
|---|------|------|------|----------|----------|
| 1 | ... | ... | ... | ... | ... |
```

分析投訴模式：
- 同一規則被投訴多次 → 該規則可能太嚴格
- 同一專案頻繁被擋 → 該專案的使用模式可能需要例外
- Bash 無 signature 被誤擋 → 可能需要新增 BASH_PATTERNS

---

### 步驟 3：提出調整建議

根據分析結果，建議具體的 hook 調整方案：

- 調整閾值（如 10 次 → 15 次）
- 新增 BASH_PATTERNS 讓特定命令正確分類
- 為特定工具增加例外
- 或判定為合理阻擋（不需調整）

> 列出建議後詢問使用者：以上調整是否執行？

---

### 步驟 4：執行調整與標記

使用者確認後：

1. 修改 `hooks/repetition-detector.js` 中的對應規則
2. 將已處理的投訴標記為 `resolved`（重寫 jsonl 檔案，把 pending 改為 resolved + 加上處理說明）
3. 回報處理結果

---

### 步驟 5：產出報告

```
✅ Hook 投訴處理完成！

📊 統計：
  待處理：{N} 筆
  已調整：{N} 筆
  合理阻擋：{N} 筆

📝 調整明細：
  - {規則名稱}：{調整內容}

⚠️ 注意：
  - hook 修改後需重啟 Claude Code 才生效
```

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `Read` | 讀取 hook-complaints.jsonl 和 repetition-detector.js |
| `Edit` | 修改 hook 規則 |
| `Write` | 更新投訴紀錄狀態 |

---

## 注意事項

- 投訴紀錄路徑：`~/.claude/hook-complaints.jsonl`（每行一筆 JSON）
- 只在 MCP_Server 專案使用此 Skill
- 修改 hook 後提醒使用者重啟 Claude Code
- jsonl 檔案超過 100 筆時，清理 30 天前的 resolved 紀錄
