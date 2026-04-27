# /memory_audit — 審計與整理 Claude 記憶系統

你負責審計當前專案的 Claude 記憶系統（`~/.claude/projects/{encoded}/memory/`），找出品質問題並執行清理。

---

## 觸發時機

- 記憶檔案超過 30 個
- 使用者覺得記憶混亂或重複
- 定期維護（建議每 2-4 週執行一次）
- `/retro` 時順便觸發

---

## 執行流程

### Step 0：定位記憶目錄

```
記憶路徑：~/.claude/projects/{encoded}/memory/
{encoded} = 專案路徑編碼（小寫磁碟代號 + -- 分隔）
```

用 Glob 列出所有 `*.md` 檔案，統計總數。

### Step 1：健康檢查（產出診斷報告）

依序執行以下 5 項檢查：

#### 1-A：死連結（MEMORY.md 引用但檔案不存在）

```
讀取 MEMORY.md，提取所有 (xxx.md) 連結
逐一檢查檔案是否存在
不存在 → 標記為 DEAD_LINK
```

#### 1-B：孤兒檔案（檔案存在但 MEMORY.md 未索引）

```
對每個 *.md（排除 MEMORY.md 自身）：
  grep -q 該檔名 MEMORY.md
  未找到 → 標記為 ORPHAN
```

#### 1-C：重複/重疊偵測

按主題分群，找出可合併的候選：

```
規則：
- 同一主題（playwright/xd/screenshot/spec/sprint 等）有 3+ 個檔案 → 建議合併
- 兩個檔案的 description 相似度高（關鍵字重疊 > 50%）→ 標記為疑似重複
```

手動方式（不依賴語意搜尋）：
1. 按檔名前綴分組（`feedback_playwright_*`、`feedback_xd_*`...）
2. 同前綴超過 2 個 → 讀取各檔的 description 欄位比對

#### 1-D：過時記憶偵測

```
對每個 project 類型的記憶：
  讀取內容，檢查：
  - 包含「已完成」「✅」且無「待做」「進行中」→ 標記為 STALE（純歷史記錄）
  - 日期超過 30 天且未被近期對話引用 → 標記為 POSSIBLY_STALE
```

#### 1-E：MEMORY.md 肥大度

```
統計 MEMORY.md 行數
> 100 行 → 警告「索引過長，建議精簡」
> 150 行 → 嚴重「接近 200 行截斷線」
```

### Step 2：產出診斷報告

格式：

```
=== Memory Audit Report ===
專案：{project_name}
路徑：{memory_path}
總檔案數：{N}
MEMORY.md 行數：{M}

[🔴 死連結] {count} 個
  - {filename} ← MEMORY.md L{line} 引用

[🟡 孤兒檔案] {count} 個
  - {filename} — {description}

[🔵 可合併] {count} 組
  - 主題「{topic}」: {file1}, {file2}, {file3}
    → 建議合併為 {merged_name}

[⚪ 疑似過時] {count} 個
  - {filename} — {reason}

健康評分：{score}/100
  - 死連結 0 個 → +25
  - 孤兒 0 個 → +25
  - 無可合併組 → +25
  - MEMORY.md < 100 行 → +25
```

### Step 3：等待使用者確認

**不要自動執行清理。** 列出建議動作清單，等使用者選擇：

```
建議動作：
  [A] 移除死連結（從 MEMORY.md 刪除 {count} 行）
  [B] 索引孤兒檔案（加入 MEMORY.md）
  [C] 合併重複檔案（{count} 組 → {count} 個合併檔）
  [D] 刪除過時記憶（{count} 個）
  [E] 全部執行（A+B+C+D）

要執行哪些？（輸入代號，如 ACE）
```

### Step 4：執行清理

根據使用者選擇執行：

#### [A] 移除死連結
從 MEMORY.md 中刪除引用不存在檔案的行。

#### [B] 索引孤兒
讀取每個孤兒檔案的 frontmatter（name/description/type），加入 MEMORY.md 對應分類區段。

#### [C] 合併重複
對每一組可合併的檔案：
1. 讀取所有候選檔案的完整內容
2. 按主題合併為一個檔案，保留所有獨特規則（去除重複描述）
3. 新檔命名：`{type}_{topic}.md`（如 `feedback_playwright.md`）
4. 刪除舊的個別檔案
5. 更新 MEMORY.md 索引

