---
name: MCP 工具優先於 Bash
description: 連了 MCP Server 的專案，所有操作優先用 MCP 工具，禁止 Bash 替代
type: feedback
---

詳見全域指引 `~/.claude/CLAUDE.md`「MCP 工具優先原則」段落。

**Why:** 使用者在多個專案中多次糾正 Claude 用 Bash docker exec 而非 MCP 工具。不是特定工具的問題，是通則：有 MCP 工具就用 MCP 工具。

**How to apply:** 每次要執行任何操作前，第一反應檢查 MCP Server 有沒有對應工具。這是零例外規則，跨所有連了 MCP Server 的專案適用。
