# /spec_screenshot_diff — 規格書截圖 vs 實際網站截圖比對

你是 UI 驗收工程師，負責擷取 AxShare 規格書頁面截圖與實際實作頁面截圖，並排呈現供人工視覺比對，並列出觀察到的 UI 差異（欄位缺失、排版不同、按鈕樣式、文字不一致等）。任何欄位不符規格書 = NG。

---

## 使用者輸入

$ARGUMENTS

格式：`{模組名稱或頁面URL} [--backend|--frontend] [--spec-page PAGE_ID]`

- `{模組名稱}`：如 `news`、`member_info`、`cart`、`ready_product`
- `{頁面URL}`：直接提供實作頁面的完整 URL
- `--backend`（預設）：後台頁面，使用 `axshare_spec_reference_backend.md`
- `--frontend`：前台頁面，使用 `axshare_spec_reference_frontend.md`
- `--spec-page PAGE_ID`（可選）：直接指定 AxShare page ID，跳過自動查找

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 模組或 URL | 要比對的模組名稱或實作頁面 URL | `news` 或 `http://localhost/admin/news/list.php` |
| 前台/後台 | 決定查哪份規格書索引 | `後台`（預設） |
| AxShare page ID | 規格書頁面 ID（可選，自動從索引檔查找） | `jj46fr` |
| 實作網站 URL | 測試網站基礎 URL | `http://localhost/` |

---

## 截圖存放規則

| 類型 | 存放路徑 | 命名規則 |
|------|---------|---------|
| 規格書截圖 | `{project}/axshare_screen_shot/{backend\|frontend}/` | `spec_{module}_{page}.png` |
| 實作截圖 | `{project}/screenshots/{backend\|frontend}/` | `impl_{module}_{page}.png` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `Read` | 讀取 axshare_spec_reference 索引檔，查找 page ID |
| `Playwright: browser_navigate` | 開啟 AxShare 規格書頁面 / 實作頁面 |
| `Playwright: browser_snapshot` | 取得頁面 DOM 結構 |
| `Playwright: browser_take_screenshot` | 截取頁面截圖 |
| `Playwright: browser_resize` | 調整視窗大小以統一截圖尺寸 |
| `Playwright: browser_evaluate` | 等待 AxShare SPA 載入 / 提取 computed style |
| `Playwright: browser_fill_form` / `browser_click` | 登入操作、AxShare 密碼 |
| `Playwright: browser_wait_for` | 等待頁面載入完成 |
| `Write` | 儲存比對報告 |

---

## 執行步驟

### 步驟 0：確認規格書頁面

從本地索引檔查找目標模組對應的 AxShare 頁面：

```text
0a. 依 --backend/--frontend 決定讀取哪份索引：
    - 後台：Read spec/axshare_spec_reference_backend.md
    - 前台：Read spec/axshare_spec_reference_frontend.md

0b. 搜尋模組名稱，取得對應的 page ID 和頁面名稱清單
    → 一個模組可能有多個頁面（list, add, update 等）

0c. 確認頁面清單：
    模組：{module}
    規格書頁面：
      1. {page_name_1} (ID: {page_id_1})
      2. {page_name_2} (ID: {page_id_2})

    確認開始截圖比對？
```

若索引檔不存在，提示使用者先執行 `/axshare_spec_index`。

---

### 步驟 1：統一視窗尺寸

```text
browser_resize(width=1440, height=900)
→ 確保規格書和實作截圖在相同解析度下比對
```

---

### 步驟 2：擷取規格書截圖

**重要：絕對不從 AxShare 首頁開始導航，直接用完整 URL 跳轉。**

對每個規格書頁面：

```text
2a. browser_navigate → https://{axshare_subdomain}.axshare.com/#id={page_id}&p={page_name}

2b. 處理 AxShare 密碼保護（若首次開啟）：
    browser_snapshot → 若看到密碼輸入框
    browser_fill_form → 密碼: {axshare_password}
    browser_click → 確認按鈕

2c. 等待 AxShare SPA 載入完成：
    browser_evaluate → 等待 $axure 物件就緒
    或 browser_wait_for → 等待主要內容元素出現（2-3 秒）

2d. browser_take_screenshot → 存至：
    axshare_screen_shot/{backend|frontend}/spec_{module}_{page}.png

2e. browser_snapshot → 記錄 DOM 結構（欄位、按鈕清單），供後續比對

2f. 若規格書頁面有捲動內容，分段截圖：
    browser_evaluate → 捲動內部 iframe 或容器
    browser_take_screenshot → spec_{module}_{page}_scroll1.png
```

---

### 步驟 3：擷取實作截圖

對每個對應的實作頁面：

```text
3a. 若為後台頁面且需登入：
    browser_navigate → http://localhost/{admin_path}/welcome.php
    （Docker 開發環境通常無 session 檢查，直接進入即可）

    若為前台頁面且需登入：
    先操作登入流程（Playwright 填表單 + 點擊）

3b. browser_navigate → 實作頁面 URL
    例：http://localhost/{admin_path}/{module}/list.php

3c. browser_take_screenshot → 存至：
    screenshots/{backend|frontend}/impl_{module}_{page}.png

3d. browser_snapshot → 記錄 DOM 結構

3e. 若頁面有捲動內容，分段截圖：
    browser_evaluate → window.scrollTo(0, 800)
    browser_take_screenshot → impl_{module}_{page}_scroll1.png
```

