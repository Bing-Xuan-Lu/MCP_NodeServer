---
name: design_diff
description: "設計稿比對、UI 比對、design diff、Figma 比對、XD 比對"
---

# /design_diff — 設計稿 vs 實際網站截圖比對

你是 UI 像素級驗收工程師，將設計師提供的設計稿（本地圖片 或 線上 XD/Figma 連結）與 Playwright 截取的實際頁面截圖進行逐項比對，產出視覺差異報告。檢查項目涵蓋版面結構、顏色、字體、間距、元件完整性、缺失元素。

---

## 使用者輸入

$ARGUMENTS

格式：`{設計稿來源} [目標URL] [--breakpoint 1920]`

- `{設計稿來源}`：以下三種之一：
  - **本地路徑**：設計稿圖片/PDF 的檔案或資料夾路徑（`D:\Design\homepage.png`）
  - **線上 XD 連結**：Adobe XD 分享連結（`https://xd.adobe.com/view/...`）
  - **線上 Figma 連結**：Figma 分享連結（`https://www.figma.com/...`）
- `[目標URL]`（可選）：實作頁面 URL；省略時從設計稿檔名或頁面名稱推斷
- `--breakpoint`（可選）：指定截圖寬度（預設由專案規格書決定，無則用 `1920`）

支援的設計稿格式：PNG、JPG、JPEG、PDF、線上 XD/Figma。

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 設計稿來源 | 本地路徑或線上連結 | `D:\Design\` 或 `https://xd.adobe.com/view/...` |
| 實作 URL | 前台頁面 URL | `http://localhost/` |
| 斷點寬度 | 截圖視窗寬度（由專案規格書決定） | `1920`（預設） |
| 登入需求 | 是否需要先登入 | 不需要 / 帳號密碼 |

**若使用者未提供本地資料夾也未提供線上連結，詢問：**
```
設計稿來源？
1. 本地圖片資料夾路徑（如 D:\Design\XDimg\）
2. 線上 XD 連結（如 https://xd.adobe.com/view/...）
3. 線上 Figma 連結
```

---

## 線上 XD 設計稿處理流程

若設計稿來源為 XD 線上連結，XD viewer 是 **canvas 渲染**，不是 `<img>` 標籤。以下方法皆無效：
- ❌ grid view CDN URL — 只有縮圖（~188px 寬），文字完全看不清
- ❌ detail view fullPage screenshot — canvas 只截到 viewport 範圍
- ❌ 拉高 viewport — canvas 會等比縮放變更模糊

**正確做法 — Detail View 分段捲動截圖**：

```
1. browser_navigate → XD grid 頁面（URL 尾端加 /grid）
2. browser_evaluate → 從 [role="gridcell"] 找到目標 artboard 名稱
3. browser_navigate → artboard detail 頁面：
   https://xd.adobe.com/view/{project_id}/screen/{artboard_id}/
4. 關閉「網格視圖」彈窗（若出現）
5. browser_run_code → 找 scrollable container，迴圈 scroll + 逐段截圖
6. Read 每段截圖 → 驗證內容完整且文字清晰可讀
7. 每段截圖存為 xd_{page_name}_part{N}.png
```

> **分段截圖的 browser_run_code**：
> ```js
> async (page) => {
>   const container = await page.evaluate(() => {
>     const all = document.querySelectorAll('*');
>     for (const el of all) {
>       if (el.scrollHeight > el.clientHeight + 10 && el.clientHeight > 100) {
>         el.id = '__xd_scroll__';
>         return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
>       }
>     }
>   });
>   const steps = Math.ceil(container.scrollHeight / container.clientHeight);
>   for (let i = 0; i < steps; i++) {
>     await page.evaluate(({ top }) => {
>       document.getElementById('__xd_scroll__').scrollTop = top;
>     }, { top: i * container.clientHeight });
>     await page.waitForTimeout(1000); // 等 canvas 重繪
>     await page.screenshot({ path: `screenshots/xd_part${i + 1}.png`, type: 'png' });
>   }
>   return { steps };
> }
> ```

