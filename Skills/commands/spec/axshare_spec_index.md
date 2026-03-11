---
name: axshare_spec_index
description: |
  一次性爬取整份 AxShare 規格書並存成本地 Markdown 索引檔。涵蓋：自動抽取所有頁面 URL、逐頁擷取欄位/按鈕/邏輯、輸出結構化快照供 axshare_diff 直接讀取（不需每次重爬）。
  當使用者說「建規格書索引」「axshare 快照」「spec reference」「先把規格書存下來」時使用。
---

# /axshare_spec_index — 爬取 AxShare 規格書並建立本地索引

你是規格書索引建立專家。一次性爬取整份 AxShare 規格書（或本地 HTML 匯出），將每個頁面的結構化內容存成本地 Markdown 索引檔，讓後續的 `/axshare_diff` 可以直接讀取，無需每次重爬。

---

## 使用者輸入

$ARGUMENTS

---

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

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

## 執行步驟

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

3. browser_evaluate(script: `
     const frames = Array.from(document.querySelectorAll('iframe'));
     const links = [];
     frames.forEach(f => {
       try {
         f.contentDocument.querySelectorAll('a[href]').forEach(a => {
           const text = a.textContent.trim();
           const href = a.href;
           if (text && href) links.push({ text, href });
         });
       } catch(e) {}
     });
     // fallback：從主頁面找 AxShare hash 格式連結
     if (links.length === 0) {
       document.querySelectorAll('a[href*="#p="],a[href*="#id="]').forEach(a => {
         links.push({ text: a.textContent.trim(), href: a.href });
       });
     }
     return links;
   `)
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
   - 表單欄位（label + input type + required）
   - 下拉選單選項（若有）
   - 按鈕清單（文字 + 功能描述）
   - 表格欄位標頭
   - 特殊邏輯說明（規格書中的文字描述、條件、規則）
   - 日期標記（如「20260304 新增」格式）
```

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

**欄位清單**
| # | 欄位名稱 | 類型 | 必填 | 備註 |
|---|---------|------|------|------|
| 1 | 標題 | text | 是 | 最多 100 字 |

**按鈕**：儲存、取消、返回列表

**特殊邏輯**
- 日期預設今天
- 狀態 [啟用/停用] 預設啟用

**日期標記**：（如有）20260304 新增「排序欄位」

---
```

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
