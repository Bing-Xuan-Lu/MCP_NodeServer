/* ══════════════════════════════════════════════════════════
   Dashboard JS — Swiss Minimalism Dark
   project-migration-assistant-pro v5.1.0
   ══════════════════════════════════════════════════════════ */

const SKILLS = {
  'php_crud_generator':    { dept:'PHP 開發部',     title:'PHP後台CRUD模組產生器',           desc:'開始開發新功能前，只要提供資料表名稱，即可自動產生完整 PHP 後台 CRUD 模組（列表、新增、編輯、刪除、表單驗證、DB 操作）。',      usage:'/php_crud_generator [資料表名稱或功能描述]', tools:['get_db_schema','get_db_schema_batch','execute_sql','create_file','create_file_batch','read_files_batch','send_http_requests_batch'] },
  'php_upgrade':           { dept:'PHP 開發部',     title:'PHP 7.x → 8.4 升級',             desc:'當 PHP 7.x 專案出現 Deprecated 警告，或需要升級 PHP 版本時，自動掃描並修正所有過時語法至 PHP 8.4 標準。', usage:'/php_upgrade [掃描目錄或檔案路徑]',                              tools:['list_files','list_files_batch','read_file','read_files_batch','apply_diff'] },
  'php_crud_test':         { dept:'測試品管部',     title:'PHP CRUD 模組整合測試',              desc:'新功能開發完成後用於後端邏輯驗證：對 PHP 模組執行 CRUD 整合測試，逐步確認資料寫入與 DB 狀態一致性。',             usage:'/php_crud_test [專案資料夾] [PHP資料夾] [模組名稱]',                 tools:['send_http_request','send_http_requests_batch','execute_sql','execute_sql_batch','run_php_test','run_php_script_batch','list_files_batch','read_files_batch','get_db_schema_batch'] },
  'playwright_ui_test':    { dept:'測試品管部',     title:'Playwright UI 自動化測試、除錯與截圖總覽', desc:'使用 Playwright 對網頁進行 UI 自動化測試（CRUD）、互動式除錯（Xdebug），或截圖模式快速瀏覽系統功能。支援 DEV_MODE 驗證碼繞過。', usage:'/playwright_ui_test [測試網站網址] [目標描述]', tools:['Playwright MCP'] },
  'web_performance':       { dept:'測試品管部',     title:'網站前端效能檢測與優化建議',       desc:'量測 LCP、FCP、TTI、資源大小等效能指標，分析載入瓶頸（大圖、未壓縮 JS/CSS），提供具體優化建議。',                usage:'/web_performance [測試網站網址]',                          tools:['Playwright MCP','send_http_request'] },
  'axshare_diff':          { dept:'規格分析部',     title:'AxShare 規格書 vs 網站差異比對（全站/單一單元）',  desc:'比對 AxShare 原型規格與實際測試網站。全站模式產出完整差異報告；單一單元模式針對特定模組深度分析（含 DB 影響評估、ALTER TABLE SQL），結果直接整合進現有報告檔。建議先執行 /axshare_spec_index 建立快照後再使用。',  usage:'/axshare_diff [模組名稱或"全站"] [規格書來源(可省略)] [測試網站網址]',  tools:['Playwright MCP'] },
  'axshare_spec_index':    { dept:'規格分析部',     title:'AxShare 規格書一次性建立本地索引',              desc:'一次爬取整份 AxShare 規格書（或本地匯出 HTML），將所有頁面的欄位、按鈕、邏輯、日期標記整理成結構化 Markdown 索引檔。後續 /axshare_diff 可直接讀取此檔案，不需每次重爬規格書，速度快且不受 iframe 限制。', usage:'/axshare_spec_index [AxShare網址或本地匯出目錄]', tools:['Playwright MCP','list_files','create_file'] },
  'db_schema_designer':    { dept:'資料庫規劃部',   title:'MySQL 資料表結構設計',             desc:'需求訪談後、開工前，根據業務描述設計符合 3NF 的資料表結構與索引策略，輸出可直接執行的 CREATE TABLE SQL。',          usage:'/db_schema_designer [業務描述]',             tools:['load_db_connection','get_db_schema','get_db_schema_batch','execute_sql'] },
  'db_migration':          { dept:'資料庫規劃部',   title:'Schema 遷移全流程（產生+執行+追蹤）', desc:'合一工作流：generate 模式比對 Schema 差異並產出 ALTER TABLE + 回滾腳本；run 模式批次執行、建立 _migrations 版本追蹤表、支援 rollback 與 status 查詢。', usage:'/db_migration generate | run [SQL] | run rollback | run status', tools:['load_db_connection','get_db_schema','get_db_schema_batch','execute_sql','execute_sql_batch','read_file'] },
  'db_index_analyzer':     { dept:'資料庫規劃部',   title:'MySQL 查詢效能與索引優化分析',     desc:'執行 EXPLAIN 分析慢查詢，識別全表掃描、冗餘索引、索引順序錯誤等問題，產生 ADD/DROP INDEX 優化腳本與效能預估。',    usage:'/db_index_analyzer [SQL 或表格名稱]',        tools:['load_db_connection','get_db_schema','get_db_schema_batch','execute_sql','execute_sql_batch'] },
  'sftp_deploy':           { dept:'部署維運部',     title:'本機 PHP 專案部署到遠端測試機',    desc:'透過 SFTP 將本機 PHP 目錄上傳到遠端伺服器，部署前確認目標目錄內容，部署後驗證遠端檔案結果。',                    usage:'/sftp_deploy [要部署的目錄或檔案(可省略)]',                              tools:['sftp_connect','sftp_upload','sftp_upload_batch','sftp_list'] },
  'sftp_pull':             { dept:'部署維運部',     title:'從遠端測試機拉取程式到本機',       desc:'透過 SFTP 將遠端伺服器的檔案或目錄下載到本機，適用於取回測試機改動、備份遠端資料或同步最新版本。',               usage:'/sftp_pull [遠端目錄或檔案]',                                tools:['sftp_connect','sftp_download','sftp_download_batch','sftp_list','sftp_list_batch'] },
  'sftp_ops':              { dept:'部署維運部',     title:'遠端主機即時除錯與環境檢查',       desc:'透過 SFTP 連線遠端主機，讀取 error log、檢查設定檔、確認目錄結構。UI 測試失敗時可直接查看後端報錯，快速定位問題。', usage:'/sftp_ops [除錯目標描述 或 "tail log"]',                   tools:['sftp_connect','sftp_list','sftp_list_batch','sftp_download','read_files_batch','tail_log'] },
  'remote_diff':           { dept:'部署維運部',     title:'本機 vs 遠端 SFTP 檔案差異比對',  desc:'透過 SFTP 拉取遠端檔案與本機 Git 專案做 diff，找出同事直接在遠端修改的檔案，避免部署時覆蓋他人修改。支援 merge 回本機或僅產出報告。', usage:'/remote_diff [比對範圍(可省略)]', tools:['sftp_connect','sftp_list_batch','sftp_download','list_files_batch','read_files_batch'] },
  'remote_db_exec':        { dept:'部署維運部',     title:'SFTP+PHP 間接執行遠端 SQL',       desc:'無法直連 MySQL 時（如準測試機只有 phpMyAdmin），透過 SFTP 上傳帶 token 驗證的一次性 PHP 腳本執行 SQL，用完立刻刪除。', usage:'/remote_db_exec [SQL 或描述]', tools:['sftp_connect','sftp_upload','sftp_delete','send_http_request','create_file'] },
  'full_deploy':           { dept:'部署維運部',     title:'整合部署（程式碼 + DB + 安全檢查）', desc:'四階段部署流水線：Phase A remote_diff 安全閘（偵測遠端被改過的檔案）→ Phase B SFTP 上傳程式碼 → Phase C DB migration（直連或間接）→ Phase D smoke test。以本機為主，設定檔永不覆蓋。', usage:'/full_deploy [code-only | db-only | --skip-diff]', tools:['sftp_connect','sftp_upload','sftp_upload_batch','sftp_download','sftp_list_batch','sftp_delete','sftp_delete_batch','send_http_request','execute_sql','execute_sql_batch','create_file','read_file'] },
  'docker_setup':          { dept:'Docker 維運部', title:'Docker 環境建置：路徑搬遷與 Apache 短路徑映射', desc:'兩種一次性環境建置任務：模式 A 將 Compose 環境從一個路徑搬遷到另一個路徑，自動更新 image 名稱與設定檔；模式 B 為 Docker 容器中的 Apache 設定 mod_rewrite 短路徑映射，讓長 URL 可用短路徑存取。', usage:'/docker_setup [搬遷 或 短路徑]', tools:['read_file','create_file','apply_diff','send_http_request'] },
  'docker_compose_ops':    { dept:'Docker 維運部', title:'Docker Compose 日常操作',          desc:'執行 docker compose up/down/restart/logs/ps 等日常操作，根據目前環境狀態自動判斷最佳操作方式。',                   usage:'/docker_compose_ops [操作如 up/down/restart]',                       tools:[] },
  'version_conflict_debug':{ dept:'Docker 維運部', title:'服務元件版本相容性衝突診斷修復',   desc:'當兩服務整合出現神秘連線失敗或 API 拒絕時，系統性收集版本、分析 log 訊號、測試通訊、判斷根因並套用修復。適用 Docker+Traefik、PHP+MySQL、Node+npm 等任意組合。', usage:'/version_conflict_debug [Component A] [Component B] [錯誤症狀]', tools:[] },
  'docx':                  { dept:'文書處理部',     title:'Word 文件建立、編輯與解析',        desc:'透過 docx-js 或 XML 直接操作建立/修改 .docx 文件。支援 Tracked Changes、表格、頁首頁尾、.doc 轉換。',              usage:'/docx [任務描述]',                             tools:['read_word_file','read_word_files_batch','run_python_script'] },
  'pdf':                   { dept:'文書處理部',     title:'PDF 讀取、建立、合併、拆分與 OCR', desc:'處理 PDF 檔案的全套操作：文字萃取（pdfplumber）、多檔合併、單頁拆分、建立新 PDF（reportlab）、OCR 掃描（pytesseract）。', usage:'/pdf [任務描述]',                              tools:['read_pdf_file','read_pdf_files_batch','run_python_script'] },
  'pptx':                  { dept:'文書處理部',     title:'PowerPoint 簡報建立與編輯',        desc:'從零建立投影片（pptxgenjs）或修改現有簡報（XML），內建 10 套色彩主題，拒絕 AI 刻板設計。含視覺 QA 流程。',           usage:'/pptx [任務描述]',                             tools:['read_pptx_file','read_pptx_files_batch','run_python_script'] },
  'xlsx':                  { dept:'文書處理部',     title:'Excel 試算表建立與財務模型',        desc:'pandas 資料分析 + openpyxl 建立含公式的試算表。強制 LibreOffice 公式重算，業界標準色彩規範（藍=輸入、黑=公式）。',    usage:'/xlsx [任務描述]',                             tools:['get_excel_values_batch','trace_excel_logic','simulate_excel_change','run_python_script'] },
  'tdd':                   { dept:'開發流程部',     title:'TDD Red-Green-Refactor 循環指引', desc:'引導開發者按照 TDD 節奏：先寫失敗測試（Red）→ 最小實作（Green）→ 重構（Refactor），確保每步都有測試保護。',        usage:'/tdd [功能描述]',                            tools:['run_php_test','read_file','apply_diff'] },
  'clean_arch':            { dept:'開發流程部',     title:'Clean Architecture 架構審查',     desc:'當發現現有程式碼混亂（God Class、業務邏輯散落 Controller、循環依賴）時，審查並提供 Clean Architecture 重構路線圖。',    usage:'/clean_arch [要審查的目錄或檔案]',                               tools:['list_files','read_file'] },
  'sadd':                  { dept:'開發流程部',     title:'規格書驅動逐任務派遣開發（Demo-able Change 粒度）', desc:'SADD 模式：每個任務以「使用者可 demo 的變化」為單位（非技術層切片），按使用者旅程垂直貫穿。步驟 0 內建 DDD 架構規範，支援循序與並行模式，完成後立即審查。', usage:'/sadd [規格書路徑]', tools:[] },
  'directory_reorganize':  { dept:'開發流程部',     title:'目錄結構自動分類整理',             desc:'分析目錄內所有檔案，根據功能與命名規律自動建立子資料夾分類，搬移檔案並產出整理報告。',                            usage:'/directory_reorganize [目錄路徑]',           tools:['list_files','create_file'] },
  'bookmark_organizer':    { dept:'系統工具部',     title:'Chrome 書籤整理助手',             desc:'整理 Chrome 書籤：掃描無效連結（404/DNS 失效）、移除重複書籤、依主題分類到資料夾、排序整理。',                    usage:'/bookmark_organizer [要整理的資料夾(可省略)]',                       tools:['scan_and_clean_bookmarks','move_bookmarks','sort_bookmarks'] },
  'retro':                 { dept:'Claude 維運部',  title:'對話回顧：收割 Memory、Skill、Tool 改善', desc:'對話結束前一次掃描三個面向：Memory（該存的經驗）、Skill（可固化的流程）、Tool（MCP 工具改善機會），列出發現後由使用者決定處理哪些。支援新增/改進 Skill、參考庫研究模式。', usage:'/retro [memory | skill | tool | skill 改進 {name} | skill 研究 {repo}]', tools:['save_claude_skill','list_claude_skills','delete_claude_skill','read_files_batch','list_files_batch','apply_diff','create_file'] },
  'git_commit':            { dept:'系統工具部',     title:'產生繁體中文 Git Commit 訊息',    desc:'分析 git diff 與 git status，自動產生符合專案慣例的繁體中文 Commit 訊息（含 Co-authored-by），並執行 commit。',    usage:'/git_commit [額外指示(可省略)]',                               tools:['git_status','git_diff'] },
  'relocate_directory':    { dept:'系統工具部',     title:'搬移目錄並更新所有路徑引用',       desc:'搬移目錄到新位置後，自動掃描並更新所有 .json、.bat、.md、設定檔中的舊路徑引用，確保不遺漏。',                     usage:'/relocate_directory [原目錄] [新目錄]',                       tools:['list_files','read_file','apply_diff'] },
  'windows_node_autostart':{ dept:'系統工具部',     title:'Windows Node.js 開機自動啟動',     desc:'使用 VBS 單例保護 + Task Scheduler XML 設定 Node.js 服務開機靜默啟動，防重複執行、延遲避免搶佔網路。',              usage:'/windows_node_autostart',                   tools:[] },
  'gitignore_setup':       { dept:'系統工具部',     title:'掃描專案並自動補全 .gitignore',    desc:'掃描專案目錄識別機密、建置產出、OS/IDE 暫存等不應提交的檔案，與現有 .gitignore 比對後補全規則，並提示 git rm --cached 已追蹤的問題檔案。', usage:'/gitignore_setup [路徑或排除需求]',          tools:['list_files','read_file','apply_diff'] },
  'project_claudemd':      { dept:'Claude 維運部',  title:'為專案自動產生 CLAUDE.md 專案文件', desc:'系統性探索專案結構、設定檔、架構模式，自動產生結構化的 CLAUDE.md，讓 Claude 能快速理解專案全貌。',                  usage:'/project_claudemd [額外指示]',              tools:[] },
  'skill_audit':           { dept:'Claude 維運部',  title:'Skill 耦合審計與合併建議',         desc:'技能越來越多不知用哪個時，掃描所有 Skill 找出重疊、命名混淆的技能，產出優先行動清單並執行合併或刪除。',           usage:'/skill_audit',                              tools:[] },
  'fetch_article':         { dept:'內容擷取部',     title:'網頁文章擷取與儲存',              desc:'需要永久儲存文章時，擷取網頁正文並存為 .txt 檔（若只要當場閱讀與分析，請改用 /read_article）。',                       usage:'/fetch_article [URL]',                      tools:['send_http_request','create_file'] },
  'read_article':          { dept:'內容擷取部',     title:'快速閱讀網頁文章並摘要',           desc:'丟一個 URL 立即獲得結構化摘要（主題、重點、洞察），適合技術文章、觀點評論的當場分析與討論。',                       usage:'/read_article [URL] [關注的重點(可省略)]',                       tools:['WebFetch'] },
  'yt_transcript':         { dept:'內容擷取部',     title:'YouTube 字幕轉純文字',            desc:'從 YouTube 影片下載自動生成或手動字幕（支援中英），清理時間碼後輸出為可閱讀的純文字，方便筆記或摘要。',             usage:'/yt_transcript [YouTube URL]',              tools:['send_http_request','create_file'] },
  'youtube_organizer':     { dept:'生活自動化部',   title:'YouTube 播放清單自動分類',         desc:'分析播放清單中的影片，依語言（中文/日文/英文）與類型（流行/搖滾/古典/動漫）自動分類整理到不同歌單。',             usage:'/youtube_organizer [播放清單URL]',           tools:['send_http_request'] },
  'n8n_workflow_ops':      { dept:'生活自動化部',   title:'n8n 工作流建立/更新 SOP',         desc:'新建或安全更新 n8n workflow。新建模式：Create → PUT settings → Activate → Backup；更新模式：Deactivate → PUT → Activate → Verify。', usage:'/n8n_workflow_ops [操作如 create/update]',                         tools:['send_http_request'] },
  'n8n_discord_dispatcher':{ dept:'生活自動化部',   title:'n8n Discord 指令路由調度器',      desc:'建立 n8n Discord Bot 指令路由，讓不同的 Discord Slash Command 能觸發對應的 n8n workflow 分支處理。',              usage:'/n8n_discord_dispatcher',                   tools:['send_http_request'] },
  'n8n_webhook_debug':     { dept:'生活自動化部',   title:'n8n Webhook 不觸發除錯',          desc:'診斷 n8n Webhook 節點無回應的根因：log 分析、HTTP method 測試、httpMethod 參數修復、deactivate→PUT→activate 流程。',  usage:'/n8n_webhook_debug [Webhook URL 或 節點名稱]',                        tools:['send_http_request'] },
  
  // 新增遺漏的 Skills
  'github_skill_import':   { dept:'研究開發部',     title:'爬取 GitHub Skill 儲存庫',         desc:'爬取 GitHub 上他人的 Claude Skill 儲存庫，下載所有 .md 技能檔並整理成本地學習參考庫。', usage:'/github_skill_import [GitHub Repo URL]', tools:[] },
  'gemini_playwright_setup':{ dept:'測試品管部',     title:'Playwright MCP 設定指南',          desc:'引導安裝與設定微軟官方的 Playwright MCP 伺服器，讓 Gemini CLI 具備自動化瀏覽器操作能力。', usage:'/gemini_playwright_setup', tools:[] },
  'verify':                { dept:'測試品管部',     title:'提交前七合一驗證',                 desc:'依序執行語法檢查、測試、Lint、git 狀態、AI 品質稽核等七項驗證，產出 PASS/FAIL 報告，確認程式碼品質。', usage:'/verify [quick/full/pre-pr]', tools:['run_shell_command'] },
  'checkpoint':            { dept:'開發流程部',     title:'建立工作流程安全點',               desc:'在長任務執行過程中建立 git 快照與日誌記錄，發生問題時可快速回溯。', usage:'/checkpoint [create/verify/list]', tools:['git_status', 'git_log', 'git_stash_ops'] },
  'debug_session':         { dept:'開發流程部',     title:'版本化除錯工作階段管理',            desc:'管理多輪迭代除錯，產出版本化除錯指示文件（debug_vN.md）作為調查與修復的介面。明確分離已解決/待修復，以零程式碼區塊格式避免 AI 截斷，跨迭代追蹤修復進度直到結案。', usage:'/debug_session [問題描述] 或 /debug_session v{N} [文件路徑]', tools:['read_files_batch','tail_log','run_php_test','execute_sql','send_http_request','create_file'] },
  'harness_audit':         { dept:'Claude 維運部',  title:'審計 Claude Code 工具設置',        desc:'從多個維度評估目前專案的 AI 輔助開發能力成熟度（Hooks、Skills、MCP、Memory 等），並提出改進建議。', usage:'/harness_audit [hooks/skills/mcp/memory]', tools:['run_shell_command'] },
  'update_codemaps':       { dept:'開發流程部',     title:'掃描專案並產生架構文件',           desc:'掃描專案目錄結構並產生精簡的架構地圖 (Codemaps)，讓 AI 能在大型專案中快速定位關鍵檔案與流程。', usage:'/update_codemaps [目標路徑(可省略)]', tools:['list_files'] },
  'logic_trace':           { dept:'程式移植與規格分析部', title:'同步爬前台＋讀後台 Code，產出模組完整邏輯文件', desc:'三軌並進（Playwright 爬前台 + MCP 讀 PHP Code + DB Schema 查詢），合併產出每個模組的完整技術邏輯文件，涵蓋前台行為、後台流程、DB 操作、錯誤處理、跨模組依賴。支援單模組深挖與全站逐域掃描兩種模式，報告存為 Markdown 供後續規格比對或重構使用。', usage:'/logic_trace {ProjectFolder} [ModuleName]', tools:['list_files','list_files_batch','read_file','read_files_batch','get_db_schema','get_db_schema_batch','execute_sql','create_file','Playwright MCP'] },
  'task_map':              { dept:'開發流程部',     title:'專案全景心智模型（Task Map）', desc:'從使用者旅程出發產出專案全景地圖，標示每一步涉及的模組、DB 表、API 端點與第三方串接。定義黃金路徑供 /e2e_golden_path 使用，標示風險熱區供 /sprint_plan 評估優先序。', usage:'/task_map {ProjectFolder} [規格來源]', tools:['list_files_batch','read_files_batch','get_db_schema_batch','execute_sql','create_file','Playwright MCP'] },
  'sprint_plan':           { dept:'開發流程部',     title:'Tier-based 依賴層快速開發計畫', desc:'分析模組間的 DB 外鍵與業務流程依賴，將工作拆解為 Tier 並行執行。每模組評估陌生度/影響/回報頻率三維度，高風險模組完成後自動觸發 /e2e_golden_path 回歸。', usage:'/sprint_plan {ProjectFolder} [規格來源]', tools:['list_files_batch','read_files_batch','get_db_schema_batch','create_file','create_file_batch'] },
  'design_diff':           { dept:'程式移植與規格分析部', title:'設計稿 vs 實際網站截圖比對', desc:'將設計師提供的設計稿圖片（PSD/Figma/XD 匯出 PNG/JPG 或 PDF）與 Playwright 截取的實際頁面截圖逐項比對，檢查版面結構、顏色、字體、間距、元件完整性，產出視覺差異報告。', usage:'/design_diff {設計稿路徑} [目標URL] [--breakpoint 1440]', tools:['Playwright MCP'] },
  'spec_screenshot_diff':  { dept:'程式移植與規格分析部', title:'規格書截圖 vs 實際網站截圖並排比對', desc:'擷取 AxShare 規格書頁面截圖與實作頁面截圖，並排呈現供視覺比對，逐項列出 UI 差異（欄位缺失、排版不同、按鈕樣式、文字不一致）。', usage:'/spec_screenshot_diff {模組名稱或URL} [--backend|--frontend]', tools:['Playwright MCP'] },
  'rwd_scan':              { dept:'測試品管部',     title:'RWD 三斷點截圖掃描', desc:'在 Mobile (375px)、Tablet (768px)、Desktop (1440px) 三個斷點自動截圖，偵測水平溢出、文字截斷、元素重疊，產出響應式問題報告。', usage:'/rwd_scan {URL} [--breakpoints 375,768,1440] [--full-page]', tools:['Playwright MCP'] },
  'project_qc':            { dept:'測試品管部',     title:'全站品質稽核與網站校稿單', desc:'模擬專案管理師執行全站 QC：後台邏輯（Phase A）→ UI 行為（B）→ 設計稿比對（C，零容忍色差）→ 規格書比對（D）→ 業務流程端對端（E，電商/審核流程等）→ RWD（F），彙整產出可追蹤的網站校稿單，支援迭代複驗（re-check）循環。', usage:'/project_qc [測試網址] [專案目錄] [re-check]', tools:['send_http_request','send_http_requests_batch','execute_sql','execute_sql_batch','run_php_test','read_files_batch','get_db_schema_batch','create_file','Playwright MCP'] },
  'e2e_golden_path':       { dept:'測試品管部',     title:'輕量黃金路徑煙霧測試', desc:'5 分鐘快速走完系統核心業務路徑（註冊→購物→結帳→後台確認），只驗主幹能否跑通。失敗即停，每步截圖，前後台遞棒驗證。日常改 code 後的回歸測試，project_qc 的精簡版。', usage:'/e2e_golden_path {ProjectFolder} [define|run]', tools:['execute_sql','execute_sql_batch','send_http_request','send_http_requests_batch','read_files_batch','create_file','tail_log','Playwright MCP'] },
  'frontend_qc':           { dept:'測試品管部',     title:'前台逐頁品質檢查 — Bug 清單產出', desc:'單一前台頁面精細比對（設計稿 + 規格書），用 Playwright 逐頁走訪，五維度檢查（視覺 / 欄位 / 互動 / 資料 / RWD），產出結構化 Bug 清單。全站雙 Agent 稽核改用 /project_qc。', usage:'/frontend_qc [頁面URL或模組] [--spec 規格來源] [--design 設計稿]', tools:['Playwright MCP','Read','Grep','Write'] },
};

