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
- **`localhost` 不可帶 port**（`localhost:8084` ✗ → `localhost` ✓），port 是專案特定的
- 公開 Skill 路徑必須參數化（絕對路徑會因機器不同而失效，改用 Glob 搜尋或相對路徑）
- 從其他專案新增 Skill 後，必須掃一遍確認無洩漏
- `_internal` Skill 可自由寫入客戶真實資訊

---

## dashboard.html 統計機制

- 統計數字（Skills 總數、Departments 數）由 JS 動態從 `SKILLS` 物件計算
- 不需手動維護任何計數欄位，只要確保 SKILLS 物件條目正確即可

---

## MCP 工具變更後的文件同步（必做）

新增/修改 `tools/*.js` 後，必須同步更新：

1. **CLAUDE.md** — `tools/` 目錄結構中的工具名稱列表
2. **README.md** — 工具總覽區段（含數量、表格）
3. **dashboard.html** — MCP Tools 區段 tag + JS SKILLS 物件的 `tools` 陣列

**Why:** 曾多次遺漏，導致 dashboard 與實際工具不一致。

---

## Skill 內子 Agent 防衝突

Skill 派多個子 Agent 並行時：

- **任務分割不重疊**：每個子 Agent 明確指定負責的模組/檔案，不可有交集
- **共用檔案延後處理**：多模組共用的檔案（選單、設定檔、路由）等全部完成後由主流程統一修改
- **讀寫分離**：分析類任務（read-only）可並行；修改類任務（write）需序列或確保操作不同檔案

---

## MCP Server 故障處理

MCP 伺服器未啟動或啟動失敗時，**不要自行啟動**，告知使用者原因由其決定。

**Why:** 避免擅自啟動服務造成環境衝突。
