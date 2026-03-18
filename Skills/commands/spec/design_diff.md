---
name: design_diff
description: |
  設計稿比對：將設計圖檔（PNG/JPG/PDF）或線上 XD/Figma 連結與實際網站截圖進行視覺比對，檢查排版、顏色、字體、間距、元件完整性。
  當使用者說「設計稿比對」「UI 比對」「design diff」「PSD 比對」「Figma 比對」「XD 比對」「和設計稿一樣嗎」時使用。
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

若設計稿來源為 XD 線上連結：

```
1. browser_navigate → XD grid 頁面（連結尾端加 /grid）
2. browser_take_screenshot → 總覽截圖
3. 從 grid 頁面識別所有畫面名稱
4. 逐一點擊畫面 → 進入單頁檢視 → 截圖
5. 每張截圖存為 xd_{page_name}.png
6. 與前台實際截圖比對
```

> **注意**：XD 線上版是 SPA，需等待載入完成。若頁面切換後畫面空白，用 `browser_wait_for` 等待 2-3 秒。

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

```markdown
# 設計稿比對報告

比對時間：{date}
設計稿來源：{設計稿路徑}
實作網址：{base_url}

---

## 比對總覽

| # | 頁面 | 設計稿 | 實際截圖 | OK | NG | 符合率 |
|---|------|--------|---------|:--:|:--:|:------:|
| 1 | 首頁 | homepage.png | impl_homepage.png | 8 | 3 | 73% |
| 2 | 商品列表 | product_list.png | impl_product_list.png | 10 | 1 | 91% |

---

## 逐頁面比對

### 1. {頁面名稱}

**設計稿**：`{design_file}`
**實際截圖**：`screenshots/{fe|be}/diff/{live_file}`

#### 版面結構
{4a 比對表}

#### 顏色
{4b 比對表}

#### 字體
{4c 比對表}

#### 間距
{4d 比對表}

#### 元件完整性
{4e 比對表}

#### NG 項目修正建議

| # | 問題 | 建議修正 | 影響檔案 |
|---|------|---------|---------|
| 1 | 主按鈕顏色不符 | `.btn-primary { background: #E74C3C; }` | css/style.css |
| 2 | 購物車缺少 badge | 加入 `.cart-badge` 元件 | include/header.php + css/style.css |

---

## 統計

| 項目 | 數量 |
|------|:----:|
| 比對頁面 | N |
| 總檢查項 | N |
| OK | N |
| NG | N |
| 整體符合率 | N% |

---

## 修正建議 Checklist

- [ ] {NG 項目 1}：{修正描述}
- [ ] {NG 項目 2}：{修正描述}
- [ ] ...

---

## 建議下一步

- 前端開發修正 NG 項目 → 修正 NG 項目
- /rwd_scan {url} → 響應式檢查（若有多斷點設計稿）
- /spec_screenshot_diff {module} → 對照規格書確認功能正確性
- /design_diff {path} → 修正後重新比對
```

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

- **設計稿是圖片**：使用 Read 工具讀取圖片，Claude 多模態能力會自動辨識版面結構、顏色、字體等
- **PDF 設計文件**：使用 Read 工具的 `pages` 參數分頁讀取，每頁獨立分析
- **Figma 設計稿**：使用者需先匯出為 PNG/JPG 圖片，本工具不直接存取 Figma API
- **顏色容差**：RGB 各通道差值 <= 10 視為 OK（不同螢幕/渲染引擎會有微小差異）
- **字體大小容差**：+-2px 視為 OK（設計稿和瀏覽器的計算方式可能不同）
- **間距容差**：+-5px 視為 OK
- **不修改程式碼**：此 Skill 只做比對與報告產出，不自動修正差異。修正建議寫在報告中供後續執行
- **Playwright 單一 context**：不可與其他 Agent 並行使用，所有操作必須序列化
- **設計稿品質**：若設計稿解析度過低或有壓縮痕跡，在報告中註明可能影響比對準確度
- **動態內容**：設計稿通常用假資料，比對時關注結構與樣式，不比對具體文字內容（除非是固定標題/標籤）
- **多斷點設計稿**：若設計師提供多個斷點版本（desktop/tablet/mobile），每個斷點獨立比對
- **CSS 修正建議**：優先使用 CSS 變數（若專案已有 CSS 變數體系）