> **注意**：
> - XD 設計稿的 fixed bottom nav 是畫在 canvas 上的設計元素，無法用 CSS 隱藏，但分段截圖後每段內容都完整可見
> - `browser_run_code` 中不能用 `setTimeout`，必須用 `page.waitForTimeout()`
> - 每段等待 1000ms 確保 canvas 重繪完成

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `Glob` | 掃描設計稿資料夾中的圖片檔案 |
| `Read` | 讀取設計稿圖片（Claude 多模態辨識）/ 讀取 PDF 設計文件 |
| `Grep` | 搜尋 CSS class 定義 |
| `Playwright: browser_navigate` | 前往實作頁面 |
| `Playwright: browser_resize` | 調整瀏覽器寬度至設計稿對應的斷點 |
| `Playwright: browser_take_screenshot` | 截取實作頁面截圖 |
| `Playwright: browser_snapshot` | 取得 DOM 結構 |
| `Playwright: browser_evaluate` | 執行 JS 取得 computed style（顏色、字體、間距） |
| `Playwright: browser_fill_form` / `browser_click` | 登入操作 |
| `Write` | 儲存比對報告 |

---

## 執行步驟

### 步驟 1：掃描設計稿

**單一檔案模式**：
```text
Read: {設計稿路徑}
→ Claude 多模態分析圖片內容
```

**資料夾模式**：
```text
Glob: {設計稿資料夾}/*.png
Glob: {設計稿資料夾}/*.jpg
Glob: {設計稿資料夾}/*.jpeg
Glob: {設計稿資料夾}/*.pdf
→ 列出所有設計稿檔案
→ 按檔名解析頁面名稱
```

**PDF 設計文件**：
```text
Read: {設計稿}.pdf (pages: "1-5")
→ 逐頁讀取，每頁可能對應不同頁面狀態
```

輸出確認：

```text
設計稿清單（共 N 張）：

| # | 檔名 | 頁面 | 對應 URL |
|---|------|------|---------|
| 1 | homepage.png | 首頁 | / |
| 2 | product_list.png | 商品列表 | /product/list |
| 3 | unknown_page.png | ? 無法推斷 | 請指定 |

請確認對應關係，或指定「?」項的目標 URL：
```

---

### 步驟 2：讀取設計稿圖片

對每張設計稿圖片：

```text
Read: {設計稿路徑}
→ Claude 多模態分析：
  - 版面結構（header / content / sidebar / footer）
  - 主要顏色（背景色、文字色、按鈕色、強調色）
  - 字體大小比例（標題 vs 內文）
  - 間距與留白模式
  - 元件清單（按鈕、表單、卡片、列表、圖標等）
  - 缺失或多餘的元素
```

記錄分析結果供後續比對。

---

### 步驟 3：截取實作頁面截圖

```text
3a. browser_resize(width={breakpoint}, height=900)

3b. 若需登入：
    browser_navigate → 登入頁
    browser_fill_form → 帳號密碼
    browser_click → 登入

3c. browser_navigate → 對應的實作 URL
    browser_wait_for → 等待主要內容載入

3d. browser_take_screenshot → 儲存為 impl_{page_name}.png
    儲存至：screenshots/{frontend|backend}/diff/

3e. browser_evaluate → 取得關鍵元素的 computed style：
```

```javascript
browser_evaluate:
(() => {
  const extract = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      selector,
      color: style.color,
      backgroundColor: style.backgroundColor,
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      padding: style.padding,
      margin: style.margin,
      lineHeight: style.lineHeight,
      borderRadius: style.borderRadius
    };
  };
  return {
    body: extract('body'),
    header: extract('header') || extract('.header') || extract('#header'),
    nav: extract('nav') || extract('.navbar'),
    h1: extract('h1'),
    h2: extract('h2'),
    button: extract('.btn') || extract('button'),
    footer: extract('footer') || extract('.footer') || extract('#footer')
  };
})()
```

