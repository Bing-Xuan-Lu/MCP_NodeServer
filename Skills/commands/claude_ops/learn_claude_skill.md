# /learn_claude_skill — 從對話學習，建立或改進 Claude 技能

你是能從對話中提取可重用模式的 AI 助理。
支援三種模式：
- **新增模式**：從對話中萃取新技能
- **改進模式**：檢討現有 Skill 的問題並修正
- **參考庫研究模式**：讀取 `Skills/references/` 中下載的外部 Skill，分析可吸收的模式

三種模式都會自動檢索專案記憶（auto-memory），將過去的踩坑紀錄、架構決策納入分析。

---

## 判斷模式

根據使用者輸入自動判斷：

| 使用者說 | 模式 |
|---------|------|
| `/learn_claude_skill` | 新增（從對話萃取） |
| `/learn_claude_skill 把這個存成技能` | 新增（指定主題） |
| `/learn_claude_skill 改進 playwright_ui_test` | 改進（指定 Skill） |
| `/learn_claude_skill 檢討 php_crud_generator` | 改進（指定 Skill） |
| `/learn_claude_skill 修正 xxx` | 改進（指定 Skill） |
| `/learn_claude_skill 研究 HelloRuru--claude-memory-engine` | 參考庫研究（指定 repo） |
| `/learn_claude_skill 研究 HelloRuru--claude-memory-engine/hooks` | 參考庫研究（指定子目錄） |
| `/learn_claude_skill 讀參考庫` | 參考庫研究（列出可用 repo 選擇） |

關鍵字「改進 / 檢討 / 修正 / 更新 / fix」→ 改進模式
關鍵字「研究 / 讀參考庫 / analyze / study」→ 參考庫研究模式
其他 → 新增模式

---

## 新增模式

### 步驟 0：檢索專案記憶

掃描當前專案的 auto-memory，找出與本次要萃取的技能相關的經驗：

```
# 1. 找出當前專案的 memory 目錄
Glob pattern="~/.claude/projects/*/memory/MEMORY.md"
→ 從工作目錄名稱比對出對應的 memory 資料夾

# 2. 讀取 MEMORY.md 索引
Read {matched_memory_dir}/MEMORY.md
→ 掃描索引中每筆記憶的描述

# 3. 讀取相關的 memory 檔案
→ 依描述判斷哪些記憶與本次主題相關（踩坑紀錄、架構決策、feedback 等）
→ Read 這些檔案，摘要重點備用
```

**判斷相關性**：記憶提到的工具、模組、流程與本次主題有交集即為相關。
若無相關記憶或 memory 目錄不存在，跳過此步驟。

將找到的相關記憶摘要暫存，供後續步驟參考。

### 步驟 1：分析目前對話

回顧本次對話，找出最具重用價值的任務或模式，判斷標準：

- **重複性**：這個任務將來可能再次執行
- **可模板化**：流程固定，只有輸入資料會變
- **獨立性**：能在不同專案或場景使用

若有多個候選模式，列出並詢問使用者選擇哪個。
若使用者指定了描述，直接以描述為主題。

### 步驟 1b：相似技能檢查

在撰寫新 Skill 之前，先掃描現有技能是否有功能重疊：

```
ls ~/.claude/commands/*.md
→ 讀取每個 Skill 的標題行（# /name — 說明）
→ 比對目前要建立的技能是否與某個現有 Skill 功能相似
```

**判斷相似的標準**：
- 操作對象相同（如都操作 Docker、都處理 PHP 升級）
- 流程步驟高度重疊（超過 50% 步驟相同）
- 差異僅在參數或目標專案不同

**發現相似時**，向使用者報告：

> 發現以下現有技能與此次要建立的技能功能相似：
> - `/existing_skill` — 該技能的一句話說明
>
> 建議方案：
> 1. **整合**：將新功能合併到現有 `/existing_skill`（推薦）
> 2. **擴展**：在現有 Skill 加入可選參數/模式來涵蓋新場景
> 3. **獨立建立**：仍然建立新 Skill（適用於差異確實很大的情況）

若使用者選擇整合或擴展 → 自動切換為**改進模式**，目標為現有的相似技能。
若無相似技能或使用者選擇獨立建立 → 繼續步驟 2。

### 步驟 2：撰寫 Skill MD 內容

按照以下格式生成技能內容：

```
# [技能標題] — 一句話說明

## 背景
說明這個技能在什麼情境下使用（1-2句）

## 輸入
- `$ARGUMENTS` 或描述使用者需要提供哪些資訊

## 步驟
1. 第一步（具體動作，可包含工具呼叫）
2. 第二步
3. ...

## 輸出
描述完成後應輸出/交付的結果
```

