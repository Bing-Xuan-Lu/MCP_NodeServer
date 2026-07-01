# CLAUDE.md — MCP_NodeServer 專案指引

Node.js MCP Server，提供 Claude Code 工具能力與 Agent Skills。
名稱：`project-migration-assistant-pro` v5.1.0

---

## 目錄結構

```text
MCP_NodeServer/
├── index.js             ← MCP Server 主程式 v5.1.0（工具路由 + Skills 路由）
├── env.js               ← 環境變數統一載入（dotenv + 匯出常數，hooks / index.js / config.js 共用）
├── .env.example         ← 環境變數範本（進版控，複製為 .env 使用）
├── config.js            ← resolveSecurePath()，basePath 優先讀 .env
├── setup.ps1            ← 環境初始化與 PowerShell 工具鏈配置
├── .mcp.json            ← MCP Server 設定（Claude Code 自動讀取）
├── memory/              ← 長期記憶與知識庫 (MEMORY.md)
│   ├── feedback/        ← 操作回饋與最佳實踐 (playwright, qc, tooling...)
│   ├── project/         ← 專案特定知識與部署細節
│   ├── reference/       ← 靜態參考資料與外部文件連結
│   └── user/            ← 使用者偏好與設定
├── tools/               ← MCP 工具模組（分類分層，動態載入自 index.js glob pattern：tools/**/*.js）
│   ├── _shared/         ← 共用模組（工具間共享的常數、函式、資源池，不對外暴露）
│   │   ├── browser_pool.js ← Playwright browser pool factory（browser/* 共用）
│   │   ├── playwright_measure_prep.js ← prepareForMeasure（css_inspect/element_measure/css_computed_winner 共用的量測前置：等 loading 遮罩消失 → 依序點 trigger 展開 popup/modal，一般 click 被遮罩攔截 timeout 時自動 JS .click() fallback，並回報「被 .xxx 遮罩攔截」診斷；解 AJAX loader 蓋住目標導致 click 卡 3000ms 必失敗的痛點）
│   │   ├── php_modernizer.php ← php_modernize 的 token_get_all 詞法轉換器（tee 進容器執行，純 PHP，ASCII only）
│   │   └── utils.js     ← 驗證函式、錯誤處理、async 工具（全工具可用）
│   ├── file_io/         ← 檔案讀寫與文件轉換（通用 I/O）
│   │   ├── filesystem.js ← list_files, read_file, create_file, apply_diff, apply_diff_batch, read_files_batch, list_files_batch, create_file_batch
│   │   ├── cleanup.js   ← cleanup_path（白名單 tmp 路徑安全遞迴刪除：D:/tmp/、Temp、repo 根 /tmp/（run_python_script 產出，跨機動態推導）、_tmp_remote/_drift/.tmp segment）
│   │   ├── multi_inject.js ← multi_file_inject（跨檔 anchor-based 插入，CRLF/LF + indent 偵測 + idempotent skip）
│   │   ├── excel.js     ← get_excel_values_batch, trace_excel_logic, simulate_excel_change
│   │   ├── export_fetch.js ← fetch_export_file（帶 cookie / 先登入下載受保護的 .xlsx/.xls/.csv 匯出檔 → SheetJS 解析回傳可讀儲存格；偵測被導去登入頁、csv 走 UTF-8 解碼防亂碼；解 send_http_request 拿到 binary 亂碼的痛點）
│   │   ├── word.js      ← read_word_file, read_word_files_batch (.docx → Markdown/HTML/Text)
│   │   ├── pptx.js      ← read_pptx_file, read_pptx_files_batch (.pptx → Markdown/Text + 圖片)
│   │   ├── pdf.js       ← read_pdf_file, read_pdf_files_batch (.pdf → Markdown/Text)
│   │   ├── images.js    ← read_image, read_images_batch（圖片讀取 + 縮放，支援 PNG/JPG/WebP/GIF/SVG）
│   │   └── video.js     ← read_video（影片 → faster-whisper 字幕 + ffmpeg 關鍵幀，支援 MP4/MOV/MKV/WebM/AVI/M4V，走 python_runner）
│   ├── data/            ← 資料庫（DB）+ Google Sheet
│   │   ├── database.js  ← set_database, load_db_connection, get_current_db, get_db_schema, execute_sql, get_db_schema_batch, execute_sql_batch, schema_diff, mysql_log_tail
│   │   └── gsheet.js    ← gsheet_fetch_with_state（含 auto_recalc_check polling + preserve_validation 旗標：跳過空字串寫入以保留 data validation/dropdown）, gsheet_xlookup_trace, trace_gsheet_formula, gsheet_get_metadata, gsheet_fetch_formatted, gsheet_get_values（輕量 batch get，value_render 可選 UNFORMATTED/FORMATTED/FORMULA）, gsheet_set_values（輕量 batch update 純寫入）（gspread 一條龍 + 查表鏈遞迴展開 + markdown 公式追蹤報告 + worksheet metadata 列舉 + FORMATTED_VALUE 顯示字串抓取 + 輕量讀寫取代 PHP 手刻 JWT+curl 打 Sheets API，python_runner 容器）
│   ├── deploy/          ← 部署與版控工具（遠端操作、DB migration、本機 docker 操作）
│   │   ├── docker_ops.js ← docker_cp（本機 docker container ↔ 主機檔案拷貝；basePath 白名單 + container 名 + path regex 防注入；遠端機器仍走 ssh_exec）
│   │   ├── sftp.js      ← sftp_connect, sftp_upload, sftp_download, sftp_list, sftp_delete, sftp_*_batch, sftp_preset, sftp_diff_hash（MD5 比對本機 vs 遠端不下載全文；分類 identical/content_diff/eol_only/missing）。sftp_upload 在「無 session 快照」時改用 hash 即時比對：內容相同免上傳、僅換行差異放行、真內容不同才擋（解重開 session 被盲擋問題）
│   │   ├── php.js       ← run_php_script, run_php_code（lint:true 走 php -l /dev/stdin 做語法檢查，先 read_file 讀主機檔內容再傳 code，繞過容器看不到 Windows 路徑；**remote:true 在已 sftp_connect 的遠端主機執行**：code/path 經 SSH→docker exec -i 灌進遠端容器 php，免再 ssh_exec 手刻或 mcp-fallback，解遠端測試機/正式機容器 PHP 執行），共用 sftp.js 的 runRemoteSSH, run_php_test, send_http_request（Postman 風格輸出：方法+網址/狀態碼+耗時+大小+content-type/重要 Response Headers/Body 自動 JSON 美化 + body_filter regex tool 端過濾 + follow_redirects:false 不跟轉址並回傳 Location/status header 用於測權限把關 + return_headers:true 列全部標頭 + 連線失敗時挖出 error.cause 真正錯誤碼（DNS/連線被拒/TLS 憑證鏈/逾時）＋白話原因＋建議動作，不再只丟 fetch failed + timeout_ms 逾時（預設 30s，AbortSignal.timeout）+ insecure:true 略過 TLS 驗證（瀏覽器能連但 Node 報憑證鏈/自簽/過期時用，限信任測試機）, tail_log, send_http_requests_batch（每筆同 Postman 風格輸出：狀態列+耗時+大小+content-type / 重要 headers / Body JSON 美化；summary 依 HTTP <400 計 ✅、亦支援 body_filter 套用到每筆；同樣回傳真正錯誤碼診斷 + timeout_ms + insecure（整批一致））, run_php_script_batch（stderr 自動過濾 Xdebug Step Debug 連線失敗雜訊）
│   │   ├── php_modernize.js ← php_modernize（PHP 舊版語法確定性機械升級：用 token_get_all 詞法分析做 6 條語法等價轉換 — 移除結尾 ?>／$str{0}→$str[0]／PHP4 同名建構子→__construct（含 namespace 自動略過）／var→public／define 裸常數加引號／__autoload 改名 _mcp_autoload + spl_autoload_register；每檔改完容器內 php -l 過才寫回。需語意判斷的 mysql_*/ereg/each/create_function/session_register/magic_quotes 不自動改只列殘留數交 LLM。預設 apply:false 預覽，確認才寫；自動跳過 vendor/lib/plugin 等第三方目錄。轉換器 _shared/php_modernizer.php tee 進容器執行）
│   │   ├── git.js       ← git_status, git_diff, git_log, git_stash_ops（container 模式用 -w workdir 指定容器內 repo 路徑，預設 /var/www/html；本機模式可加 cwd 指定專案目錄，修正容器內非 repo cwd 導致 "not a git repository"）
│   │   ├── skill_factory.js ← save/list/delete_claude_skill, grant/list/revoke_path_access
│   │   └── flyway.js    ← flyway_info, flyway_migrate, flyway_validate, flyway_repair, flyway_baseline（需 dev-flyway Docker，選用）
│   ├── browser/         ← 瀏覽器自動化與網頁檢查（UI testing、CSS 分析）
│   │   ├── dom_compare.js ← dom_compare（批次比對兩個 URL 的 CSS/HTML/JS 差異；使用 browser_pool）
│   │   ├── playwright_tools.js ← browser_interact, page_audit, css_inspect, element_measure（後二者新增 trigger_selectors/wait_for_hidden/click_timeout/force_click：等 loading 遮罩消失再點展開器量測，遮罩攔截 click 自動 JS fallback，共用 _shared/playwright_measure_prep.js）, style_snapshot, css_coverage（含 detectOverridden 死宣告偵測）, browser_save_session, browser_restore_session
│   │   ├── css_tools.js ← css_specificity_check, css_computed_winner（使用 browser_pool；trigger 點擊改用 _shared/playwright_measure_prep.js：可設 click_timeout + wait_for_hidden 等遮罩 + force_click，不再寫死 3000ms 被 loader 攔截）
│   │   └── print_layout.js ← print_layout_test（列印版面測試：Playwright 產真實分頁 PDF → poppler render 每頁 PNG → 回傳頁圖 + 頁數 + 字體嵌入 + selector 落點；需 python_runner 容器，缺 poppler 自動補裝）
│   ├── system/          ← 系統工具（多 Agent 協調、外部程式執行、程式碼分析）
│   │   ├── python.js    ← run_python_script (Docker)
│   │   ├── bookmarks.js ← Chrome 書籤管理（12 個工具）
│   │   ├── agent_coord.js ← agent_coord（多 Agent 協調：post/poll/status/delete/archive/suggest_dispatch）
│   │   ├── file_to_prompt.js ← file_to_prompt, file_to_prompt_preview
│   │   ├── php_class.js ← class_method_lookup（PHP 原始碼直接定位，自動解析 use Trait）
│   │   ├── php_symbol.js ← symbol_index, find_usages, find_hierarchy, find_dependencies, trace_logic, find_dead_symbols（PHP AST 符號索引 + 邏輯追蹤 + 死碼掃描：用索引列出所有 class/method/function 定義再用全專案呼叫記錄反查零引用候選，分高/中/低信心，偵測 call_user_func 等動態呼叫降信心，取代逐一 find_usages 土法煉鋼）
│   │   ├── php_text_search.js ← php_text_search（PHP 純文字搜尋；搜結構語法時自動指引改用 AST 工具）
│   │   ├── js_symbol.js ← js_symbol_index, js_symbol_lookup, js_find_usages, js_trace_logic（JS/TS/Vue AST 符號索引：function/class/object methods + `obj.method=fn` 賦值 + `return {fn}` 工廠 pattern；亦掃 .php/.html/.htm 內嵌 `<script>` 區塊 JS，行號對應原始檔，legacy 內嵌 Vue methods 適用）
│   │   ├── css_class.js ← css_class_lookup, css_find_usages（CSS class 定義位置 + 跨檔引用：HTML/PHP/JS/Vue 內 class attribute / addClass / classList / querySelector）
│   │   ├── memory_triggers.js ← list_memory_triggers, memory_add_triggers, memory_remove_triggers（管理 memory frontmatter `triggers`，給 memory-auto-recall hook 用）
│   │   └── session_search.js ← session_search（跨 session 全文搜歷史對話：檔名/錯誤/功能關鍵字，回哪場/何時/命中幾次/片段）, session_changed_files（跨 session 反查：某專案近 N 天哪些程式檔被動過、各來自哪幾場 session；給 /session_deploy 配 git_status 一次全推用，唯讀）, session_recall（回顧某一場做了什麼/卡在哪/動過哪些檔/SQL/**失敗或被擋的呼叫＋原因**/**本場 SFTP 部署上傳了哪些檔（實推 / 略過 / 成功數）**/**最後一則 assistant 訊息「完整」保留不砍字（交接以這則為準）**/**偵測「結束在等使用者回答的抉擇」pendingDecision→頂部警示 + 標明未完成 TODO 可能是中途計畫已被推翻，解「照作廢 TODO 重做上一場勸阻的事」**/**使用者貼上的內嵌截圖（base64）自動 dump 成 PNG 到 D:\tmp\claude-recall-img\ 並在輸出列出 read_image 路徑＋出現位置，補「交接只看文字、貼進對話的截圖整張消失」盲區；只撈 user 貼圖不吃 Playwright 工具截圖**）；spawn ~/.claude/hooks/session-recall-scan.js（含 index/list/recall/search 四模式，亦給 session-start 與 session-recall-on-prompt 共用）重用解析邏輯，解「換場重踩同個坑」與 token 空轉
│   └── utils/           ← 通用工具與比對
│       ├── image_diff.js ← image_diff（設計稿 vs 截圖像素級比對）
│       ├── image_transform.js ← image_transform（圖片 resize / 背景色 / 圓形裁切 / 合成）
│       ├── file_diff.js ← file_diff（純 Node 雙檔 unified diff，零依賴；取代 Bash git diff fallback；支援 project 參數讓相對路徑接 basePath/{project}/）
│       ├── analyze_csv.js ← analyze_csv（CSV pivot/group/aggregate；filter + group_by + count/sum/avg/min/max/distinct/top_values，取代 batch test 後手寫 PHP/Node 解析腳本）
│       └── csv_recompute_audit.js ← csv_recompute_audit（對照 baseline CSV 跑 PHP class::method 重算 → 輸出 diff CSV；嚴格字串相等比對；情境：報價/計算類 service 對齊 Sheet baseline 避免重跑 GSheet quota）
├── hooks/               ← Claude Code Session Hooks（全域 ~/.claude/settings.json 設定）
│   ├── session-start.js ← SessionStart：對話開場載入記憶 + **最近場次輕量索引**（取代倒一份過期 compact；走 session-recall-scan index 模式，列最近 6 場日期/主題/未完成/失敗數/熱檔當「地圖」）+ 浮現 hook 投訴 + 浮現 /lesson 暫存的對話品質教訓（待 /retro lesson 轉化）
│   ├── session-recall-on-prompt.js ← UserPromptSubmit：使用者送出指令時，從 prompt 抽關鍵字（檔名含資料/文件副檔名如 .xlsx/.csv/.docx 與**中文檔名**、PascalCase 識別字、URL 段），搜「本專案」歷史找**最相關**那場（非最近那場），注入它動過的檔/失敗呼叫/未完成/片段；**另有延續詞路徑**：prompt 含「上一場/上次/繼續/還沒做完…」即使抽不到關鍵字，也按時間 recall「上一場」（已排除當前對話、防單場自我注入），逼 Claude 不裸 Glob 從零重找、不自己湊資料。抽不到關鍵字且無延續詞、或命中<2 則靜默；同場每對話只注入一次（延續詞路徑用 `__prev__` 去重）。解「session_search 要人手動喊」「開場按時間撈撈錯場」與「上一場沒寫關鍵字就被略過」
│   ├── mcp-down-guard.js ← PreToolUse：三態偵測 MCP 狀態。**down**（末段 mcp__* 呼叫失敗且含 timeout/connection/disconnected 特徵）→ 封鎖所有非 allowlist 工具（原強封鎖）；**healthy**（最近 mcp__* 成功）→ 一律放行；**unknown**（末段窗口完全沒有 mcp__* 結果＝工具可能從 deferred 清單消失、根本沒被呼叫，原盲點）→ 僅在「最後一則 assistant 訊息宣稱 MCP 不可用（斷線/沒連上/清單只剩/heartbeat 停）」＋「當前正跑 DB/PHP/HTTP 繞道指令（docker exec mysql/php、mysql -、curl、php -r）」兩者齊備才擋，其餘（一般 Bash、Read/Edit、純討論 meta 情境）放行避免誤殺。TodoWrite 恆放行、mcp__* 自己放行讓它試連線，下次 mcp__* 成功呼叫自動解封
│   ├── playwright-closed-guard.js ← PreToolUse(matcher browser_)：偵測 Playwright 瀏覽器被手動關閉/crash（transcript 末段 browser_* 結果結尾連續 ≥2 次「Target page, context or browser has been closed」），BLOCK 下一個盲試 navigate 並引導重開（抓出原本要去的網址，明示「browser_close → browser_navigate {原網址}」兩步，不再只擋死）；放行 browser_close（復原重置步驟），close 成功（最近一筆不再是關閉錯誤）即自動解除。門檻 CLAUDE_BROWSER_CLOSED_THRESHOLD 可覆寫。**限制：主場 hook 對 Task 子 agent 內部 tool call 不觸發（平台行為），子 agent 的瀏覽器盲試需靠 spawn 指令或子 agent frontmatter hook 引導**
│   ├── todowrite-reminder-escalator.js ← PreToolUse：掃 transcript 數「自最後一次 TodoWrite 後」累積的 TodoWrite reminder 次數，≥10 次 BLOCK 下一個非 TodoWrite call，把軟提醒升級為硬攔截
│   ├── token-budget-circuit-breaker.js ← PreToolUse：單場 token 預算斷路器。累加本場 tool call 次數，達 WARN（預設 150）每 50 次提醒「該收斂」；達 BLOCK（預設 250）**且近窗偵測到「打轉」**（同檔改≥5次/重複同呼叫≥4次/高量低檔案多樣性）才硬擋並點名打轉的檔；量大但在動不同檔有進展則只軟提醒不誤殺（實測 451 回合的合法大任務不被擋）。斷路器語意（跳脫一次即放行，飆到下個門檻 +150 再評估）；TodoWrite 永遠放行。門檻可由 CLAUDE_TOKEN_BUDGET_WARN/BLOCK 覆寫。補 repetition-detector 局部窗之外的「整場總量 × 打轉」視角
│   ├── repetition-detector.js ← PreToolUse：多層偵測（錯誤工具、散搜、低效、重複、同檔連修、自動修復；**L2.90 寫 code 前本回合須先查證來源否則 BLOCK**、**L2.89 帶假設語句寫 code 直接 BLOCK**），支援成本追蹤、Slack通知、debug模式
│   ├── refactor-advisor.js ← PreToolUse(Edit|Write|apply_diff|create_file)：PHP 程式碼品質偵測（13項 SOLID + Clean Code 規則）；既有檔修改僅警告，**新生成檔**帶 god class / SQL混HTML / 過大檔等嚴重結構問題則 BLOCK（內容加 `// refactor-ack` 放行）
│   ├── memory-auto-recall.js ← PreToolUse：依 frontmatter triggers 比對 tool/path/keyword，命中且距上次注入 ≥ N 次 tool call 即注入 memory（解 attention 衰減）
│   ├── entry-search-memory-gate.js ← PreToolUse(matcher Grep|Glob)：開場找入口前先翻記憶硬 gate。本場 transcript tool 呼叫 ≤ EARLY_LIMIT(12) 的開場階段，若還沒 Read 過任一 project memory 檔（含 ops_index.md / mcp read_file）也沒呼叫 session_recall/search，卻用 Grep/Glob 做「找入口式」搜尋（identifier 或 code scope；中文/自然語句字串搜尋放行）→ BLOCK 並動態列出與最近 prompt 最相關的記憶檔，逼先翻記憶。讀任一 memory 檔或 recall 即永久解除本場攔截。補 memory-auto-recall「只注入提醒、沒強制力照樣被無視」的缺口（CLAUDE_ENTRY_GATE_DISABLE/EARLY_LIMIT/MIN_FILES 可覆寫）
│   ├── agent-coord-stale-contract.js ← PreToolUse(寫入類)：多 backend 並行時，動工前掃 transcript 找最近一次 agent_coord poll api-contract 的 after_id，若 D:\Project\_coordination\{project}\api-contract.json 有比那更新的訊息且 agent != self → 警告先 poll（防跨 backend 邏輯撞車）
│   ├── pre-compact.js   ← PreCompact：context 壓縮前存快照 + 踩坑偵測
│   ├── write-guard.js   ← PreToolUse(Write|Edit)：敏感檔案寫入警告 + JS/CSS 修改時提醒 bump version
│   ├── llm-judge.js     ← PostToolUse(Write|Edit)：高/中風險檔案自我審查清單 + PHP 版本感知 lint（漸進式回退：動態發現本機 PHP 容器由新到舊逐版 php -l，任一版過即放行並標明偵測到的舊版，全版皆 parse error 才 BLOCK；解 legacy 5.x 檔被 php84 誤判語法錯整批擋下）+ JS/CSS bump version 提醒
│   ├── php-containers.js ← llm-judge 共用：動態發現本機在跑的 PHP 容器（docker ps + 逐一問 PHP_VERSION，不寫死容器名 → 跨環境通用），結果快取 ~/.claude/php-containers-cache.json（TTL 30 分）；可用 MCP_PHP_LINT_CONTAINERS env 覆寫
│   ├── user-prompt-guard.js ← UserPromptSubmit：模糊指令偵測（全域強制）+ 場景缺上下文提醒（前端/後端/QC/Playwright；維運/監控情境如 Docker/Prometheus/Grafana/容器/compose 自動排除，不再把基建除錯誤判成 PHP 後端而擋寫入）
│   ├── official-docs-guard.js ← UserPromptSubmit：偵測第三方技術行為問題（瀏覽器產品名 chrome/firefox… / Web 標準 CORS/CSP/SameSite/W3C/MDN / 框架版本用法 / 規範 / 為什麼…行為），注入提醒「回答前先 WebFetch 查官方文件，禁憑訓練記憶直接答」。純瀏覽器自動化測試（截圖/導航/click 無查文件意圖）與本系統 meta 維護（hook/memory/skill）自動跳過。非阻擋，只注入提醒
│   ├── skill-router.js  ← UserPromptSubmit：Skill 關鍵字偵測，依分數自動建議相關 Skill
│   ├── verify-pass-guard.js ← Stop：回合結束掃 assistant 最後訊息，攔「N/N PASS / 全部通過」但無逐行/逐格明細證據的驗證偷懶（合計對 ≠ 明細對；不抓「全綠」等監控/CI 狀態燈用語避免誤擋診斷訊息、markdown 逐列表格視為已附明細放行；防迴圈：stop_hook_active 放行 + 同宣告 hash 集合去重；無次數上限，每個新的未附明細 PASS 宣告都擋）
│   ├── commit-nag-guard.js ← Stop：回合結束掃 assistant 最後訊息，攔「主動提 commit/push/git add 當收尾」（CLAUDE.md 明令禁止做完就提 commit；放行：使用者本回合自己提過 commit/git/推版（含 `/git_commit` slash 指令，掃最近 6 則 user 訊息窗口而非只看最後一則，避免被「選項回覆」這種末則訊息漏判）、或唯讀 git status/diff/log；防迴圈 stop_hook_active + 同訊息 hash 去重）
│   ├── task-stop-docker-warn.js ← PostToolUse(Bash run_in_background + TaskStop)：背景任務若以 `docker exec` 啟動，TaskStop 只 kill 外層 pipe、container 內 child 仍在跑（曾踩坑：以為 kill 了實際還在燒 Sheet API）。Bash 階段把 docker child 命令寫進 %TEMP% cache，TaskStop 時比對 task_id → 提醒 + 給 ps/kill 驗證指令（非阻擋，exit 0；6 小時自動清 cache）
│   └── record-lesson.cjs ← 非 hook 輔助腳本：由 /lesson skill 呼叫，append 對話品質教訓到 ~/.claude/quality-lessons.jsonl（跨專案 sink）；支援 --list / --done <ts>，給 /retro lesson 消化用
├── skills/index.js      ← MCP Prompts 路由（注意：小寫 skills，不是 Skills）
└── Skills/              ← Skill MD 檔
    ├── *_agent.md       ← MCP Prompts 內容
    └── commands/        ← 斜線指令（部署到 ~/.claude/commands/，flat）
        ├── _skill_template.md  ← 撰寫新 Skill 前必讀
        ├── php_dev/     ← PHP 開發部
        ├── migration/   ← 程式移植部
        ├── testing/     ← 測試品管部
        ├── spec/        ← 規格分析部
        ├── db_planning/ ← 資料庫規劃部
        ├── deploy/      ← 部署維運部（sftp）
        ├── docker/      ← Docker 維運部
        ├── dev_workflow/← 開發流程部
        ├── tooling/     ← 系統工具部
        ├── claude_ops/  ← Claude 維運部（Skill 管理、MCP 維護）
        ├── content/     ← 內容擷取部
        ├── life/        ← 生活自動化部（n8n, youtube）
        └── _internal/   ← 私有 Skill（.gitignore 排除，不進版控）