**合併原則：**
- 每個獨立規則保留為一個 `##` 子標題
- Why/How to apply 保留在各規則下
- 程式碼片段保留（可能是關鍵 reference）
- 去除重複的開場白/背景描述

#### [D] 刪除過時
刪除檔案並從 MEMORY.md 移除引用。

### Step 5：完成報告並存檔

將完成報告存到記憶目錄，供下次對話追蹤變化：

```
檔案：{memory_path}/reports/audit_{YYYY-MM-DD}.md
```

報告內容：

```
=== Memory Audit Complete ===
日期：{YYYY-MM-DD}
清理前：{N_before} 檔 / MEMORY.md {M_before} 行
清理後：{N_after} 檔 / MEMORY.md {M_after} 行

執行動作：
  [A] 移除死連結：{count} 個
  [B] 索引孤兒：{count} 個
  [C] 合併檔案：{merged_count} 組（{old_count} → {new_count}）
  [D] 刪除過時：{count} 個

健康評分：{score_before} → {score_after}
```

`reports/` 目錄下的檔案不納入 MEMORY.md 索引，僅作歷史紀錄。只保留最近 3 份報告，舊的自動刪除。

---

## 快速用法

```
/memory_audit              ← 完整審計（預設）
/memory_audit status       ← 只看診斷報告，不執行清理
/memory_audit quick        ← 只做 A+B（死連結+孤兒），跳過合併分析
```

---

## 合併策略參考

以下是常見的主題分群（適用於大多數專案）：

| 前綴模式 | 合併目標 |
|----------|---------|
| `feedback_playwright_*` | `feedback_playwright.md` |
| `feedback_xd_*` / `feedback_design_*` | `feedback_xd_design.md` |
| `feedback_screenshot_*` | `feedback_screenshots.md` |
| `feedback_spec_*` | `feedback_spec_reading.md` |
| `feedback_sprint_*` | `feedback_sprint_verification.md` |
| `feedback_css_*` / `feedback_style_*` | `feedback_css.md` |
| `feedback_deploy_*` / `feedback_sftp_*` | `feedback_deploy.md` |
| `project_sprint*_progress` | 保留最新一個，舊的歸檔或刪除 |

專案特定的主題由 Step 1-C 動態偵測，不限於此表。

---

## Step 6（可選）：角色整合建議

> **前置條件**：檢查 `D:\Project\_coordination\{project}\` 是否存在 `_config.json`。不存在 → 跳過整個 Step 6。

如果專案使用 `agent_coord`（多 Agent 協作，`_coordination/{project}/_config.json`），審計時額外檢查：

### 6-A：高頻 feedback → 角色 rules 候選

識別**每次任務都會用到**的 feedback 記憶，建議嵌入角色定義（`_config.json` 的 `rules` 陣列）：

```
判斷標準：
- 該規則是角色的「核心行為」而非特殊情境（如 QA 必須比對 XD → 核心行為）
- 忘記這條規則會導致明顯的品質問題
- 規則可以用 1-2 句話表達（太長的留在記憶檔）
```

候選格式：
```
建議併入角色 rules 的記憶：
  - feedback_xxx.md 的「某段規則」→ 建議加入 {agent_id} rules
  - 理由：{為什麼每次都要用}
```

### 6-B：_config.json 資料過時

檢查 `_config.json` 中的：
- `knowledge_base.reports.files` — 引用的報告是否還存在
- `tasks` — 任務清單是否與 `resume_prompt.md` 一致
- `modules` — 模組路徑是否反映當前架構

過時項目列入報告，由使用者決定是否更新。

---

## 注意

- **永遠先產報告、等確認再動手**，不可自動清理
- 合併時保留所有獨特規則，不可丟失任何 feedback 內容
- `reference_*` 類檔案通常不合併（各自獨立用途）
- `_private/` 目錄下的檔案不審計
- 清理完成後建議執行 `/claude_sync push memory` 同步回 Git
- Step 6 角色整合只在使用者同意後才修改 `_config.json`
