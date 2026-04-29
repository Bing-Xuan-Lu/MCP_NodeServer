---
name: axshare_spec_index
description: "擷取 AxShare 規格書內容。當使用者貼 axshare.com 連結、說「擷取規格」「爬規格」「抓規格」時使用。注意：使用者說「比對規格」「校閱」時應改用 /axshare_diff。"
---

# /axshare_spec_index — 爬取 AxShare 規格書並建立本地索引

你是規格書索引建立專家。支援兩種模式：

- **單頁模式**：使用者貼了 AxShare 連結，快速擷取該頁完整內容
- **全站模式**：爬取整份規格書，存成本地 Markdown 索引檔供 `/axshare_diff` 使用

---

## 使用者輸入

$ARGUMENTS

---

## 模式判斷（重要）

| 使用者輸入 | 模式 | 說明 |
|-----------|------|------|
| AxShare URL（無其他指令）| **單頁模式** | 擷取該頁完整內容並輸出 |
| AxShare URL +「全站」「建索引」「全部爬」| 全站模式 | 爬取全站並存檔 |
| `/axshare_spec_index` 無 URL | 全站模式 | 詢問來源後爬全站 |
| AxShare URL +「比對」「校閱」| **不觸發本 Skill** | 應改用 `/axshare_diff` |

---

## 需要的資訊

### 單頁模式
| 參數 | 必要 | 說明 |
|------|------|------|
| AxShare 頁面 URL | 是 | 從使用者輸入取得，不需額外詢問 |

### 全站模式
| 參數 | 說明 | 範例 |
|------|------|------|
| 規格書來源 | AxShare 網址 或 本地匯出目錄 | `https://xxx.axshare.com` 或 `D:\specs\export\` |
| 輸出目錄 | 索引檔存放目錄 | `D:\Project\{ProjectFolder}\spec\` |
| 掃描範圍 | 全部頁面 或 指定模組 | `全部` 或 `首頁管理,訂單管理` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `browser_navigate` | 開啟規格書頁面 |
| `browser_snapshot` | 擷取頁面 accessibility tree |
| `browser_evaluate` | 從 iframe 中抽取導航連結清單 |
| `list_files` | 掃描本地匯出目錄找 HTML 檔案 |
| `create_file` | 寫入索引檔 |

---

## 單頁模式（使用者貼了 AxShare 連結時）

> **此模式不需詢問任何額外資訊，直接執行。**

### S1：開啟頁面

```
browser_navigate(url: "{使用者貼的 AxShare URL}")
```

### S2：用 browser_evaluate 擷取完整內容

> **核心方法**：AxShare 內容在 iframe 中，用 JS 直接從 iframe DOM 抽取比 snapshot 更完整。
>
> 抽取腳本放在 `_axshare_spec_index/extract_iframe_script.md`，讀取後將「完整內容抽取」段落貼進 `browser_evaluate` 的 `script` 參數執行。

### S3：整理並輸出

將 browser_evaluate 取得的結構化資料整理為可讀格式：

1. **頁面標題**
2. **文字內容**：所有文字按出現順序列出，保留功能說明、備註、注意事項等區塊的完整性
3. **表格**：還原為 Markdown 表格格式
4. **表單欄位**：列出所有 input/select/textarea
5. **連結**：列出頁面內的跨頁引用

直接輸出到對話中（不存檔），格式：

```
📄 AxShare 規格書擷取：{頁面標題}
來源：{URL}

---

{完整內容，保留所有區塊}
```

> **提示**：若使用者後續要全站建索引，建議執行 `/axshare_spec_index`（全站模式）。
> 若要比對實作差異，建議執行 `/axshare_diff`。

---

## 全站模式

### 步驟 1：確認來源與輸出

詢問使用者確認：
- 規格書來源（A. AxShare 網址 / B. 本地匯出 HTML）
- 輸出目錄（預設 `{ProjectFolder}/spec/`）
- 掃描範圍（預設全部）

顯示計畫後等使用者確認再開始。

> 輸出固定為兩個檔案（按前後台分離），不可合併成單檔：
> - `spec/axshare_spec_reference_backend.md` — 後台頁面
> - `spec/axshare_spec_reference_frontend.md` — 前台頁面

---

### 步驟 2：取得所有頁面清單

#### 來源 A — AxShare 網址

> AxShare 使用多層 iframe，nav 無法直接 click，必須用 `browser_evaluate` 抽取連結。

```
1. browser_navigate(url: "{AxShare 網址}")
2. browser_snapshot() → 確認載入成功

3. browser_evaluate(script: 讀取 `_axshare_spec_index/extract_iframe_script.md` 的「全站模式 nav 連結抽取」段落)
   → 取得完整頁面清單 [{ text: "頁面名稱", href: "完整URL" }, ...]
