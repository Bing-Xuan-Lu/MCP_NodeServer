/* ══════════════════════════════════════════════════════════
   Dashboard JS — Swiss Minimalism Dark
   project-migration-assistant-pro v5.1.0
   ══════════════════════════════════════════════════════════ */

const SKILLS = {
  'php_crud_generator':    { dept:'PHP 開發部',     title:'PHP後台CRUD模組產生器',           desc:'開始開發新功能前，只要提供資料表名稱，即可自動產生完整 PHP 後台 CRUD 模組（列表、新增、編輯、刪除、表單驗證、DB 操作）。',      usage:'/php_crud_generator [資料表名稱或功能描述]', tools:['get_db_schema','get_db_schema_batch','execute_sql','create_file','read_files_batch','send_http_requests_batch'] },
  'php_upgrade':           { dept:'PHP 開發部',     title:'PHP 7.x → 8.4 升級',             desc:'當 PHP 7.x 專案出現 Deprecated 警告，或需要升級 PHP 版本時，自動掃描並修正所有過時語法至 PHP 8.4 標準。', usage:'/php_upgrade',                              tools:['list_files','list_files_batch','read_file','read_files_batch','apply_diff'] },
  'php_path_fix':          { dept:'PHP 開發部',     title:'修正 PHP 混合斜線路徑問題',        desc:'掃描 PHP 專案中所有 Windows 反斜線路徑寫法（如 include "\\Folder\\file.php"），統一修正為正斜線跨平台格式。',       usage:'/php_path_fix',                             tools:['list_files','read_file','apply_diff'] },
  'dotnet_to_php':         { dept:'程式移植部',     title:'.NET C# → PHP 翻寫',             desc:'將 .NET（C#）程式碼翻譯為 PHP，保留業務邏輯，轉換語言特性（型別系統、LINQ、async/await、泛型等）。',               usage:'/dotnet_to_php',                            tools:['read_file','create_file','apply_diff','get_db_schema_batch'] },
  'php_crud_test':         { dept:'測試品管部',     title:'PHP CRUD 模組整合測試',              desc:'新功能開發完成後用於後端邏輯驗證：對 PHP 模組執行 CRUD 整合測試，逐步確認資料寫入與 DB 狀態一致性。',             usage:'/php_crud_test [模組描述]',                 tools:['send_http_request','send_http_requests_batch','execute_sql','execute_sql_batch','run_php_test','list_files_batch','read_files_batch','get_db_schema_batch'] },
  'playwright_ui_test':    { dept:'測試品管部',     title:'Playwright UI 自動化測試、除錯與截圖總覽', desc:'使用 Playwright 對網頁進行 UI 自動化測試（CRUD）、互動式除錯（Xdebug），或截圖模式快速瀏覽系統功能。支援 DEV_MODE 驗證碼繞過。', usage:'/playwright_ui_test [目標描述]', tools:['Playwright MCP'] },
  'web_performance':       { dept:'測試品管部',     title:'網站前端效能檢測與優化建議',       desc:'量測 LCP、FCP、TTI、資源大小等效能指標，分析載入瓶頸（大圖、未壓縮 JS/CSS），提供具體優化建議。',                usage:'/web_performance',                          tools:['Playwright MCP','send_http_request'] },
  'axshare_diff':          { dept:'規格分析部',     title:'AxShare 規格書 vs 網站差異比對（全站/單一單元）',  desc:'比對 AxShare 原型規格與實際測試網站。全站模式產出完整差異報告；單一單元模式針對特定模組深度分析（含 DB 影響評估、ALTER TABLE SQL），結果直接整合進現有報告檔。建議先執行 /axshare_spec_index 建立快照後再使用。',  usage:'/axshare_diff [模組名稱]',  tools:['Playwright MCP'] },
  'axshare_spec_index':    { dept:'規格分析部',     title:'AxShare 規格書一次性建立本地索引',              desc:'一次爬取整份 AxShare 規格書（或本地匯出 HTML），將所有頁面的欄位、按鈕、邏輯、日期標記整理成結構化 Markdown 索引檔。後續 /axshare_diff 可直接讀取此檔案，不需每次重爬規格書，速度快且不受 iframe 限制。', usage:'/axshare_spec_index [規格書來源]', tools:['Playwright MCP','list_files','create_file'] },
  'db_schema_designer':    { dept:'資料庫規劃部',   title:'MySQL 資料表結構設計',             desc:'需求訪談後、開工前，根據業務描述設計符合 3NF 的資料表結構與索引策略，輸出可直接執行的 CREATE TABLE SQL。',          usage:'/db_schema_designer [業務描述]',             tools:['load_db_connection','get_db_schema','get_db_schema_batch','execute_sql'] },
  'db_migration_generator':{ dept:'資料庫規劃部',   title:'Schema 差異遷移腳本產生器',        desc:'比對現有 DB Schema 與目標設計的差異，產生 ALTER TABLE 遷移腳本與回滾腳本，並標示 DROP COLUMN 等高風險操作。',       usage:'/db_migration_generator [目標描述]',         tools:['load_db_connection','get_db_schema','get_db_schema_batch','execute_sql','execute_sql_batch'] },
  'db_migration_run':      { dept:'資料庫規劃部',   title:'批次執行 DB 遷移並追蹤版本',       desc:'與 /db_migration_generator 互補：批次執行遷移 SQL、建立 _migrations 版本追蹤表、紀錄執行歷史，並支援 rollback 回滾。', usage:'/db_migration_run [SQL檔案或描述]',          tools:['load_db_connection','execute_sql','execute_sql_batch','get_db_schema','get_db_schema_batch','read_file'] },
  'db_index_analyzer':     { dept:'資料庫規劃部',   title:'MySQL 查詢效能與索引優化分析',     desc:'執行 EXPLAIN 分析慢查詢，識別全表掃描、冗餘索引、索引順序錯誤等問題，產生 ADD/DROP INDEX 優化腳本與效能預估。',    usage:'/db_index_analyzer [SQL 或表格名稱]',        tools:['load_db_connection','get_db_schema','get_db_schema_batch','execute_sql','execute_sql_batch'] },
  'sftp_deploy':           { dept:'部署維運部',     title:'本機 PHP 專案部署到遠端測試機',    desc:'透過 SFTP 將本機 PHP 目錄上傳到遠端伺服器，部署前確認目標目錄內容，部署後驗證遠端檔案結果。',                    usage:'/sftp_deploy',                              tools:['sftp_connect','sftp_upload','sftp_list'] },
  'sftp_pull':             { dept:'部署維運部',     title:'從遠端測試機拉取程式到本機',       desc:'透過 SFTP 將遠端伺服器的檔案或目錄下載到本機，適用於取回測試機改動、備份遠端資料或同步最新版本。',               usage:'/sftp_pull',                                tools:['sftp_connect','sftp_download','sftp_list','sftp_list_batch'] },
  'sftp_ops':              { dept:'部署維運部',     title:'遠端主機即時除錯與環境檢查',       desc:'透過 SFTP 連線遠端主機，讀取 error log、檢查設定檔、確認目錄結構。UI 測試失敗時可直接查看後端報錯，快速定位問題。', usage:'/sftp_ops [除錯目標描述]',                   tools:['sftp_connect','sftp_list','sftp_list_batch','sftp_download','read_files_batch','tail_log'] },
  'docker_relocate':       { dept:'Docker 維運部', title:'Docker Compose 開發環境搬遷',     desc:'將 Docker Compose 環境從一個路徑搬遷到另一個路徑，自動更新 Volume 掛載路徑與所有相關設定檔。',                    usage:'/docker_relocate',                          tools:['read_file','apply_diff','create_file'] },
  'docker_compose_ops':    { dept:'Docker 維運部', title:'Docker Compose 日常操作',          desc:'執行 docker compose up/down/restart/logs/ps 等日常操作，根據目前環境狀態自動判斷最佳操作方式。',                   usage:'/docker_compose_ops',                       tools:[] },
  'docker_short_url':      { dept:'Docker 維運部', title:'Docker Apache 短路徑映射設定',     desc:'為 Docker 容器中的 Apache 設定 mod_rewrite RewriteRule，讓長 URL 路徑可用短路徑存取，不影響其他專案。',            usage:'/docker_short_url',                         tools:['read_file','create_file','apply_diff','send_http_request'] },
  'version_conflict_debug':{ dept:'Docker 維運部', title:'服務元件版本相容性衝突診斷修復',   desc:'當兩服務整合出現神秘連線失敗或 API 拒絕時，系統性收集版本、分析 log 訊號、測試通訊、判斷根因並套用修復。適用 Docker+Traefik、PHP+MySQL、Node+npm 等任意組合。', usage:'/version_conflict_debug [Component A] [Component B] [錯誤症狀]', tools:[] },
  'git_worktree':          { dept:'開發流程部',     title:'建立隔離 Git Worktree',           desc:'為需要並行開發的分支建立 Git Worktree，自動設定相依性與環境，讓多分支同時開發互不干擾。',                          usage:'/git_worktree',                             tools:[] },
  'tdd':                   { dept:'開發流程部',     title:'TDD Red-Green-Refactor 循環指引', desc:'引導開發者按照 TDD 節奏：先寫失敗測試（Red）→ 最小實作（Green）→ 重構（Refactor），確保每步都有測試保護。',        usage:'/tdd [功能描述]',                            tools:['run_php_test','read_file','apply_diff'] },
  'clean_arch':            { dept:'開發流程部',     title:'Clean Architecture 架構審查',     desc:'當發現現有程式碼混亂（God Class、業務邏輯散落 Controller、循環依賴）時，審查並提供 Clean Architecture 重構路線圖。',    usage:'/clean_arch',                               tools:['list_files','read_file'] },
  'ddd':                   { dept:'開發流程部',     title:'PHP DDD 架構規範指引',            desc:'開發新功能前的架構規範指引，提供 Clean Architecture 四層目錄結構、領域命名規範（避免 utils/helpers）、Early Return、DRY 等程式碼品質規則。', usage:'/ddd [模組名稱]',                          tools:['read_file'] },
  'sadd':                  { dept:'開發流程部',     title:'規格書驅動逐任務派遣開發',         desc:'有規格書後，以 SADD 模式建立任務清單，逐一派遣 SubAgent 執行並審查。支援循序（DB→Model→Controller）與並行（獨立模組同步）兩種模式，防止上下文污染與缺陷累積。', usage:'/sadd [規格書路徑]',                      tools:[] },
  'directory_reorganize':  { dept:'開發流程部',     title:'目錄結構自動分類整理',             desc:'分析目錄內所有檔案，根據功能與命名規律自動建立子資料夾分類，搬移檔案並產出整理報告。',                            usage:'/directory_reorganize [目錄路徑]',           tools:['list_files','create_file'] },
  'bookmark_organizer':    { dept:'系統工具部',     title:'Chrome 書籤整理助手',             desc:'整理 Chrome 書籤：掃描無效連結（404/DNS 失效）、移除重複書籤、依主題分類到資料夾、排序整理。',                    usage:'/bookmark_organizer',                       tools:['scan_and_clean_bookmarks','move_bookmarks','sort_bookmarks'] },
  'learn_claude_skill':    { dept:'Claude 維運部',  title:'從對話學習並建立 Skill',          desc:'當某個工作流程重複了 2-3 次、想固化為可重用指令時，從對話歷史提取模式、按規範撰寫 MD 並自動部署。',                 usage:'/learn_claude_skill',                       tools:['save_claude_skill','list_claude_skills'] },
  'git_commit':            { dept:'系統工具部',     title:'產生繁體中文 Git Commit 訊息',    desc:'分析 git diff 與 git status，自動產生符合專案慣例的繁體中文 Commit 訊息（含 Co-authored-by），並執行 commit。',    usage:'/git_commit',                               tools:['git_status','git_diff'] },
  'relocate_directory':    { dept:'系統工具部',     title:'搬移目錄並更新所有路徑引用',       desc:'搬移目錄到新位置後，自動掃描並更新所有 .json、.bat、.md、設定檔中的舊路徑引用，確保不遺漏。',                     usage:'/relocate_directory',                       tools:['list_files','read_file','apply_diff'] },
  'windows_node_autostart':{ dept:'系統工具部',     title:'Windows Node.js 開機自動啟動',     desc:'使用 VBS 單例保護 + Task Scheduler XML 設定 Node.js 服務開機靜默啟動，防重複執行、延遲避免搶佔網路。',              usage:'/windows_node_autostart',                   tools:[] },
  'gitignore_setup':       { dept:'系統工具部',     title:'掃描專案並自動補全 .gitignore',    desc:'掃描專案目錄識別機密、建置產出、OS/IDE 暫存等不應提交的檔案，與現有 .gitignore 比對後補全規則，並提示 git rm --cached 已追蹤的問題檔案。', usage:'/gitignore_setup [路徑或排除需求]',          tools:['list_files','read_file','apply_diff'] },
  'project_claudemd':      { dept:'Claude 維運部',  title:'為專案自動產生 CLAUDE.md 專案文件', desc:'系統性探索專案結構、設定檔、架構模式，自動產生結構化的 CLAUDE.md，讓 Claude 能快速理解專案全貌。',                  usage:'/project_claudemd [額外指示]',              tools:[] },
  'skill_audit':           { dept:'Claude 維運部',  title:'Skill 耦合審計與合併建議',         desc:'技能越來越多不知用哪個時，掃描所有 Skill 找出重疊、命名混淆的技能，產出優先行動清單並執行合併或刪除。',           usage:'/skill_audit',                              tools:[] },
  'fetch_article':         { dept:'內容擷取部',     title:'網頁文章擷取與儲存',              desc:'需要永久儲存文章時，擷取網頁正文並存為 .txt 檔（若只要當場閱讀與分析，請改用 /read_article）。',                       usage:'/fetch_article [URL]',                      tools:['send_http_request','create_file'] },
  'read_article':          { dept:'內容擷取部',     title:'快速閱讀網頁文章並摘要',           desc:'丟一個 URL 立即獲得結構化摘要（主題、重點、洞察），適合技術文章、觀點評論的當場分析與討論。',                       usage:'/read_article [URL]',                       tools:['WebFetch'] },
  'yt_transcript':         { dept:'內容擷取部',     title:'YouTube 字幕轉純文字',            desc:'從 YouTube 影片下載自動生成或手動字幕（支援中英），清理時間碼後輸出為可閱讀的純文字，方便筆記或摘要。',             usage:'/yt_transcript [YouTube URL]',              tools:['send_http_request','create_file'] },
  'youtube_organizer':     { dept:'生活自動化部',   title:'YouTube 播放清單自動分類',         desc:'分析播放清單中的影片，依語言（中文/日文/英文）與類型（流行/搖滾/古典/動漫）自動分類整理到不同歌單。',             usage:'/youtube_organizer [播放清單URL]',           tools:['send_http_request'] },
  'n8n_workflow_ops':      { dept:'生活自動化部',   title:'n8n 工作流建立/更新 SOP',         desc:'新建或安全更新 n8n workflow。新建模式：Create → PUT settings → Activate → Backup；更新模式：Deactivate → PUT → Activate → Verify。', usage:'/n8n_workflow_ops',                         tools:['send_http_request'] },
  'n8n_discord_dispatcher':{ dept:'生活自動化部',   title:'n8n Discord 指令路由調度器',      desc:'建立 n8n Discord Bot 指令路由，讓不同的 Discord Slash Command 能觸發對應的 n8n workflow 分支處理。',              usage:'/n8n_discord_dispatcher',                   tools:['send_http_request'] },
  'n8n_webhook_debug':     { dept:'生活自動化部',   title:'n8n Webhook 不觸發除錯',          desc:'診斷 n8n Webhook 節點無回應的根因：log 分析、HTTP method 測試、httpMethod 參數修復、deactivate→PUT→activate 流程。',  usage:'/n8n_webhook_debug',                        tools:['send_http_request'] },
};

