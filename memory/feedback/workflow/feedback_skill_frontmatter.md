---
name: Skill frontmatter 精簡規範
description: 新建 Skill 時 frontmatter 的 token 節省規則：何時加、何時不加、description 怎麼寫
type: feedback
---

Skill 的 YAML frontmatter（name + description）決定是否出現在 system-reminder skill 清單。有 frontmatter = 每輪對話都吃 token；沒有 = 仍可 `/name` 呼叫但 Claude 不主動建議。

## 規則

### 不加 frontmatter（冷）
- 使用者一定會手動打 `/name` 的 skill（如 `/retro`、`/git_commit`、`/memory_sync`）
- 純參考檔 / template（如 `field_types`、`upgrade_rules`、`report_template`）
- Agent prompt（如 `logic_agent`、`uiux_agent`）
- `_internal/` 全部冷儲存，不部署到 `~/.claude/commands/`
- `_cold/` 全部冷儲存

### 加 frontmatter（熱）
- 需要 Claude 從自然語言判斷並主動建議的 skill（如使用者說「查詢很慢」→ 建議 `/db_index_analyzer`）

### description 寫法
- **只寫觸發詞，一行搞定**，不寫功能說明
- 格式：`description: "觸發詞1、觸發詞2、觸發詞3"`
- 禁止用 `description: |` 多行格式
- 禁止寫「涵蓋：」「當使用者說」等說明文字

**Why:** 52 個 skill 的 description 原本吃 ~5,000 tokens/輪。精簡後 19 個熱 skill 只吃 ~2,000 tokens/輪，省 60%。每 10 輪對話省 30K tokens。

**How to apply:** 新建 skill 時先問「使用者會不會用自然語言觸發？」→ 會：加 1 行 frontmatter；不會：不加。