```

若 browser_evaluate 無法取得（cross-origin），改用 browser_snapshot 手動整理清單。

#### 來源 B — 本地匯出 HTML

```
1. list_files("{匯出目錄}") → 列出所有 .html 檔案
2. 過濾排除 index.html、frame_*.html 等框架檔
3. 每個 .html 檔案對應一個規格頁面
4. 啟動本地 HTTP server：
   cd "{匯出目錄}" && python -m http.server 8099 &
5. 用 curl http://localhost:8099 確認啟動成功
```

整理輸出：`[{ text: "頁面名稱", href: "http://localhost:8099/{page}.html" }, ...]`

---

### 步驟 2b：分類前台 / 後台

根據 AxShare 導航樹的結構，將頁面分為兩組：

```
分類規則（依導航樹的父節點判斷）：
- 「後台」組：父節點為「後台」「後台管理」「adminControl」或類似名稱的頁面
- 「前台」組：父節點為「前台」「前台頁面」或類似名稱的頁面
- 「共用」頁面（如「主機架構環境」「規格說明」「網站大單元架構」）：
  兩份索引都包含，放在最前面的「通用規格」區塊

若導航樹無明確前後台分層，依頁面名稱關鍵字判斷：
- 含「管理」「列表」「新增」「編輯」「設定」→ 後台
- 含「首頁」「商品頁」「購物車」「結帳」「會員中心」→ 前台
- 無法判斷 → 兩份都放
```

產出兩份頁面清單：`backendPages[]` 和 `frontendPages[]`

---

### 步驟 3：逐頁擷取內容

對每個頁面（若掃描範圍有限制，只處理指定模組）：

```
1. browser_navigate(url: "{頁面直連 URL}")
2. browser_snapshot() → 取得 accessibility tree

3. 從 snapshot 解析並記錄：
   - 頁面標題 / 模組歸屬
   - 篩選區（必須記載 UI 控件類型與分組，見下方規則）
   - 表單欄位（label + input type + required）
   - 下拉選單選項（若有）
   - 按鈕清單（文字 + 功能描述）
   - 表格欄位標頭（含表格內所有行列資料，不可只取標頭）
   - 日期標記（如「20260304 新增」格式）
   - **跨頁引用**（見下方規則）
```

> **⚠️ 關鍵：所有註解區塊必須原文照抄，不可精簡或摘要**
>
> AxShare 規格書每頁可能包含以下 5 種註解區塊（以色塊標記），全部必須擷取：
>
> | 色塊 | 標識文字 | 處理方式 |
> |------|---------|---------|
> | 綠色 | **功能說明** | 原文照抄所有條目，包含編號 |
> | 黃色 | **備註內容** | 原文照抄，含業務規則、計算公式、例外條件 |
> | 紅色 | **注意事項** | 原文照抄，這些通常是容易出錯的關鍵規則 |
> | 紫色 | **日期修正/更新**（如 `20260304修正`）| 原文照抄，含修正日期和變更內容 |
> | 藍色 | **待確認事項 / 達格-待確認事項** | 原文照抄，標示尚未定案的規格 |
>
> **禁止**：
> - 把多行功能說明濃縮成一句話
> - 省略「備註」或「注意事項」區塊（這些是最常漏掉且最常造成開發錯誤的內容）
> - 只記欄位名稱而忽略欄位旁的說明文字、placeholder、計算規則
>
> **驗證**：每頁擷取完成後，比對 snapshot 中所有 paragraph 節點，確認沒有遺漏的文字區塊

> **⚠️ 篩選區必須記載 UI 控件類型與分組關係**
>
> 只寫欄位名稱（如「訂單日期區間、出貨日期區間、關鍵字」）**不合格**，無法判斷 UI 實作方式。
>
> 必須記載：
> | 項目 | 說明 | 範例 |
> |------|------|------|
> | 控件類型 | dropdown / date-pair / text / radio / checkbox / toggle | `date-pair` |
> | 分組關係 | 哪些欄位獨立、哪些共用 dropdown 切換 | `日期類型(dropdown) + 日期區間(共用 date-pair)` |
> | 欄位數量 | 幾個 input / 幾個 select | `2 組 date-pair = 4 個 input` |
>
> **正確格式**：
> ```
> 篩選：
> - 訂單日期區間（date-pair：起日 + 迄日）
> - 出貨日期區間（date-pair：起日 + 迄日）
> - 關鍵字（text + dropdown 類型選擇）
> - 訂單狀態（dropdown）
> ```
>
> **錯誤格式**（禁止）：
> ```
> 篩選：訂單日期區間、出貨日期區間、關鍵字
> ```
>
> **為什麼重要**：「2 組獨立 date-pair」vs「1 個 dropdown 切換 + 1 組共用 date-pair」對應完全不同的後端參數結構與 SQL 條件。

> **⚠️ 跨頁引用必須擷取並記錄**
>
> AxShare 規格書頁面常用文字引用其他頁面的定義（如「詳見 XX 頁面」「參照 YY 列表」）。這些引用**必須**記錄到索引中，供 `/axshare_diff` 判斷掃描範圍。
>
> **觸發關鍵字**（snapshot 文字中出現即需記錄）：
> - 參照、參考、詳見、見、請見、連結、Link、Ref
> - 同 XX 頁面、與 XX 相同、依 XX 規則
>
> **記錄格式**：在每頁的結構化資料末尾加上：
> ```
> **跨頁引用**：
> - → {被引用的頁面名稱}（原文：「詳見 XX 頁面的欄位定義」）
> - → {被引用的頁面名稱}（原文：「參照 YY 列表」）
> ```
>
> **為什麼重要**：若只掃描目標模組頁面，會遺漏在其他頁面定義的欄位規格、共用邏輯、狀態機規則。`/axshare_diff` 需要這些引用來自動擴展掃描範圍。

---

### 步驟 4：整理結構化索引（分前後台兩份）

分別對 `backendPages[]` 和 `frontendPages[]` 各整理一份 Markdown，格式相同：

```markdown
# AxShare 規格書索引（後台 / 前台）
來源: {規格書 URL 或 本地路徑}
建立時間: {今日日期}
頁面總數: N 頁

