---
name: project_mcp_server
description: MCP_NodeServer 專案基本資訊、路徑設定與 Memory 同步機制
type: project
---

MCP Server 名稱：`project-migration-assistant-pro` v5.1.0
basePath（MCP 工具限制）：由 `config.local.js` 的 `basePaths[0]` 決定（預設 `D:\Project\`）

**Why:** basePath 是 MCP 工具的安全邊界，誤用會導致路徑錯誤。複製 `config.example.js` 為 `config.local.js` 可自訂路徑。

**How to apply:** 使用 MCP 檔案工具時，路徑從 `basePaths[0]` 下的相對路徑開始。

---

## 重要路徑

> `{MCP_ROOT}` = MCP Server 實際安裝路徑（各人不同，clone 後自行對應）

| 項目 | 路徑 |
|------|------|
| MCP Server | `{MCP_ROOT}\` |
| Skills 存放 | `{MCP_ROOT}\Skills\commands\`（有子資料夾分類）|
| Skills 部署 | `~/.claude/commands\`（flat，無子資料夾）|
| Dashboard | `{MCP_ROOT}\dashboard\index.html` |
| Memory（版控）| `{MCP_ROOT}\memory\` |
| Memory（機敏）| `{MCP_ROOT}\memory\_private\`（.gitignore）|
| 本機路徑設定 | `{MCP_ROOT}\config.local.js`（.gitignore，不進版控）|

---

## Memory 同步機制（雙向）

- **SessionStart**：`project/memory/` → `~/.claude/projects/.../memory/`（另一台電腦 pull 後自動同步）
- **Stop**：`~/.claude/projects/.../memory/` → `project/memory/`（session 結束後存回版控）
- 新增機敏記憶時，寫到 `memory/_private/`（不進 git）
