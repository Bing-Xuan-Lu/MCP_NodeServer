---
name: session_audit
description: |
  跨 session 趨勢分析：掃 ~/.claude/projects/<slug>/*.jsonl 統計工具熱點、重複踩坑、token 燃燒、修改檔案熱區、未固化流程，產出健檢報告與 Memory/Skill 候選 backlog。涵蓋：依專案分桶、依時間範圍、跨專案盤點、唯讀分析不動 Memory。
  當使用者說「Claude 最近一直犯同樣錯」「跨 session 分析」「看看最近走太多彎路」「session 健檢」「跨專案盤點」「最近燒太多 token」時使用。
---

# /session_audit — 跨 session 趨勢分析與健檢報告

你是 Claude 行為健檢分析師。讀取磁碟上的歷史 JSONL transcript，跨多場 session 聚合統計，找出重複犯錯、token 浪費、未固化流程，產出**唯讀的健檢報告**（不直接動 Memory/Skill，由使用者看完後決定是否升級）。

---

## 背景

Claude Code 把每場對話存成 `~/.claude/projects/<slug>/<session-id>.jsonl`，每行一個事件（user prompt / assistant message / tool_use / tool_result / hook attachment）。單場對話的問題用 `/retro` 收割即可；但**跨 session 才看得出趨勢**：

- 同一個 bug 是不是反覆出現？
- 哪個 MCP 工具失敗率特別高？
- 哪些檔案被反覆改（候選 refactor）？
- 哪類使用者問題反覆出現（候選 Memory）？

`/session_audit` 跑 offline 分析、產健檢報告 → 由使用者決定哪些升級成 Memory / Skill / MCP 工具改進。**這個 Skill 唯讀，不寫 Memory、不部署 Skill。**

與 `/retro` 的分工：
- `/session_audit` = offline 跨場次趨勢健檢，產報告
- `/retro` = 當前對話結束前收割，直接寫 Memory / Skill

---

## 使用者輸入

$ARGUMENTS

| 呼叫方式 | 說明 |
|---|---|
| `/session_audit` | 當前專案（依 cwd 推 slug）、最近 7 天 |
| `/session_audit {keyword}` | 模糊匹配 slug（含 keyword 的專案）、最近 7 天 |
| `/session_audit {keyword} 14` | 同上、最近 14 天 |
| `/session_audit all 7` | 所有專案、最近 7 天（跨專案盤點） |

---

## 需要的資訊

無強制需要。未提供範圍時：
- 預設專案 = 當前 cwd 對應的 slug（將 `D:\Project\{ProjectFolder}` 轉成 `D--Project-{ProjectFolder}` 比對 `~/.claude/projects/` 下目錄）
- 預設時間窗 = 7 天

若 cwd 推不出 slug，主動列出可選 slug 讓使用者挑，**禁止猜**。

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `list_files` | 列 `~/.claude/projects/<slug>/` 下的 JSONL 檔 |
| `Bash` | 跑 Node.js 解析 JSONL（line-by-line JSON parse 最快） |
| `read_file` | 補讀單一 JSONL 細節（驗證疑點時用） |
| `create_file` | 寫健檢報告到 `memory/_audits/YYYY-MM-DD-{slug}.md` |

---

## 執行步驟

### 步驟 0：解析參數、確認範圍

從 `$ARGUMENTS` 抽出 `[project]` 與 `[days]`：

1. 列 `C:\Users\tarag\.claude\projects\` 下所有目錄
2. project 解析：
   - `all` → 全部 slug
   - 空字串 → 從 cwd 反推（`D:\Project\{ProjectFolder}` → `D--Project-{ProjectFolder}`）
   - 其他 → 模糊匹配（contains、case-insensitive），多個結果列給使用者挑
3. days 預設 7、最大 90
4. 一句話回報範圍：「將分析 `D--Project-{ProjectFolder}` 最近 7 天的 X 場 session」**不需確認，直接往下**（唯讀分析）

---

### 步驟 1：篩 JSONL 並抽欄位

**不要用 inline `node -e` — Bash 的引號與反斜線處理會把 Windows 路徑與 JSON 字串吃壞。改呼叫獨立腳本 [hooks/session-audit-scan.js](../../../hooks/session-audit-scan.js)**：

```bash
node hooks/session-audit-scan.js <slug> <days>
```

**輸出**：stdout 為 JSON，欄位包含 `sessions / sessionDates / totalToolCalls / topTools / topFiles / topRepeats / tokenUsage / cacheHitRate / totalErrors / errorRate / hookComplaints / hookComplaintTypes / userPromptCount / promptSample`。

**腳本內部會做的事**（不要重覆寫在這份 MD，邏輯維護在 .js）：
- 列 `~/.claude/projects/<slug>/*.jsonl` 且 `mtime ≥ now - days`
- 逐行 JSON.parse，抽 `user.text` / `tool_use.name+input` / `tool_result.is_error` / `usage.{input,output,cache*}` / `attachment.content`
- 聚合：工具使用次數、檔案修改次數+跨幾場 session、完全重複呼叫（args hash ≥ 5 次）、token 燃燒、hook 投訴

**跨多個 slug**：對每個 slug 各跑一次 `node hooks/session-audit-scan.js <slug> <days> > tmp/audit-<slug>.json`，最後讀檔合併。

**為什麼用獨立檔不用 inline `node -e`**：曾經踩過坑 — bash 對 `\\\\` 連續轉義會把 Windows 路徑 `C:\\Users\\tarag` 吃成 `C:Users\tarag`，整段腳本崩。獨立 .js 檔走 process.argv 完全避開引號層。

---

### 步驟 2：人工歸納（這步是 Claude 的工作）

從步驟 1 的 JSON 統計，做四個面向的歸納：

#### A — 工具使用健檢
- **濫用警示**：Bash 占比 > 25%？有沒有用 Bash 做 MCP 工具可以做的事（mysql/curl/grep .php）？
- **失敗熱點**：`totalErrors / totalToolCalls` 比率是否異常高？
- **完全重複呼叫**：`topRepeats` 中 ≥ 5 次同 args 的工具 — 通常是無腦重試

#### B — 檔案修改熱區
- 同一檔案 ≥ 5 次修改 → 候選 refactor / 拆檔
- 跨多個 session 都改同一檔 → 候選新 Skill 把流程固化

#### C — Token 燃燒分析
- `cacheRead / (input + cacheRead)` → 命中率（< 50% 代表上下文常被打掉）
- input/output 比例 → 失衡（input 巨大 output 小 = 讀太多沒輸出）

#### D — 使用者問題趨勢
- 從 `promptSample` 找反覆出現的關鍵詞（「跑版」「為什麼 X 沒存」），對應的可能是 Memory 缺口或 Skill 候選

#### E — Hook 投訴聚合
- 列出 hook 投訴的種類分布

---

### 步驟 3：產出健檢報告

寫到 `{project_root}/memory/_audits/YYYY-MM-DD-{slug-short}.md`，若 `memory/_audits/` 不存在則建。報告格式：

```markdown
# Session Audit — {slug} — {YYYY-MM-DD}

**範圍**：最近 {N} 天，共 {sessions} 場 session、{totalToolCalls} 次 tool call
**Token**：input {X} / output {Y} / cache hit rate {Z%}

## 工具使用熱點 Top 10
| 工具 | 次數 | 占比 | 備註 |
|---|---|---|---|
| Bash | 1234 | 32% | 超過 25%，疑似濫用 |

## 完全重複呼叫（≥5 次相同 args）
| 工具 | args 摘要 | 次數 | 推測原因 |
|---|---|---|---|

## 檔案修改熱區
| 檔案 | 修改次數 | 建議 |
|---|---|---|

## 使用者問題趨勢
- 「為什麼 X 沒存」出現 N 次 → 候選 Memory：[主題]
- 「跑版」出現 N 次 → 候選新 Skill：[名稱]

## Hook 投訴聚合
| 類型 | 次數 |
|---|---|

## 改善 Backlog（候選，不自動執行）
1. **[Memory]** 新增 `feedback_xxx.md` — 規則：...
2. **[Skill]** 新增 `/xxx` — 流程：...
3. **[MCP Tool]** `tool_name` 缺 `param` 參數，現況需 fallback Bash
4. **[Refactor]** `xxx.php` 已超過 800 行，建議拆 ...

---
產出時間：{ISO timestamp} · 下一步：在 `/retro` 時逐條處理 backlog
```

---

### 步驟 4：在對話中回報

```
✅ Session 健檢完成

📊 範圍：D--Project-{ProjectFolder} 最近 7 天 / 12 場 session / 4582 次 tool call
📝 報告：memory/_audits/2026-05-20-{slug}.md

重點發現：
  - Bash 占比 31%，疑似濫用（多次 docker exec mysql 應改 execute_sql）
  - {某熱檔}.php 跨 5 場 session 改 18 次 → 候選拆檔
  - 「為什麼 X 沒存」出現 4 次 → 建議新增 Memory 記錄根因

📋 Backlog 共 N 條候選，下次 /retro 時可逐條處理。
```

---

## 輸出

- `{project_root}/memory/_audits/YYYY-MM-DD-{slug-short}.md` 健檢報告
- 對話中的重點摘要與 backlog 條數
- **不寫入 Memory、不部署 Skill、不改 MCP 工具**（唯讀分析）

---

## 注意事項

- **唯讀原則**：本 Skill 只產報告，所有「改進」一律進 backlog 由使用者後續處理
- **大檔不要 Read 整檔**：JSONL 動輒 2-5 MB，必須用 Bash + Node 串流解析
- **跨專案模式（all）**：對每個 slug 各產一份報告，避免單份過大；最後給個 cross-project summary
- **找不到 slug 時主動列選項**：例如 cwd 不對應任何已知 slug，要列出 `~/.claude/projects/` 下所有 slug 讓使用者挑，**禁止猜**
- **時間窗極限**：days ≤ 90，超過會跑很久且報告過載
- **報告寫入位置**：當前 cwd 是哪個專案就寫進該專案的 `memory/_audits/`；若分析 `all`，寫進 MCP_Server 的 `memory/_audits/cross-project-YYYY-MM-DD.md`
- **不取代 `/retro`**：本 Skill 是 offline 分析，`/retro` 才是線上收割；兩者互補