---

## 頁面索引
- [{頁面名稱}](#{anchor}) — {模組歸屬}
- ...

---

## {模組名稱}

### {頁面名稱}（{URL}）

**篩選**：（列表頁才有，記載控件類型與分組）
- 訂單日期區間（date-pair：起日 + 迄日）
- 關鍵字（text + dropdown 類型選擇）
- 訂單狀態（dropdown）

**欄位清單**
| # | 欄位名稱 | 類型 | 必填 | 備註 |
|---|---------|------|------|------|
| 1 | 標題 | text | 是 | 最多 100 字 |

**按鈕**：儲存、取消、返回列表

**功能說明**：（原文照抄綠色區塊所有條目）
1. xxx
2. xxx

**備註**：（原文照抄黃色區塊）
- xxx

**注意事項**：（原文照抄紅色區塊）
- xxx

**日期修正/更新**：（原文照抄紫色區塊，含日期）
- 20260304修正：xxx

**跨頁引用**：（若有引用其他頁面，列出被引用頁面與原文）
- → {被引用頁面名稱}（原文：「詳見 XX」）

---
```

> 若某頁面沒有某種區塊，該區段**省略不寫**（不要寫「無」）。
> 但只要 snapshot 中有對應文字，就**必須**出現在索引中。

---

### 步驟 5：寫入索引檔（兩份）

```
create_file(
  path: "{輸出目錄}/axshare_spec_reference_backend.md",
  content: {後台頁面的完整 Markdown}
)

create_file(
  path: "{輸出目錄}/axshare_spec_reference_frontend.md",
  content: {前台頁面的完整 Markdown}
)
```

寫入後顯示統計摘要：

```
✅ 規格書索引建立完成！

📊 統計：
  後台頁面：X 頁（axshare_spec_reference_backend.md, ~XX KB）
  前台頁面：Y 頁（axshare_spec_reference_frontend.md, ~XX KB）
  涵蓋模組：M 個
  有日期標記的頁面：K 頁

📄 輸出檔案：
  {輸出目錄}/axshare_spec_reference_backend.md
  {輸出目錄}/axshare_spec_reference_frontend.md

下次執行 /axshare_diff 時，會自動讀取對應檔案，
無需重新爬取規格書。
```

---

## 輸出

- `{ProjectFolder}/spec/axshare_spec_reference_backend.md`：後台規格書索引
- `{ProjectFolder}/spec/axshare_spec_reference_frontend.md`：前台規格書索引

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| browser_evaluate 取到空陣列 | AxShare iframe cross-origin 限制 | 用 browser_snapshot 手動整理頁面清單 |
| 本地 HTML 用 file:// 開啟失敗 | Playwright MCP 封鎖 file:// 協定 | 必須先啟動 `python -m http.server` |
| 頁面 snapshot 內容為空 | JS 尚未渲染 | 加一秒等待後重新 snapshot |
| 中文檔名 URL 404 | 需 URL encode | 用 `encodeURIComponent()` 轉換後再 navigate |

---

## 注意事項

- 索引檔是**靜態快照**，規格書更新後需重新執行此 Skill 更新
- 建議儲存路徑與專案 git 同層，方便版控追蹤規格書變更
- 本地匯出模式啟動的 HTTP server 在 session 結束後自動停止
- 此 Skill 只讀取規格書，不連線測試網站，不需要登入資訊
