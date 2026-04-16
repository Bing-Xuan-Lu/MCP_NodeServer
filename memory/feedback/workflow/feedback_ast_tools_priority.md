---
name: PHP 函式查詢必須優先用 AST 工具
description: 搜尋 PHP class/method 時禁止 Grep 散搜，必須用 find_usages / class_method_lookup / trace_logic
type: feedback
---

搜尋 PHP 函式、方法、class 定義時，必須優先使用 MCP AST 工具，禁止用 Grep 逐檔掃描。

**Why:** 兩個專案 session 都習慣性用 Grep→Read 追蹤函式呼叫鏈，浪費大量 tool call。find_usages 一次定位、class_method_lookup 一次取得原始碼、trace_logic 直接展開控制流，都比 Grep+Read 高效得多。

**How to apply:**
- 找「誰呼叫了這個 method」→ `find_usages`
- 取得 method 原始碼 → `class_method_lookup`
- 追蹤邏輯分支（if/switch 走哪條路）→ `trace_logic`
- 找繼承關係 → `find_hierarchy`
- **切換到新模組/新主題時**，強制先用 AST 工具定位，不要直接 Grep 開掃
- Grep 只用於搜尋變數名、字串常數等純文字定位
- Hook `grep_php_symbol`（L2.4）會在 2+ 次跨路徑 PHP symbol Grep 時強制警告
