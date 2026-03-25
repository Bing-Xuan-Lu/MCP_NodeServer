---
name: pdf
description: |
  處理 PDF 檔案：讀取、建立、合併、拆分、旋轉、浮水印、表單填寫、OCR 掃描。涵蓋：
  文字與表格萃取、多檔合併、單頁拆分、加密解密、圖片擷取。
  當使用者說「讀 PDF」「合併 PDF」「拆分 PDF」「PDF 轉文字」「PDF OCR」時使用。
---

# /pdf — PDF 讀取、建立、合併、拆分與 OCR

你是 PDF 處理專家，能透過 MCP 工具讀取 PDF 內容，並透過 Python 腳本（pypdf/pdfplumber/reportlab）執行建立、合併、拆分等操作。

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `read_pdf_file` | 讀取 PDF 內容（Markdown/Text 格式） |
| `read_pdf_files_batch` | 批次讀取多個 PDF |
| `run_python_script` | 執行 Python 腳本（pypdf/pdfplumber/reportlab/pytesseract） |
| `Bash` | 執行 poppler 命令列工具（pdftotext、pdfimages） |

---

## 執行步驟

### 步驟 1：判斷任務類型

| 任務 | 工具 |
|------|------|
| 讀取/分析文字內容 | `read_pdf_file` MCP 工具 |
| 提取表格資料 | `pdfplumber`（Python） |
| 合併 PDF | `pypdf.PdfWriter` |
| 拆分 PDF | `pypdf.PdfWriter`（逐頁） |
| 建立新 PDF | `reportlab` |
| OCR 掃描文件 | `pytesseract` + `pdf2image` |
| 批次文字提取 | `poppler pdftotext` |

---

### 步驟 2：讀取內容

```
read_pdf_file({path: "檔案路徑"})
→ 回傳 Markdown 格式（含標題、段落、可識別的表格）
→ 若需精確表格：改用 pdfplumber
```

---

### 步驟 3：Python 操作範例

**合併 PDF：**
```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as f:
    writer.write(f)
```

**拆分 PDF（每頁獨立）：**
```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as f:
        writer.write(f)
```

**提取表格（pdfplumber）：**
```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            for row in table:
                print(row)
```

**建立新 PDF（reportlab）：**
```python
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

c = canvas.Canvas("output.pdf", pagesize=A4)
width, height = A4
c.setFont("Helvetica", 12)
c.drawString(72, height - 72, "標題文字")
c.showPage()
c.save()
```

**OCR 掃描文件：**
```python
import pytesseract
from pdf2image import convert_from_path

pages = convert_from_path("scanned.pdf", dpi=300)
full_text = ""
for page in pages:
    text = pytesseract.image_to_string(page, lang="chi_tra+eng")
    full_text += text + "\n"
print(full_text)
```

---

## 圖片型 PDF 逐頁截圖（Playwright）

適用：掃描版 PDF、手寫標注截圖 PDF（`read_pdf_file` 回傳「此頁無文字內容」時使用）

### 流程

1. **用 Playwright 開啟 PDF**
   ```
   browser_navigate → file:///absolute/path/to/file.pdf
   ```
   > 瀏覽器內建 PDF viewer 會自動渲染

2. **取得總頁數**（透過 PDF viewer API）
   ```js
   browser_evaluate → () => {
     // Chrome PDF viewer exposes page count
     const pages = document.querySelectorAll('.page');
     return pages.length || document.querySelector('[data-page-count]')?.dataset?.pageCount || 'unknown';
   }
   ```
   > 如果無法取得頁數，用滾動到底部的方式逐頁截圖直到沒有新內容

3. **逐頁截圖**
   ```js
   // 方法 A：滾動 + viewport 截圖
   browser_evaluate → (pageNum) => {
     const page = document.querySelector(`[data-page-number="${pageNum}"]`);
     if (page) { page.scrollIntoView(); return true; }
     return false;
   }
   browser_take_screenshot → { filename: "screenshots/pdf/{name}_p{N}.png" }

   // 方法 B：用 Node.js pdf-lib + canvas（如果 Playwright 方式不穩定）
   // 需要 npm install pdfjs-dist canvas
   ```

4. **截圖存檔命名**
   - 目標目錄：`screenshots/pdf/`
   - 格式：`{pdf_filename}_p{01}.png`, `{pdf_filename}_p{02}.png`, ...

5. **逐頁閱讀截圖**（用 Read tool 讀取 PNG）
   ```
   Read → screenshots/pdf/{name}_p01.png  （Claude 是 multimodal，可直接讀圖）
   ```

### 注意事項
- Chrome PDF viewer 的 DOM 結構可能因版本不同而變化
- 大型 PDF（>50頁）建議分批截圖，每批 10 頁
- 截圖完成後可刪除暫存檔或保留供後續參考

---

### 步驟 4：產出報告

```
✅ PDF 處理完成！

📄 輸出：{檔案路徑}
📊 統計：
  頁數：N 頁
  處理方式：{合併/拆分/建立/OCR}

⚠️ 需人工確認：（若有版面異常或 OCR 低信心區段）
```

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| 中文 OCR 亂碼 | 語言包未安裝 | `lang="chi_tra"` 需要 `tesseract-ocr-chi-tra` |
| pdfplumber 找不到表格 | 掃描版 PDF | 先 OCR 轉文字再解析 |
| reportlab 中文無法顯示 | 預設字型不含中文 | 註冊 TTF 字型後使用 |

---

## 注意事項

- 加密 PDF 需先解密才能操作（`reader.decrypt("密碼")`）
- pypdf 適合結構操作；pdfplumber 適合內容提取；reportlab 適合建立新文件
- OCR 前將 DPI 設為 300 以上，確保辨識率
- 大檔案（100頁以上）考慮分批處理，避免記憶體不足
