# /harness_audit — 審計 Claude Code 工具設置並產生評分報告

你是 Claude Code 工具設置審計員，從 8 個維度評估目前專案的 AI 輔助開發能力成熟度，並提出優先改進建議。

---

## 使用者輸入

$ARGUMENTS

可選（空格分隔，複數可同時指定）：

- `hooks` — 只審計 Hook 設定
- `skills` — 只審計 Skill
- `mcp` — 只審計 MCP 工具模組（含 JS 程式碼品質）
- `memory` — 只審計 Memory 系統
- `arch` — 程式碼架構掃描
- `conflict` — Hook × Skill × Tool 衝突矩陣
- 無引數 → 全部執行

---

## 可用工具

- **Skill 清單**：`list_claude_skills`
- **檔案讀取**：`read_file`, `read_files_batch`
- **Git 歷史**：`git_log`, `git_status`
- **Bash**：動態掃描、node 執行、wc、grep

---

## 步驟 0：健康度前置檢查（Hard Check）

先於一切評分執行，發現問題直接在報告頂部標紅。

### A. Hook 檔案完整性

```text
讀取 ~/.claude/settings.json → 提取所有 hooks[*].hooks[*].command 中的 .js 路徑
→ 對每個 .js 用 Bash ls 驗証是否存在
→ ❌ 缺失 → 報告頂部顯示 ⚠️ BROKEN HOOK，並從「品質閘道」與「工具健康度」兩個維度扣分

```text

### B. MCP 工具模組動態清單

```bash
node --input-type=module <<'EOF'
import { glob } from 'glob';
const files = await glob('tools/**/*.js', { ignore: ['tools/_shared/**'] });
let tools = [];
for (const f of files) {
  try {
    const m = await import('./' + f);
    if (m.definitions) tools.push(...m.definitions.map(d => ({ name: d.name, file: f })));
  } catch(e) { tools.push({ name: '❌ IMPORT_ERROR', file: f, err: e.message }); }
}
console.log(JSON.stringify(tools));
EOF

```text

→ 解析 JSON 輸出：

- 統計總工具數、各分類工具數（file_io / data / deploy / browser / system / utils）
- `IMPORT_ERROR` 條目 → 報告頂部顯示 ⚠️ MODULE_LOAD_ERROR（模組無法載入）

### C. Skills 部署同步狀態

```bash
ls Skills/commands/**/*.md | grep -v "_internal/" | grep -v "_steps" | grep -v "_skill_template" | grep -v "/_" | wc -l   # 來源數
ls ~/.claude/commands/*.md | wc -l   # 已部署數

```text

→ 差異 > 3 → 提示可能有未部署的 Skill

---

## 步驟 1：收集審計資料

並行掃描以下來源：

### Hooks 設定

```text
讀取 ~/.claude/settings.json
→ 找出 hooks 設定（PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, PreCompact）
→ 記錄每個 hook 事件、matcher pattern、對應 .js 檔

```text

### Skills 清單

```bash
ls ~/.claude/commands/*.md

```text

→ 計算公開 Skill 數量，抽樣 3-5 個讀取標題行評估品質

### MCP Server

```text
讀取 .mcp.json → 找出已設定的 MCP server 清單

```text

### Memory 系統

```text
讀取 ~/.claude/projects/{project}/memory/MEMORY.md
→ 評估記憶筆記數量與覆蓋範圍

```text

### CLAUDE.md

```text
讀取當前專案的 CLAUDE.md → 評估指引完整度

```text

---

## 步驟 1b：MCP 工具模組深度掃描（`mcp` scope）

### B1. 模組行數統計

```bash
wc -l tools/**/*.js tools/*.js | sort -rn | head -20

```text

→ 單一模組 > 1000 行 → 標記 🟡 過大，建議拆分

### B2. JS 常見問題掃描

對每個 `tools/` 下的 `.js` 檔（排除 `_shared/`）執行以下檢查：

#### B2-1 未捕捉的 import 錯誤（步驟 0B 已執行，此處補充細節）

- 動態 import 有無 `.catch` 或 try/catch 包裹

#### B2-2 重複邏輯（DRY 違反）

```bash
grep -rn "function matchTier\|function resolveSecurePath\|function validateRequired" tools/ hooks/ --include="*.js"

```text

→ 同名工具函式出現在多個非 `_shared/` 檔案 → 標記 🟡 建議搬入 `_shared/utils.js`

#### B2-3 硬編碼路徑