const TOOLS = {
  'list_files':             { dept:'檔案系統 & 資料庫', title:'列出目錄內容', desc:'讀取指定目錄下的所有檔案與資料夾名稱。', usage:'list_files {path:"..."}', tools:[] },
  'read_file':              { dept:'檔案系統 & 資料庫', title:'讀取檔案內容', desc:'讀取檔案完整內容，支援大檔分段讀取 (offset/limit)。', usage:'read_file {path:"..."}', tools:[] },
  'create_file':            { dept:'檔案系統 & 資料庫', title:'建立或覆寫檔案', desc:'將指定的文字內容寫入檔案。', usage:'create_file {path:"...", content:"..."}', tools:[] },
  'apply_diff':             { dept:'檔案系統 & 資料庫', title:'修改檔案 (Search & Replace)', desc:'透過尋找並替換字串的方式修改檔案內容。', usage:'apply_diff {path:"...", search:"...", replace:"..."}', tools:[] },
  'read_files_batch':       { dept:'檔案系統 & 資料庫', title:'批次讀取多個檔案', desc:'一次讀取多個檔案（減少 tool call 來回），每個檔案回傳前 N 行摘要。', usage:'read_files_batch {paths:["..."]}', tools:[] },
  'list_files_batch':       { dept:'檔案系統 & 資料庫', title:'批次列出多個目錄內容', desc:'一次讀取多個目錄內容（減少 tool call 來回）。', usage:'list_files_batch {paths:["..."]}', tools:[] },
  'create_file_batch':      { dept:'檔案系統 & 資料庫', title:'批次建立多個檔案', desc:'一次建立或覆寫多個檔案，適合模板產生、多檔建立流程。', usage:'create_file_batch {files:[{path:"...",content:"..."}]}', tools:[] },

  'set_database':           { dept:'檔案系統 & 資料庫', title:'設定資料庫連線', desc:'設定資料庫連線資訊，同一次對話內所有查詢都會使用此連線。', usage:'set_database {host:"...", user:"...", ...}', tools:[] },
  'get_current_db':         { dept:'檔案系統 & 資料庫', title:'查看目前的資料庫連線', desc:'檢查目前 AI 記住的資料庫連線設定。', usage:'get_current_db {}', tools:[] },
  'get_db_schema':          { dept:'檔案系統 & 資料庫', title:'查看資料表結構', desc:'查看單一資料表的欄位定義與結構。', usage:'get_db_schema {table_name:"..."}', tools:[] },
  'execute_sql':            { dept:'檔案系統 & 資料庫', title:'執行 SQL 指令', desc:'執行 DDL/DML，支援多條語句以分號分隔逐條執行。', usage:'execute_sql {sql:"..."}', tools:[] },
  'get_db_schema_batch':    { dept:'檔案系統 & 資料庫', title:'批次查看多張資料表結構', desc:'一次查看多張表的 Schema，減少 tool call。', usage:'get_db_schema_batch {table_names:["..."]}', tools:[] },
  'execute_sql_batch':      { dept:'檔案系統 & 資料庫', title:'批次執行多組獨立 SQL', desc:'各自獨立連線執行，互不影響，不會因某條失敗而中斷。', usage:'execute_sql_batch {queries:[{sql:"..."}]}', tools:[] },

  'run_php_script':         { dept:'PHP & SFTP 部署', title:'執行 PHP 腳本', desc:'在伺服器上執行 PHP 腳本 (CLI 模式)，並回傳輸出結果。', usage:'run_php_script {path:"..."}', tools:[] },
  'run_php_test':           { dept:'PHP & SFTP 部署', title:'執行 PHP 測試', desc:'自動建立測試環境 (Session/Config) 並執行 PHP 腳本。', usage:'run_php_test {targetPath:"..."}', tools:[] },
  'send_http_request':      { dept:'PHP & SFTP 部署', title:'發送 HTTP 請求', desc:'發送 GET/POST 請求，支援 Multipart 實體檔案上傳。', usage:'send_http_request {url:"...", method:"..."}', tools:[] },
  'tail_log':               { dept:'PHP & SFTP 部署', title:'讀取 Log 最後 N 行', desc:'讀取檔案最後 N 行 (適用於查看 PHP Error Log)。', usage:'tail_log {path:"..."}', tools:[] },
  'send_http_requests_batch':{ dept:'PHP & SFTP 部署', title:'批次發送 HTTP 請求', desc:'並行發送多個請求，減少 tool call 延遲。', usage:'send_http_requests_batch {requests:[...]}', tools:[] },
  'run_php_script_batch':   { dept:'PHP & SFTP 部署', title:'批次執行多個 PHP 腳本', desc:'循序執行多支 PHP 腳本，適合測試、migration 批次跑。', usage:'run_php_script_batch {scripts:[{path:"..."}]}', tools:[] },

  'sftp_connect':           { dept:'PHP & SFTP 部署', title:'設定 SFTP 連線', desc:'設定後同一次對話內的所有操作都會使用此連線。', usage:'sftp_connect {host:"...", user:"..."}', tools:[] },
  'sftp_upload':            { dept:'PHP & SFTP 部署', title:'上傳檔案/目錄', desc:'上傳本機檔案或整個目錄到遠端伺服器。', usage:'sftp_upload {local_path:"...", remote_path:"..."}', tools:[] },
  'sftp_download':          { dept:'PHP & SFTP 部署', title:'下載檔案/目錄', desc:'從遠端伺服器下載檔案或目錄到本機。', usage:'sftp_download {remote_path:"...", local_path:"..."}', tools:[] },
  'sftp_list':              { dept:'PHP & SFTP 部署', title:'列出遠端目錄', desc:'列出遠端目錄內容（檔名、類型、大小、修改時間）。', usage:'sftp_list {remote_path:"..."}', tools:[] },
  'sftp_delete':            { dept:'PHP & SFTP 部署', title:'刪除遠端檔案', desc:'刪除遠端檔案或目錄（支援遞迴刪除）。', usage:'sftp_delete {remote_path:"..."}', tools:[] },
  'sftp_list_batch':        { dept:'PHP & SFTP 部署', title:'批次列出遠端目錄', desc:'共用一條連線，一次列出多個目錄內容。', usage:'sftp_list_batch {remote_paths:["..."]}', tools:[] },
  'sftp_upload_batch':      { dept:'PHP & SFTP 部署', title:'批次上傳檔案/目錄', desc:'共用一條連線，一次上傳多組檔案或目錄到遠端。', usage:'sftp_upload_batch {items:[{local_path:"...",remote_path:"..."}]}', tools:[] },
  'sftp_download_batch':    { dept:'PHP & SFTP 部署', title:'批次下載檔案/目錄', desc:'共用一條連線，一次從遠端下載多組檔案或目錄。', usage:'sftp_download_batch {items:[{remote_path:"...",local_path:"..."}]}', tools:[] },
  'sftp_delete_batch':      { dept:'PHP & SFTP 部署', title:'批次刪除遠端檔案', desc:'共用一條連線，一次刪除多個遠端檔案或目錄。', usage:'sftp_delete_batch {items:[{remote_path:"..."}]}', tools:[] },

  'get_excel_values_batch': { dept:'系統、Excel 與 Python', title:'批次讀取 Excel 儲存格', desc:'批次讀取 Excel 儲存格 (省 Token 版)，支援範圍或列表。', usage:'get_excel_values_batch {path:"...", sheet:"..."}', tools:[] },
  'trace_excel_logic':      { dept:'系統、Excel 與 Python', title:'追蹤 Excel 邏輯鏈', desc:'追蹤公式「引用來源」與「從屬影響」。', usage:'trace_excel_logic {path:"...", cell:"..."}', tools:[] },
  'simulate_excel_change':  { dept:'系統、Excel 與 Python', title:'模擬修改 Excel 重算', desc:'模擬修改 Excel 數值並重算結果 (不修改原檔)。', usage:'simulate_excel_change {path:"...", changeCell:"..."}', tools:[] },

  'save_claude_skill':      { dept:'系統、Excel 與 Python', title:'儲存 Claude Skill', desc:'將對話提取為 Skill 檔案並自動部署到 Claude Code。', usage:'save_claude_skill {name:"...", content:"..."}', tools:[] },
  'list_claude_skills':     { dept:'系統、Excel 與 Python', title:'列出所有 Skills', desc:'列出目前已建立及部署的所有 Skills。', usage:'list_claude_skills {}', tools:[] },
  'delete_claude_skill':    { dept:'系統、Excel 與 Python', title:'刪除 Skill', desc:'刪除指定的 Skill 檔案。', usage:'delete_claude_skill {name:"..."}', tools:[] },
  
  'grant_path_access':      { dept:'系統、Excel 與 Python', title:'開放目錄權限', desc:'將 basePath 外的路徑加入白名單允許存取。', usage:'grant_path_access {path:"..."}', tools:[] },
  'list_allowed_paths':     { dept:'系統、Excel 與 Python', title:'列出允許存取路徑', desc:'列出目前 MCP 可以存取的 basePath 與白名單。', usage:'list_allowed_paths {}', tools:[] },
  'revoke_path_access':     { dept:'系統、Excel、Python 與 Git', title:'撤銷目錄權限', desc:'從白名單移除指定路徑。', usage:'revoke_path_access {path:"..."}', tools:[] },

  'run_python_script':      { dept:'系統、Excel、Word、Python 與 Git', title:'執行 Python 腳本', desc:'在 Docker (python_runner) 中執行 Python 程式碼，支援 inline 與實體檔案。', usage:'run_python_script {code:"..."}', tools:[] },
  'read_word_file':         { dept:'系統、Excel、文件、Python 與 Git', title:'讀取 Word 文件', desc:'讀取 .docx 檔案並轉換為 Markdown、HTML 或純文字格式輸出，自動提取圖片。', usage:'read_word_file {path:"...", format:"markdown"}', tools:[] },
  'read_word_files_batch':  { dept:'系統、Excel、文件、Python 與 Git', title:'批次讀取 Word 文件', desc:'一次讀取多個 .docx 檔案，回傳 Markdown 摘要（截斷過長內容）。', usage:'read_word_files_batch {paths:["..."], format:"markdown"}', tools:[] },
  'read_pptx_file':         { dept:'系統、Excel、文件、Python 與 Git', title:'讀取 PowerPoint 簡報', desc:'讀取 .pptx 檔案，逐頁提取文字與圖片，輸出 Markdown 或純文字。', usage:'read_pptx_file {path:"...", format:"markdown"}', tools:[] },
  'read_pptx_files_batch':  { dept:'系統、Excel、文件、Python 與 Git', title:'批次讀取 PowerPoint 簡報', desc:'一次讀取多個 .pptx 檔案。', usage:'read_pptx_files_batch {paths:["..."]}', tools:[] },
  'read_pdf_file':          { dept:'系統、Excel、文件、Python 與 Git', title:'讀取 PDF 文件', desc:'逐頁提取 PDF 文字內容，支援指定頁碼範圍（如 "1-5" 或 "3,7,10-12"）。', usage:'read_pdf_file {path:"...", pages:"1-5"}', tools:[] },
  'read_pdf_files_batch':   { dept:'系統、Excel、文件、Python 與 Git', title:'批次讀取 PDF 文件', desc:'一次讀取多個 PDF 檔案，回傳文字摘要。', usage:'read_pdf_files_batch {paths:["..."]}', tools:[] },
  
  'git_status':             { dept:'系統、Excel、Python 與 Git', title:'Git 狀態檢查', desc:'查看目前 Git 工作目錄狀態 (git status)，包含未暫存與未追蹤檔案。', usage:'git_status {}', tools:[] },
  'git_diff':               { dept:'系統、Excel、Python 與 Git', title:'Git 改動比對', desc:'查看檔案改動內容 (git diff)，支援 staged 模式。', usage:'git_diff {file_path:"...", staged:true}', tools:[] },
  'git_log':                { dept:'系統、Excel、Python 與 Git', title:'Git 提交歷史', desc:'查看最近的 Commit 歷史 (git log)，預設顯示 5 筆一列。', usage:'git_log {limit:5}', tools:[] },
  'git_stash_ops':          { dept:'系統、Excel、Python 與 Git', title:'Git Stash 操作', desc:'執行 Git Stash 相關操作 (push, pop, list)，用於暫存臨時工作。', usage:'git_stash_ops {action:"push", message:"..."}', tools:[] },

  'file_to_prompt':         { dept:'系統、Excel、文件、Python 與 Git', title:'檔案打包成 Prompt', desc:'將多個檔案內容打包成結構化 prompt（支援 glob pattern），免手動逐檔指定。輸出 XML/Markdown/Plain 格式。', usage:'file_to_prompt {glob:"project/**/*.php", format:"xml"}', tools:[] },
  'file_to_prompt_preview': { dept:'系統、Excel、文件、Python 與 Git', title:'預覽檔案匹配結果', desc:'預覽 file_to_prompt 會匹配哪些檔案（不讀取內容，僅列清單與大小），確認範圍正確後再執行。', usage:'file_to_prompt_preview {glob:"project/**/*.php"}', tools:[] },

  'rag_index':              { dept:'系統、Excel、文件、Python 與 Git', title:'RAG 索引建立', desc:'將專案檔案索引至 ChromaDB 向量資料庫，支援增量索引（僅處理變更檔案）。每個專案獨立 collection，可選共用 rag_shared。', usage:'rag_index {project:"PG_dbox3", paths:["PG_dbox3/admin/"]}', tools:['ChromaDB Docker'] },
  'rag_query':              { dept:'系統、Excel、文件、Python 與 Git', title:'RAG 語意搜尋', desc:'用自然語言查詢已索引的程式碼，從 ChromaDB 向量檢索最相關的程式碼片段。', usage:'rag_query {project:"PG_dbox3", query:"訂單折扣邏輯"}', tools:['ChromaDB Docker'] },
  'rag_status':             { dept:'系統、Excel、文件、Python 與 Git', title:'RAG 索引狀態', desc:'查看 ChromaDB 連線狀態、collection 統計、已索引檔案清單與語言分佈。', usage:'rag_status {project:"PG_dbox3"}', tools:['ChromaDB Docker'] },
};

