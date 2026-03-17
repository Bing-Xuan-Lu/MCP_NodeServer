---
name: feedback_workflow_rules
description: MCP Server 專案的工作規則：Skill 流程、工具變更同步、故障處理
type: feedback
---

## Skill 新增/修改流程

新增或修改 `Skills/commands/*.md` 前必須先讀取範本：`Skills/commands/_skill_template.md`

**Why:** 過去有過格式不一致、章節遺漏的問題。

**完成後必做：**
1. 部署：`cp Skills/commands/subfolder/skill.md ~/.claude/commands/skill.md`
2. 更新 `docs/dashboard.html`：對應部門加入 tag + JS `SKILLS` 物件新增條目
3. 若新增 MCP Tool：另需更新 CLAUDE.md + README.md（見下方）

不需要修改 CLAUDE.md 的 Skill 列表。

---

## Skill 行為規則

- `_internal` Skill 放 `Skills/commands/_internal/`，不部署、不列 dashboard、不進版控
- 所有公開 Skill MD 必須放在對應部門子資料夾（`_skill_template.md` 例外）
- 公開 Skill 上限 60 個；超過前用 `/skill_audit` 審查合併
- 公開 Skill MD 禁止寫入客戶真實資訊，一律使用 `{ProjectFolder}`、`module_a` 等佔位符
- **`localhost` 不可帶 port**（`localhost:8084` ✗ → `localhost` ✓），port 是專案特定的
- **從其他專案新增外部 Skill 時**：完成後必須掃一遍確認無洩漏
- `_internal` Skill 可自由寫入客戶真實資訊

---

## dashboard.html 統計機制

統計數字（Skills 總數、Departments 數）由 JS 動態從 `SKILLS` 物件計算，不需手動維護計數欄位。

---

## MCP 工具變更後的文件同步（必做）

新增/修改 `tools/*.js` 後，必須同步更新：
1. **CLAUDE.md** — `tools/` 目錄結構中的工具名稱列表
2. **README.md** — 工具總覽區段（含數量、表格）
3. **dashboard.html** — MCP Tools 區段 tag + JS SKILLS 物件的 `tools` 陣列

**Why:** 曾多次遺漏，導致 dashboard 與實際工具不一致。

---

## MCP Server 故障處理

若 MCP 伺服器未啟動或啟動失敗，**不要讓 Claude 自行運行 MCP Server**。告知使用者問題原因，由使用者決定處理方式。

**Why:** 避免擅自啟動服務造成環境衝突。