```

---

## 重要限制

- MCP 檔案工具 basePath = `D:\Project\` + `D:\tmp\`（路徑相對第一個目錄；`D:\tmp\` 給短期暫存用，免 grant_path_access）
- MCP Server 自身根目錄（由 `env.js` 的 `__dirname` 推導，跨機通用）預設放行：讓檔案/git 等 MCP 工具能操作 MCP_Server 自己的 repo（維護本專案時免 grant_path_access）
- Claude 記憶目錄預設放行：`~/.claude/memory/` 與 `~/.claude/projects/<slug>/memory/`（含中文記憶檔可直接走 `create_file`，免 grant_path_access）
- 存取其他路徑：先呼叫 `grant_path_access`（重啟後清空）
- DB 連線（`set_database`）只在當次對話有效，重啟後需重新設定
- 書籤操作前需先關閉 Chrome

---

## Docker 選用元件

不啟用時其他工具完全不受影響。

- **Python**：容器名 `python_runner`，`restart: unless-stopped`
  - 內建：`ffmpeg`（apt 安裝）、`faster-whisper`（pip 安裝）給 `read_video` 用
  - 若 container 被 `docker compose down` 重建會遺失，需重跑：
    `docker exec python_runner sh -c "apt-get update && apt-get install -y --no-install-recommends ffmpeg && pip install --no-cache-dir faster-whisper"`

---

## 環境變數

所有環境變數統一透過 `.env` 管理，由 `env.js` 載入後匯出給 hooks / index.js / config.js 使用。

**初次設定**：`cp .env.example .env`，再依本機環境修改。`.env` 已在 `.gitignore` 中。

### MCP Server

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `MCP_BASE_PATHS` | `D:\Project\` | 允許存取的根目錄（逗號分隔多個）；覆蓋 config.local.js |

### Hook 設定

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `CLAUDE_HOOK_DEBUG` | `0` | 啟用 hook 除錯日誌（`[hook-debug]` 標籤輸出） |
| `CLAUDE_SLACK_WEBHOOK` | _(空)_ | Slack webhook URL，用於發送阻擋告警 |
| `CLAUDE_NOTIFY_ON_BLOCK` | `1` | 僅在 block 事件時發送 Slack 通知 |
| `CLAUDE_TOKEN_FEEDBACK` | `passive` | Token 浪費回饋模式：`active`=逐次即時提醒、`passive`=定期累計摘要 |
| `CLAUDE_SUMMARY_INTERVAL` | `25` | 被動模式下每 N 次 tool call 輸出一次效率摘要 |
| `CLAUDE_TOKEN_BUDGET_WARN` | `150` | token-budget-circuit-breaker：本場 tool call 數達此值開始警告「該收斂」 |
| `CLAUDE_TOKEN_BUDGET_BLOCK` | `250` | token-budget-circuit-breaker：本場 tool call 數達此值硬擋一次要求收斂/分發（之後每 +150 再跳） |
| `CLAUDE_DUAL_STATE_PATH_REGEX` | _(空)_ | refactor-advisor #14 觸發路徑限制 regex（空＝所有 .php 都檢查） |
| `CLAUDE_DUAL_STATE_SESSION_RE` | _(預設見 hook)_ | refactor-advisor #14 偵測 session 分支的 regex |
| `MCP_PHP_LINT_CONTAINERS` | _(空＝動態發現)_ | llm-judge PHP lint 容器組覆寫（逗號分隔，由新到舊）。預設空值時走動態發現（docker ps + 問 PHP_VERSION）；僅特殊環境（容器名特殊、不想被探測）需手動指定 |

### Git Bash PATH 補充

Claude Code 在 Windows 上透過 Git Bash 執行指令，部分工具不在預設 PATH 中（已寫入 `~/.bashrc`）：

| 工具 | 路徑 | 用途 |
|------|------|------|
| `gh` | `/c/Program Files/GitHub CLI` | GitHub CLI（PR、Issue、API 操作） |

如遇 `command not found`，先檢查 `~/.bashrc` 是否有對應的 `export PATH` 設定。

**Hook 偵測規則**：repetition-detector 27 層偵測（L4 uncommitted_accumulation 未 commit 提醒已依使用者要求停用；含 L2.4e Grep 找 class 引用建議 find_usages/find_dead_symbols、L2.4f Grep 找 JS 符號（function/class/obj.method）建議 js_symbol_lookup/js_find_usages、L2.90 寫 code 前須先查證、L2.89 假設語句寫入硬擋）+ refactor-advisor 14 項 PHP 品質檢查（新生成檔嚴重結構問題會 BLOCK）+ 獨立 `agent-coord-stale-contract`、`token-budget-circuit-breaker`（單場 tool call 150 警告 / 250 硬擋）、`entry-search-memory-gate`（matcher Grep|Glob：開場找入口前未翻 project memory 就 Grep/Glob 散搜 → 硬擋並列出相關記憶檔）。**完整對照表（每條 ID／觸發條件／行為／放行條件）見 [docs/HOOKS.md](docs/HOOKS.md)**；被 hook 擋到時去那查對應規則。

---

## 兩套 Skills 系統

**系統 A：MCP Prompts**（較少用）

- 存放：`Skills/*_agent.md`，需在 `skills/index.js` 登記後重啟

**系統 B：斜線指令**（主要）

- 存放：`Skills/commands/{dept_folder}/*.md`（必須放在對應部門子資料夾，不可放根目錄）
- 部署：呼叫 `save_claude_skill` 工具（自動儲存＋部署）或執行 `deploy-commands.bat`
- 觸發：在 Claude Code 輸入 `/skill-name`
- **上限：公開 Skill 總數不超過 60 個**，超過前先用 `/skill_audit` 審查並合併相似技能

**Skills 清單**：見 `dashboard/index.html` 或對話開始時的 system-reminder。

---

## 新增 Skill 流程

1. 先讀 `Skills/commands/_skill_template.md`（格式規範）
2. 將 MD 檔寫入對應子資料夾（如 `Skills/commands/deploy/sftp_deploy.md`）
3. 部署到 `~/.claude/commands/`（flat，不含子資料夾路徑）：
   - 單檔：`cp Skills/commands/subfolder/skill.md ~/.claude/commands/skill.md`
   - 全部：重跑 `deploy-commands.bat`（自動發現所有公開 Skill）
   - 使用 `save_claude_skill` 工具時**步驟 3 自動完成**，但步驟 4 仍需手動執行
4. 更新 `dashboard/index.html`（**必做**，不可遺漏）：
   - 在對應部門加入 tag、更新 `dept-count`
   - 更新 section-total 數字與頂部總能力數
   - 在 JS `SKILLS` 物件中新增 click-to-detail 資料
   - **`_internal` Skill 不寫入 dashboard.html**（不加 tag、不計入數字）
5. 重啟 Claude Code

**完成後自我核對（每次新增/修改 Skill 後必做）：**

```text
☐ ~/.claude/commands/skill.md 存在？
☐ dashboard.html tag 已新增？
☐ dept-count 數字已更新？
☐ section-total（skills 數）已更新？
☐ JS SKILLS 物件已新增條目？
☐ Skills/SKILL_INDEX.md 已同步更新？
```

私有 Skill：統一放在 `Skills/commands/_internal/` 資料夾（檔名仍保留 `_internal` 後綴，.gitignore 排除整個資料夾），部署用 `deploy-commands-internal.bat`，**不列入 dashboard.html**

伴隨參考檔：檔名加 `_steps`（如 `playwright_ui_test_steps.md`），由主 Skill 引用，**不獨立部署**

YAML Frontmatter（選用）：在 Skill MD 頂部加入 `name` + `description`，可讓 Claude 在對話中主動建議該 Skill；不需主動建議時可省略。格式見 `_skill_template.md`。

**Frontmatter 使用規範（依部門）**：

| 部門 | Frontmatter | 原因 |
| --- | --- | --- |
| `life/`（生活自動化） | ❌ 不加 | 情境特定，由使用者手動下指令 |
| 其餘部門 | 視需求選用 | 若希望 Claude 主動建議則加 |

---

## 修改 Hook 後必做（零例外）

Hook 實際執行的是 `~/.claude/hooks/` 下的副本，**不是** repo 的 `hooks/`。只改 repo 不同步＝改了等於沒改（hook 不生效）。

```text
☐ 改的是 repo `hooks/*.js`（source of truth）
☐ node --check hooks/xxx.js 語法過
☐ 行為驗證：餵 stdin JSON 給 hook 實跑一次，確認該擋的擋、該放的放（不靠口頭宣告）
☐ 同步到 live：cp hooks/xxx.js ~/.claude/hooks/xxx.js（hook 每次 spawn 新 process 讀檔，同步後即生效，免重啟）
☐ 規則有增減 → 同步更新 docs/HOOKS.md 與本檔的 hook 描述／層數
```

> 區別：tool 模組（`tools/**`）改動要**重啟 MCP Server** 才生效，不是 hook 同步那套。

---

## 新增 MCP 工具模組

1. 將新工具 `my_module.js`（匯出 `definitions` + `handle(name, args)`）放入合適的分類資料夾：
   - `file_io/` — 檔案讀寫、文件轉換
   - `data/` — 資料庫、索引、RAG
   - `deploy/` — 遠端部署、版控、DB migration
   - `browser/` — 瀏覽器自動化、網頁檢查
   - `system/` — 系統工具、多 Agent 協調、程式碼分析
   - `utils/` — 通用比對工具
   - 若新工具需共用函式，提取至 `tools/_shared/`
2. **在 `index.js` 的 `TOOL_MODULE_FILES` 白名單加入路徑**（按字母排序）——白名單載入而非 glob，冷啟動較快且載入失敗時錯誤訊息明確
3. 同步更新三份文件（**必做**，不可遺漏）：
   - **CLAUDE.md** — `tools/{category}/` 目錄結構中加入新工具
   - **README.md** — 工具總覽區段（數量、表格列、如有新區段則新增）
   - **dashboard.html** — MCP Tools 區段的 tag + `dept-count` + `section-total` + 頂部總數 + JS `SKILLS` 物件內各 Skill 的 `tools` 陣列
4. **回頭看哪些 Skill 該引用此工具並更新（雙向同步，零例外）**：工具做好沒用進 Skill＝Claude 不會在該情境用它，等於白做。
   - **新增工具** → 想「哪些既有 Skill 的情境該用它？」逐一在那些 Skill 的『可用工具』或對應步驟補上引用（情境一句話 + 工具名）。例：新增 `find_dead_symbols` → 補進 refactor/清理/`skill_audit` 類；新增前端 AST（`js_symbol_*`/`css_*`）→ 補進前端 bug/QC 類，取代「叫人 `browser_evaluate`/散搜」。
   - **改名/淘汰工具** → 反向 Grep 所有 Skill MD 找舊工具名，一併改名或移除，避免 Skill 指到死工具。
   - 找落點：`grep -rl "舊/相關工具名" Skills/commands/` 或語意判斷該情境的 Skill。
5. 重啟 MCP Server

**完成後自我核對（每次新增/修改 MCP 工具後必做）：**

```text
☐ tools/{category}/my_module.js 建立並匯出 definitions + handle？
☐ index.js TOOL_MODULE_FILES 白名單已加入路徑？
☐ CLAUDE.md tools/ 目錄結構（對應分類下）已更新？
☐ README.md 工具表格/數量已更新？
☐ dashboard.html tag 已新增？
☐ dashboard.html dept-count 已更新？
☐ dashboard.html section-total 與頂部總數已更新？
☐ dashboard.html JS SKILLS 物件的 tools 陣列已更新？
☐ 已掃過相關 Skill：新工具補上引用 / 淘汰工具從 Skill 移除？（雙向同步）
☐ MCP Server 已重啟？
```

---

## 注意事項

- **禁止在 Bash 直接呼叫 `python`、`python3`、`pip`**：Windows 上這些命令會觸發 Microsoft Store stub，不會執行 Python。所有 Python 執行一律透過 MCP 工具 `run_python_script`（走 Docker 容器 `python_runner`）。安裝套件用 `docker exec python_runner pip install 套件名`。
- `skills/index.js`（小寫）= MCP Prompts 路由；`Skills/`（大寫）= MD 檔目錄，兩者不同
- **所有 Skill MD 必須放在對應部門子資料夾**（`_skill_template.md` 例外）；部署到 `~/.claude/commands/` 才是 flat 結構
- 新增 Skill 後更新 `dashboard/index.html`（含 JS SKILLS 物件）；**不需修改此 CLAUDE.md**（目錄結構變動除外）
- Playwright MCP：`npm install -g @playwright/mcp@latest`
- **多 Playwright 實例備案（雙 Agent 同時操作瀏覽器）**：在 `.mcp.json` 登記第二個 Playwright MCP，指定不同 `--port`（預設 3000，第二實例用 3001），兩個 session 互不干擾。目前環境僅單實例；如需雙 Agent 並行操作瀏覽器，工程師手動增設後重啟 Claude Code。

  ```json
  {
    "mcpServers": {
      "playwright":  { "command": "npx", "args": ["@playwright/mcp@latest", "--port", "3000"] },
      "playwright2": { "command": "npx", "args": ["@playwright/mcp@latest", "--port", "3001"] }
    }
  }
  ```
- 大型 PHP 專案建議先執行 `/update_codemaps {ProjectFolder}` 產生 `codemap.md`，再開始開發對話，可大幅降低首輪 token 消耗
- **禁止在公開 Skill MD 檔（`Skills/commands/*.md`，排除 `_internal/`）中寫入客戶實際網址、域名、專案名稱、資料表名稱、模組名稱**，範例一律使用 `{ProjectFolder}`、`{TableName}`、`module_a`、`example.com`、`localhost` 等通用佔位符。`reports/` 目錄與 `Skills/commands/_internal/` 下的檔案不受此限。
