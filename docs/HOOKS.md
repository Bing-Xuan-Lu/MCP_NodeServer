# Hook 偵測規則完整對照表

> 這份是從 `CLAUDE.md` 抽出的詳細 hook 規則參考（避免大表每次都被夾帶進 context）。被 hook 擋到時，來這裡查對應 ID、行為與放行條件。CLAUDE.md 只留摘要與指標。

**Hook 偵測規則**（repetition-detector 26 層 + refactor-advisor 14 項；另有獨立 `agent-coord-stale-contract`、`token-budget-circuit-breaker`（單場 tool call 達 150 警告 / 250 硬擋）兩個 PreToolUse hook）：

| 層級 | ID | 觸發條件 | 行為 |
| --- | --- | --- | --- |
| L1.5b | prompt_guard_mcp_write | `apply_diff` / `apply_diff_batch` / `create_file` / `create_file_batch` / `multi_file_inject` 在 `promptGuardActive=true` 時同樣 BLOCK，避免繞過內建 write-guard（同 2 分鐘 TTL 自動失效） | ❌ |
| L1.55 | snapshot_wrong_path | Write/create_file/apply_diff 寫 `.yml`/`.yaml` 含 `[ref=eNNN]`（Playwright a11y tree）且不在 `.playwright-mcp/` / `screenshot*/` / `tmp/` / `_tmp_*/` 子目錄 | ❌ |
| L1 | bash_wrong_tool | 用 Bash / PowerShell 做有專用工具的事（docker mysql、cat/grep/find 等）；PHP-targeted 繞道路徑（`grep .php` / `rg --type php` / `node -e fs.read .php` / `awk\|sed .php` / `Select-String .php`）強制 BLOCK | ⚠️ 警告（PHP/destructive block） |
| L1.6 | mcp_fallback_counter | 同 session `# mcp-fallback:` 註解使用次數：第 1 次靜默 / 第 2 次警告 / 第 3 次 BLOCK，要求向使用者報告 tool gap | ⚠️→❌ |
| L1.7 | ssh_exec_docker_exec | ssh_exec 命令含 `docker exec ... mysql/php/python` → ⚠️ 警告（不擋）。原因：ssh_exec 本質連遠端，本機 MCP（`set_database` docker_exec / `run_php_script` container）搆不到遠端容器，硬擋會跟 remote_db_exec 遠端跑 SQL 工作流衝突。提醒「容器在本機才改用 MCP」；mysql 的 `-e "SHOW/.../ALTER/DROP"` DDL 與尾端 `# mcp-fallback:` 仍放行（不出警告）。（2026-06-02 由 BLOCK 降級） | ⚠️ |
| L2 | bash_pattern_repeat | Bash 模式重複 2+ 次 | ⚠️ 警告 |
| L2.4 | grep_php_symbol | Grep 搜 PHP class/method；明確 PHP scope (`*.php` glob / type=php / 路徑為 .php 檔) 第 1 次 BLOCK；鬆散 PHP context (路徑含 admin/model/controller 等) 需 pattern 含 PHP 結構符號 (`::` / `->` / `function` / `class` / `extends`) 才 BLOCK，避免誤殺純 JS 變數 | ❌ 建議 AST 工具 |
| L2.4b | grep_read_same_php_file | 同一 PHP 檔 Grep+Read 拼湊 ≥ 3 次（最近 8 步） | ⚠️ 強制改用 class_method_lookup |
| L2.4c | grep_php_structural_block | Grep PHP 結構語法（function xxx / ->method( / ::method( / class xxx / extends 等）+ PHP context | ❌ 第 1 次就 BLOCK |
| L2.4d | php_text_search_no_scope | `php_text_search` 無 `scope` 且未 `force_full_scan: true`：首次由工具內 `FULL_SCAN_THRESHOLD=1500` 擋下、第 2 次本 hook BLOCK，避免重複全專案散搜燒 token | ❌ 第 2 次 BLOCK |
| L2.4e | grep_find_class_refs | Grep（PHP context）找 class 引用：pattern 形如 `new X` / `X::` / `extends X` / `implements X` → 建議改 `find_usages`（精確列引用）/ `find_dead_symbols`（整包零引用死碼掃描），免被字串常數/檔尾 demo 行誤導 | ⚠️ 建議 AST 工具 |
| L2.5 | grep_scatter_search | Grep 散搜 3+ 不同路徑 | 🧠 強制注入記憶 |
| L2.6 | grep_read_alternation | Grep↔Read 交替 3+ 次 | ⚠️ 提醒改用高效工具 |
| L2.7 | edit_batch_replace | Edit 跨檔相同替換 3+ 次 | ⚠️ 警告（5+ 次 block） |
| L2.75 | status_value_audit | Edit/Write/apply_diff/create_file 內容含 `'status' => 'UPPERCASE'` PHP 陣列 syntax 或 SQL `INSERT/UPDATE` 含 status 欄位 → 提示先 Glob `**/list.php` + Grep `status\s*=` 列既有 tab filter 完整值表，避免新狀態值撞既有 filter | ⚠️ 警告（不擋） |
| L2.76 | status_value_thrashing | 同檔同 status/payment_chk 值連續 Edit/apply_diff ≥3 次 → BLOCK。反覆改同一狀態值代表「方向錯」（漏 audit / 撞 filter / 邊改邊試），強制停下做全 audit 後再選方案 | ❌ 第 3 次 BLOCK |
| L2.8 | same_file_edit | 同一檔案連續修改：apply_diff 5 警告 / 10 強警告；Edit 單區塊 5/10、多區塊 8/18（純警告，不阻擋） | ⚠️ 提示 apply_diff_batch 或 Edit replace_all |
| L2.82 | sftp_local_test_gate | sftp_upload PHP/CSS/JS 前 30 分鐘內無 localhost / 區網訪問記錄（自動排除 include/class/config/migrations/vendor） | ⚠️ 警示（不阻擋，提醒先 local 測過） |
| L2.83 | ui_verify_mismatch | 最近改過前端互動檔案 (.vue/.js/.php 含 v-* 或 @click 等；.php 先比 diff，fallback 掃整檔 ≤512KB) + 用 run_php_code 跑驗證類程式（echo/var_dump/驗證/build） | ⚠️ 警示（提醒改用 browser_interact 端到端，run_php_code 無法驗 Vue reactivity / DOM / 點擊） |
| L2.84 | ui_click_no_progress | 同 selector 連續 click ≥3 次（最近 8 步內）且未跑過 send_http_request / fetch raw body | ⚠️ 警示（callback 可能根本沒執行，要求先打 endpoint 看 raw 200 body 排除後端 fatal） |
| L2.9 | php_db_cursor_trap | PHP 寫入時 `while ($x = $db->getNext())` 外層對同一 `$db` 做 execute/execNext | ❌ block（外層 cursor 被覆蓋） |
| L2.10 | css_inspect_gate | (a) `.css` 寫入第 **1** 個 `!important` 但 session 未跑過 inspect 工具 → BLOCK；(b) 使用者回報「排版/跑版/樣式問題」設 `cssInspectRequired` flag，未 inspect 前任何 `.css` 寫入 BLOCK；(c) 已 inspect 但累計 ≥10 個 `!important` → 警告改隔離命名空間 | ❌ 強制先 css_computed_winner / css_specificity_check / css_inspect |
| L2.10b | css_legacy_skill_gate | 寫入頁面層 CSS（路徑含 `/v3/` `/page/` `/page/vN/` 等）時印 3 項建議檢查（specificity / @media 全斷點 / 排版預期），純色/字體/動畫/間距微調可忽略；不阻擋寫入 | ⚠️ 警告（不擋） |
| L2.10c | layout_suspect_js_edit | 使用者剛回報「popup / 跑版 / 錯位 / 樣式」相關問題（user-prompt-guard 啟動 `cssInspectRequired`），但 Claude 下一個 Edit/Write 動的是 `.js`/`.vue`/`.ts` 而非 `.css` → 提醒「確定不是 CSS 問題嗎？」並建議先跑 `css_computed_winner` / `css_specificity_check`。已 inspect 過或 lastPrompt 明確說「就是 JS 問題」即放行 | ⚠️ 警告（不擋） |
| L2.11 | playwright_media_leak | `browser_run_code`/`browser_evaluate`/`run_python_script`/`run_php_*` 的 code 含 `page.pdf()`，但 emulateMedia 狀態是 `screen`（① 同段 code 先設 screen 未 reset 就 pdf；② 跨呼叫：先前某次 browser code 設了 `emulateMedia({media:'screen'})` 從未 reset 回 print，本次又 pdf）→ 警告「screen 殘留會讓 PDF 用螢幕樣式渲染、版面臨界值全是假數據，產 PDF 前先 `emulateMedia({media:'print'})`」。reset/print 視為安全；cross-call 僅 MCP 同一 browser page 適用（python 每次新 process 不殘留） | ⚠️ 警告（不擋） |
| L2.85 | exact_same_call | 完全相同 args 重複呼叫：預設 5 次 BLOCK；`browser_wait_for` / `browser_navigate` 放寬到 9；`run_php_script` 跑 `_harness/*.php` 或檔名含 `diff`/`verify`/`audit` 放寬到 12（迭代驗證 case 用） | ❌ 完全相同呼叫達門檻 |
| L2.86 | verification_cheat_detect | 共通「驗證捷徑」偵測：6 大類偷工 pattern（① Mock/Stub `window.confirm/open/fetch/print/alert/location` + localStorage auth bypass；② browser_evaluate 直呼業務動詞函式沒走 click；③ 空 catch / Python `except: pass` / Shell `\|\| true` / 驗證命令 `2>/dev/null` / PHP `@` 抑制；④ 硬編碼 PASS/OK 無斷言、mock 函式只 `return true`；⑤ DML 無 SELECT 驗證但宣告成功；⑥ `git --no-verify`/`--no-gpg-sign`、`mcp-fallback:` 註解）。可在 code 寫 `// unit test` 或 `// 不驗 UX/E2E` 明確標註豁免。單次 ⚠️ 警告，同 session 累計 ≥3 次 ❌ BLOCK 要求向使用者報告捷徑內容 | ⚠️→❌ |
| L2.87 | git_first_for_dependencies | 使用者問「誰用 / 誰依賴 / 哪裡會掛到 X / 砍/刪除 X 要改哪些」類找當前依賴問題，Claude 卻用 `git log` / `git blame` / `git show` / `git grep` 翻歷史。原因：依賴是當前 code 狀態問題，不是歷史問題。建議改用 `find_usages` / `find_dependencies` / `Grep`（純文字 SQL 表名/字串） | ⚠️ 警告（同 user-turn 一次） |
| L2.88 | ambiguous_ui_complaint | 使用者貼模糊 UI 抱怨（「跑版/壞了/不對/有問題/怪/錯了」）+ 圖片附件 + 訊息未指明具體層級線索，Claude 卻直接用動手工具（Playwright/Grep/Edit/SQL 等）。原因：截圖只證明「現象出現」，不證明使用者在意的 4 個層級（layout/trigger/data/interaction）。建議：先反問 1 句確認層級，可呼叫 `/bug_trace` 步驟 0 自動分層 | ⚠️ 警告（同 user-turn 一次） |
| L2.88b | causal_bug_layer_gate | 因果型 bug 抱怨（「為什麼…還是/沒/又」「明明…怎麼被」「後台設定…還能報價」）後，Claude 尚未做任何根因調查就要用「寫入類」工具（Edit/Write/apply_diff/create_file/multi_file_inject）改 code → BLOCK，要求先分層（layout/trigger/data/backend）+ 查資料來源。放行條件：① 寫入目標**全部是 memory 目錄或文件檔（.md/.txt）**→ 直接放行（寫筆記/記憶不可能治標蓋現象）；② 自抱怨後做過調查工具（find_usages/execute_sql/class_method_lookup/trace_logic/css_inspect/send_http_request/js_symbol_lookup/js_symbol_index/css_class_lookup/css_find_usages 等）或 AskUserQuestion；③ 已擋過一次。原因：因果 bug 直接治標（改 CSS/前端）是「修了又犯」主因，把 bug_trace 步驟 0 升級為硬擋 | ❌ 第 1 次 BLOCK（只擋寫入，不擋調查） |
| L2.89 | assumption_in_write | Write/Edit/apply_diff/create_file 前，AI input 含假設語句（「我假設」「應該是」「猜測」「probably」等）。原因：不確定時應先問或查證，不可假設後直接寫。放行：目標為 memory/文件、或含「已確認/已驗證/confirmed/verified」標記 | ❌ BLOCK |
| L2.90 | write_needs_investigation | 寫 code 檔（.php/.js/.css/.py/.sql/.vue/.html 等）前，自使用者上一則訊息後完全沒做過任何查證/調查動作（讀檔 / Grep / 查 DB / 查符號·依賴 / trace Sheet·Excel / 打 API 等）。原因：憑記憶冷寫＝用猜的，是 bug 清不完的根源。放行：做過任一查證、目標為文件/設定/memory、或內容註明「source-verified」 | ❌ BLOCK |
| L3 | same_category_repeat | 同類操作 3+ 次 | ⚠️ 警告（10+ 次 block） |
| L3b | consecutive_batch_eligible | batch-eligible 工具（execute_sql / send_http_request / sftp_upload / run_php_script / Read images-PDF-Word-pptx 等）**連續** ≥4 次（不分子類別）→ 主動建議改用對應 batch 版。同 session 同工具僅在第 4 次提一次去重 | 📦 提示 batch（不擋） |
| L2.84b | consecutive_same_url_navigate | `browser_navigate` 連續導航**同一 URL** 第 3 次提示（早於 L2.85 exact_same_call 的 9 次門檻）。常見因：page 沒清 stale state、selector 不存在、callback 沒跑 | ⚠️ 警告（不擋） |
| L4 | uncommitted_accumulation | 修改 15+ 檔案未 commit | ℹ️ 提醒（大 commit 流程） |
| L5 | token_waste_detection | 8 種低效模式（重複讀檔、無過濾 Grep、頻繁截圖等） | 💰 active=逐次提醒 / passive=每 N 次摘要 |
| L6 | auto_fix_suggestion | sed/awk 可自動化操作 | ✨ 生成修復建議 |
| L7 | workload_reminder | 30+ tool calls + 4+ 工具種類 + 20%+ 修改比例 | 📋 提醒分發任務（僅一次） |

**Refactor Advisor**（refactor-advisor.js，觸發：Edit/Write/apply_diff/create_file 操作 PHP 檔案時）。既有檔修改僅輸出警告（不擋）；**新生成檔**（create_file/Write 且檔案原本不存在）若帶 🔴 嚴重結構問題（god class / SQL混HTML / 函式過多 / 檔過大）則 **BLOCK**，內容加 `// refactor-ack` 可放行：

| # | 偵測項 | 嚴重度 | 說明 |
| --- | --- | --- | --- |
| 1 | file_too_large | 🔴/🟡 | 檔案 >400/800 行 |
| 2 | srp_violation | 🔴 | 單檔函式 >15 個 |
| 3 | long_function | 🟡 | 單一函式 >80 行 |
| 4 | god_class | 🔴 | 單一 class >20 方法 |
| 5 | deep_nesting | 🟡 | 巢狀 >5 層 |
| 6 | mixed_concerns | 🔴 | SQL + HTML 同檔 |
| 7 | duplicate_code | 🟡 | 連續 5 行重複 3+ 次 |
| 8 | inline_sql | 🟡 | SQL 無 class/function 封裝 |
| 9 | hardcoded_repeat | 🟡 | 單行硬編碼重複 5+ 次 |
| 10 | inline_css | 🟡 | `<style>` >30 行或 inline style >10 個 |
| 11 | short_var_names | 🟡 | 單字母變數（排除 $i/$j/$k） |
| 12 | too_many_params | 🟡 | 函式參數 >4 個 |
| 13 | magic_numbers | 🟡 | 魔術數字重複 3+ 次 |
| 14 | dual_state_session_branch | 🟡 | method 含 `if(isset($_SESSION...))` + `else` 雙分支 SQL，提醒同步維護登入/未登入兩路徑（觸發路徑與 session regex 可由 `CLAUDE_DUAL_STATE_PATH_REGEX` 與 `CLAUDE_DUAL_STATE_SESSION_RE` 覆寫） |