技能內容應**通用**，不寫死特定 URL、資料表名等，改用佔位符。

#### 撰寫品質原則（Composio Best Practices）

- **說明行**：`# /name — 說明` 的一句話應能回答「何時該用這個 Skill」。例：「將本機 PHP 專案部署到遠端測試機」比「部署工具」更容易在對的情境觸發。
- **祈使語氣**：步驟描述用動詞開頭（「讀取」、「連線」、「確認」），避免「你應該…」或「請去做…」。
- **精簡原則**：Skill MD 只放核心執行步驟；複雜範例、對照表移到底部「參考」或「常見錯誤」章節，保持步驟主體簡潔。
- **技能命名**：優先使用「動詞 + 領域」格式（`sftp_deploy`、`db_migration_generator`），避免泛用名稱（`tool`、`helper`、`dev_util`）。

生成後，以 code block 展示完整 MD 內容，詢問使用者：

> 以上是生成的 Skill 內容，確認後繼續。如需調整，請說明需要更改哪些部分。

收到確認（或依據反饋修改完畢）後，再進入步驟 2.5。

### 步驟 2.5：品質閘道

在儲存前執行內容層級的重複與品質確認（不跳過此步驟）：

**檢查清單（逐一執行）：**

- [ ] Grep `~/.claude/commands/` 中的 Skill 標題與描述，確認**內容**無重疊（Step 1b 做過結構比較；這裡做內容比較）
- [ ] 確認此技能是「可重用模式」而非「一次性修復」（例：特定 bug 的修法不適合存成 Skill）
- [ ] 確認技能名稱符合「動詞 + 領域」格式，一句話說明能回答「何時該用」

**整合判定（給出一個結論）：**

| 判定 | 意義 | 下一步 |
|------|------|--------|
| **儲存** | 獨特、聚焦、有重用價值 | 繼續步驟 3 |
| **改進後儲存** | 有價值但需調整（說明哪裡要改） | 修改草稿 → 重新評估（一次） |
| **合併至 [X]** | 應附加到某個現有 Skill | 顯示目標 Skill 與新增內容 → 切換改進模式 |
| **放棄** | 瑣碎、重複或過度抽象 | 說明原因後結束 |

判定為**儲存**或使用者確認改進完畢後，繼續步驟 3。

### 步驟 3：選擇指令類型與所屬部門

詢問使用者：

> 這個 Skill 要設為哪種指令？
> 1. **外部指令**（通用，會進版控，適用所有專案）
> 2. **內部指令**（私有，不進版控，可寫死專案路徑與設定）

確認後，依技能內容判斷所屬部門與子資料夾：

| 技能類型 | 部門 | 子資料夾 |
|---------|------|---------|
| PHP 開發、CRUD、升級、路徑修正 | PHP 開發部 | `php_dev/` |
| .NET、程式翻譯、移植 | 程式移植部 | `migration/` |
| 測試、品管、整合測試、UI 測試 | 測試品管部 | `testing/` |
| 規格書、文件比對、需求分析 | 規格分析部 | `spec/` |
| 資料表設計、Schema、索引 | 資料庫規劃部 | `db_planning/` |
| SFTP、上傳、部署到伺服器 | 部署維運部 | `deploy/` |
| Docker、容器、Compose | Docker 維運部 | `docker/` |
| Git、開發流程、架構、TDD | 開發流程部 | `dev_workflow/` |
| 書籤、目錄整理、Git 工具 | 系統工具部 | `tooling/` |
| Skill 管理、MCP 維護、CLAUDE.md | Claude 維運部 | `claude_ops/` |
| 文章擷取、影片、內容處理 | 內容擷取部 | `content/` |
| n8n、YouTube、生活自動化 | 生活自動化部 | `life/` |
| GitHub 研究、Skill 匯入、外部參考 | 研究開發部 | `research/` |

若無法確認，詢問使用者選擇部門。

依選擇設定：

| | 外部指令 | 內部指令 |
|--|---------|---------|
| 檔名 | `{name}.md` | `{name}_internal.md` |
| 內容風格 | 通用、用佔位符 | 可寫死專案路徑、DB 設定、Docker 容器等 |
| 版控 | 會 commit | `.gitignore` 已排除 `*_internal*` |
| 部署方式 | `save_claude_skill` 或手動 cp | 手動 cp（見儲存與部署章節） |

若使用者選擇內部指令，回到步驟 2 確認是否需要將佔位符替換為專案實際值。

### 步驟 4：儲存與部署

