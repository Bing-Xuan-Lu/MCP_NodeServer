---
name: reference_known_issues
description: 開發過程中遇到的已知問題與解法速查表
type: reference
---

## 已知問題速查

### Playwright MCP session 不保持

**症狀：** 每次 `browser_navigate` 登入後台都要重新登入，或必須在 PHP config 寫死測試 session
**根因：** Playwright MCP 預設不帶 `--user-data-dir`，每次啟動都是全新 browser context
**解法：** `.mcp.json` 加 `--user-data-dir` 參數（詳見 `reference_playwright_config.md`）

### MCP 工具引用名稱過時

**症狀：** 內部 Skill 引用的工具名稱不存在，執行時找不到工具
**根因：** 公開 Skill/Tool 更新後，內部 Skill 未同步更新引用
**解法：** 定期執行 `/internal_skill_manager_internal` 步驟 2 做依賴分析

### 公開 Skill 洩漏專案資訊

**症狀：** git push 後才發現 Skill MD 中有專案 URL、port、資料表名
**根因：** 從其他專案工作時新增 Skill，腦中全是該專案的資訊
**解法：** 完成後執行 Grep 掃描，全域 CLAUDE.md 已有佔位符規範