```bash
grep -rn "D:\\Project\|D:/Project\|C:\\Users\|localhost:[0-9]" tools/ --include="*.js" | grep -v "_shared"

```text

→ 發現 → 標記 🔴 硬編碼路徑，應改用 `config.js` 或環境變數

#### B2-4 未處理的 Promise

```bash
grep -rn "\.then(" tools/ --include="*.js" | grep -v "\.catch\|_shared"

```text

→ `.then()` 後無 `.catch()` → 標記 🟡 潛在 unhandled rejection

#### B2-5 handle() 缺乏預設錯誤回傳

```bash
grep -n "export.*handle\|async function handle" tools/**/*.js

```text

→ 抽查 3 個 handle 函式：是否有 catch 並回傳 `{ isError: true, content: [...] }` 格式

#### B2-6 definitions 與 handle() 工具名稱不對稱

```text
從步驟 0B 的動態清單 + Grep handle() 的 switch/case 或 if/else 名稱
→ definitions 中有但 handle 沒 case → 🔴 DEAD_TOOL（呼叫必回 unknown tool）
→ handle 有 case 但 definitions 沒有 → 🟡 PHANTOM_HANDLER（永遠不會被呼叫）

```text

#### B2-7 參數 schema 品質

```bash
# 找出 required 欄位為空陣列、或 properties 為空的 definition
node --input-type=module <<'EOF'
import { glob } from 'glob';
const files = await glob('tools/**/*.js', { ignore: ['tools/_shared/**'] });
for (const f of files) {
  try {
    const m = await import('./' + f);
    if (!m.definitions) continue;
    for (const d of m.definitions) {
      const p = d.inputSchema?.properties || {};
      const r = d.inputSchema?.required || [];
      if (Object.keys(p).length === 0) console.log(`NO_PROPS: ${f} → ${d.name}`);
      if (!d.description || d.description.length < 10) console.log(`POOR_DESC: ${f} → ${d.name}`);
    }
  } catch(e) {}
}
EOF

```text

### B3. Hook JS 掃描

對每個 `hooks/*.js` 執行：

#### B3-1 重複定義的 matchTier

```bash
grep -l "function matchTier" hooks/*.js

```text

→ 出現在 2+ 個 hook → 🟡 建議提取成共用模組

#### B3-2 Hook 執行時間風險

```bash
grep -n "await\|sleep\|setTimeout\|setInterval" hooks/*.js | grep -v "//\|^\s*\*"

```text

→ Hook 內有長時間 await（非立即 return）→ 🟡 可能造成 Claude 回應延遲

#### B3-3 Hook 無 process.exit() 回傳

```bash
grep -n "process.exit\|process.stdout.write" hooks/*.js | wc -l

```text

→ 每個 hook 都應有 `process.stdout.write(JSON.stringify({...}))` + `process.exit(0|1|2)`

---

## 步驟 1c：衝突矩陣分析（`conflict` scope）

### C1. Hook × Tool 攔截矩陣

從 `~/.claude/settings.json` 讀取 hook matcher，建立攔截表：

```text
PreToolUse hooks（按執行順序）：
  repetition-detector  matcher: .*           → 攔截所有工具
  write-guard          matcher: Write|Edit   → 攔截寫入工具
  user-prompt-guard    matcher: .*           → 攔截所有工具
  skill-router         matcher: .*           → 攔截所有工具
  refactor-advisor     matcher: Write|Edit|apply_diff|apply_diff_batch

PostToolUse hooks：
  llm-judge            matcher: Write|Edit

```text

輸出矩陣（節選常用工具）：

```text
工具名稱              | rep-det | write-gd | prompt-gd | skill-rt | refactor | llm-judge
──────────────────────|---------|----------|-----------|----------|----------|──────────
Edit                  |   ✓     |    ✓     |    ✓      |    ✓     |    ✓     |    ✓
Write                 |   ✓     |    ✓     |    ✓      |    ✓     |    ✓     |    ✓
Bash                  |   ✓     |          |    ✓      |    ✓     |          |
Grep                  |   ✓     |          |    ✓      |    ✓     |          |
apply_diff            |   ✓     |          |    ✓      |    ✓     |    ✓     |
apply_diff_batch      |   ✓     |          |    ✓      |    ✓     |    ✓     |
run_php_code          |   ✓     |          |    ✓      |    ✓     |          |
execute_sql           |   ✓     |          |    ✓      |    ✓     |          |
browser_interact      |   ✓     |          |    ✓      |    ✓     |          |
css_inspect           |   ✓     |          |    ✓      |    ✓     |          |

```text

