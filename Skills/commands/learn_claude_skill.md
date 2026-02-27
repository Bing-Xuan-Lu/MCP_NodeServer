# /learn_claude_skill — 從對話學習並建立新 Claude 技能

你是能從對話中提取可重用模式的 AI 助理。
當使用者說「/learn_claude_skill」或「把這個存成技能」時，請執行以下完整流程。

---

## 流程

### 步驟 1：分析目前對話

回顧本次對話，找出最具重用價值的任務或模式，判斷標準：

- **重複性**：這個任務將來可能再次執行
- **可模板化**：流程固定，只有輸入資料會變
- **獨立性**：能在不同專案或場景使用

若有多個候選模式，列出並詢問使用者選擇哪個。
若使用者呼叫 `/learn_claude_skill [描述]`，直接以描述為主題，跳過詢問。

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

### 步驟 3：儲存技能

確認 MD 內容後，優先使用 MCP 工具，失敗時自動 fallback 到內建工具：

**方式 A（優先）— 使用 MCP 工具 `save_claude_skill`：**

- `name`：技能名稱（英文小寫加底線，例如 `api_error_handler`）
- `content`：步驟 2 生成的 Markdown 內容
- `description`：一句話中文說明

**方式 B（Fallback）— MCP 不可用時，改用 Claude Code 內建工具：**

1. 使用 `Write` 工具將 MD 內容寫入：
   `d:\Develop\MCP_NodeServer\Skills\commands\[name].md`

2. 使用 `Bash` 工具複製到部署目錄：

   ```bash
   cp "d:/Develop/MCP_NodeServer/Skills/commands/[name].md" \
      "$HOME/.claude/commands/[name].md"
   ```

儲存成功後繼續更新相關文件。

### 步驟 4：更新 CLAUDE.md

讀取 `d:\Develop\MCP_NodeServer\CLAUDE.md`，找到「可用 Skills（斜線指令）」表格，
在表格末尾新增一列：

```
| `/[name]` | [技能說明] | 公開 |
```

若為 `_internal` 結尾的技能，備註欄改為「私有，git-ignored」。

### 步驟 5：更新 docs/dashboard.html

讀取 `d:\Develop\MCP_NodeServer\docs\dashboard.html`，在 Agent Skills 區塊中找出最適合的部門列（`dept-row`）：

**判斷歸類規則：**

| 技能類型 | 對應部門 |
| ------- | ------- |
| PHP 開發、CRUD、升級 | `PHP 開發部` |
| .NET、程式翻譯、移植 | `程式移植部` |
| 測試、品管、整合測試、UI 測試 | `測試品管部` |
| 規格書、文件比對、分析 | `規格分析部` |
| 書籤、工具管理、技能管理、學習 | `工具管理部` |
| 全新類型（不符合以上） | 新增一個 `dept-row` |

**更新內容：**

1. 在目標 `dept-row` 的 `.dept-tags` 中，末尾加入：

   ```html
   <span class="tag">/[name]</span>
   ```

2. 將該 `dept-row` 的 `.dept-count` 數字 +1

3. 更新 `section-total` 中的 skills 總數（例如 `8 skills` → `9 skills`）

4. 更新頁首統計列（約 248 行）中的 Skills 數字與總數：

   ```html
   <strong>[新總數]</strong> &nbsp;個能力已建立 &nbsp;·&nbsp; [新Skills數] Skills &nbsp;+&nbsp; 15 MCP Tools
   ```

若新技能屬於全新部門，在 Skills 區塊末尾新增 `dept-row`，並同時更新 `section-total` 的 departments 數。

### 步驟 6：確認完成

告知使用者以下資訊：

```text
✅ 技能 /[name] 已建立並部署
📁 Skills/commands/[name].md
📦 已部署至 ~/.claude/commands/
📝 CLAUDE.md Skills 表格已更新
📊 dashboard.html 已歸類至 [部門名稱]
⚠️  請重啟 Claude Code 讓新指令生效
```

---

## 注意事項

- 內部私用技能（不想推 Git）命名加 `_internal` 後綴，`dashboard.html` 中同樣加入但標記 `[內部]`
- 若使用者指定技能名稱，優先使用使用者給的名稱
- `CLAUDE.md` 與 `dashboard.html` 更新完成後，使用者可自行 commit push
