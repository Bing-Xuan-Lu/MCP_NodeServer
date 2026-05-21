---
name: session_recall
description: |
  跨對話回顧：讀 ~/.claude/projects/<slug>/*.jsonl，回顧某一場 session 做了什麼、做完沒、卡在哪、動過哪些檔，或跨專案搜關鍵字找出相關場次。涵蓋：指定專案選某一場 recap、跨專案關鍵字搜尋、compact 摘要優先、唯讀不動 Memory。
  當使用者說「上一場在做什麼」「上個 session 做到哪」「compact 後想找之前的工作」「哪一場提過 X」「{project} 上次做了什麼」時使用。
---

# /session_recall — 回顧上一場或指定 session 的工作內容

你是跨對話記憶查詢助手。Claude Code 把每場對話存成 `~/.claude/projects/<slug>/<session-id>.jsonl`，這個 Skill 把指定場次的「任務、已完成、未完成、改過的檔、關鍵決策」抽出來成一頁 recap，或跨專案搜關鍵字找出相關場次。**唯讀，不寫 Memory、不改任何檔案。**

---

## 背景

- session-start hook 只在「開新對話開場」自動帶**最近一場**摘要，無法隨選、無法指定哪一場、無法跨專案。
- `/session_audit` 是跨多場的**統計健檢**（工具熱點、token 燃燒），不是「上一場在幹嘛」的敘事回顧。
- 本 Skill 補這個缺口：對話中**隨時**指定專案 + 哪一場做 recap，或跨專案搜關鍵字。
- 資料源優先序：先用 compact 摘要（`~/.claude/sessions/*-compact.md`，已預先濃縮、便宜），沒有才從 jsonl 抽。

---

## 使用者輸入

$ARGUMENTS

| 呼叫方式 | 說明 |
|---|---|
| `/session_recall` | 當前專案（依 cwd 推 slug）、**上一場**（`prev`，自動排除正在進行的當前對話檔） |
| `/session_recall {project}` | 指定專案（模糊匹配 slug）、上一場（`prev`） |
| `/session_recall {project} {selector}` | selector：`prev`（上一場，預設）/ `latest`（含當前場）/ 數字 N（往前第 N 場，1=最近）/ `YYYY-MM-DD` / session-id 前綴 |
| `/session_recall {project} list` | 先列該專案所有場次（日期/大小/有無摘要）讓使用者挑 |
| `/session_recall search {keyword} [days]` | 跨所有專案搜關鍵字（days 預設 30、上限 180），找出相關場次再挑一場 recall |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `Bash` | 跑 `node ~/.claude/hooks/session-recall-scan.js`（list / recall / search 三模式） |
| `read_file` | 讀對應的 compact 摘要 `.md`（recap 有 snapshot 時拿來補充敘事） |

---

## 執行步驟

### 步驟 0：解析參數、決定模式

從 `$ARGUMENTS` 判斷：

- 開頭是 `search` → **跨專案搜尋模式**（步驟 S）
- 否則 → **指定專案 recall 模式**（步驟 1）

解析 project slug：
1. 空字串 → 從 cwd 反推：`D:\Project\{ProjectFolder}` → slug `d--Project-{ProjectFolder}`（大小寫不敏感，比對 `~/.claude/projects/` 下實際目錄名）
2. 有給文字 → 模糊匹配（contains, case-insensitive）`~/.claude/projects/` 下目錄；多個結果**列給使用者挑，禁止猜**

---

### 步驟 1：取場次

若 selector 是 `list` 或不確定要哪一場：

```bash
node ~/.claude/hooks/session-recall-scan.js list <slug>
```

→ 列出場次（sessionId / date / sizeKB / hasSnapshot），請使用者挑一場（或直接用 `prev` 抓上一場）。

確定後抽 recap（無指定 selector 時用 `prev`＝上一場，會自動跳過正在進行的當前對話檔；要含當前場才用 `latest`）：

```bash
node ~/.claude/hooks/session-recall-scan.js recall <slug> <selector>
```

→ 回傳 JSON：`date / lastActivity / snapshot / userRequests / filesModified / sqlPhpRun / topTools / lastTodos / closingNotes`。

---

### 步驟 2：若有 snapshot，讀來補充

recap JSON 的 `snapshot` 欄非空時，用 `read_file` 讀那份 `-compact.md`（已是人寫的摘要，敘事比 jsonl 抽出的更完整）。把兩者合併：snapshot 給「敘事與標題」，jsonl 抽出的給「改過的檔 / pending todos / 工具熱點」這些 snapshot 未必有的硬資料。

---

### 步驟 S：跨專案搜尋模式

```bash
node ~/.claude/hooks/session-recall-scan.js search <keyword> <days>
```

→ 回傳 `matches`（每筆：slug / sessionId / date / hits / snippet），依時間排序。

列給使用者看，請對方挑一場 → 接步驟 1 的 `recall <slug> <sessionId前綴>` 做完整 recap。

---

### 步驟 N：產出 recap

```
回顧：{slug} / {session 短 id} / {date}

任務：
  - （從 userRequests 與 closingNotes 歸納這場在做什麼）

已完成：
  - （lastTodos 中 status=completed 的項目 + closingNotes 收尾結論）

未完成 / 卡住：
  - （lastTodos 中 status=pending/in_progress 的項目 ← 最重要，下一場接手點）

動過的檔（Top）：
  - file.php ×N

關鍵 SQL / PHP：
  - （sqlPhpRun 摘要，若有）

備註：
  - 工具熱點 / 異常（如 Grep 38 次=散搜過多），有才寫
```

---

## 輸出

- 對話中一頁 recap（任務 / 已完成 / 未完成 / 改過的檔 / 關鍵決策）
- 跨專案搜尋時：相關場次清單 + 使用者挑選後的完整 recap
- **不寫入 Memory、不改任何檔案**（唯讀）

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| `require is not defined` | helper 被當 ESM | helper 已用 `import`；若手動改過確認沒退回 `require` |
| cwd 推不出 slug | 不在 `D:\Project\` 下 | 列出所有 slug 讓使用者挑，禁止猜 |
| recall 出來 userRequests 很少 | 該場多為 tool_result / 純 IDE 開檔通知 | 正常，靠 closingNotes 與 lastTodos 補；必要時讀 snapshot |

---

## 注意事項

- **唯讀原則**：只查不改，不寫 Memory、不部署任何東西
- **大檔不要 Read 整檔**：jsonl 動輒數 MB，一律走 helper 串流解析；只有 snapshot `.md` 才用 read_file
- **未完成項目最重要**：recap 的重點是「下一場從哪接」，`lastTodos` 的 pending/in_progress 要放最顯眼
- **找不到 slug 主動列選項**：禁止猜專案
- **與其他 Skill 分工**：`/session_audit`=多場統計健檢；`/retro`=當前對話結束前收割寫 Memory；本 Skill=單場敘事回顧（唯讀）
- helper 位置固定在 `~/.claude/hooks/session-recall-scan.js`（絕對路徑，不依賴 cwd，可從任意專案執行）