→ 標記「高攔截工具」（被 4+ hook 攔截），提示測試時需模擬所有 hook 組合

### C2. Hook 內部衝突偵測

```text
檢查各 hook 的 block 條件是否存在互相矛盾的情況：
- L2.10 css_inspect_gate：CSS 寫入前必須 inspect → 但若 skill-router 建議某 Skill，
  該 Skill 有無先調用 css_inspect / css_computed_winner 步驟？
- repetition-detector L2.4c：Grep PHP 結構語法第 1 次就 BLOCK
  → 哪些 Skill 的說明中有建議用 Grep 搜尋 PHP？（違反 hook 規則）

```text

執行：

```bash
# 找出 Skill 中用 Grep 搜 PHP 的說明（違反 L2.4c 規則）
grep -rl "grep.*\.php\|Grep.*php\|grep.*class\|grep.*function" Skills/commands/ --include="*.md" | grep -v "_internal/"

```text

→ 發現違反 → 輸出 ⚠️ SKILL_HOOK_CONFLICT：`{skill_name}` 建議的操作會被 `{hook_name}` 的 `{rule_id}` 攔截

### C3. Skill 使用的工具 × Hook Block 清單

```bash
# 統計 Skills 中引用的 MCP 工具名稱
grep -rh "execute_sql\|run_php\|browser_interact\|css_inspect\|send_http\|sftp_\|git_\|class_method\|symbol_index\|find_usages\|php_text_search\|apply_diff\|multi_file_inject" Skills/commands/ --include="*.md" | grep -oE "[a-z_]{3,}[a-z_]" | sort | uniq -c | sort -rn | head -20

```text

→ 對比各工具是否有 hook 的特殊限制（如 `css_inspect_gate` 針對 CSS 寫入）

---

## 步驟 1d：程式碼架構掃描（`arch` scope）

### A. 循環依賴偵測

```bash
# ESM import 圖（tools/ 內部）
grep -rn "^import.*from" tools/ --include="*.js" | grep -v "_shared" | sed "s|.*from '||;s|'.*||"

```text
→ 建立依賴圖，找出 A → B → ... → A 的循環

### B. 高耦合模組（Fan-Out > 8 或 Fan-In > 10）

```bash
# Fan-In（被其他模組 import 的次數）
grep -rn "^import" tools/ hooks/ --include="*.js" | grep -oE "tools/[a-z_/]+\.js" | sort | uniq -c | sort -rn | head -10

```text

### C. 上帝物件偵測

```bash
wc -l tools/**/*.js | sort -rn | head -10  # 超過 1000 行警示
grep -c "^export async function\|^  async " tools/**/*.js 2>/dev/null | sort -t: -k2 -rn | head -10

```text

---

## 步驟 2：依 8 維度評分（各 0-10 分）

| 維度 | 說明 | 評分依據 |
|------|------|---------|
| **1. 工具覆蓋** | MCP 工具是否涵蓋主要工作流程 | 工具數量、功能多樣性、模組無 IMPORT_ERROR |
| **2. Context 效率** | CLAUDE.md 與 Codemaps 是否精簡有效 | 文件品質、避免重複說明 |
| **3. 品質閘道** | 是否有驗證、測試、lint 相關 Skill/hook | /tdd, /verify, hooks |
| **4. 記憶持久性** | Memory 系統是否記錄關鍵決策與踩坑 | memory 筆記數量與類型 |
| **5. Eval 覆蓋** | 是否有評估 Skill 品質的機制 | /skill_audit, /harness_audit |
| **6. 安全防護** | 是否有敏感路徑保護、危險操作確認機制 | .gitignore, _internal 分離 |
| **7. 成本效率** | Skill 是否避免過度 token 消耗 | Skill 長度、重複呼叫防護 |
| **8. 工具健康度** | hook/工具是否真實存在且能執行、JS 無明顯 Bug | 步驟 0 Hard Check + 步驟 1b JS 掃描結果 |

### 評分標準

- 9-10：完整且有實際驗證
- 7-8：有設置但可改進
- 4-6：部分設置或品質待提升
- 1-3：幾乎沒有設置
- 0：完全缺失

### 維度 8（工具健康度）扣分規則

- 每個 BROKEN_HOOK：-2
- 每個 MODULE_LOAD_ERROR：-3
- 每個 DEAD_TOOL（definition 有但 handle 無 case）：-1
- 每個 🔴 硬編碼路徑：-1
- matchTier 重複定義 2+ 處：-1

