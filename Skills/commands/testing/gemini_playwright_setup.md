# 通用 Agentic UI 測試設定指南 (Gemini CLI 專用)

本指南旨在為 Gemini CLI 提供與 Google Codelab 相同的「Agentic UI」能力，核心在於透過 **BrowserMCP** 連結你現有的 Chrome 瀏覽器，達成通用的自動化與手動協作測試。

---

## 1. 核心工具鏈 (核心安裝)

這是所有環境都適用的通用工具：

### A. 安裝 BrowserMCP (通訊橋樑)
這是讓 AI 直接控制你目前開啟的 Chrome 分頁的最強工具。
```bash
npm install -g @browsermcp/mcp
```
> **啟動方式**：在終端機輸入 `npx @browsermcp/mcp`。

### B. 安裝 Chrome 擴充功能
1. 從 [Chrome Web Store](https://chromewebstore.google.com/detail/browsermcp/...) 安裝 **BrowserMCP**。
2. 點擊擴充功能圖示，確保它顯示為 **「Connected」**。

---

## 2. 全域設定 (Universal Config)

讓 Gemini CLI 能夠識別這些工具。修改全域設定檔 `~/.gemini/settings.json`：

```json
{
  "mcpServers": {
    "browsermcp": {
      "command": "npx",
      "args": ["-y", "@browsermcp/mcp@latest"]
    }
  }
}
```

---

## 3. 技能部署 (Skill-Driven)

Gemini 需要一份「操作手冊」才能正確執行 Agentic 測試。

### 建立通用的 Playwright 技能包
將本專案的技能同步至 Gemini：
1. 確保 `~/.gemini/skills/playwright-cli/SKILL.md` 存在。
2. 內容應包含：
   - 如何使用 `browser_` 開頭的 MCP 工具（點擊、截圖、輸入）。
   - 如何使用 `playwright-cli` 跑腳本。

---

## 4. 通用操作流程 (如何使用)

一旦設定完成，你可以在 Gemini CLI 中執行以下通用指令：

1. **連線檢查**：
   輸入 `List my MCP tools`。若看到 `browser_click`, `browser_navigate` 等工具，即代表成功。

2. **操作目前分頁 (最通用方式)**：
   「幫我查看我目前的 Chrome 分頁，並點擊畫面上的 'Login' 按鈕。」
   *Gemini 會透過 BrowserMCP 傳送指令給你的 Chrome 擴充功能。*

3. **視覺化測試**：
   「幫我截圖目前的網頁，並分析是否有任何 UI 跑版。」

---

## 5. 優勢：為什麼這是「通用」的？

- **無須下載專案**：直接在你的開發環境（Gemini CLI）中運作。
- **支援已登入狀態**：因為是操作你的 Chrome，所以不需要重新處理登入或 Session。
- **跨平台一致性**：無論是 Windows 還是 Mac，只要有 Chrome + Node.js 就能執行。

---

## 疑難排解

- **Gemini 說找不到工具**：請檢查 `~/.gemini/settings.json` 是否已正確載入 `browsermcp`。
- **擴充功能圖示為紅色**：請確認 `npx @browsermcp/mcp` 伺服器正在執行。
