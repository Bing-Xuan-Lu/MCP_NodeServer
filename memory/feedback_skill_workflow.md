---
name: feedback_skill_workflow
description: Skill 建立、修改與部署的行為規範，以及 dashboard 更新規則
type: feedback
---

新增或修改 `Skills/commands/*.md` 前必須先讀取範本：
`d:\Develop\MCP_NodeServer\Skills\commands\_skill_template.md`

**Why:** 過去有過格式不一致、章節遺漏的問題，範本確保一致性。

**How to apply:** 每次動 Skill 檔案前的第一步，不跳過。

---

## Skill 完成後必做清單

1. 部署：`cp Skills/commands/subfolder/skill.md ~/.claude/commands/skill.md`
2. 更新 `docs/dashboard.html`：
   - 對應部門加入 tag
   - 更新 JS `SKILLS` 物件（click-to-detail 資料）
3. 若新增 MCP Tool：更新 `CLAUDE.md` 工具清單

不需要修改 `CLAUDE.md` 的 Skill 列表。

---

## 重要行為規則

- `_internal` Skill 放 `Skills/commands/_internal/`，不部署、不列 dashboard、不進版控
- 所有公開 Skill MD 必須放在對應部門子資料夾（`_skill_template.md` 例外）
- 公開 Skill 上限 60 個；超過前用 `/skill_audit` 審查合併
- 公開 Skill MD 禁止寫入客戶真實資訊，一律使用 `{ProjectFolder}`、`module_a` 等佔位符
- `_internal` Skill 可自由寫入客戶真實資訊

---

## dashboard.html 統計機制

- 統計數字（Skills 總數、Departments 數）由 JS 動態從 `SKILLS` 物件計算
- 不需手動維護任何計數欄位，只要確保 SKILLS 物件條目正確即可
