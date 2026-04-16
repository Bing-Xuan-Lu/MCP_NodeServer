/* MCP Tools 資料 */
const TOOLS = {
  'list_files':             { dept:'檔案系統 & 資料庫', title:'列出目錄內容', desc:'讀取指定目錄下的所有檔案與資料夾名稱。', usage:'list_files {path:"..."}', tools:[] },
  'read_file':              { dept:'檔案系統 & 資料庫', title:'讀取檔案內容', desc:'讀取檔案完整內容，支援大檔分段讀取 (offset/limit)。', usage:'read_file {path:"..."}', tools:[] },
  'create_file':            { dept:'檔案系統 & 資料庫', title:'建立或覆寫檔案', desc:'將指定的文字內容寫入檔案。', usage:'create_file {path:"...", content:"..."}', tools:[] },
  'apply_diff':             { dept:'檔案系統 & 資料庫', title:'修改檔案 (Search & Replace)', desc:'透過尋找並替換字串的方式修改檔案內容。回傳行號與淨行數變化。', usage:'apply_diff {path:"...", search:"...", replace:"..."}', tools:[] },
  'apply_diff_batch':       { dept:'檔案系統 & 資料庫', title:'批次修改多個檔案 (Search & Replace)', desc:'一次對多個檔案進行 Search & Replace，減少 tool call。每項含 path/search/replace，回傳各檔行號與淨行數變化。', usage:'apply_diff_batch {diffs:[{path:"...", search:"...", replace:"..."}]}', tools:[] },
  'read_files_batch':       { dept:'檔案系統 & 資料庫', title:'批次讀取多個檔案', desc:'一次讀取多個檔案（減少 tool call 來回），每個檔案回傳前 N 行摘要。', usage:'read_files_batch {paths:["..."]}', tools:[] },
  'list_files_batch':       { dept:'檔案系統 & 資料庫', title:'批次列出多個目錄內容', desc:'一次讀取多個目錄內容（減少 tool call 來回）。', usage:'list_files_batch {paths:["..."]}', tools:[] },
  'create_file_batch':      { dept:'檔案系統 & 資料庫', title:'批次建立多個檔案', desc:'一次建立或覆寫多個檔案，適合模板產生、多檔建立流程。', usage:'create_file_batch {files:[{path:"...",content:"..."}]}', tools:[] },

  'set_database':           { dept:'檔案系統 & 資料庫', title:'設定資料庫連線', desc:'設定資料庫連線資訊，同一次對話內所有查詢都會使用此連線。', usage:'set_database {host:"...", user:"...", ...}', tools:[] },
  'get_current_db':         { dept:'檔案系統 & 資料庫', title:'查看目前的資料庫連線', desc:'檢查目前 AI 記住的資料庫連線設定。', usage:'get_current_db {}', tools:[] },
  'get_db_schema':          { dept:'檔案系統 & 資料庫', title:'查看資料表結構', desc:'查看單一資料表的欄位定義與結構。', usage:'get_db_schema {table_name:"..."}', tools:[] },
  'execute_sql':            { dept:'檔案系統 & 資料庫', title:'執行 SQL 指令', desc:'執行 DDL/DML，支援多條語句以分號分隔逐條執行。', usage:'execute_sql {sql:"..."}', tools:[] },
  'get_db_schema_batch':    { dept:'檔案系統 & 資料庫', title:'批次查看多張資料表結構', desc:'一次查看多張表的 Schema，減少 tool call。', usage:'get_db_schema_batch {table_names:["..."]}', tools:[] },
  'execute_sql_batch':      { dept:'檔案系統 & 資料庫', title:'批次執行多組獨立 SQL', desc:'各自獨立連線執行，互不影響，不會因某條失敗而中斷。', usage:'execute_sql_batch {queries:[{sql:"..."}]}', tools:[] },

  'run_php_script':         { dept:'PHP & SFTP 部署', title:'執行 PHP 腳本', desc:'在伺服器上執行 PHP 腳本 (CLI 模式)，並回傳輸出結果。支援 container 參數在 Docker 容器內執行。', usage:'run_php_script {path:"...", container:"dev-php84"}', tools:[] },
  'run_php_test':           { dept:'PHP & SFTP 部署', title:'執行 PHP 測試', desc:'自動建立測試環境 (Session/Config) 並執行 PHP 腳本。支援 container 參數在 Docker 容器內執行。', usage:'run_php_test {targetPath:"...", container:"dev-php84"}', tools:[] },
  'send_http_request':      { dept:'PHP & SFTP 部署', title:'發送 HTTP 請求', desc:'發送 GET/POST 請求，支援 Multipart 實體檔案上傳。', usage:'send_http_request {url:"...", method:"..."}', tools:[] },
  'tail_log':               { dept:'PHP & SFTP 部署', title:'讀取 Log 最後 N 行', desc:'讀取檔案最後 N 行 (適用於查看 PHP Error Log)。支援 container 參數讀取 Docker 容器內的 log。', usage:'tail_log {path:"/var/log/apache2/error.log", container:"dev-php84"}', tools:[] },
  'send_http_requests_batch':{ dept:'PHP & SFTP 部署', title:'批次發送 HTTP 請求', desc:'並行發送多個請求，減少 tool call 延遲。', usage:'send_http_requests_batch {requests:[...]}', tools:[] },
  'run_php_script_batch':   { dept:'PHP & SFTP 部署', title:'批次執行多個 PHP 腳本', desc:'循序執行多支 PHP 腳本，適合測試、migration 批次跑。支援 container 參數在 Docker 容器內執行。', usage:'run_php_script_batch {container:"dev-php84", scripts:[{path:"..."}]}', tools:[] },

  'sftp_connect':           { dept:'PHP & SFTP 部署', title:'設定 SFTP 連線', desc:'設定後同一次對話內的所有操作都會使用此連線。支援 preset 參數一鍵載入已儲存的連線 + 路徑對應。', usage:'sftp_connect {preset:"my_project"} 或 sftp_connect {host:"...", user:"..."}', tools:[] },
  'sftp_upload':            { dept:'PHP & SFTP 部署', title:'上傳檔案/目錄', desc:'上傳本機檔案或整個目錄到遠端伺服器。若已載入 preset，可只傳相對路徑。', usage:'sftp_upload {local_path:"...", remote_path:"..."} 或 sftp_upload {local_path:"app/file.php"}', tools:[] },
  'sftp_preset':            { dept:'PHP & SFTP 部署', title:'管理部署 Preset', desc:'儲存/列出/刪除 SFTP 部署 preset（連線資訊 + local_base/remote_base 路徑對應 + excludes 排除清單），重啟後仍保留。', usage:'sftp_preset {action:"save", preset_name:"my_project", host:"...", user:"...", local_base:"D:\\\\Project\\\\xxx", remote_base:"/var/www/html_xxx/"}', tools:[] },
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
  
  'git_status':             { dept:'系統、Excel、Python 與 Git', title:'Git 狀態檢查', desc:'查看目前 Git 工作目錄狀態 (git status)。支援 container 參數在 Docker 容器內執行。', usage:'git_status {container:"dev-php84"}', tools:[] },
  'git_diff':               { dept:'系統、Excel、Python 與 Git', title:'Git 改動比對', desc:'查看檔案改動內容 (git diff)，支援 staged 模式。支援 container 參數在 Docker 容器內執行。', usage:'git_diff {file_path:"...", staged:true, container:"dev-php84"}', tools:[] },
  'git_log':                { dept:'系統、Excel、Python 與 Git', title:'Git 提交歷史', desc:'查看最近的 Commit 歷史 (git log)，預設顯示 5 筆一列。支援 container 參數在 Docker 容器內執行。', usage:'git_log {limit:5, container:"dev-php84"}', tools:[] },
  'git_stash_ops':          { dept:'系統、Excel、Python 與 Git', title:'Git Stash 操作', desc:'執行 Git Stash 相關操作 (push, pop, list)，用於暫存臨時工作。支援 container 參數在 Docker 容器內執行。', usage:'git_stash_ops {action:"push", message:"...", container:"dev-php84"}', tools:[] },

  'file_to_prompt':         { dept:'系統、Excel、文件、Python 與 Git', title:'檔案打包成 Prompt', desc:'將多個檔案內容打包成結構化 prompt（支援 glob pattern），免手動逐檔指定。輸出 XML/Markdown/Plain 格式。', usage:'file_to_prompt {glob:"project/**/*.php", format:"xml"}', tools:[] },
  'file_to_prompt_preview': { dept:'系統、Excel、文件、Python 與 Git', title:'預覽檔案匹配結果', desc:'預覽 file_to_prompt 會匹配哪些檔案（不讀取內容，僅列清單與大小），確認範圍正確後再執行。', usage:'file_to_prompt_preview {glob:"project/**/*.php"}', tools:[] },


  'css_specificity_check':  { dept:'CSS 分析', title:'CSS Specificity 分析', desc:'分析 CSS 檔案中所有包含目標 selector 的規則，回傳行號、specificity 分數、屬性清單。覆寫前先確認權重避免反覆迭代。', usage:'css_specificity_check {file:"...", selector:".imgbox"}', tools:[] },
  'css_computed_winner':    { dept:'CSS 分析', title:'CSS 規則勝出查詢', desc:'對活頁面查詢指定元素的某個 CSS property 最終由哪條規則勝出（類似 DevTools Computed 展開看來源），含所有競爭規則與 specificity。', usage:'css_computed_winner {url:"...", selector:".box", property:"grid-column"}', tools:['Playwright'] },

  'class_method_lookup':    { dept:'PHP 分析', title:'PHP Class/Method 原始碼定位', desc:'給定 class 名稱 + method 名稱（可選），直接回傳函式完整原始碼（含行號），一次到位取代 Grep→Read 兩步。省略 method 則回傳 class 概覽。', usage:'class_method_lookup {project:"...", class_name:"news", method_name:"getAll"}', tools:[] },

  'symbol_index':           { dept:'PHP 分析', title:'PHP 符號索引建立', desc:'掃描 PHP 專案建立 AST 符號索引（class、method、function），快取 10 分鐘，供 find_usages / find_hierarchy / find_dependencies 使用。', usage:'symbol_index {project:"..."}', tools:[] },
  'find_usages':            { dept:'PHP 分析', title:'找出所有引用位置', desc:'找出指定 class 或 method 在專案中所有被呼叫、繼承、實作的位置。基於 AST 精確分析，非文字搜尋。', usage:'find_usages {project:"...", class_name:"Order", method_name:"getList"}', tools:[] },
  'find_hierarchy':         { dept:'PHP 分析', title:'Class 繼承鏈查詢', desc:'列出指定 class 的完整繼承鏈：父類別、子類別、實作的 interface，以樹狀圖呈現。', usage:'find_hierarchy {project:"...", class_name:"BaseModel"}', tools:[] },
  'find_dependencies':      { dept:'PHP 分析', title:'檔案 include/require 依賴', desc:'列出指定檔案的 include/require 依賴關係（它引用了誰、誰引用了它）。', usage:'find_dependencies {project:"...", file:"admin/model/order.php"}', tools:[] },
  'trace_logic':            { dept:'PHP 分析', title:'業務邏輯流程追蹤', desc:'追蹤 PHP 函式/方法的控制流：解析 if/switch/迴圈/呼叫/回傳，輸出樹狀流程圖。支援遞迴追蹤子呼叫（max_depth 2-3）。', usage:'trace_logic {project:"...", function_name:"cancelOrder", class_name:"OrderModel", max_depth:2}', tools:[] },

  'image_transform':        { dept:'圖片處理', title:'圖片轉換與合成', desc:'resize、加背景色、圓形裁切、多圖合成、格式轉換、旋轉翻轉。一次呼叫可串聯多個操作。', usage:'image_transform {input:"...", operations:[{type:"resize", width:200}]}', tools:[] },
};
