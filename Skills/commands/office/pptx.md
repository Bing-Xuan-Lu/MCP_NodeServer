---
name: pptx
description: |
  建立、編輯、解析 PowerPoint 簡報（.pptx）。涵蓋：從零建立投影片、從範本修改、
  內容萃取、設計主題選擇（10 套色彩方案）、視覺 QA。
  當使用者說「建立簡報」「做投影片」「編輯 pptx」「deck」「slides」時使用。
---

# /pptx — 建立、編輯與解析 PowerPoint 簡報

你是投影片設計專家，能透過 MCP 工具讀取 .pptx 內容，並透過 pptxgenjs 或 XML 修改建立/編輯專業級簡報。設計原則：**拒絕 AI 刻板美學**，每份簡報都有獨特視覺語言。

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `read_pptx_file` | 讀取 .pptx 內容（Markdown/Text 格式） |
| `read_pptx_files_batch` | 批次讀取多個 .pptx |
| `run_python_script` | 執行 Python 腳本（XML 解包、LibreOffice 轉圖） |
| `Bash` | 執行 pptxgenjs、markitdown |

---

## 執行步驟

### 步驟 1：判斷任務類型

| 任務 | 方法 |
|------|------|
| 讀取/分析內容 | `read_pptx_file` MCP 工具 |
| 從零建立 | pptxgenjs（Node.js） |
| 修改現有簡報 | 解包 XML → 修改 → 重打包 |
| 轉為圖片預覽 | LibreOffice + pdftoppm |

---

### 步驟 2：讀取內容

```
read_pptx_file({path: "檔案路徑"})
→ 回傳每頁文字內容與備註
→ 若需要視覺概覽：用 LibreOffice 轉 PDF 再轉圖片
```

---

### 步驟 3：設計決策（建立新簡報前必做）

**選擇色彩主題**（從下列 10 套中選一，或依主題自訂）：

| 主題 | 主色 | 輔色 | 強調色 |
|------|------|------|--------|
| Midnight Executive | `#1E2761`（深藍） | `#CADCFC`（冰藍） | `#FFFFFF` |
| Forest & Moss | `#2C5F2D`（森林綠） | `#97BC62`（苔綠） | `#F5F5F5` |
| Coral Energy | `#F96167`（珊瑚紅） | `#F9E795`（金） | `#2F3C7E` |
| Warm Terracotta | `#B85042`（赭紅） | `#E7E8D1`（沙色） | `#A7BEAE` |
| Ocean Gradient | `#065A82`（深藍） | `#1C7293`（青） | `#21295C` |
| Charcoal Minimal | `#36454F`（炭灰） | `#F2F2F2`（淺灰） | `#212121` |
| Teal Trust | `#028090`（藍綠） | `#00A896`（海泡） | `#02C39A` |
| Berry & Cream | `#6D2E46`（莓紅） | `#A26769`（藕粉） | `#ECE2D0` |
| Sage Calm | `#84B59F`（鼠尾草綠） | `#69A297` | `#50808E` |
| Cherry Bold | `#990011`（深紅） | `#FCF6F5`（米白） | `#2F3C7E` |

**設計原則：**
- 主色佔視覺比重 60-70%，搭配 1-2 個輔色與一個強調色
- 首尾投影片深色背景，內容頁淺色（「三明治」結構）；或全程深色調
- 每張投影片必須有視覺元素（圖片、圖表、圖示或形狀），禁止純文字頁
- 選定一個視覺主題（圓角圖框 / 彩色圓形圖示 / 粗邊框），全程貫穿
- **禁止**在標題下加裝飾線（AI 刻板元素）
- **禁止**正文置中對齊（只有標題置中）

**字型配對：**
| 標題字型 | 內文字型 |
|---------|---------|
| Georgia | Calibri |
| Arial Black | Arial |
| Cambria | Calibri |
| Trebuchet MS | Calibri |

字級：標題 36-44pt、段落標題 20-24pt、內文 14-16pt、說明文字 10-12pt

---

### 步驟 4：從零建立（pptxgenjs）

```javascript
// 安裝：npm install -g pptxgenjs
const PptxGenJS = require("pptxgenjs");
const pptx = new PptxGenJS();

// 設定主題
pptx.defineLayout({ name: "CUSTOM", width: 13.33, height: 7.5 });

// 標題投影片
let slide = pptx.addSlide();
slide.background = { color: "1E2761" };
slide.addText("簡報標題", {
  x: 1, y: 2.5, w: 11, h: 1.5,
  fontSize: 44, bold: true, color: "FFFFFF", align: "center"
});

// 內容投影片
let slide2 = pptx.addSlide();
slide2.addText("章節標題", { x: 0.5, y: 0.3, w: 12, h: 0.8, fontSize: 32, bold: true });
slide2.addText([
  { text: "重點一", options: { bullet: true, fontSize: 16 } },
  { text: "重點二", options: { bullet: true, fontSize: 16 } },
], { x: 0.5, y: 1.3, w: 6, h: 4 });

await pptx.writeFile({ fileName: "output.pptx" });
```

---

### 步驟 5：視覺 QA（必做）

```bash
# 檢查內容完整性
python -m markitdown output.pptx

# 檢查是否有殘留佔位符文字
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|placeholder"
```

**QA 檢核清單：**
- [ ] 每頁都有視覺元素
- [ ] 字型大小對比足夠（標題 36pt+，內文 14-16pt）
- [ ] 顏色對比度足夠（深色背景配淺色文字）
- [ ] 無殘留佔位符文字
- [ ] 首尾投影片風格一致（「三明治」結構）

---

### 步驟 6：產出報告

```
✅ 簡報處理完成！

📄 輸出：{檔案路徑}
📊 統計：
  投影片數：N 頁
  色彩主題：{主題名}
  設計模式：{從零建立/範本修改}

⚠️ QA 提醒：（若有發現問題）
```

---

## 注意事項

- 「從零建立」用 pptxgenjs；「修改現有」用 XML 解包
- 不要每頁套用相同版型，版型要多樣化（雙欄、網格、大數字展示、時間軸）
- 大型數據展示用 60-72pt 大字搭配小標籤，視覺衝擊力強
- 禁止使用 Arial / Roboto / Inter 作為標題字型
