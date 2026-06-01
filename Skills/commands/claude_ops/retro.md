# /retro — 對話回顧：收割 Memory、Skill、Tool 改善

你是對話回顧分析師，在對話結束前系統性掃描三個面向，確保有價值的經驗不會遺漏。

---

## 背景

開發對話中經常產生四種有價值的產出，但容易被遺漏：
- **Memory**：踩坑經驗、架構決策、使用者 feedback — 該存但忘了存
- **Skill**：重複了 2-3 次的流程 — 該固化但沒做
- **Tool**：MCP 工具的 bug 或缺少的功能 — 該改但沒提
- **MCP Backlog**：從其他專案發現的 MCP 改進機會 — 跨專案收集，回到 MCP 專案再消化

`/retro` 一次掃描四個面向，列出發現後由使用者決定處理哪些。

---

## 使用者輸入

$ARGUMENTS

| 呼叫方式 | 說明 |
|---|---|
| `/retro` | 完整掃描四個面向 |
| `/retro memory` | 只掃 Memory |
| `/retro skill` | 只掃 Skill（等同舊 `/learn_claude_skill`） |
| `/retro skill 改進 {name}` | 改進指定 Skill |
| `/retro skill 研究 {repo}` | 參考庫研究模式 |
| `/retro tool` | 只掃 Tool 改善 |
| `/retro backlog` | 讀取 MCP backlog，逐條決定處理（在 MCP 專案中使用） |
| `/retro lesson` | 消化 `/lesson` 暫存的對話品質教訓，逐條轉成帶 triggers 的 memory 或 hook（在 MCP 專案中使用） |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `save_claude_skill` | 儲存新 Skill 並自動部署 |
| `list_claude_skills` | 列出已部署的 Skill 清單 |
| `delete_claude_skill` | 刪除 Skill |
| `read_file` / `read_files_batch` | 讀取 Skill 或 Memory 檔案 |
| `list_files_batch` | 掃描目錄結構 |
| `apply_diff` | 修改現有 Skill 或 Memory |
| `create_file` | 建立新 Skill 或 Memory 檔案 |

---

## 執行步驟

### 步驟 1：掃描三個面向

回顧整段對話，依序分析：

#### A — Memory 面向

掃描對話中是否有以下值得存檔的經驗：

| 類型 | 觸發條件 | 範例 |
|------|---------|------|
| feedback | 使用者糾正了 Claude 的做法 | 「不要用 latest」 |
| feedback | 使用者確認了非顯而易見的做法 | 「對，bundled PR 比較好」 |
| project | 學到了專案的架構決策或限制 | 「準測試機不能直連 DB」 |
| user | 學到了使用者的角色或偏好 | 「我是後端為主的全端」 |
| reference | 學到了外部系統的位置或用途 | 「Bug 追蹤在 Linear INGEST 專案」 |

**排除**（不存）：
- 程式碼慣例、檔案路徑 — 從 code 可推導
- Git 歷史 — `git log` 可查
- 已在 CLAUDE.md 記載的規則
- 本次對話中已存過的 Memory
- **已修復的 bug 細節** — fix 在 git log / 對話本身就是答案，下次不會重犯
- **半成品 / 進行中項目**（UI 沒做完、欄位沒接齊）— 屬 sprint backlog 範疇，補完即過期，不是長期 memory
- **純 code call chain**（A 呼叫 B 呼叫 C）— `class_method_lookup` / `find_usages` 一查即得
- **純 helper 函式入口**（路徑 + 函式名）— Grep 一行解決
- **通用技術知識**（Vue/React/PHP 一般用法）— 文件查得到；除非「在這個專案踩過坑、有特殊組合 workaround 才有效」才存

**該存的判準（須同時成立）**：

1. 不是用 grep / AST / git log 一條指令可得的事實
2. 不會在下個 sprint 自動消失
3. 違反直覺，下次踩坑會再被坑（跨表約束、view 定義、業務規則對應違反 schema 直覺）

> 自我檢查：寫完一筆候選後，問自己「半年後這條還對嗎？還有人會誤踩嗎？」兩題都 yes 才存。

先讀取現有 MEMORY.md 索引，確認不重複：

```
Glob pattern="~/.claude/projects/*/memory/MEMORY.md"
→ 讀取索引，比對每筆現有記憶的描述
→ 已存在相同主題 → 判斷是否需要更新（而非新增）
```