---

## 步驟 3：產出評分報告

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Harness Audit 報告
  專案：{project_name}
  日期：{date}
  MCP 工具總數：{N}（{file_io}/{data}/{deploy}/{browser}/{system}/{utils} 個分類）
  公開 Skill：{N}  Hook：{N}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ 健康度警告（若步驟 0 有發現則顯示）：
  ❌ BROKEN HOOK：{hook 名稱} → {.js 路徑}（檔案不存在）
  ❌ MODULE_LOAD_ERROR：{模組路徑}（{錯誤訊息摘要}）
  ❌ DEAD_TOOL：{工具名} in {模組}（definition 存在但 handle 無對應 case）

總分：{X}/80

分項評分：
  工具覆蓋      {X}/10  {說明}
  Context 效率  {X}/10  {說明}
  品質閘道      {X}/10  {說明}
  記憶持久性    {X}/10  {說明}
  Eval 覆蓋     {X}/10  {說明}
  安全防護      {X}/10  {說明}
  成本效率      {X}/10  {說明}
  工具健康度    {X}/10  {說明（JS 掃描 + Hard Check 綜合結果）}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

（若執行 mcp scope）
MCP 工具模組 JS 問題清單：
  🔴 {嚴重}  {模組路徑}：{問題描述}
  🟡 {警告}  {模組路徑}：{問題描述}

（若執行 conflict scope）
Hook × Skill × Tool 衝突：
  ⚠️ SKILL_HOOK_CONFLICT：{skill_name} 建議操作會被 {hook} {rule_id} 攔截
  📋 Hook 攔截矩陣：{工具名} 被 {N} 個 hook 攔截（高風險工具列表）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
優先改進項目（Top 3）：

1. [{維度}] {具體改進動作}
   建議：{實際操作步驟}

2. [{維度}] {具體改進動作}
   建議：{實際操作步驟}

3. [{維度}] {具體改進動作}
   建議：{實際操作步驟}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
已做好的部分：
  ✅ {優點 1}
  ✅ {優點 2}

```text

---

## 步驟 3b：arch scope 附加報告（若有執行步驟 1d）

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  程式碼架構掃描（arch）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A. 循環依賴：{N} 個
   最嚴重：{模組A} ↔ {模組B}（建議斷點：移除哪條邊）

B. 高耦合模組：{N} 個
   Fan-Out > 8：{模組}（依賴 N 個其他模組）
   Fan-In > 10：{模組}（被 N 個模組依賴，改動風險高）

C. 過大模組（> 1000 行）：
   {模組}：{N} 行（建議拆分為：{建議子模組名}）

D. 重複邏輯：
   matchTier 定義於：{hook1.js}, {hook2.js}（建議搬入 hooks/_shared/ 或保留現狀若無需要）

整體架構健康度：{健康 / 輕微問題 / 需要重構 / 嚴重技術債}
建議優先處理：{具體一件事}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

```text

---

## 步驟 4：寫入歷史記錄

報告完成後，將本次分數追加寫入 `docs/audit_history.md`：

```text
| {date} | {工具覆蓋} | {Context效率} | {品質閘道} | {記憶持久性} | {Eval覆蓋} | {安全防護} | {成本效率} | {工具健康度} | {總分}/80 |

```text

若本次有 mcp 或 conflict scope 發現問題，在備註區段補充問題摘要。

---

## 評分參考（本專案情境）

針對 MCP_NodeServer + PHP 後台開發環境的評分重點：

- **工具覆蓋**：filesystem / database / php / sftp / excel / browser 等模組是否完整
- **品質閘道**：是否有 /tdd、/php_crud_test、/playwright_ui_test，hook 是否有 lint
- **記憶持久性**：MEMORY.md 是否有 feedback / project / user 類型記憶
- **安全防護**：_internal skill 是否獨立、basePath 限制是否有效
- **工具健康度**：JS 模組可正常載入、handle() 無 DEAD_TOOL、hook 無重複邏輯

---

## 注意事項

- 評分基於可觀察設定 + 靜態程式碼掃描，不執行實際工具驗證
- 若某設定檔不存在，該維度分數預設從 5 開始往下扣
- 改進建議優先列出「投入少、效益高」的項目
- 每季執行一次，追蹤成熟度趨勢
- **步驟 0B 的 node 指令需在 MCP_NodeServer 根目錄執行**
- 2026-03-30 前的歷史記錄為 7 維度（/70），之後為 8 維度（/80）
