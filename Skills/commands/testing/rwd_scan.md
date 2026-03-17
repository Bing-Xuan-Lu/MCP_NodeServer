---
name: rwd_scan
description: |
  RWD 三斷點截圖掃描：在 Mobile (375px)、Tablet (768px)、Desktop (1440px) 三個斷點自動截圖，偵測水平溢出/文字截斷/元素重疊，產出響應式問題報告。
  當使用者說「RWD 測試」「響應式檢查」「手機版截圖」「三斷點」「rwd scan」時使用。
---

# /rwd_scan — RWD 三斷點截圖掃描（Mobile 375 / Tablet 768 / Desktop 1440）

你是前端 RWD 品質檢測工程師，使用 Playwright MCP 對指定頁面在三個標準斷點自動截圖，並分析截圖中的響應式問題（水平溢出、文字截斷、元素重疊、選單未收合等），產出掃描報告。

---

## 使用者輸入

$ARGUMENTS

格式：`{URL 或頁面清單} [--breakpoints 375,768,1440] [--full-page] [--project ProjectFolder]`

- `{URL}`：單一 URL 或逗號分隔的多個 URL
- `全頁面`：自動從首頁爬取所有內部連結進行掃描
- `--breakpoints`（可選）：自訂斷點寬度，預設 `375,768,1440`
- `--full-page`（可選）：截取完整頁面長截圖（預設僅首屏）
- `--project`（可選）：指定專案以使用對應截圖目錄

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| URL | 要掃描的頁面網址 | `http://localhost/` |
| 斷點寬度 | RWD 斷點列表 | `375,768,1440`（預設） |
| 截圖目錄 | 截圖儲存位置 | `{project}/screenshots/rwd/`（預設） |
| 登入需求 | 是否需要先登入才能存取頁面 | 不需要 / 帳號密碼 |

---

## 標準斷點定義

| 斷點名稱 | 寬度 | 高度 | 說明 |
|---------|------|------|------|
| Mobile | 375px | 812px | iPhone SE/12/13/14 標準寬度 |
| Tablet | 768px | 1024px | iPad 直向標準寬度 |
| Desktop | 1440px | 900px | 標準桌面/筆電寬度 |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `Playwright: browser_navigate` | 前往目標頁面 |
| `Playwright: browser_resize` | 調整瀏覽器視窗寬度（模擬斷點） |
| `Playwright: browser_take_screenshot` | 截取頁面截圖 |
| `Playwright: browser_snapshot` | 取得 DOM 結構，分析溢出元素 |
| `Playwright: browser_evaluate` | 執行 JS 偵測水平溢出、元素重疊 |
| `Playwright: browser_fill_form` / `browser_click` | 登入操作（若需要） |
| `Read` | 讀取頁面清單或設定檔 |
| `Write` | 儲存掃描報告 |

---

## 執行步驟

### 步驟 0：環境準備

確認 Playwright MCP 可用，若需要登入先完成登入流程：

```
browser_navigate → 登入頁
browser_fill_form → 帳號密碼
browser_click → 登入按鈕
browser_snapshot → 確認登入成功
```

建立截圖目錄（若不存在）：

```bash
mkdir -p {project}/screenshots/rwd/
```

---

### 步驟 1：收集頁面清單

**單一/多個 URL 模式**：直接使用使用者提供的 URL 清單。

**全頁面自動探索模式**（使用者輸入「全頁面」）：

```
browser_navigate → 首頁
browser_evaluate → 取得所有內部連結：
  Array.from(document.querySelectorAll('a[href]'))
    .map(a => a.href)
    .filter(url => url.startsWith('{baseUrl}'))
    .filter(url => !url.includes('#') && !url.includes('javascript:'))
    → 去重 + 排序
```

輸出確認：

```
掃描頁面清單（共 N 頁）：
  1. / — 首頁
  2. /product/product_list.php — 商品列表
  3. /member/info.php — 會員中心
  ...

確認開始掃描？
```

---

### 步驟 2：逐頁面三斷點截圖

對每個頁面，依序在三個斷點進行截圖：

```
for each URL:
  for each breakpoint in [{375, 812}, {768, 1024}, {1440, 900}]:

    2a. browser_resize(width={breakpoint.width}, height={breakpoint.height})
    2b. browser_navigate(url={URL})
    2c. browser_take_screenshot(
          fileName="{page_name}_{breakpoint.width}.png",
          savePath="{截圖目錄}"
        )
    2d. browser_evaluate → 執行溢出偵測 JS（見步驟 3）
    2e. browser_snapshot → 記錄 DOM 結構供分析
```

**頁面命名規則**：從 URL path 提取，`/` → `index`，`/product/product_list.php` → `product_list`

**截圖命名**：`{page_name}_{width}.png`

例：
```
index_375.png
index_768.png
index_1440.png
product_list_375.png
product_list_768.png
product_list_1440.png
```

---

### 步驟 3：自動偵測響應式問題

在每個斷點截圖後，執行以下 JavaScript 偵測：

#### 3a. 水平溢出偵測

