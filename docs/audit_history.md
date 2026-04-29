# Harness Audit 歷史記錄

每次執行 `/harness_audit` 後，將分數追加至此。

> 2026-03-30 前為 7 維度（/70），之後為 8 維度（/80，新增「工具健康度」）

| 日期 | 工具覆蓋 | Context效率 | 品質閘道 | 記憶持久性 | Eval覆蓋 | 安全防護 | 成本效率 | 工具健康度 | 總分 |
|------|---------|------------|---------|-----------|---------|---------|---------|----------|------|
| 2026-03-23 | 9 | 8 | 9 | 8 | 8 | 9 | 7 | - | 58/70 |
| 2026-03-25 | 9 | 8 | 9 | 9 | 9 | 9 | 7 | - | 60/70 |
| 2026-03-30 | 9 | 8 | 8 | 9 | 8 | 9 | 7 | - | 58/70 |
| 2026-04-30 | 9 | 8 | 9 | 9 | 8 | 9 | 6 | 3 | 61/80 |

## 備註

### 2026-04-30

- 100 個 MCP 工具零載入錯誤、零 DEAD_TOOL，9 個 hook 全部健在
- 工具健康度大扣分：4 POOR_DESC + 4 NO_PROPS + Skill 部署落差 27 個 + matchTier 重複
- 成本效率扣分：Skill 來源 41 個但 ~/.claude/commands/ 僅部署 14 個（嚴重落差）
- 改進行動：重跑 deploy-commands.bat；補齊 inputSchema 與 description；拆分 playwright_tools.js (1730 行)

### 2026-03-30

- 品質閘道/成本效率扣分：repetition-detector.js 已設定於 settings.json 但 ~/.claude/hooks/ 中缺失（BROKEN hook）
- 成本效率：php_crud_generator_internal.md 459 行過長
- 改進行動：補建 repetition-detector.js；精簡 php_crud_generator_internal.md；CLAUDE.md hooks 補 session-stop.js

### 2026-03-23

- 61 個 MCP 工具，14 模組，涵蓋完整 PHP 開發工作流
- 成本效率扣分：session 記錄 Bash×26 / ToolSearch×5 / Edit×9 重試（project_qc.md B0 卡迴圈）
- 改進行動：project_qc.md 加入重試保護規則；新增架構決策 memory；建立此歷史檔