```text
3f. browser_snapshot → 取得完整 DOM 結構
```

---

### 步驟 4：逐項比對

對每組設計稿 vs 實際截圖，執行五個維度的比對：

#### 4a. 版面結構比對

| 項目 | 設計稿 | 實際 | 狀態 |
|------|--------|------|:----:|
| Header 高度 | ~80px | 75px | OK |
| 內容區寬度 | 1200px 居中 | 1170px 居中 | OK |
| 側邊欄 | 無 | 無 | OK |
| Footer 區塊數 | 4 欄 | 3 欄 | NG |

#### 4b. 顏色比對

| 元素 | 設計稿色碼 | 實際色碼 | 狀態 |
|------|-----------|---------|:----:|
| 背景色 | #FFFFFF | #FFFFFF | OK |
| 主按鈕 | #E74C3C | #DD4B39 | NG |

容差範圍：RGB 各通道差值 <= 10 視為 OK。

#### 4c. 字體比對

| 元素 | 設計稿 | 實際 | 狀態 |
|------|--------|------|:----:|
| 標題字體 | Noto Sans TC Bold 24px | Noto Sans TC Bold 22px | OK |
| 內文大小 | 14px | 14px | OK |

容差範圍：+-2px 視為 OK。

#### 4d. 間距比對

| 項目 | 設計稿 | 實際 | 狀態 |
|------|--------|------|:----:|
| 卡片間距 | ~20px | 15px | NG |
| 內容上方留白 | ~40px | 30px | OK |

容差範圍：+-5px 視為 OK。

#### 4e. 元件完整性比對

| 元件 | 設計稿 | 實際 | 狀態 |
|------|--------|------|:----:|
| 搜尋框 | Header 右側 | Header 右側 | OK |
| 購物車 icon | 有 + badge 數字 | 有但無 badge | NG |
| 社群登入按鈕 | LINE + Google + FB | LINE + Google | NG |

---

### 步驟 5：產出比對報告

讀取 `_design_diff/report_template.md` 作為報告骨架，填入步驟 4 的比對數據。

報告包含：比對總覽表 → 逐頁五維度比對（版面/顏色/字體/間距/元件）→ NG 修正建議 → 統計 → Checklist。

儲存至：`{project}/reports/{frontend|backend}/design_diff_{date}.md`

---

### 步驟 6：完成摘要

```text
設計稿比對完成！

結果：
  比對頁面：N 個
  總檢查項：N 個（OK N / NG N）
  整體符合率：N%

截圖目錄：screenshots/{frontend|backend}/diff/
報告：reports/{frontend|backend}/design_diff_{date}.md

主要 NG 項目：
  1. {頁面} — {問題摘要}
  2. {頁面} — {問題摘要}

建議下一步：
  - 依報告修正 CSS / HTML
  - 前端開發修正 NG 項目 → 自動修正
  - /design_diff {path} → 修正後重新比對
```

---

## 注意事項

- **PDF 設計文件**：使用 Read 工具的 `pages` 參數分頁讀取
- **Figma 設計稿**：使用者需先匯出為 PNG/JPG，本工具不直接存取 Figma API
- **容差標準**：顏色 RGB <=10、字體 +-2px、間距 +-5px（已定義在步驟 4 各維度中）
- **Playwright 獨佔**：詳見 `_project_qc/global_rules.md`「工具主權劃分」
- **不修改程式碼**：只做比對與報告，修正建議寫在報告中
- **動態內容**：比對結構與樣式，不比對假資料文字（除非是固定標題/標籤）
- **多斷點設計稿**：每個斷點獨立比對
- **CSS 修正建議**：優先使用 CSS 變數（若專案已有）