/* ══════════════════════════════════════════════
   Panel Logic
   ══════════════════════════════════════════════ */

const panel        = document.getElementById('skillPanel');
const panelOverlay = document.getElementById('panelOverlay');
const panelCmd     = document.getElementById('panelSkillCmd');
const panelDept    = document.getElementById('panelDept');
const panelTitle   = document.getElementById('panelTitle');
const panelDesc    = document.getElementById('panelDesc');
const panelUsage   = document.getElementById('panelUsage');
const panelTools   = document.getElementById('panelTools');

function openPanel(key, isTool = false) {
  const d = isTool ? TOOLS[key] : SKILLS[key];
  if (!d) return;

  panelCmd.textContent   = isTool ? 'Tool: ' + key : '/' + key;
  if(panelDept) panelDept.textContent  = d.dept;
  if(panelTitle) panelTitle.textContent = d.title;
  if(panelDesc) panelDesc.textContent  = d.desc;
  if(panelUsage) panelUsage.textContent = d.usage;

  if(panelTools) {
    panelTools.innerHTML = d.tools && d.tools.length
      ? d.tools.map(t => `<span class="panel-tool-tag">${t}</span>`).join('')
      : '<span class="panel-no-tools">不需要 MCP 工具</span>';
  }

  panel.classList.add('open');
  if(panelOverlay) panelOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closePanel() {
  panel.classList.remove('open');
  if(panelOverlay) panelOverlay.classList.remove('active');
  document.body.style.overflow = '';
}

// Close button (exposed globally for onclick attribute)
function closePanelHandler() {
  closePanel();
}

// ESC key
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closePanel();
});