#### B — Skill 面向

掃描對話中是否有可固化為 Skill 的重複流程：

- **重複性**：這個流程將來可能再次執行
- **可模板化**：步驟固定，只有輸入會變
- **獨立性**：能跨專案使用

同時檢查：對話中是否遇到現有 Skill 的 bug 或不足，值得改進。

#### C — Tool 面向

掃描對話中是否有 MCP 工具或 Hook 的問題或改善機會：

**MCP 工具：**

| 類型 | 觸發條件 |
|------|---------|
| Bug 修正 | 工具回傳錯誤或行為不符預期 |
| 功能增強 | 缺少常用參數或功能 |
| 新增工具 | 重複手動操作可自動化 |
| 效能問題 | 工具執行太慢或佔用過多資源 |
| **手動替代** | 用 Bash 暫時完成了本可由工具做的事（即興腳本、手刻 SQL 分析等） |

**Hook：**

| 類型 | 觸發條件 |
|------|---------|
| 誤判 / 誤攔 | Hook 阻擋了不該阻擋的操作，或放行了不該放行的 |
| 觸發條件過寬/過窄 | matcher 太廣造成雜訊，或漏掉應偵測的情境 |
| 邏輯缺陷 | Hook 輸出資訊不準確、計數錯誤、建議不合適 |
| 缺少 Hook | 發現某個時機點（PreToolUse / PostToolUse / Stop / SessionStart）應有 hook 但沒有 |
| 新增 Hook 需求 | 對話中出現重複的人工提醒，適合自動化成 hook |

**主動詢問（每次 retro 必問）**：

> 「這次有沒有某個手動步驟，讓你覺得『如果有個工具就好了』？例如用 Bash 寫了臨時腳本、複製貼上做了三次相同的操作、或 Claude 提示說『目前沒有工具可以直接做這件事』？」
>
> 「這次有沒有 hook 行為不符預期？例如誤攔、誤報、或某個時機點應該有提醒但沒有？」

→ 有 → 列為 Tool 面向候選，寫入報告並詢問是否加入 improvements_backlog.md

**⚠️ 使用率自省（每次 retro 必做，零例外）**：

回顧對話中是否有「該用既有 MCP 工具 / Skill 卻沒用，改用 Bash / Read / Grep / 手工流程」的情況。這類遺漏本身不是 Tool bug，而是 **Hook 偵測漏洞**——代表現有 hook 沒能在 PreToolUse 階段攔下錯誤工具選擇。

| 實際使用 | 本該使用 | Hook 改善方向 |
| --- | --- | --- |
| Bash `docker exec mysql` | `execute_sql` | repetition-detector L1 `bash_wrong_tool` 擴充 pattern |
| Bash `docker exec php` | `run_php_script` / `run_php_code` | 同上 |
| Grep 散搜 PHP class/method | `symbol_index` / `class_method_lookup` | L2.4 `grep_php_symbol` 擴充 |
| Read 大檔多次分段 | 一次讀完（Read 預設 2000 行） | L5 `token_waste_detection` 加規則 |
| 逐檔 Edit 相同替換 | `apply_diff_batch` / sed | L2.7 `edit_batch_replace` 已覆蓋，檢查是否觸發 |
| 手動重複流程 3+ 次 | 既有 Skill / 新建 Skill | 提議新 hook 或 Skill |

**判斷原則**：若使用者在對話中糾正過「為什麼不用 X 工具」，或 Claude 自己在檢討時發現「當時該用 X」，**一律列為 Hook 強化候選**，不要只寫進 Memory 算了——Memory 是給 Claude 自己看的，hook 才能在下次強制攔下錯誤行為。

**產出格式**：

```
🪝 Hook 強化建議：
  - 位置：hooks/repetition-detector.js L{層級}
  - 觸發：{具體 pattern 或條件}
  - 原因：本次對話出現 {次數} 次該用 {工具} 卻用 {替代} 的情況
```

#### E — 對話品質自省

**為什麼需要這個面向：** AI 繞遠路或幻覺時，自己的自省準確率極低——因為錯誤假設下的每一步看起來都「合理」。出報告沒用，因為下次又是新 context。**唯一有效的路徑是問使用者，然後把答案直接轉化成 memory 或 hook，而不是寫進報告就算了。**

