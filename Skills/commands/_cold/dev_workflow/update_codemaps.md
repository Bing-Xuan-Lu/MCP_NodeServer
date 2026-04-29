# /update_codemaps — 掃描專案並產生 token 精簡架構文件

你是架構文件維護員，掃描專案目錄結構並產生精簡的架構地圖，讓 Claude 在大型 codebase 中快速定位關鍵檔案與流程。

---

## 背景

大型專案隨時間膨脹，Claude 每次對話都需重新理解結構。Codemaps 是一份 token 精簡的靜態快照，記錄路由、服務層、資料流等高層結構，讓 Claude 無需每次全量掃描即可快速掌握架構。

---

## 使用者輸入

$ARGUMENTS

可選：指定掃描目標路徑（預設為當前工作目錄）

---

## 可用工具

| 工具 | 用途 |
| ---- | ---- |
| `get_folder_contents` | 取得完整目錄樹狀結構（優先使用） |
| `list_files` / `list_files_batch` | 掃描目錄，取得檔案清單 |
| `read_file` / `read_files_batch` | 批次讀取關鍵入口檔（index.php、routes.php、config 等） |
| `create_file` | 產生 codemap.md |
| `apply_diff` | 更新既有 codemap.md（增量更新） |

---

## 執行步驟

### 步驟 1：識別專案類型

掃描根目錄，判斷專案類型：

- **PHP 後台**：有 `adminControl/`、`config.php`、`.php` 檔案為主
- **Node.js MCP**：有 `index.js`、`tools/`、`package.json`
- **混合專案**：兩者皆有

確認輸出目錄：優先使用 `docs/CODEMAPS/`，不存在時使用 `.reports/codemaps/`

---

### 步驟 2：掃描結構

依專案類型掃描：

**PHP 後台專案：**
```
list_files 或 Glob 掃描：
→ 找出所有 list.php / add.php / update.php / del.php（模組入口）
→ 找出 config.php（DB 設定）
→ 找出 common/（共用函式）
→ 找出 adminControl/（後台根目錄）
```

**Node.js / MCP 專案：**
```
→ 找出 index.js（主程式入口）
→ 找出 tools/*.js（工具模組）
→ 找出 skills/（MCP Prompts）
→ 掃描 package.json dependencies
```

---

### 步驟 3：產生 Codemap 檔案

在輸出目錄建立以下檔案（依專案類型選擇適用的）：

#### `architecture.md` — 系統全覽

```markdown
<!-- Generated: {date} | Files scanned: {N} | Token estimate: ~{X} -->
# Architecture Overview

## Project Type
{專案類型說明}

## Entry Points
{入口檔案清單}

## Key Directories
{重要目錄與用途}

## Data Flow
{ASCII 示意圖，例：Request → Controller → Service → DB}
```

#### `backend.md` — 後端結構

```markdown
<!-- Generated: {date} -->
# Backend Structure

## Routes / Modules
{模組名稱} → {入口檔} → {主要功能}

## Shared Libraries
{共用函式位置與用途}

## Config
{設定檔位置與關鍵設定項}
```

#### `data.md` — 資料層

```markdown
<!-- Generated: {date} -->
# Data Layer

## Database Connection
{連線設定來源}

## Key Tables (if discoverable from code)
{資料表名稱} — {用途}

## File Storage
{檔案上傳路徑}
```

#### `dependencies.md` — 依賴關係

```markdown
<!-- Generated: {date} -->
# Dependencies

## External Services
{服務名稱} — {用途} — {設定位置}

## Key Libraries
{套件名稱} — {版本} — {用途}
```

**格式原則（每份檔案）：**
- 每份保持在 1000 tokens 以內
- 用檔案路徑 + 功能說明，不貼整段程式碼
- ASCII 圖取代冗長描述

---

### 步驟 3b：死碼與 typo 偵測（PHP 專案）

掃描 PHP class 結構時順帶執行：

#### 死碼標記（0 引用 method）

對每個 class 的 public method：

```
1. 用 symbol_index 列出所有 method
2. 對每個 method 用 find_usages 統計呼叫次數
3. 若呼叫次數 = 0 且非框架保留方法（__construct/__destruct/__call/__get/__set/Action/handle*）：
   → 在 backend.md 標記為 ⚠️ DEAD: {ClassName}::{method}
```

#### Trait 拆分後的 typo 殘留

當 class 有 `use Trait` 時：

```
1. 讀取 trait 檔案，列出 trait 內所有 method 名
2. 在使用該 trait 的 class 內 grep 呼叫名（$this->xxx() / self::xxx()）
3. 找出「呼叫名 vs trait method 名」的拼字差異候選：
   - 編輯距離 ≤ 2（如 `pahment_chk` vs `payment_chk`）
   - 或前綴/後綴一字之差
   → 在 backend.md 標記為 🔤 TYPO 候選：{caller_file}:{line} 呼叫 `xxx`，疑似 trait method `yyy`
```

> **為什麼**：trait 拆分重構時容易留下舊呼叫名 typo，跑時才以 fatal 暴雷。靜態分析在 codemap 階段抓到。

#### 在 backend.md 加區塊

```markdown
## ⚠️ Dead Code Candidates
- {ClassName}::{method}  (file:line, 0 references)

## 🔤 Typo Candidates (Trait migration residue)
- {file}:{line} calls `{wrong_name}`, likely meant `{correct_name}` (in {trait})
```

---

### 步驟 4：差異偵測

若 Codemaps 已存在：

1. 比較新舊內容的差異程度
2. 若差異 > 30%：顯示主要差異，詢問使用者確認後再覆寫
3. 若差異 ≤ 30%：直接更新，在 freshness header 更新日期

---

### 步驟 5：輸出報告

```
✅ Codemaps 已更新！

📁 輸出位置：{output_dir}/
   architecture.md（{N} tokens）
   backend.md（{N} tokens）
   data.md（{N} tokens）
   dependencies.md（{N} tokens）

📊 掃描摘要：
   掃描檔案：{N} 個
   識別模組：{N} 個
   資料表：{N} 個（從 SQL 推測）

⚠️ 需人工確認：
   - （若有）超過 90 天未更新的 Codemap
   - （若有）發現新模組但無法分類
```

---

## 注意事項

- Codemaps 是靜態快照，每次大功能完成後重跑更新
- 不寫入任何密碼、帳號、IP 等敏感資訊
- token 估算：每行 ~5-10 tokens，保持每份 < 100 行
- 若無法確定資料表結構，標記 `(from code analysis)` 而非猜測
- `.reports/` 目錄應加入 `.gitignore`