```javascript
browser_evaluate:
(() => {
  const docWidth = document.documentElement.clientWidth;
  const overflows = [];
  document.querySelectorAll('*').forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.right > docWidth + 5 || rect.left < -5) {
      overflows.push({
        tag: el.tagName,
        class: el.className?.substring?.(0, 60),
        right: Math.round(rect.right),
        docWidth
      });
    }
  });
  return overflows.slice(0, 20);
})()
```

#### 3b. 文字截斷偵測

```javascript
browser_evaluate:
(() => {
  const truncated = [];
  document.querySelectorAll('*').forEach(el => {
    if (el.scrollWidth > el.clientWidth + 2 && el.children.length === 0) {
      const style = getComputedStyle(el);
      if (style.overflow === 'hidden' || style.textOverflow === 'ellipsis') {
        truncated.push({
          tag: el.tagName,
          text: el.textContent?.substring(0, 40),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth
        });
      }
    }
  });
  return truncated.slice(0, 20);
})()
```

#### 3c. 元素重疊偵測

```javascript
browser_evaluate:
(() => {
  const buttons = Array.from(document.querySelectorAll('button, a.btn, input[type="submit"]'));
  const overlaps = [];
  for (let i = 0; i < buttons.length; i++) {
    for (let j = i + 1; j < buttons.length; j++) {
      const a = buttons[i].getBoundingClientRect();
      const b = buttons[j].getBoundingClientRect();
      if (a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom) {
        overlaps.push({
          el1: buttons[i].textContent?.trim().substring(0, 20),
          el2: buttons[j].textContent?.trim().substring(0, 20)
        });
      }
    }
  }
  return overlaps.slice(0, 10);
})()
```

---

### 步驟 4：產出掃描報告

將所有偵測結果匯整為 Markdown 報告：

```markdown
# RWD 響應式掃描報告

掃描時間：{date}
掃描頁面：{N} 個
斷點寬度：375px (Mobile) / 768px (Tablet) / 1440px (Desktop)

---

## 問題摘要

| 嚴重度 | 問題數 | 說明 |
|--------|:------:|------|
| HIGH | N | 水平溢出、元素重疊 |
| MED | N | 文字截斷、選單未收合 |
| LOW | N | 間距不均、圖片未縮放 |

---

## 截圖總覽

| 頁面 | Mobile (375) | Tablet (768) | Desktop (1440) |
|------|:---:|:---:|:---:|
| 首頁 | PASS/FAIL | PASS/FAIL | PASS/FAIL |
| 商品列表 | PASS/FAIL | PASS/FAIL | PASS/FAIL |
| ... | ... | ... | ... |

---

## 逐頁面結果

### 1. {page_name} ({URL})

| 斷點 | 截圖 | 溢出 | 截斷 | 重疊 | 狀態 |
|------|------|:----:|:----:|:----:|:----:|
| 375 | {page}_375.png | 0 | 0 | 0 | PASS |
| 768 | {page}_768.png | 2 | 1 | 0 | FAIL |
| 1440 | {page}_1440.png | 0 | 0 | 0 | PASS |

**375px 問題：**
- [HIGH] 水平溢出：`.product-table` 右側超出 120px
- [MED] 文字截斷：商品名稱被 ellipsis 截斷

**768px 問題：**
- [HIGH] 元素重疊：按鈕 A 與按鈕 B 重疊
- ...

---

## 建議修正優先順序

1. [HIGH] {page} @ 375px：{問題描述} → 建議用 `@media (max-width: 480px)` 調整
2. [HIGH] {page} @ 768px：{問題描述} → 建議加 `overflow-x: auto` 到表格容器
3. [MED] ...
```

儲存至：`{project}/screenshots/rwd/rwd_scan_{date}.md`

---

### 步驟 5：完成摘要

```
RWD 掃描完成！

統計：
  掃描頁面：N 個
  總截圖數：N 張（N 頁 x 3 斷點）
  問題數：HIGH N / MED N / LOW N

截圖目錄：{截圖目錄}
報告：{報告路徑}

建議下一步：
  - 依報告中 HIGH 優先修正
  - 前端開發修正響應式問題
  - /spec_screenshot_diff {module} → 對照規格書確認
```

---

## 注意事項

- **Playwright 單一 context**：不可與其他 Agent 並行使用 Playwright MCP，必須序列化
- **登入 Session**：若頁面需要登入，在步驟 0 完成登入後，同一 browser context 內所有頁面都能存取
- **截圖高度**：預設使用各斷點標準高度（Mobile 812 / Tablet 1024 / Desktop 900），`--full-page` 模式需用 `browser_evaluate` 取得 `document.body.scrollHeight` 後調整
- **效能**：每個頁面 3 個斷點 = 3 次 resize + 3 次 navigate + 3 次 screenshot，大量頁面時耗時較長
- **溢出偵測限制**：JS 偵測只能找到 DOM 層級的溢出，CSS `overflow: hidden` 隱藏的問題需靠截圖人工判斷
- **動態內容**：SPA 頁面需等待資料載入完成後再截圖，可用 `browser_wait_for` 等待關鍵元素出現
- **不修改程式碼**：此 Skill 只做掃描與報告，不自動修正問題
- **resize 後需重新 navigate**：`browser_resize` 後必須重新載入頁面，否則 RWD 媒體查詢可能不生效
