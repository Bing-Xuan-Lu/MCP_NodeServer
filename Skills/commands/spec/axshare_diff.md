# AxShare 規格書 vs 測試網站 差異比對

搭配 Project Migration Assistant Pro MCP Server 使用。
此 Skill 不讀取 PHP 原始碼，純粹比對「規格書畫面」vs「網站實際渲染的 HTML」。

## 使用者輸入

$ARGUMENTS

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 資訊 | 說明 | 範例 |
|------|------|------|
| AxShare 網址 | Axure 規格書的 AxShare 連結 | `https://xxx.axshare.com` |
| 測試網站網址 | 測試網站的基礎 URL | `http://localhost/project/adminControl` |
| 比對頁面 | 要比對的頁面清單 | `list, add, detail, update` |
| 登入資訊 | 測試帳號密碼（後台通常需要登入） | `admin / password` |

## 執行步驟

### Step 0：確認規格書來源

詢問使用者提供規格書的方式：
- **A. AxShare 網址** → 用 `send_http_request` GET 抓取
- **B. 本地匯出 HTML** → 用 `list_files` + `read_file` 讀取 Axure 匯出檔案
- **C. 手動描述** → 使用者逐頁列出欄位/按鈕/流程

若 AxShare 回傳空殼 HTML（SPA），建議改用 B 或 C。

### Step 1：擷取規格書內容

從選定的來源擷取每個頁面的規格：
- 欄位清單（名稱、類型、是否必填）
- 按鈕清單
- 特殊邏輯（預設值、限制、驗證規則）

### Step 2：登入測試網站

後台頁面（adminControl）需要登入才能存取。

1. 詢問使用者：登入網址、帳號、密碼
2. GET 登入頁面，分析表單欄位名稱
3. POST 登入，取得 Set-Cookie 中的 PHPSESSID
4. 用 Cookie 存取一個後台頁面，驗證登入成功
5. 若 POST 登入失敗，請使用者從瀏覽器複製 Cookie

### Step 3：擷取測試網站內容

帶著 Step 2 的 Cookie，用 `send_http_request` GET 每個頁面，解析 HTML：
- `<form>` 中的 `<input>`, `<select>`, `<textarea>`
- `<button>` 和提交按鈕
- JavaScript 驗證邏輯
- `<table>` 表頭欄位

### Step 4：逐頁比對

比對項目：
- 欄位存在性、類型、必填屬性
- 按鈕存在性
- 流程完整性（CRUD）
- 文字/標籤一致性
- 特殊功能（上傳、匯出、列印）

### Step 5：產出差異報告

輸出三種格式：
1. **總覽表格** — 所有比對項目的狀態一覽
2. **逐頁比對** — 每個頁面的規格 vs 實作詳細對照
3. **待辦清單** — 缺少/差異項目的 TODO 清單

### Step 6：統計摘要

統計一致/差異/缺少的數量和比例，計算規格完成度。

## 比對準則

- 不讀取 PHP 原始碼，只比對規格書畫面 vs 網站渲染的 HTML
- 先完成兩端擷取再比對，不要邊抓邊猜
- 以規格書為基準，「缺少」= 規格有但實作沒有
- 若 AxShare 內容不足，主動建議替代方案
- 後台頁面必須先登入取得 Cookie 再抓取，不要拿登入頁 HTML 當比對內容
- 此 Skill 僅做分析報告，不修改任何程式碼
