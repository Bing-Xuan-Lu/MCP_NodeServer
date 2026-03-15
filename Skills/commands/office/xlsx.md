---
name: xlsx
description: |
  建立、編輯、分析 Excel 試算表（.xlsx）。涵蓋：資料分析（pandas）、財務模型建立（openpyxl）、
  公式設定、格式化、圖表、公式重算（LibreOffice）。
  當使用者說「建立 Excel」「分析試算表」「財務模型」「xlsx 格式化」「做報表」時使用。
---

# /xlsx — 建立、編輯與分析 Excel 試算表

你是 Excel 試算表專家，能透過 MCP 工具分析現有 Excel 資料，並透過 Python 腳本（pandas/openpyxl）建立/修改試算表，嚴格遵守財務模型最佳實踐。

---

## 背景

核心原則：**永遠使用 Excel 公式，不得在 Python 中計算後寫入硬碼數值**。試算表必須在資料更新時自動重算。使用 openpyxl 建立含公式的檔案後，必須執行 LibreOffice 公式重算步驟。

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `get_excel_values_batch` | 讀取 Excel 儲存格值 |
| `trace_excel_logic` | 追蹤 Excel 公式邏輯 |
| `simulate_excel_change` | 模擬儲存格變更並預覽影響 |
| `run_python_script` | 執行 pandas/openpyxl 腳本 |
| `Bash` | 執行公式重算（LibreOffice） |

---

## 執行步驟

### 步驟 1：判斷任務類型

| 任務 | 工具 |
|------|------|
| 讀取/分析資料 | `get_excel_values_batch` + pandas |
| 追蹤公式邏輯 | `trace_excel_logic` |
| 建立新試算表 | openpyxl（含公式） |
| 資料清整/轉換 | pandas |
| 格式化/財務模型 | openpyxl + 公式重算 |

---

### 步驟 2：資料分析（pandas）

```python
import pandas as pd

# 讀取
df = pd.read_excel('file.xlsx')
all_sheets = pd.read_excel('file.xlsx', sheet_name=None)  # 所有分頁

# 分析
print(df.head())
print(df.describe())
print(df.info())

# 寫入（純資料，不含公式）
df.to_excel('output.xlsx', index=False)
```

---

### 步驟 3：建立含公式的試算表（openpyxl）

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, numbers

wb = Workbook()
ws = wb.active
ws.title = "財務模型"

# 欄位標題
headers = ["項目", "2024", "2025", "2026"]
for col, h in enumerate(headers, 1):
    ws.cell(1, col, h)

# 輸入假設（藍色 = 使用者可修改的硬碼輸入）
ws['B2'] = 1000000   # 基期營收
ws['B3'] = 0.15      # 成長率假設

# ✅ 正確：使用 Excel 公式，不在 Python 計算
ws['C2'] = '=B2*(1+$B$3)'   # 2025 營收
ws['D2'] = '=C2*(1+$B$3)'   # 2026 營收
ws['B10'] = '=SUM(B2:B9)'   # 合計
ws['C5'] = '=(C4-B4)/B4'    # 成長率%

# ❌ 錯誤：計算後硬碼
# ws['C2'] = 1150000  # 不要這樣做！
```

---

### 步驟 4：財務模型色彩規範

```python
from openpyxl.styles import Font, PatternFill

# 業界標準色彩規範
BLUE   = Font(color="0000FF")    # 硬碼輸入（使用者填入）
BLACK  = Font(color="000000")    # 公式與計算
GREEN  = Font(color="008000")    # 同一活頁簿的跨頁引用
RED    = Font(color="FF0000")    # 外部檔案連結
YELLOW = PatternFill("solid", fgColor="FFFF00")  # 需注意的假設

# 套用
ws['B2'].font = BLUE    # 輸入值
ws['C2'].font = BLACK   # 公式
ws['D5'].fill = YELLOW  # 重要假設

# 數字格式
ws['B2'].number_format = '$#,##0'       # 金額
ws['B3'].number_format = '0.0%'         # 百分比
ws['B4'].number_format = '0.0x'         # 倍數（EV/EBITDA）
# 零值顯示為 "-"：
ws['B5'].number_format = '$#,##0;($#,##0);-'
# 負數用括號：(123) 非 -123
```

---

### 步驟 5：公式重算（MANDATORY 若含公式）

```bash
# 使用 LibreOffice 重算，確保公式值正確
python scripts/recalc.py output.xlsx
# → 回傳 JSON，status: "success" 或 "errors_found"
# → 若有錯誤：檢查 error_summary 中的 #REF!、#DIV/0! 等
```

**必須無錯誤才算完成**：`#REF!`、`#DIV/0!`、`#VALUE!`、`#N/A`、`#NAME?` 一個都不能有。

---

### 步驟 6：產出報告

```
✅ Excel 試算表處理完成！

📄 輸出：{檔案路徑}
📊 統計：
  分頁數：N 個
  公式數：N 個
  公式重算：✅ 無錯誤

⚠️ 需人工確認：（若有假設值需確認）
```

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| `#REF!` | 儲存格引用失效（刪行/列後） | 修正公式範圍 |
| `#DIV/0!` | 除以零 | 加 `=IF(B2=0,"-",A2/B2)` 保護 |
| `#VALUE!` | 公式引用非數字 | 確認來源儲存格型態 |
| 公式未重算 | openpyxl 不計算公式 | 執行 `scripts/recalc.py` |

---

## 注意事項

- 年份格式為文字字串（`"2024"` 非數字 `2024`）
- 金額欄位標題需標明單位（如 `營收 ($千元)`）
- 所有假設集中放在假設區，不散落在公式中
- 假設儲存格旁邊加來源備註（格式：`來源：[文件名], [日期], [頁碼/章節]`）
- pandas 適合純資料操作；openpyxl 適合含公式/格式的財務模型