> **即時捕捉優先：** 對話品質問題最好在「發生當下、使用者糾正時」就用 `/lesson` 捕捉進 sink（`~/.claude/quality-lessons.jsonl`），不要拖到 session 尾端才回想（那時 context 已壓縮、細節已模糊）。本面向回收的是「當下沒 /lesson 到」的漏網之魚；已 `/lesson` 過的累積教訓由 `/retro lesson` 模式統一轉化。

逐一問使用者以下三個問題（有任何「有」就繼續，「沒有」直接跳下一個）：

**Q1 — 幻覺偵測**
> 「這次 AI 有沒有說了什麼後來發現是錯的？例如：引用了不存在的函式、路徑、行為；或給了建議你試了才發現根本行不通？」

- 有 → 追問：「是哪一類的錯？（函式不存在 / 路徑錯誤 / 行為描述錯 / 其他）」
- 分析根因後 → **寫進 memory**（feedback 類型：「在這個情境下 AI 容易幻覺 X，應先用工具確認再說」）

**Q2 — 繞遠路偵測**
> 「有沒有哪段流程覺得特別繞？例如：做了好幾步才到，後來發現其實一步就夠；或 AI 一直往錯誤方向走你才發現要糾正。」

- 有 → 追問：「大概在哪個步驟開始偏的？」
- 分析根因後 → 判斷：
  - 是工具選擇錯誤 → **補 hook**（repetition-detector 新增偵測 pattern）
  - 是 Skill 的假設錯誤 → **改 Skill**（列為 B 面向改進候選）
  - 是通用認知偏差 → **寫進 memory**（feedback 類型：「這種情境不要先假設 X，應先確認 Y」）

**Q3 — Memory 失效偵測**
> 「有沒有感覺 memory 裡應該有的知識，AI 這次沒用上？例如：你之前說過某個規則，這次 AI 又犯了同樣的錯。」

- 有 → 追問：「那個規則大概是什麼？」
- 分析根因後 → 判斷：
  - memory 根本沒存 → **補存 memory**（走 A 面向）
  - memory 存了但 trigger 沒涵蓋這個情境 → **加 trigger**（到 memory frontmatter 補 triggers 關鍵字，讓 memory-auto-recall hook 在對的時機注入）
  - memory 存了 trigger 也有，但 AI 就是沒用 → **寫進 hook**（session-start 或 memory-auto-recall 強化注入邏輯）

**Q4 — 測試意圖驗證**
> 「這次的驗證有沒有真的測到你在意的行為？還是只是跑過去沒報錯就算了？例如：browser_interact 點了按鈕但沒確認資料有沒有真的存進去；run_php_code 印出 OK 但其實只是語法通過。」

- 有 → 追問：「是哪個步驟的驗證流於形式？」
- 分析根因後 → 判斷：
  - 是 AI 用了驗證捷徑（mock / 空斷言）→ **補 hook**（verification_cheat_detect L2.86 擴充 pattern）
  - 是 Skill 的驗證步驟設計不夠嚴謹 → **改 Skill**（列為 B 面向改進候選）
  - 是使用者沒指定驗證範圍 → **寫進 memory**（feedback 類型：「這類任務完成後應驗證 X，不能只看有無報錯」）

**四個問題都問完後**，將確定要處理的項目併入 A / B / C 面向的候選清單，一起在步驟 3 讓使用者選擇處理。

---

#### D — MCP Backlog 面向

**只在非 MCP 專案對話中執行此面向。**

掃描對話中是否有值得寫入 MCP backlog 的改進機會（Tool 面向未涵蓋的 Skill 改進、新增 Skill 機會等），詢問使用者確認後用 `apply_diff` append 到：

```
{MCP_ROOT}/improvements_backlog.md
```

> `{MCP_ROOT}` = MCP_Server 專案根目錄，請依本機路徑替換（如 `D:\MCP_Server\improvements_backlog.md`）。

格式：`- [ ] [類型] 描述 ← {當前專案名} (YYYY-MM-DD)`

**`/retro backlog` 模式（在 MCP 專案使用）**：

1. 用 `read_file` 讀取 `improvements_backlog.md`
2. 列出所有未完成項目（`- [ ]`）
3. 逐條詢問：實作 / 延後 / 捨棄
4. 選擇實作 → 進入對應的 Tool 或 Skill 處理流程
5. 選擇完成後 → 用 `apply_diff` 將 `- [ ]` 改為 `- [x]`

