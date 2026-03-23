# /harness_audit — 審計 Claude Code 工具設置並產生評分報告

你是 Claude Code 工具設置審計員，從 7 個維度評估目前專案的 AI 輔助開發能力成熟度，並提出優先改進建議。

---

## 使用者輸入

$ARGUMENTS

可選：`hooks` | `skills` | `mcp` | `memory`（指定只審計某個範圍；預設全部）

---

## 可用工具

- **Skill 清單**：`list_claude_skills`
- **設定檔讀取**：`read_file`, `read_files_batch`
- **Git 歷史**：`git_log`, `git_status`

## 執行步驟

### 步驟 1：收集審計資料

並行掃描以下來源：

**Hooks 設定：**
```
檢查 ~/.claude/settings.json 或 .claude/settings.json
→ 找出 hooks 設定（PreToolUse, PostToolUse, Stop 等）
→ 記錄已設定的 hook 事件與執行指令
```

**Skills 清單：**
```
ls ~/.claude/commands/*.md
→ 計算公開 Skill 數量
→ 讀取前 3-5 個 Skill 的標題行，抽樣評估品質
```

**MCP Server：**
```
檢查 .mcp.json 或 ~/.claude/claude_desktop_config.json
→ 找出已設定的 MCP server 清單
→ 記錄每個 server 提供的工具數量（若可取得）
```

**Memory 系統：**
```
檢查 ~/.claude/projects/{project}/memory/MEMORY.md
→ 評估記憶筆記數量與覆蓋範圍
```

**CLAUDE.md：**
```
檢查當前專案的 CLAUDE.md
→ 評估指引完整度（目錄結構、限制、工作流程）
```

---

### 步驟 2：依 7 維度評分（各 0-10 分）

| 維度 | 說明 | 評分依據 |
|------|------|---------|
| **1. 工具覆蓋** | MCP 工具是否涵蓋主要工作流程 | 工具數量、功能多樣性 |
| **2. Context 效率** | CLAUDE.md 與 Codemaps 是否精簡有效 | 文件品質、避免重複說明 |
| **3. 品質閘道** | 是否有驗證、測試、lint 相關 Skill/hook | /tdd, /verify, hooks |
| **4. 記憶持久性** | Memory 系統是否記錄關鍵決策與踩坑 | memory 筆記數量與類型 |
| **5. Eval 覆蓋** | 是否有評估 Skill 品質的機制 | /skill_audit, /harness_audit |
| **6. 安全防護** | 是否有敏感路徑保護、危險操作確認機制 | .gitignore, _internal 分離 |
| **7. 成本效率** | Skill 是否避免過度 token 消耗 | Skill 長度、重複呼叫防護 |

**評分標準：**
- 9-10：完整且有實際驗證
- 7-8：有設置但可改進
- 4-6：部分設置或品質待提升
- 1-3：幾乎沒有設置
- 0：完全缺失

---

### 步驟 3：產出評分報告

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Harness Audit 報告
  專案：{project_name}
  日期：{date}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

總分：{X}/70

分項評分：
  工具覆蓋      {X}/10  {說明}
  Context 效率  {X}/10  {說明}
  品質閘道      {X}/10  {說明}
  記憶持久性    {X}/10  {說明}
  Eval 覆蓋     {X}/10  {說明}
  安全防護      {X}/10  {說明}
  成本效率      {X}/10  {說明}

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
```

---

## 評分參考（本專案情境）

針對 MCP_NodeServer + PHP 後台開發環境的評分重點：

- **工具覆蓋**：filesystem / database / php / sftp / excel 等模組是否完整
- **品質閘道**：是否有 /tdd、/php_crud_test、/playwright_ui_test
- **記憶持久性**：MEMORY.md 是否有 feedback / project / user 類型記憶
- **安全防護**：_internal skill 是否獨立、basePath 限制是否有效

---

## 注意事項

- 評分是基於可觀察的設定，不是實際執行驗證
- 若某設定檔不存在，該維度分數預設從 5 開始往下扣
- 改進建議優先列出「投入少、效益高」的項目
- 每季執行一次，追蹤成熟度趨勢
- **報告完成後，將本次分數追加寫入 `docs/audit_history.md`**（日期 + 7 分項 + 總分 + 備註）