→ 跳到「儲存與部署」章節

---

## 參考庫研究模式

### 步驟 R1：確認研究目標

若使用者指定了 repo 名稱或子目錄，直接使用；否則列出可用的參考庫：

```
Glob pattern="**/Skills/references/*/
→ 列出所有已下載的 repo 名稱供選擇

範例輸出：
  可研究的參考庫：
  1. affaan-m--everything-claude-code（commands/ × 43, skills/ × 81）
  2. HelloRuru--claude-memory-engine（commands/ × 30, hooks/ × 7）
```

詢問使用者：
> 要研究哪個？可指定子目錄（例：`HelloRuru--claude-memory-engine/hooks`）

---

### 步驟 R2：讀取參考檔

依目標讀取檔案：

```
若指定子目錄（如 hooks/）：
  Glob pattern="**/Skills/references/{repo}/{subdir}/*"
  → 讀取所有檔案

若只指定 repo（無子目錄）：
  Glob pattern="**/Skills/references/{repo}/commands/*.md"
  → 優先讀取 commands/（最接近 Skill 格式）
  → 同時列出其他子目錄供後續選擇

讀取上限：單次最多 20 個檔案（避免 context 溢出）
超過時：依檔名排序，分批提示使用者繼續
```

---

### 步驟 R3：分析模式與比對現有 Skills

讀取完成後，進行三層分析：

#### 層 1 — 結構分析（外部 Skill 的設計模式）

```
分析重點：
- 步驟設計：如何拆分執行流程？
- 輸入處理：如何接收 $ARGUMENTS？
- 錯誤處理：遇到失敗如何 fallback？
- 輸出格式：報告結構是否優於現有 Skill？
- 特殊機制：hooks、記憶同步、session 管理等
```

#### 層 2 — 功能比對（與現有 Skills 對照）

```
讀取 ~/.claude/commands/*.md 的標題行
→ 比對每個外部 Skill 的功能：

分類標記：
  🆕 全新功能   — 本地完全沒有對應
  🔄 有改進空間 — 本地有類似但外部做法更好
  ✓ 已涵蓋     — 本地已有且等同或更完整
  ⚠️ 不適用     — 針對特定技術棧（如 Go、Swift）暫不需要
```

#### 層 3 — 可吸收模式整理

```
萃取具體可應用的模式，例如：
- "session-start hook 在對話開始時自動載入記憶"
- "checkpoint 指令在對話中途強制存檔"
- "verify 步驟在執行後自動驗證結果"
```

---

### 步驟 R4：產出研究報告

```
📚 參考庫研究報告：{repo}/{subdir}
讀取檔案數：{N}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🆕 值得引入的全新功能（{n} 個）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. {功能名} — {一句話說明為什麼值得引入}
   來源：{filename}
   建議動作：建立新 Skill / 加入現有 Skill

2. ...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔄 可改進現有 Skills 的模式（{n} 個）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 現有 /{skill_name} 可借鑑：{具體改進點}
   來源：{filename}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ 已涵蓋 / ⚠️ 不適用（略）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

### 步驟 R5：選擇後續動作

報告產出後詢問：

詢問使用者：要針對哪個「值得引入」的項目繼續？

1. **建立新 Skill** → 自動切換新增模式（步驟 2），以外部 Skill 為藍本起草
2. **改進現有 Skill** → 自動切換改進模式（步驟 M1），帶入分析結果
3. **繼續研究下一批檔案** → 回到步驟 R2
4. **結束研究** → 輸出完整報告後結束

---

## 改進模式

### 步驟 M1：讀取現有 Skill

已部署的 Skill 一定在 `~/.claude/commands/`，直接讀取：

```
Read ~/.claude/commands/{skill_name}.md
```

若需要讀取原始碼（未部署的版本），找到 MCP Server 專案目錄：

```
Glob pattern="**/Skills/commands/{skill_name}.md"
→ 找到路徑後 Read 該檔案
```

### 步驟 M1b：相似技能檢查

改進時同步掃描是否有其他 Skill 與目標 Skill 功能重疊：

```
ls ~/.claude/commands/*.md
→ 讀取每個 Skill 的標題行
→ 找出與目標 Skill 功能相近的技能
```

**發現可合併的技能時**，在步驟 M3 報告中一併提出：
- 說明哪些 Skill 功能重疊
- 建議合併方向（誰併入誰、保留哪個名稱）
- 合併後需刪除的 Skill 檔案與 dashboard tag

若使用者同意合併，在步驟 M4 一併處理：修改目標 Skill + 刪除被合併的 Skill + 更新 dashboard 計數。

### 步驟 M1c：檢索專案記憶

掃描當前專案的 auto-memory，找出與目標 Skill 相關的經驗紀錄：

```
# 1. 找出當前專案的 memory 目錄
Glob pattern="~/.claude/projects/*/memory/MEMORY.md"
→ 從工作目錄名稱比對出對應的 memory 資料夾

