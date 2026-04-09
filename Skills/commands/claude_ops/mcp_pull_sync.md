# /mcp_pull_sync — MCP Server Git Pull 後同步設定

你是 MCP Server 同步助手。當使用者從 Git 拉取最新程式碼後，你負責自動偵測所有需要補做的設定，並盡可能自動完成，剩餘需人工操作的部分輸出清單。

---

## 背景

MCP_NodeServer 更新後，通常有六類後續工作需要處理：

1. 環境變數檔（`.env`）建立或更新
2. 新 npm 套件安裝
3. 新 Skill MD 部署到 `~/.claude/commands/`
4. Hook 檔案複製到 `~/.claude/hooks/`
5. Hook 登記到 `settings.json`（自動寫入）
6. MCP Server 重啟（tools / index.js 有變動時）

---

## 執行步驟

### 步驟 1：確認 Pull 範圍並取得變更清單

Git pull 後會自動記錄 `ORIG_HEAD`，優先用這個取得完整的 pull 範圍：

```bash
git rev-parse ORIG_HEAD 2>/dev/null && \
  git log --oneline ORIG_HEAD..HEAD && \
  git diff ORIG_HEAD HEAD --name-only
```

- 若 `ORIG_HEAD` 存在 → 用 `git diff ORIG_HEAD HEAD --name-only` 取得所有本次 pull 的變更
- 若 `ORIG_HEAD` 不存在（首次或已被清除） → 詢問使用者：「這次 pull 了幾個 commit？」，或請使用者提供起始 commit hash

取得變更檔案清單後，分類到以下 5 個桶：

```text
A: .env.example 或 env.js 有變動？
B: package.json 有變動？
C: Skills/commands/**/*.md 新增或修改（排除 _internal/）
D: hooks/*.js 有新增或修改
E: tools/*.js 或 index.js 有變動
F: 首次部署（.env 不存在 或 ~/.claude/hooks/ 目錄不存在或為空）
```

**若為首次部署（F）：強制執行步驟 2～5，不論 git diff 結果。**

---

### 步驟 2：處理 A — 環境變數檔

檢查 MCP_Server 根目錄是否存在 `.env`：

- **不存在**（首次部署或新成員）→ 自動複製：

  ```bash
  cp .env.example .env
  ```

  並提醒使用者：「已從 `.env.example` 建立 `.env`，請檢查並依本機環境調整設定值。」

- **已存在但 `.env.example` 有新增變數** → 比對兩檔的 key，列出 `.env` 缺少的變數：

  ```bash
  # 取出 .env.example 的 key（排除註解和空行）
  grep -oP '^[A-Z_]+=?' .env.example | sort > /tmp/env_example_keys
  grep -oP '^[A-Z_]+=?' .env | sort > /tmp/env_keys
  comm -23 /tmp/env_example_keys /tmp/env_keys
  ```

  若有差異 → 輸出缺少的變數名稱及 `.env.example` 中的預設值和註解，提醒使用者手動補入。

- **兩邊一致** → 標記「環境變數：無需更新」。

---

### 步驟 3：處理 B — npm install

若 `package.json` 有變動：

```bash
npm install
```

→ 輸出安裝結果，確認無 error。
→ 若無變動，跳過並標記「套件：無需更新」。

---

### 步驟 4：處理 C — 部署新 Skill

對每個 `Skills/commands/` 下有變動的 `.md` 檔（排除 `_internal/`、`_skill_template.md`、`*_steps.md`）：

1. 用 Glob 找出完整路徑
2. 比對 `~/.claude/commands/` 是否已有該檔（只比檔名，忽略子資料夾）
3. 不存在或內容不同 → 執行複製：

```bash
cp "Skills/commands/{dept}/{skill}.md" ~/.claude/commands/{skill}.md
```

→ 逐一輸出部署結果。
→ 若無新 Skill，標記「Skill：無需部署」。

---

### 步驟 5：處理 D — 複製 Hook 檔案

對每個 `hooks/` 下有變動的 `.js` 檔（以及首次部署時的全部 `.js` 檔）：

```bash
# 確保目標目錄存在
mkdir -p ~/.claude/hooks

# 逐一複製
cp hooks/{file}.js ~/.claude/hooks/{file}.js
```

同時也複製 `hooks/skill-keywords.json`（若存在）：

```bash
cp hooks/skill-keywords.json ~/.claude/hooks/skill-keywords.json
```

→ 逐一輸出複製結果。

---

### 步驟 6：處理 D — 自動登記 Hook 到 settings.json

複製完成後，讀取 `~/.claude/settings.json`，確認以下 hook 是否已登記。
**未登記的項目自動寫入**（用 Node.js 讀寫 JSON，保留原有 permissions 不動）：

