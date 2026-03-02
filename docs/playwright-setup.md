# Playwright MCP 安裝與設定指南

Playwright MCP 讓 Claude Code 能操作瀏覽器，用於 UI 測試、網頁截圖、自動化登入等場景。

---

## 1. 安裝套件

```bash
npm install -g @playwright/mcp@latest
```

> 套件名稱是 `@playwright/mcp`，不是 `@anthropic-ai/playwright-mcp`（後者不存在）。

## 2. 安裝瀏覽器

```bash
npx playwright install chromium
```

Playwright 需要下載專用的 Chromium 瀏覽器（約 170MB），存放於：

```
C:\Users\<使用者>\AppData\Local\ms-playwright\chromium-xxxx
```

## 3. 設定 .mcp.json

在專案根目錄的 `.mcp.json` 中，將 `playwright` 加入 `mcpServers` **內部**：

```json
{
  "mcpServers": {
    "project-migration-assistant-pro": {
      "type": "stdio",
      "command": "node",
      "args": ["D:\\MCP_Server\\index.js"]
    },
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

### 常見設定錯誤

| 錯誤 | 說明 |
|------|------|
| `playwright` 放在 `mcpServers` 外面 | Claude Code 讀不到，必須放在 `mcpServers` 物件內 |
| 使用 `--headed` 參數 | 新版已移除此參數，預設就是 headed（可見瀏覽器視窗） |
| 套件名寫錯 | 正確：`@playwright/mcp`，不是 `@anthropic-ai/playwright-mcp` |

### 可用參數

| 參數 | 說明 |
|------|------|
| `--headless` | 無頭模式（不開瀏覽器視窗） |
| `--allowed-origins` | 限制允許存取的網域（分號分隔） |
| `--user-data-dir <path>` | 指定 Chrome profile 路徑（可重用已登入的 session） |

## 4. 重啟 Claude Code

修改 `.mcp.json` 後需重啟 Claude Code 才會載入新的 MCP Server。

驗證方式：在 Claude Code 輸入 `/mcp`，確認 `playwright` 狀態為 `running`。

若顯示 `failed`，執行 `/mcp` → restart playwright 重試。

## 5. 驗證碼登入流程

Playwright 預設開啟可見的瀏覽器視窗（headed 模式），遇到驗證碼時有兩種處理方式：

### 方式 A：Claude 辨識驗證碼（自動）

1. Claude 截圖驗證碼圖片
2. 辨識文字並自動填入
3. 適用於簡單的數字/英文驗證碼

### 方式 B：人工介入

1. 在開啟的瀏覽器視窗中手動輸入驗證碼
2. 點擊登入
3. 登入成功後告知 Claude，由 Claude 接手後續自動化操作

### 方式 C：跳過登入頁

若登入頁有跳轉問題，可直接導航到登入後的頁面（前提是 session 已存在）：

```
直接告訴 Claude：「進入 http://xxx/welcome.php」
```

## 6. 疑難排解

### Playwright MCP 連線失敗

```
Failed to reconnect to playwright
```

**排查步驟：**

```bash
# 1. 確認套件可執行
npx @playwright/mcp@latest --version

# 2. 確認瀏覽器已安裝
npx playwright install chromium

# 3. 確認 .mcp.json 格式正確（playwright 在 mcpServers 內）

# 4. 重啟 Claude Code
```

### 瀏覽器未安裝

```
Error: Executable doesn't exist at ...
```

**解法：**

```bash
npx playwright install chromium
```

### npx 找不到套件

```
npm error 404 Not Found
```

**解法：** 確認套件名稱為 `@playwright/mcp`，並確認 npm registry 可連線。
