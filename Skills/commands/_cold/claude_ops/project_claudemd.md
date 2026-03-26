# /project_claudemd — 為專案自動產生 CLAUDE.md 專案文件

## 可用工具

- **專案探索**：`list_files_batch`, `get_folder_contents`
- **程式碼讀取**：`read_files_batch`, `read_file`
- **輸出寫入**：`create_file`, `apply_diff`

## 背景
當接手新專案或需要讓 Claude 快速理解既有專案時，透過系統性探索產生一份結構化的 CLAUDE.md，涵蓋目錄結構、架構模式、業務模組與開發注意事項。

## 輸入
- `$ARGUMENTS` — 可選。額外指示，例如「要包含哪些報告」或「特別關注的模組」

## 步驟

### 1. 確認專案根目錄與基本資訊

```bash
# 確認 git repo、語言、框架
git remote -v 2>/dev/null
ls -la
```

若已存在 CLAUDE.md，詢問使用者：覆蓋 or 補充？

### 2. 探索目錄結構

用 Glob + ls 系統性掃描：

- 頂層目錄列表
- 各主要子目錄的檔案數量與用途
- 設定檔位置（config/、.env、docker-compose 等）
- 進入點檔案（index.php、app.js、Program.cs 等）

### 3. 讀取關鍵設定檔

根據專案語言/框架，讀取：

| 語言 | 優先讀取 |
|------|---------|
| PHP | config.php、composer.json、.htaccess |
| Node | package.json、tsconfig.json |
| .NET | *.csproj、appsettings.json、Program.cs |
| Python | requirements.txt、pyproject.toml、settings.py |

從設定檔提取：
- DB 連線方式與資料庫名稱
- 第三方服務整合（金流、社群登入、API）
- Autoload / DI 機制
- 環境變數與常數定義

### 4. 分析架構模式

讀取 2-3 個代表性檔案，識別：
- 框架與設計模式（MVC、Repository、無框架等）
- DB 層（ORM / Query Builder / Raw SQL / ADOdb）
- 前端技術（Vue / React / jQuery / 純 HTML）
- Session / Auth 機制
- API 回應格式

### 5. 識別業務模組

掃描 Model / Controller / Route 目錄，建立模組對照表：

| 模組 | DB 主表 | Model | 前台路徑 | 後台路徑 |
|------|---------|-------|---------|---------|

### 6. 產生 CLAUDE.md

按以下結構撰寫：

```
# 專案名稱 — 一句話說明

## 開始前必讀
（若有規格書、差異報告等需每次閱讀的文件，列在這裡）

## 專案概要
- 技術棧、DB、開發環境概述（3-5 行）

## 目錄結構
（帶註解的目錄樹，只列重要目錄與檔案）

## 架構模式
### 後端
### 前端
### 後台管理

## 業務模組
（模組對照表）

## 第三方整合
（金流、社群登入、API 等）

## 開發注意事項
（版本遷移陷阱、已知問題、編碼規範等）
```

### 7. 寫入檔案

用 Write 工具將內容寫入專案根目錄的 `CLAUDE.md`。

### 8. 確認 .gitignore

檢查 `.gitignore` 是否排除了 CLAUDE.md（通常不應排除，因為它對團隊有用）。
若使用者不希望進版控，協助加入 `.gitignore`。

## 輸出
- 專案根目錄的 `CLAUDE.md` 檔案
- 向使用者摘要報告文件涵蓋的範圍

## 注意事項
- 不要在 CLAUDE.md 中寫入密碼、API Secret 等敏感資訊（僅標註「見 config.php」）
- 目錄結構只列重要檔案，不要列出所有檔案（避免過長）
- 若專案已有 README.md，優先參考其內容，避免重複
- CLAUDE.md 內容應保持在 200 行以內，超過則拆分為子文件並連結