// Click outside (overlay)
if(panelOverlay) {
  panelOverlay.addEventListener('click', closePanel);
}

/* ══════════════════════════════════════════════
   Tag Click Binding
   ══════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', function() {
  /* ── Auto-count Stats ── */
  const skillCount = Object.keys(SKILLS).length;
  const toolCount  = Object.keys(TOOLS).length;
  const deptSet    = new Set(Object.values(SKILLS).map(s => s.dept));
  Object.values(TOOLS).forEach(t => deptSet.add(t.dept));
  const deptCount  = deptSet.size;

  ['heroSkillCount','statSkills'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = skillCount; });
  ['heroToolCount','statTools'].forEach(id =>  { const el = document.getElementById(id); if (el) el.textContent = toolCount; });
  const deptEl = document.getElementById('statDepts'); if (deptEl) deptEl.textContent = deptCount;

  const tags = document.querySelectorAll('.tag:not(.plan-tag)');
  tags.forEach(function(tag) {
    tag.addEventListener('click', function() {
      // Strip leading slash if present, then look up
      const raw = tag.textContent.trim().replace(/^\//, '');
      const isTool = tag.classList.contains('tool-tag');
      
      if (isTool && TOOLS[raw]) {
        openPanel(raw, true);
      } else if (!isTool && SKILLS[raw]) {
        openPanel(raw, false);
      }
    });
  });
  
  // Bind close button
  const closeBtn = document.getElementById('closePanel');
  if(closeBtn) {
    closeBtn.addEventListener('click', closePanel);
  }
});
