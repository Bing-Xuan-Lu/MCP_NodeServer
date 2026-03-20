---
name: reference_playwright_config
description: Playwright MCP 啟動參數與 session 保持設定
type: reference
---

## Playwright MCP 設定

各專案的 `.mcp.json` 中 Playwright 設定建議加上 `--user-data-dir`，讓 PHP session cookie 跨對話保留：

```json
"playwright": {
  "type": "stdio",
  "command": "npx",
  "args": ["@playwright/mcp@latest", "--user-data-dir", "D:\\tmp\\playwright-profile"]
}
```

- 不加 `--user-data-dir` → 每次全新 browser，登入 session 必丟，只能靠 PHP 端寫死測試 session
- 加了之後 → 登入一次即保持，不需 bypass
- 清除登入狀態：刪除 `D:\tmp\playwright-profile` 資料夾
- 多專案若需隔離 session，可用不同資料夾名稱（如 `playwright-profile-erp`）