const TOOLS = {
  'list_files':             { dept:'檔案系統 & 資料庫', title:'列出目錄內容', desc:'讀取指定目錄下的所有檔案與資料夾名稱。', usage:'list_files {path:"..."}', tools:[] },
  'read_file':              { dept:'檔案系統 & 資料庫', title:'讀取檔案內容', desc:'讀取檔案完整內容，支援大檔分段讀取 (offset/limit)。', usage:'read_file {path:"..."}', tools:[] },
  'create_file':            { dept:'檔案系統 & 資料庫', title:'建立或覆寫檔案', desc:'將指定的文字內容寫入檔案。', usage:'create_file {path:"...", content:"..."}', tools:[] },
  'apply_diff':             { dept:'檔案系統 & 資料庫', title:'修改檔案 (Search & Replace)', desc:'透過尋找並替換字串的方式修改檔案內容。', usage:'apply_diff {path:"...", search:"...", replace:"..."}', tools:[] },
  'read_files_batch':       { dept:'檔案系統 & 資料庫', title:'批次讀取多個檔案', desc:'一次讀取多個檔案（減少 tool call 來回），每個檔案回傳前 N 行摘要。', usage:'read_files_batch {paths:["..."]}', tools:[] },
  'list_files_batch':       { dept:'檔案系統 & 資料庫', title:'批次列出多個目錄內容', desc:'一次讀取多個目錄內容（減少 tool call 來回）。', usage:'list_files_batch {paths:["..."]}', tools:[] },
  
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

  'sftp_connect':           { dept:'PHP & SFTP 部署', title:'設定 SFTP 連線', desc:'設定後同一次對話內的所有操作都會使用此連線。', usage:'sftp_connect {host:"...", user:"..."}', tools:[] },
  'sftp_upload':            { dept:'PHP & SFTP 部署', title:'上傳檔案/目錄', desc:'上傳本機檔案或整個目錄到遠端伺服器。', usage:'sftp_upload {local_path:"...", remote_path:"..."}', tools:[] },
  'sftp_download':          { dept:'PHP & SFTP 部署', title:'下載檔案/目錄', desc:'從遠端伺服器下載檔案或目錄到本機。', usage:'sftp_download {remote_path:"...", local_path:"..."}', tools:[] },
  'sftp_list':              { dept:'PHP & SFTP 部署', title:'列出遠端目錄', desc:'列出遠端目錄內容（檔名、類型、大小、修改時間）。', usage:'sftp_list {remote_path:"..."}', tools:[] },
  'sftp_delete':            { dept:'PHP & SFTP 部署', title:'刪除遠端檔案', desc:'刪除遠端檔案或目錄（支援遞迴刪除）。', usage:'sftp_delete {remote_path:"..."}', tools:[] },
  'sftp_list_batch':        { dept:'PHP & SFTP 部署', title:'批次列出遠端目錄', desc:'共用一條連線，一次列出多個目錄內容。', usage:'sftp_list_batch {remote_paths:["..."]}', tools:[] },

  'get_excel_values_batch': { dept:'系統、Excel 與 Python', title:'批次讀取 Excel 儲存格', desc:'批次讀取 Excel 儲存格 (省 Token 版)，支援範圍或列表。', usage:'get_excel_values_batch {path:"...", sheet:"..."}', tools:[] },
  'trace_excel_logic':      { dept:'系統、Excel 與 Python', title:'追蹤 Excel 邏輯鏈', desc:'追蹤公式「引用來源」與「從屬影響」。', usage:'trace_excel_logic {path:"...", cell:"..."}', tools:[] },
  'simulate_excel_change':  { dept:'系統、Excel 與 Python', title:'模擬修改 Excel 重算', desc:'模擬修改 Excel 數值並重算結果 (不修改原檔)。', usage:'simulate_excel_change {path:"...", changeCell:"..."}', tools:[] },

  'save_claude_skill':      { dept:'系統、Excel 與 Python', title:'儲存 Claude Skill', desc:'將對話提取為 Skill 檔案並自動部署到 Claude Code。', usage:'save_claude_skill {name:"...", content:"..."}', tools:[] },
  'list_claude_skills':     { dept:'系統、Excel 與 Python', title:'列出所有 Skills', desc:'列出目前已建立及部署的所有 Skills。', usage:'list_claude_skills {}', tools:[] },
  'delete_claude_skill':    { dept:'系統、Excel 與 Python', title:'刪除 Skill', desc:'刪除指定的 Skill 檔案。', usage:'delete_claude_skill {name:"..."}', tools:[] },
  
  'grant_path_access':      { dept:'系統、Excel 與 Python', title:'開放目錄權限', desc:'將 basePath 外的路徑加入白名單允許存取。', usage:'grant_path_access {path:"..."}', tools:[] },
  'list_allowed_paths':     { dept:'系統、Excel 與 Python', title:'列出允許存取路徑', desc:'列出目前 MCP 可以存取的 basePath 與白名單。', usage:'list_allowed_paths {}', tools:[] },
  'revoke_path_access':     { dept:'系統、Excel、Python 與 Git', title:'撤銷目錄權限', desc:'從白名單移除指定路徑。', usage:'revoke_path_access {path:"..."}', tools:[] },

  'run_python_script':      { dept:'系統、Excel、Python 與 Git', title:'執行 Python 腳本', desc:'在 Docker (python_runner) 中執行 Python 程式碼，支援 inline 與實體檔案。', usage:'run_python_script {code:"..."}', tools:[] },
  
  'git_status':             { dept:'系統、Excel、Python 與 Git', title:'Git 狀態檢查', desc:'查看目前 Git 工作目錄狀態 (git status)，包含未暫存與未追蹤檔案。', usage:'git_status {}', tools:[] },
  'git_diff':               { dept:'系統、Excel、Python 與 Git', title:'Git 改動比對', desc:'查看檔案改動內容 (git diff)，支援 staged 模式。', usage:'git_diff {file_path:"...", staged:true}', tools:[] },
  'git_log':                { dept:'系統、Excel、Python 與 Git', title:'Git 提交歷史', desc:'查看最近的 Commit 歷史 (git log)，預設顯示 5 筆一列。', usage:'git_log {limit:5}', tools:[] },
  'git_stash_ops':          { dept:'系統、Excel、Python 與 Git', title:'Git Stash 操作', desc:'執行 Git Stash 相關操作 (push, pop, list)，用於暫存臨時工作。', usage:'git_stash_ops {action:"push", message:"..."}', tools:[] },
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