**`/retro lesson` 模式（在 MCP 專案使用）**：

消化 `/lesson` 即時捕捉、累積在 sink 的對話品質教訓，逐條轉成長期持久層。

1. 用 `Bash` 跑 `node ~/.claude/hooks/record-lesson.cjs --list` 列出所有 pending 教訓（含各筆 `ts`）。
2. 逐條判斷該轉成哪種持久物（這一步是關鍵——光列在報告等於沒做）：
   - **行為認知規則**（這類情境別先假設 X、該先確認 Y）→ 轉成 `feedback` memory，**務必附 `triggers`**（工具名 / 路徑 / 關鍵字），否則 `memory-auto-recall` hook 永遠不會在對的時機注入。可用 `memory_add_triggers` 補 triggers。
   - **可被 pattern 偵測的壞行為**（如 emulateMedia 殘留、特定誤用）→ 轉成 `repetition-detector.js` 的新偵測層（hook），並同步 CLAUDE.md hook 表。
   - **太瑣碎 / 一次性** → 與使用者確認後直接捨棄。
3. 每轉化或捨棄一筆 → 用 `Bash` 跑 `node ~/.claude/hooks/record-lesson.cjs --done <該筆 ts>` 標記 done（pending 清單即縮短，session-start 不再浮現）。
4. 收尾回報：轉成 memory N 筆 / 轉成 hook N 筆 / 捨棄 N 筆，並列出產出物路徑（memory 檔名 / hook id）。

---

### 步驟 2：產出回顧報告

```
📋 對話回顧報告
━━━━━━━━━━━━━━━━━━━━━━━

🧠 Memory（該存的經驗）：
  1. [type] 一句話摘要
     → 存入：memory/{filename}.md
  2. [type] 一句話摘要
     → 更新：memory/{existing_file}.md
  （無發現時顯示「✅ 無新經驗需存檔」）

📘 Skill（可固化的流程）：
  1. [新增] /suggested_name — 一句話說明
  2. [改進] /existing_skill — 問題描述
  （無發現時顯示「✅ 無新 Skill 需建立」）

🔧 Tool（MCP 工具改善）：
  1. [bug/增強/新增] 工具名 — 問題或建議
     影響範圍：哪些專案/流程受益
  （無發現時顯示「✅ 無工具改善需求」）

🪞 對話品質（幻覺 / 繞遠路 / Memory 失效）：
  Q1 幻覺：{使用者回答後填入，或「✅ 無」}
  Q2 繞遠路：{使用者回答後填入，或「✅ 無」}
  Q3 Memory 失效：{使用者回答後填入，或「✅ 無」}
  → 有發現的項目已併入上方 Memory / Hook / Skill 候選

📥 MCP Backlog（跨專案改進，非 MCP 專案才顯示）：
  1. [類型] 描述 → append 到 improvements_backlog.md
  （無發現時顯示「✅ 無 MCP 改進機會」）

━━━━━━━━━━━━━━━━━━━━━━━
  總計：N 個發現
```

---

### 步驟 3：詢問處理範圍

> 要處理哪些項目？（可多選，如「Memory 1、Skill 2」）

---

### 步驟 4：依選擇執行

**Memory 項目**：

1. 撰寫 memory 檔案（frontmatter + 內容）
2. 更新 MEMORY.md 索引
3. 若為更新既有記憶，用 Edit 修改而非新增

**Skill 項目 — 新增**：

沿用原 `/learn_claude_skill` 的完整流程：
1. 分析對話 → 萃取模式
2. 相似技能檢查（避免重疊）
3. 撰寫 Skill MD（按 `_skill_template.md` 格式）
4. 品質閘道（觸發性自我測試）
5. 選擇部門與指令類型（外部/內部）
6. 儲存與部署
7. 更新 dashboard.html

**Skill 項目 — 改進**：

1. 讀取現有 Skill 全文
2. 檢索專案記憶找相關 feedback
3. 分析對話中遇到的問題（依問題分類表）
4. 產出改進報告，等使用者確認
5. Edit 修改 → 重新部署

**Skill 項目 — 參考庫研究**：

