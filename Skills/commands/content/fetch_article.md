---
name: fetch_article
description: |
  從網頁 URL 擷取文章正文並**儲存為 .txt 檔案**（持久化存檔用）。涵蓋：移除廣告/導覽列等雜訊、輸出純文字、指定本機存檔路徑。
  當使用者說「把這篇存下來」「下載文章」「抓到本機」「archive 這篇」時使用；若只是想當場閱讀摘要，改用 /read_article。
---

# /fetch_article — 從網頁 URL 擷取並儲存純文字文章

你是網頁文章擷取專家，從指定 URL 萃取出乾淨的文章正文，移除廣告、導覽列、頁尾等雜訊，並儲存為 .txt 檔案。

---

## 使用者輸入

$ARGUMENTS

若 `$ARGUMENTS` 提供了 URL，則擷取該網頁。否則詢問使用者要擷取哪篇文章的 URL。

---

## 可用工具

- **網路請求**：`send_http_request`
- **檔案寫入**：`create_file`

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| URL | 要擷取的文章網址 | `https://example.com/article/123` |
| 儲存目錄（選填）| 輸出的 .txt 存放位置 | 預設當前目錄 |

---

## 執行步驟

### 步驟 1：確認可用工具

依優先順序檢查工具是否已安裝：

```bash
# 優先：trafilatura（Python，部落格 / 新聞效果佳）
python -c "import trafilatura" 2>/dev/null && echo "trafilatura OK"

# 次選：curl（不需額外安裝）
curl --version
```

確認工具後告知使用者將使用哪個工具擷取。

---

### 步驟 2：擷取文章內容

**方案 A — 使用 trafilatura（推薦）：**

```bash
python -c "
import trafilatura
downloaded = trafilatura.fetch_url('URL')
result = trafilatura.extract(downloaded, include_comments=False, include_tables=False)
print(result)
"
```

**方案 B — 使用 curl 備用：**

```bash
curl -s -L -A "Mozilla/5.0" "URL" | python -c "
import sys, re
html = sys.stdin.read()
# 移除 script / style / nav / header / footer
html = re.sub(r'<(script|style|nav|header|footer)[^>]*>.*?</\1>', '', html, flags=re.DOTALL|re.IGNORECASE)
# 移除所有 HTML 標籤
text = re.sub(r'<[^>]+>', '', html)
# 清理多餘空白
text = re.sub(r'\n{3,}', '\n\n', text).strip()
print(text)
"
```

---

### 步驟 3：擷取標題並建立安全檔名

從文章內容或 `<title>` 標籤取得標題，轉換為安全檔名：

- 移除 `/`、`:`、`?`、`*`、`"`、`<`、`>` 等不合法字元
- 空格改為 `_`
- 截斷至 80 字元
- 附加 `.txt` 副檔名

---

### 步驟 4：儲存並預覽

將擷取內容儲存到指定目錄：

```
<output-dir>/<sanitized-title>.txt
```

顯示前 15 行作為預覽，讓使用者確認擷取品質。

若預覽內容看起來還是包含廣告或導覽列雜訊，自動切換備用方案重試。

---

### 步驟 5：產出報告

```
✅ 文章擷取完成！

📊 統計：
  來源 URL：<url>
  使用工具：trafilatura / curl
  字元數：N 字
  儲存路徑：<file-path>

📝 預覽（前 10 行）：
  <article content preview>

⚠️ 需人工確認：
  - （若有）擷取品質疑慮，建議改用其他工具
```

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| 擷取到大量廣告文字 | 網站使用動態渲染 | 改用備用方案或搭配 `/playwright_ui_test` |
| 輸出為空白 | 網站需要登入或防爬蟲 | 告知使用者手動複製內容 |
| 中文標題亂碼 | 編碼問題 | 加入 `encoding='utf-8'` 參數 |

---

## 注意事項

- 只擷取使用者明確指定的 URL，不自行猜測或修改
- 不抓取需要登入的付費內容
- 預覽後若品質不佳，優先切換工具而非放棄
- 適合用於：技術文章、部落格、新聞；不適合：動態 SPA、需登入的頁面
- 擷取完成後可搭配 `/yt_transcript` 整合多種媒體內容
