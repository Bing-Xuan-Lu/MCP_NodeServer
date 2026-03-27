---
name: project_mcp_server
description: MCP_NodeServer 專案基本資訊、路徑設定與 Memory 同步機制
type: project
---

MCP Server 名稱：`project-migration-assistant-pro` v5.1.0
basePath（MCP 工具限制）：`D:\Project\`（路徑相對此目錄，不加磁碟路徑）

**Why:** basePath 是 MCP 工具的安全邊界，誤用會導致路徑錯誤。

**How to apply:** 使用 MCP 檔案工具時，路徑從 `D:\Project\` 下的相對路徑開始。

---

## 重要路徑

| 項目 | 路徑 |
|------|------|
| MCP Server | `d:\MCP_Server\` |
| Skills 存放 | `d:\MCP_Server\Skills\commands\`（有子資料夾分類） |
| Skills 部署 | `~/.claude/commands\`（flat，無子資料夾） |
| Dashboard | `d:\MCP_Server\dashboard\index.html`（JS 資料：`dashboard\js\data-skills.js`） |
| Memory（版控）| `d:\MCP_Server\memory\` |
| Memory（機敏） | `d:\MCP_Server\memory\_private\`（.gitignore） |
| Docker 開發 | `D:\Project\Docker_Dev\`（docker-compose 環境） |

---

## Memory 同步機制（雙向）

- **SessionStart**：`project/memory/` → `~/.claude/projects/.../memory/`（另一台電腦 pull 後自動同步）
- **Stop**：`~/.claude/projects/.../memory/` → `project/memory/`（session 結束後存回版控）
- 新增機敏記憶時，寫到 `memory/_private/`（不進 git）
