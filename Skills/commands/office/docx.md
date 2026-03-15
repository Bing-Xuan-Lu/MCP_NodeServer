---
name: docx
description: |
  建立、編輯、解析 Word 文件（.docx）。涵蓋：新建文件、XML 直接修改、tracked changes 處理、
  表格/標題/頁首頁尾操作、.doc 轉換、內容萃取。
  當使用者說「建立 Word 檔」「編輯 docx」「Word 報告」「修改追蹤變更」時使用。
---

# /docx — 建立、編輯與解析 Word 文件（.docx）

你是 Word 文件處理專家，能透過 MCP 工具讀取 .docx 內容，並透過 docx-js 或 XML 直接操作建立/修改文件。

---

## 背景

.docx 是 ZIP 壓縮的 XML 檔案。建立新文件推薦用 `docx-js`（Node.js）；修改現有文件則用解包 XML → 修改 → 重打包的方式，可精確控制格式。

---

## 使用者輸入（可選）

$ARGUMENTS

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `read_word_file` | 讀取 .docx 內容（Markdown/HTML/Text 格式） |
| `read_word_files_batch` | 批次讀取多個 .docx |
| `run_python_script` | 執行 Python 腳本（XML 解包、LibreOffice 轉換） |
| `Bash` | 執行 docx-js、pandoc、LibreOffice 指令 |
| `create_file` / `apply_diff` | 寫入/修改文件 |

---

## 執行步驟

### 步驟 1：判斷任務類型

根據使用者需求選擇路徑：

| 任務 | 方法 |
|------|------|
| 讀取/分析內容 | `read_word_file` MCP 工具 |
| 建立新文件 | docx-js（`npm install -g docx`） |
| 修改現有文件 | 解包 XML → 修改 → 重打包 |
| .doc 轉 .docx | LibreOffice `--convert-to docx` |

---

### 步驟 2：讀取（如需分析現有文件）

```
read_word_file({path: "檔案路徑", format: "markdown"})
→ 回傳 Markdown 格式內容，含標題階層、表格、清單
→ 若需要原始 XML：改用 format: "html" 或解包方式
```

---

### 步驟 3：建立新文件（docx-js）

```javascript
// 安裝：npm install -g docx
const { Document, Paragraph, TextRun, Table } = require("docx");

const doc = new Document({
  sections: [{
    properties: {},
    children: [
      new Paragraph({
        children: [new TextRun({ text: "標題", bold: true, size: 32 })],
        heading: HeadingLevel.HEADING_1,
      }),
      new Paragraph({ children: [new TextRun("內文段落")] }),
    ],
  }],
});

// 輸出
const buffer = await Packer.toBuffer(doc);
fs.writeFileSync("output.docx", buffer);
```

重要格式規則：
- RSID 格式：8 位十六進位（如 `00AB1234`）
- 表格寬度：`columnWidths` + 每格 `width` 都要設定
- 智慧引號：用 XML entity（`&#x2019;`、`&#x201C;`、`&#x201D;`）
- 底色透明：用 `ShadingType.CLEAR`

---

### 步驟 4：修改現有文件（XML 方式）

```python
# 解包
import zipfile, shutil, os

def unpack_docx(docx_path, output_dir):
    with zipfile.ZipFile(docx_path, 'r') as z:
        z.extractall(output_dir)

# → 修改 output_dir/word/document.xml
# → 重打包
def repack_docx(input_dir, docx_path):
    with zipfile.ZipFile(docx_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(input_dir):
            for file in files:
                filepath = os.path.join(root, file)
                arcname = os.path.relpath(filepath, input_dir)
                z.write(filepath, arcname)
```

Tracked Changes 語法：
```xml
<!-- 刪除 -->
<w:del w:id="1" w:author="作者" w:date="2026-01-01T00:00:00Z">
  <w:r><w:delText>要刪除的文字</w:delText></w:r>
</w:del>
<!-- 插入 -->
<w:ins w:id="2" w:author="作者" w:date="2026-01-01T00:00:00Z">
  <w:r><w:t>要插入的文字</w:t></w:r>
</w:ins>
```

---

### 步驟 5：產出報告

```
✅ Word 文件處理完成！

📄 輸出：{檔案路徑}
📊 統計：
  頁數：N 頁
  段落：N 個
  表格：N 個

⚠️ 需人工確認：（若有格式異常）
```

---

## 注意事項

- 先用 `read_word_file` 理解現有文件結構，再動手修改
- 編輯 XML 前備份原始檔案
- docx-js 不支援 .doc 格式，舊檔先用 LibreOffice 轉換
- 智慧引號用 XML entity，不用直接貼 Unicode 字符
- Tracked Changes 的 `w:id` 不可重複