# 2. 讀取 MEMORY.md 索引
Read {matched_memory_dir}/MEMORY.md
→ 掃描索引中每筆記憶的描述

# 3. 讀取相關的 memory 檔案
→ 依描述判斷哪些記憶與目標 Skill 相關
→ 特別留意：feedback 類型（使用者曾糾正的行為）、project 類型（架構決策）
→ Read 這些檔案，摘要重點備用
```

**納入分析的重點**：
- **feedback 記憶**：使用者曾糾正的模式 → 檢查 Skill 是否仍有同樣問題
- **project 記憶**：架構決策或限制 → 檢查 Skill 步驟是否違反
- **踩坑紀錄**：過去的失敗經驗 → 檢查 Skill 是否已涵蓋防範措施

若無相關記憶或 memory 目錄不存在，跳過此步驟。

### 步驟 M2：分析對話中的問題

回顧本次對話，找出 Skill 執行時遇到的問題：

**問題分類表**：

| 問題類型 | 症狀 | Skill 該補什麼 |
|---------|------|---------------|
| 無窮錯誤迴圈 | 同一個步驟反覆失敗重試 | 加「失敗處理」：重試 N 次後停止，改用替代方案或詢問使用者 |
| 步驟遺漏 | 缺少前置檢查導致後續步驟失敗 | 加前置檢查步驟（環境確認、檔案存在、權限等） |
| 假設錯誤 | Skill 假設某個條件成立但實際不是 | 把假設改為檢查，不滿足時有 fallback |
| 路徑/名稱錯誤 | 寫死的路徑或命名規則不正確 | 修正路徑，或改為動態取得 |
| 工具使用不當 | 用了錯誤的 MCP 工具或參數 | 修正工具名稱和參數 |
| 缺少交叉參考 | 自己猜解法而不去參考已有程式碼 | 加入參考模組/檔案的步驟 |
| 範圍膨脹 | 做了超出 Skill 範圍的事 | 明確列出「不做什麼」清單 |
| 輸出格式不清 | 結果雜亂難讀 | 改進輸出模板 |

### 步驟 M3：產出改進報告

向使用者回報分析結果：

```
📋 Skill 檢討報告：/{skill_name}

🔍 本次對話發現的問題：

| # | 問題類型 | 具體描述 | 建議修改 |
|---|---------|---------|---------|
| 1 | 無窮迴圈 | 步驟 3 表單送出失敗後一直重試 | 加失敗上限 + fallback |
| 2 | 假設錯誤 | 假設所有模組都有 del.php | 先 list_files 確認再操作 |
| 3 | 缺少參考 | 自己猜 form action 格式 | 加交叉參考步驟 |

🧠 專案記憶中的相關發現：（若無則省略此區塊）

| # | 記憶來源 | 相關內容 | 對 Skill 的影響 |
|---|---------|---------|----------------|
| 1 | feedback_testing.md | 測試不可 mock DB | 步驟 X 應改用真實連線 |
| 2 | project_auth.md | auth 改寫因合規需求 | 步驟 Y 的假設已過時 |

📝 計畫修改的段落：
  - 步驟 2c（新增頁）：加入失敗重試上限
  - 測試準則：新增「最多重試 2 次」規則
  - 新增「錯誤處理」章節
