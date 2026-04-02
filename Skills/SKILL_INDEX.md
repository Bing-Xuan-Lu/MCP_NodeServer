# Skills 索引（Tier 0 導航）

> 快速找到對應 Skill，不必掃描所有 commands/。
> 每個條目格式：`/skill-name` — 一句話說明

---

## PHP 開發部

- `/php_crud_generator` — 依資料表自動產生完整後台 CRUD 模組

## 測試品管部

- `/project_qc` — 雙 Agent 全站品質稽核，產出網站校稿單
- `/frontend_qc` — 前台逐頁 QC，對照設計稿 + 規格書產出 Bug 清單
- `/php_crud_test` — PHP 模組整合測試（CRUD + 檔案上傳 + DB 驗證）
- `/playwright_ui_test` — PHP 後台 UI 自動化測試 + Xdebug 互動除錯
- `/rwd_scan` — 三斷點截圖掃描，偵測響應式問題
- `/web_performance` — Playwright 實測載入指標 + PageSpeed 評分
- `/verify` — 提交前七合一驗證（含 AI 品質稽核），產出 PASS/FAIL 報告
- `/bug_trace` — 從症狀追蹤 Bug 根因，跨層定位（頁面→Model→SQL→DB）產出分析報告

## 規格分析部

- `/axshare_diff` — 比對 AxShare 規格書與測試網站功能差異
- `/axshare_spec_index` — 一次性爬取 AxShare 規格書並存成本地索引
- `/design_diff` — 設計稿圖檔 vs 實際截圖視覺比對
- `/logic_trace` — 同步爬前台 + 讀後台 Code，產出模組完整邏輯文件

## 開發流程部

- `/sprint_plan` — 依賴層快速開發計畫（含陌生度/影響/回報頻率評估）
- `/sadd` — 規格書驅動，逐任務派遣 Agent 開發 PHP 功能
- `/tdd` — TDD Red-Green-Refactor 循環指引（含輸出契約定義）
- `/checkpoint` — 長任務安全點：git 快照 + 日誌記錄
- `/debug_session` — 版本化除錯工作階段，管理多輪迭代直到結案

## 部署維運部

- `/sftp_deploy` — SFTP 將本機 PHP 專案部署到遠端測試機
- `/sftp_ops` — SFTP 連線遠端即時除錯與環境檢查
- `/sftp_pull` — SFTP 將遠端檔案拉取到本機
- `/remote_diff` — 比對本機 vs 遠端 SFTP 檔案差異，找出同事改過的檔案
- `/remote_db_exec` — SFTP+PHP 間接執行遠端 SQL（無法直連 MySQL 時）
- `/full_deploy` — 整合部署（diff 安全閘 + 程式碼 + DB migration + smoke test）

## 資料庫規劃部

- `/db_schema_designer` — 規劃 MySQL 資料表結構與關聯
- `/db_migration` — 比對 Schema 差異、產生遷移腳本、追蹤版本
- `/db_index_analyzer` — 分析慢查詢，找出缺少或冗餘的索引

## 內容擷取部

- `/read_article` — 即時讀取網頁 URL 並提供結構化摘要
- `/fetch_article` — 擷取網頁正文並儲存為本機 .txt 檔案

## 系統工具部

- `/git_commit` — 分析 git diff 並產生繁體中文 commit 訊息

## Claude 維運部

- `/retro` — 對話回顧：收割 Memory、Skill、Tool 改善
- `/skill_audit` — 審查 Skill 耦合與重疊，建議合併或淘汰
- `/harness_audit` — 審計 Claude Code 工具設置，產生評分報告
- `/memory_sync` — 同步 Git memory/ 與本機 Claude 記憶（pull/push/status）
- `/memory_audit` — 審計與整理 Claude 記憶系統（死連結、孤兒、重複、過時偵測）
- `/settings_cleanup` — 掃描並整理 settings.json 權限規則，合併重複、移除垃圾
- `/hook_complaints` — 查閱與處理其他專案 session 回報的 hook 誤擋紀錄
- `/mcp_pull_sync` — git pull 後同步設定（npm install、Skill 部署、Hook 檢查、重啟提示）

## 研究部

- `/github_skill_import` — 爬取 GitHub 上他人的 Skill 庫並整理成本地參考

---

> 冷凍 Skills 存放於 `Skills/commands/_cold/`，按需解凍即可使用。
> 詳細用法見各 Skill MD 檔案：`Skills/commands/{部門}/{skill}.md`
