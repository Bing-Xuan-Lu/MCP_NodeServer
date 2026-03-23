---
name: MCP Server 架構決策記錄
description: 關鍵架構選擇的原因與應用邊界，避免未來重複踩坑或誤改設計
type: project
---

## Batch 工具設計

每個主要操作都有 `_batch` 版本（`read_files_batch`、`execute_sql_batch`、`sftp_upload_batch` 等）。

**Why:** 單次 tool call 有 token 開銷；多檔操作用 batch 可一次回傳，大幅降低來回次數。PHP 大型專案常需同時讀取 10–30 個檔案，batch 是效率關鍵。

**How to apply:** 超過 2 個同類操作時，優先用 batch；單個操作用一般版即可。

---

## RAG 設計為選用元件

ChromaDB 容器未啟動時，`rag_*` 工具靜默失敗，其他所有工具完全不受影響。

**Why:** 避免單一依賴影響整體可用性。ChromaDB 是重量級容器，日常輕量工作不需要它；大型專案搜尋才啟動。

**How to apply:** 進入測試/開發流程前，先確認 ChromaDB 是否需要啟動；若 RAG 回傳錯誤直接跳過，改用 Grep。

---

## _internal 資料夾隔離

客戶專屬 Skill 統一放 `Skills/commands/_internal/`，整個資料夾被 `.gitignore` 排除。

**Why:** 公開 Skill 可能進版控並分享給其他人，不能含客戶真實資訊（域名、資料表、模組名）。`_internal` 是唯一的合法例外區。

**How to apply:** 含客戶名稱/URL/密碼的 Skill 一律放 `_internal/`；公開 Skill 用 `{ProjectFolder}` 等佔位符。

---

## basePath 限制（`D:\Project\`）

MCP filesystem 工具只能存取 `D:\Project\` 以下路徑，存取其他路徑需先呼叫 `grant_path_access`（重啟後清空）。

**Why:** 防止 Claude 誤讀系統敏感路徑（如 `C:\Windows\`、`~/.ssh/`）。最小權限原則。

**How to apply:** 操作 MCP_NodeServer 本身（`D:\Develop\`）時，每次對話開始需 `grant_path_access`；或改用 Read/Edit 等 Claude 原生工具（無 basePath 限制）。

---

## 單一 MCP Server 設計

所有工具集中在一個 `project-migration-assistant-pro` server，不拆分多個 server。

**Why:** 多 server 設定複雜，Claude 在工具選擇時需要辨別 server 名稱，增加認知負擔。單一 server 讓工具清單直觀；效能差異可忽略。

**How to apply:** 新增工具模組只需在 `TOOL_MODULES` 陣列加入，不需修改 `.mcp.json`。

---

## Skills 60 個上限

公開 Skill（`~/.claude/commands/`）上限 60 個，超過前需先用 `/skill_audit` 審查合併。

**Why:** 超過 60 個 Skill 時，系統 prompt 中的 Skill 清單過長，影響 Claude 的工具選擇精準度，也增加每次對話的 token 開銷。

**How to apply:** 新增 Skill 前確認目前數量；功能相似的 Skill 優先合併而非新增。
