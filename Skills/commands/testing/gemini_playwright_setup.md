# 通用 Agentic UI 測試設定指南 (Gemini CLI 專用)

本指南旨在為 Gemini CLI 提供通用且強大的網頁自動化與測試能力。核心在於透過微軟官方的 **Playwright MCP** 連結瀏覽器，達成自動化與協作測試。

---

## 1. 環境需求與核心工具

這是所有環境都適用的通用工具：

### 系統需求
- **Node.js**: 需要 Node.js 18 或以上版本。

---

## 2. 全域設定 (Universal Config)

讓 Gemini CLI 能夠識別 Playwright MCP 工具。修改全域設定檔 `~/.gemini/settings.json`：

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

### 進階參數設定
若你需要自訂瀏覽器行為，可以在 `args` 中加入額外參數：
- `--headless`: 在背景執行瀏覽器 (無 UI)。
- `--browser chromium` (或 `firefox`, `webkit`): 指定瀏覽器核心。
- `--ignore-https-errors`: 忽略 HTTPS 憑證錯誤。
- `--isolated`: 使用獨立的瀏覽器設定檔 (預設為持久性設定檔 Persistent Profile)。

例如 (以 headless 模式啟動 chromium)：
```json
"args": [
  "-y",
  "@playwright/mcp@latest",
  "--browser", "chromium",
  "--headless"
]
```

---

## 3. 安裝瀏覽器核心 (Browser Binaries)

若執行時遇到瀏覽器未安裝的錯誤，可以在 Gemini CLI 成功掛載工具後，直接呼叫 MCP 工具：
- 使用 `browser_install` 工具來自動安裝 Playwright 所需的瀏覽器二進位檔。

---

## 4. 通用操作流程 (如何使用)

一旦設定完成並重啟 Gemini CLI，你可以執行以下通用指令：

1. **連線檢查**：
   輸入 `List my MCP tools`。若看到 `browser_navigate`, `browser_click`, `browser_fill` 等由 playwright 提供的工具，即代表成功。

2. **操作瀏覽器**：
   「幫我前往 https://example.com ，並點擊畫面上的 'Login' 按鈕。」
   *Gemini 會透過 Playwright MCP 啟動並控制瀏覽器。*

3. **視覺化與資料擷取**：
   「幫我截圖目前的網頁，並擷取網頁的文字內容進行分析。」

---

## 疑難排解

- **Gemini 說找不到工具**：請檢查 `~/.gemini/settings.json` 是否已正確載入 `playwright` 伺服器配置。
- **瀏覽器無法啟動**：請確認是否已透過 `browser_install` 工具安裝瀏覽器，或 Node.js 版本是否大於等於 18。