```

等使用者確認後再修改。

### 步驟 M4：修改 Skill

使用 `Edit` 工具修改 Skill 檔案，針對每個問題逐一修正。

修改原則：
- **最小修改**：只改有問題的部分，不重寫整份 Skill
- **保留原有結構**：不改變步驟編號和章節順序（除非新增章節）
- **加註修改原因**：在改動處附近加一行註解說明為什麼改

### 步驟 M5：部署修改後的 Skill

→ 跳到「儲存與部署」章節

---

## 儲存與部署

先找到 MCP Server 專案目錄（只需找一次）：
```
Glob pattern="**/Skills/commands/_skill_template.md"
→ 從結果路徑推算出 MCP Server 根目錄，記為 {MCP_ROOT}
```

### 外部指令

**方式 A（新增，優先）— MCP 工具 `save_claude_skill`：**

注意：`save_claude_skill` 的 `content` 參數會**覆蓋**整個檔案。
- 新增模式：傳入完整 MD 內容，並帶上 `dept_folder`（例如 `php_dev`、`testing`、`deploy`），確保存到正確部門子資料夾
- 改進模式：**不要用 save_claude_skill**，改用方式 B

**方式 B（改進模式 / Fallback）— Claude Code 內建工具：**

```
新增：Write {MCP_ROOT}/Skills/commands/{dept_folder}/[name].md
改進：Edit {MCP_ROOT}/Skills/commands/{dept_folder}/[name].md（局部修改）
部署：cp "{MCP_ROOT}/Skills/commands/{dept_folder}/[name].md" "$HOME/.claude/commands/[name].md"
（注意：Skills/commands/ 有子資料夾分類；~/.claude/commands/ 是 flat，無子資料夾）
```

### 內部指令

內部指令**不使用 `save_claude_skill`**（該工具不處理 `_internal` 後綴的特殊部署邏輯）。

```
新增：Write {MCP_ROOT}/Skills/commands/{dept_folder}/[name]_internal.md
改進：Edit {MCP_ROOT}/Skills/commands/{dept_folder}/[name]_internal.md（局部修改）
部署：cp "{MCP_ROOT}/Skills/commands/{dept_folder}/[name]_internal.md" "$HOME/.claude/commands/[name]_internal.md"
```

> 內部指令的 `.md` 檔已被 `.gitignore` 排除（`*_internal*`），不會進版控。

---

## 更新 dashboard.html

找到 `{MCP_ROOT}/docs/dashboard.html` 並讀取，在 Agent Skills 區塊中找出最適合的部門列（`dept-row`）：

**歸類規則：**

| 技能類型 | 對應部門 |
|---------|---------|
| PHP 開發、CRUD、升級 | PHP 開發部 |
| .NET、程式翻譯、移植 | 程式移植部 |
| 測試、品管、整合測試、UI 測試 | 測試品管部 |
| 規格書、文件比對、分析 | 規格分析部 |
| 書籤、工具管理、技能管理、學習 | 工具管理部 |
| Git、Docker、開發流程 | 開發流程部 |
| 文章擷取、影片、內容 | 內容擷取部 |
| 全新類型（不符合以上） | 新增一個 `dept-row` |

**新增模式（外部）**：加入新 tag + 更新計數。
**新增模式（內部）**：`_internal` Skill **不加入** dashboard tag，也不更新計數。
**改進模式**：Skill 已存在於 dashboard，不需更新（除非改了名稱）。
**合併模式**：移除被合併 Skill 的 tag，對應 `dept-count` 和總數各 -1。同時刪除被合併的 Skill 檔案和部署檔。

更新內容：
1. 在目標 `dept-row` 的 `.dept-tags` 中末尾加入 `<span class="tag">/[name]</span>`
2. 該 `dept-row` 的 `.dept-count` +1
3. `section-total` 的 skills 總數 +1
4. 頁首統計列的 Skills 數字與總數 +1

---

## 確認完成

**新增模式（外部）**：
```
✅ 技能 /[name] 已建立並部署
📁 Skills/commands/[name].md
📦 已部署至 ~/.claude/commands/
📊 dashboard.html 已歸類至 [部門名稱]
⚠️  請重啟 Claude Code 讓新指令生效
```

**新增模式（內部）**：
```
✅ 技能 /[name]_internal 已建立並部署（內部指令）
📁 Skills/commands/[name]_internal.md（不進版控）
📦 已部署至 ~/.claude/commands/
⚠️  請重啟 Claude Code 讓新指令生效
```

**合併模式**：
```
✅ 技能已合併
📁 /[target_name] ← 已整合 /[merged_name] 的功能
🗑️ /[merged_name] 已刪除（Skills/commands/ + ~/.claude/commands/）
📊 dashboard.html 已更新計數
⚠️  請重啟 Claude Code 讓修改生效
```

**改進模式**：
```
✅ 技能 /[name] 已改進並重新部署
📁 Skills/commands/[name].md（已修改）
📦 已部署至 ~/.claude/commands/

📝 本次修改摘要：
  - [修改 1 的一句話描述]
  - [修改 2 的一句話描述]

⚠️  請重啟 Claude Code 讓修改生效
```

---

## 注意事項

- 內部私用技能命名加 `_internal` 後綴
- 改進模式下用 `Edit` 做局部修改，不要用 `save_claude_skill` 覆蓋整個檔案
- 若使用者指定技能名稱，優先使用使用者給的名稱
- 改進前務必先讀取現有 Skill 全文，理解完整結構再動手
- 改進後立即部署到 `~/.claude/commands/`，不需等使用者手動部署