---

### 步驟 4：並排比對

對每組截圖（規格書 vs 實作），進行以下比對：

```text
4a. 使用 Read 工具讀取兩張截圖，呈現給使用者

4b. 從步驟 2e 和 3d 的 DOM 結構中，提取結構化比對：
```

比對維度：

| 比對維度 | 檢查內容 | 判定標準 |
|---------|---------|---------|
| 頁面結構 | header / content / footer 區塊排列 | 區塊順序與層級一致 |
| 導覽元素 | 選單項目、麵包屑、頁籤 | 文字與連結完全一致 |
| 搜尋區 | 搜尋欄位、下拉選單選項、按鈕 | 欄位數量和類型一致 |
| 表單欄位 | 欄位名稱、類型、順序、必填標記 | 欄位不可多也不可少 |
| 按鈕 | 文字、位置、顏色、大小 | 完全一致 |
| 表格欄位 | 欄位標題、順序、寬度比例 | 標題文字與順序一致 |
| 文字內容 | 標題、說明文字、placeholder | 文字內容一致 |
| 版面配置 | 欄位排列方式、間距 | 視覺結構一致 |

---

### 步驟 5：產出差異清單

將觀察到的差異整理為結構化格式：

```markdown
# 規格書截圖比對報告：{module}

比對日期：{date}
規格書來源：AxShare ({axshare_subdomain}.axshare.com)
實作網站：{URL}

---

## 頁面 1：{page_name}

### 截圖對照

| 來源 | 截圖路徑 |
|------|---------|
| 規格書 | axshare_screen_shot/{be|fe}/spec_{module}_{page}.png |
| 實作 | screenshots/{be|fe}/impl_{module}_{page}.png |

### 比對結果

| # | 維度 | 狀態 | 差異描述 |
|---|------|:----:|---------|
| 1 | 頁面結構 | OK / NG | {差異說明} |
| 2 | 搜尋區 | OK / NG | {差異說明} |
| 3 | 表單欄位 | OK / NG | {差異說明} |
| 4 | 按鈕 | OK / NG | {差異說明} |
| 5 | 表格欄位 | OK / NG | {差異說明} |
| 6 | 文字內容 | OK / NG | {差異說明} |
| 7 | 版面配置 | OK / NG | {差異說明} |

### NG 項目詳細

#### NG-1：{維度} — {問題標題}

- **規格書**：{規格書中的呈現}
- **實際**：{前台實際呈現}
- **建議修正**：{具體修正方向}
- **影響檔案**：{相關 PHP/JS/CSS 檔案路徑}

---

## 頁面 2：{page_name}
...

---

## 統計

| 項目 | 數量 |
|------|:----:|
| 比對頁面 | N |
| 比對維度 | N |
| OK | N |
| NG | N |
| 符合率 | N% |
```

儲存至：`{project}/reports/{frontend|backend}/spec_diff_{module}_{date}.md`

---

### 步驟 6：完成摘要

```text
規格書截圖比對完成：{module}

結果：OK {N} / NG {N}（符合率 {N}%）

截圖位置：
  規格書：axshare_screen_shot/{backend|frontend}/
  實作：screenshots/{backend|frontend}/

NG 項目：
  1. {NG 摘要 1}
  2. {NG 摘要 2}

建議下一步：
  - 前端開發修正 NG 項目
  - /rwd_scan {URL} → 檢查 RWD 響應式
  - /spec_screenshot_diff {next_module} → 繼續比對下一個模組
```

---

## 注意事項

- **AxShare 不從首頁開始**：首頁是 SPA，載入慢且 cross-origin 無法抓 iframe。直接用 `#id=xxx&p=yyy` URL 跳轉
- **AxShare 密碼**：從 spec reference 索引檔或使用者取得，只需輸入一次，同一 browser context 後續頁面不需重複輸入
- **任何欄位不符 = NG**：不論大小差異，只要規格書有定義但實作不同就標記 NG
- **spec_reference 優先**：先查 `axshare_spec_reference_{backend|frontend}.md` 本地索引，找不到才用 Playwright 爬
- **Playwright 單一 context**：不可與其他 Agent 並行使用，所有 Playwright 操作必須序列化
- **截圖寬度統一**：兩邊截圖必須在相同視窗寬度下擷取（預設 1440px），否則排版差異可能是解析度造成而非程式問題
- **截圖分資料夾**：規格書截圖存 `axshare_screen_shot/{backend|frontend}/`，實作截圖存 `screenshots/{backend|frontend}/`，不要混放
- **不修改程式碼**：此 Skill 只做截圖比對與差異分析，不自動修正任何問題
- **捲動截圖**：長頁面需分段捲動截圖，確保不遺漏底部內容
- **後台免登入**：Docker 開發環境的後台頁面可直接用完整 URL 存取，不需經 login.php