```bash
node - << 'EOF'
const fs = require('fs');
const path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;
const settingsPath = path.join(HOME, '.claude', 'settings.json');

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch(e) {}
if (!settings.hooks) settings.hooks = {};

// 標準 hook 登記結構
const REQUIRED_HOOKS = {
  SessionStart: [
    { command: `node "${HOME.replace(/\\/g,'/')}/.claude/hooks/session-start.js"` }
  ],
  PreCompact: [
    { command: `node "${HOME.replace(/\\/g,'/')}/.claude/hooks/pre-compact.js"` }
  ],
  PreToolUse: [
    { matcher: '.*', command: `node "${HOME.replace(/\\/g,'/')}/.claude/hooks/repetition-detector.js"` },
    { matcher: 'Write|Edit', command: `node "${HOME.replace(/\\/g,'/')}/.claude/hooks/write-guard.js"` },
    { matcher: '.*', command: `node "${HOME.replace(/\\/g,'/')}/.claude/hooks/user-prompt-guard.js"` },
    { matcher: '.*', command: `node "${HOME.replace(/\\/g,'/')}/.claude/hooks/skill-router.js"` },
  ],
  PostToolUse: [
    { matcher: 'Write|Edit', command: `node "${HOME.replace(/\\/g,'/')}/.claude/hooks/llm-judge.js"` }
  ],
  Stop: [
    { command: `node "${HOME.replace(/\\/g,'/')}/.claude/hooks/session-stop.js"` }
  ],
};

let changed = 0;

function commandExists(hookList, cmd) {
  if (!Array.isArray(hookList)) return false;
  return hookList.some(entry =>
    (entry.hooks || []).some(h => h.command === cmd)
  );
}

for (const [event, entries] of Object.entries(REQUIRED_HOOKS)) {
  if (!settings.hooks[event]) settings.hooks[event] = [];
  for (const entry of entries) {
    if (!commandExists(settings.hooks[event], entry.command)) {
      const hookEntry = { hooks: [{ type: 'command', command: entry.command }] };
      if (entry.matcher) hookEntry.matcher = entry.matcher;
      settings.hooks[event].push(hookEntry);
      changed++;
      console.log(`[登記] ${event}${entry.matcher ? ` (${entry.matcher})` : ''}: ${entry.command.split('/').pop()}`);
    }
  }
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
if (changed === 0) console.log('[Hook] 所有 hook 均已登記，無需更新');
else console.log(`[Hook] 已自動登記 ${changed} 個 hook`);
EOF
```

→ 輸出登記結果。

---

### 步驟 7：處理 E — 確認是否需重啟 MCP

若 `tools/*.js` 或 `index.js` 有任何變動：

→ 標記需重啟 MCP Server（需使用者手動操作）。

---

### 步驟 8：產出同步報告

```text
✅ MCP Pull Sync 完成！

⚙️ 環境變數
  [已建立 .env / 需補入 N 個新變數 / 無需更新]

📦 npm 套件
  [已更新 / 無需更新]

🛠 Skill 部署
  [已部署：skill_a.md, skill_b.md]
  [無需部署]

🪝 Hook 同步
  [已複製：session-start.js, session-stop.js, repetition-detector.js ...]
  [已登記：5 個 hook]
  [無需更新]

🔄 MCP Server
  [需重啟 / 無需重啟]

⚠️ 需人工操作：
  1. 檢查 .env 設定值是否正確（首次或有新變數時）
  2. 重啟 MCP Server（Ctrl+Shift+P → Restart MCP Server）
```

若所有步驟均自動完成且無需重啟，輸出：

```text
✅ 全部同步完成，無需額外操作！
```

---

## 可用工具

| 工具 | 用途 |
| --- | --- |
| Bash | git diff、npm install、cp 複製檔案、node 寫入 settings.json |
| Grep | 搜尋確認狀態 |
| Glob | 列出 Skills/commands/ 下的 MD 檔 |
| Read | 讀取 settings.json 確認 hook 結構 |

---

## 注意事項

- `git diff HEAD~1 HEAD` 只看最後一個 commit；若一次 pull 了多個 commit，改用 `git log` 先確認範圍再調整 diff 指令
- `_internal/` 下的 Skill 不部署、不列入報告
- `*_steps.md`（伴隨參考檔）不獨立部署，跳過
- `skill-keywords.json` 跟著 hooks/ 一起複製（skill-router 依賴）
- MCP Server 重啟只能由使用者手動操作，不要嘗試自動化
- Node.js 寫入 settings.json 時只操作 `hooks` 區段，`permissions` 等其他欄位保持原樣
