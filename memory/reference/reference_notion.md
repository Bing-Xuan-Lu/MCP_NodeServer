---
name: Notion MCP 整合
description: Notion MCP 設定方式、限制與筆記目標頁面設定
type: reference
---

## 設定

Notion MCP (`@notionhq/notion-mcp-server`) 已串接，設定在 `d:\Develop\MCP_NodeServer\.mcp.json`。
範例設定見 `d:\Develop\MCP_NodeServer\.mcp.json.example`（Token 用 `YOUR_TOKEN` 佔位）。

## 使用規則

- 筆記目標頁面：由使用者指定（例如「AI幫我寫筆記」），存為 `{NotionTargetPage}`，每次確認
- 搜尋頁面用 `API-post-search`，建立子頁面需先拿到 `parent.page_id`

## 已知限制

**Internal Integration 不能在 workspace 根層建頁面**
- 症狀：`post-page` 傳 `{"type": "workspace", "workspace": true}` 回傳 validation_error
- 解法：先 `API-post-search` 找到目標頁面的 page_id，改用 `{"type": "page_id", "page_id": "..."}` 當 parent
