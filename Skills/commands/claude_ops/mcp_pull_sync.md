# /mcp_pull_sync — MCP Server Git Pull 後同步設定

你是 MCP Server 同步助手。當使用者從 Git 拉取最新程式碼後，你負責自動偵測所有需要補做的設定，並盡可能自動完成，剩餘需人工操作的部分輸出清單。

---

## 背景

MCP_NodeServer 更新後，通常有四類後續工作需要處理：

1. 新 npm 套件安裝
2. 新 Skill MD 部署到 `~/.claude/commands/`
3. 新 Hook 登記到 `settings.json`
4. MCP Server 重啟（tools / index.js 有變動時）

---

## 執行步驟

### 步驟 1：確認 Pull 範圍並取得變更清單

Git pull 後會自動記錄 `ORIG_HEAD`，優先用這個取得完整的 pull 範圍：

```bash
# 確認 ORIG_HEAD 存在（pull 後自動設定）
git rev-parse ORIG_HEAD 2>/dev/null && \
  git log --oneline ORIG_HEAD..HEAD && \
  git diff ORIG_HEAD HEAD --name-only
```

- 若 `ORIG_HEAD` 存在 → 用 `git diff ORIG_HEAD HEAD --name-only` 取得所有本次 pull 的變更
- 若 `ORIG_HEAD` 不存在（首次或已被清除） → 詢問使用者：「這次 pull 了幾個 commit？」，或請使用者提供起始 commit hash

取得變更檔案清單後，分類到以下 4 個桶：

```text
A: package.json 有變動？
B: Skills/commands/**/*.md 新增或修改（排除 _internal/）
C: hooks/*.js 有新增或修改
D: tools/*.js 或 index.js 有變動
```

---

### 步驟 2：處理 A — npm install

若 `package.json` 有變動：

```bash
npm install
```

→ 輸出安裝結果，確認無 error。
→ 若無變動，跳過並標記「套件：無需更新」。

---

### 步驟 3：處理 B — 部署新 Skill

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

### 步驟 4：處理 C — 檢查 Hook 登記

對每個 `hooks/` 下有變動的 `.js` 檔，檢查 `~/.claude/settings.json` 是否已登記：

```text
用 Grep 搜尋 settings.json 中是否含有該 hook 的檔名
```

若未找到，輸出需人工補登記的 Hook 清單（見「輸出格式」）。
若已登記，標記「Hook：已登記」。

---

### 步驟 5：處理 D — 確認是否需重啟 MCP

若 `tools/*.js` 或 `index.js` 有任何變動：

→ 標記需重啟 MCP Server（無法自動化，需使用者操作）。

---

### 步驟 6：產出同步報告

```text
✅ MCP Pull Sync 完成！

📦 npm 套件
  [已更新 / 無需更新]

🛠 Skill 部署
  [已部署：skill_a.md, skill_b.md]
  [無需部署]

🪝 Hook 登記
  [已登記：repetition-detector.js]
  [需人工登記：（見下方步驟）]

🔄 MCP Server
  [需重啟 / 無需重啟]

⚠️ 需人工操作：
  1. settings.json 補登記以下 Hook：
     - PreToolUse（matcher: ".*"）→ hooks/repetition-detector.js
     （提示：用 /update-config 或直接編輯 ~/.claude/settings.json）
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
| Bash | git diff、npm install、cp 複製 Skill |
| Grep | 搜尋 settings.json 中的 hook 登記狀態 |
| Glob | 列出 Skills/commands/ 下的 MD 檔 |
| Read | 讀取 settings.json 確認 hook 結構 |

---

## 注意事項

- `git diff HEAD~1 HEAD` 只看最後一個 commit；若一次 pull 了多個 commit，改用 `git log` 先確認範圍再調整 diff 指令
- `_internal/` 下的 Skill 不部署、不列入報告
- `*_steps.md`（伴隨參考檔）不獨立部署，跳過
- Hook 登記無法自動寫入 settings.json（需使用者授權），只能輸出提示
- MCP Server 重啟只能由使用者手動操作，不要嘗試自動化