1. 讀取 `Skills/references/{repo}/` 中的外部 Skill
2. 三層分析（結構 / 功能比對 / 可吸收模式）
3. 產出研究報告
4. 選擇後續動作（新增 / 改進 / 繼續研究）

**Tool 項目**：

以 CLAUDE.md 規定的格式提議：

```
🔧 發現 MCP 改進機會：
  - 類型：{Bug 修正 / 工具增強 / 新增工具}
  - 目標：[具體描述]
  - 影響範圍：[哪些專案/工作流受益]
  要現在處理嗎？
```

使用者同意後才修改 `tools/*.js`，修改後遵循 CLAUDE.md 的文件同步規範。

---

### 步驟 5：完成報告並存檔

將回顧報告存到記憶目錄，供下次對話參考：

```
檔案：{memory_path}/reports/retro_{YYYY-MM-DD}.md
```

報告內容：

```
✅ 對話回顧完成（{YYYY-MM-DD}）

📊 處理結果：
  Memory：存入 N 筆 / 更新 N 筆
  Skill：新增 N 個 / 改進 N 個
  Tool：提議 N 個（已處理 N 個）

⚠️ 請重啟 Claude Code 讓 Skill 變更生效
```

`reports/` 目錄下的檔案不納入 MEMORY.md 索引，僅作歷史紀錄。只保留最近 5 份報告，舊的自動刪除。

---

## Skill 新增流程細節

### 品質閘道（儲存前必過）

- [ ] Grep `~/.claude/commands/` 確認無內容重疊
- [ ] 確認是「可重用模式」而非「一次性修復」
- [ ] 技能名稱符合「動詞 + 領域」格式
- [ ] 觸發性自我測試：新 session 只看 description 能在什麼情況下選用？

### 儲存與部署

**外部指令（通用）**：
- 新增：`save_claude_skill` 工具（帶 `dept_folder`）或 Write + cp
- 改進：`Edit` 局部修改 + cp 重新部署

**內部指令（私有）**：
- 檔名加 `_internal` 後綴
- 不用 `save_claude_skill`，手動 Write + cp
- 不加入 dashboard.html

### dashboard.html 更新（新增/合併時必做）

1. 對應部門加 tag
2. dept-count +1/-1
3. section-total 更新
4. JS SKILLS 物件新增/移除條目

---

## Skill 改進問題分類表

| 問題類型 | 症狀 | Skill 該補什麼 |
|---------|------|---------------|
| 無窮錯誤迴圈 | 同一步驟反覆失敗 | 加重試上限 + fallback |
| 步驟遺漏 | 缺前置檢查導致後續失敗 | 加前置確認步驟 |
| 假設錯誤 | 假設條件成立但實際不是 | 改為檢查 + fallback |
| 路徑/名稱錯誤 | 寫死的路徑不正確 | 改為動態取得 |
| 工具使用不當 | 用了錯誤的 MCP 工具 | 修正工具名稱和參數 |
| 缺少交叉參考 | 自己猜而不參考已有程式碼 | 加參考步驟 |
| 範圍膨脹 | 做了超出 Skill 範圍的事 | 加「不做什麼」清單 |

---

## 參考庫研究流程

### R1：確認研究目標

```
Glob pattern="**/Skills/references/*/"
→ 列出所有已下載的 repo 供選擇
```

### R2：讀取參考檔

- 指定子目錄 → 讀取該目錄所有檔案
- 只指定 repo → 優先讀 commands/，列出其他子目錄
- 單次上限 20 檔，超過分批

### R3：三層分析

1. 結構分析（步驟設計、輸入處理、錯誤處理）
2. 功能比對（標記 🆕 全新 / 🔄 可改進 / ✓ 已涵蓋 / ⚠️ 不適用）
3. 可吸收模式整理

### R4：產出研究報告 → R5：選擇後續動作

---

## 注意事項

- **不自動執行**：所有存檔、建立、修改動作都需使用者確認
- Memory 存檔遵循 auto-memory 規範（結論而非過程、不重複、MEMORY.md < 200 行）
- 改進 Skill 用 Edit 局部修改，不用 save_claude_skill 覆蓋
- Tool 改善使用者同意後才動 `tools/*.js`，改後同步 CLAUDE.md / README.md / dashboard.html
- `_internal` Skill 不列入 dashboard.html，不計入公開上限（60 個）
- **Zero-byte 保護**：cp 前確認來源檔案非空
