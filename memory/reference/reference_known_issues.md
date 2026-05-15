---
name: reference_known_issues
description: 開發過程中遇到的已知問題與解法速查表
metadata: 
  node_type: memory
  type: reference
  originSessionId: 011384ce-5c99-4fae-b41c-b079764f0f65
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

### Agent SendMessage 文件誤導（2026-05-15）

**症狀：** Agent 工具描述提示「SendMessage with agent's ID 可續派既有 background agent」，但本環境 deferred tools 沒有 SendMessage
**根因：** Claude Code 對 SendMessage 的可用性依環境/權限不同；harness 沒有對應上文件
**解法：** 不要依賴 SendMessage 續派 — 視為「無法續派」，agent 任務一次性派遣完整 prompt，做不完就接受重新派遣的成本；不要在 Skill 文件假設 SendMessage 存在

### Prompt Guard 誤擋 background agent（已修，2026-05-15）

**症狀：** 兩個獨立 background agent 收到完整 prompt 卻被 write-guard / repetition-detector 以「Prompt Guard 偵測到任務描述不完整」擋下
**根因：** Prompt Guard state（promptGuardActive）跨 sub-agent 共用，但 sub-agent 自帶完整任務 prompt 不該受主對話 guard 影響
**解法：** 已在 [hooks/write-guard.js](../../../../../d:/MCP_Server/hooks/write-guard.js)、[hooks/repetition-detector.js](../../../../../d:/MCP_Server/hooks/repetition-detector.js) 對 `parent_tool_use_id` 存在的 entry 跳過 promptGuardActive 阻擋。BLOCK 訊息也會附判斷依據
