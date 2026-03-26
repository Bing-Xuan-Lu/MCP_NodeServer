# /github_skill_import — 爬取 GitHub Skill 儲存庫並建立本地學習參考庫

你是 AI 技能研究員，從 GitHub 上的 Claude Skill 儲存庫爬取所有 `.md` 技能檔，整理成本地學習參考庫，供未來建立或改進 Skill 時參考。

---

## 使用者輸入

$ARGUMENTS

格式：`{GitHub Repo URL}` 或 `{owner}/{repo}`
例：`https://github.com/{owner}/{repo}` 或 `{owner}/{repo}`

---

## 前置設定（首次使用必做）

### 1. 安裝 GitHub CLI

**Windows：**
```bash
winget install --id GitHub.cli -e
# 安裝後需重新開啟終端機，或手動加入 PATH：
export PATH="$PATH:/c/Program Files/GitHub CLI"
```

**macOS：**
```bash
brew install gh
```

**Linux（Debian / Ubuntu）：**
```bash
sudo apt install gh
# 若 apt 找不到，先加 repo：
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update && sudo apt install gh
```

確認安裝：`gh --version`

### 2. 登入 GitHub 帳號

```bash
gh auth login
# 選擇：GitHub.com → HTTPS → 用瀏覽器登入
```

確認登入狀態：`gh auth status`

> 未登入僅能存取公開 repo，但 API 每小時限流 60 次；登入後提升至 5000 次。

---

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| GitHub Repo URL | 目標儲存庫網址 | `https://github.com/owner/repo` |
| Skill 目錄路徑 | Repo 內 Skill 存放路徑（可自動偵測） | `.claude/commands` / `skills/` / `commands/` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `Bash (gh api)` | 使用 GitHub CLI 列出目錄、取得檔案內容 |
| `WebFetch` | 抓取 raw.githubusercontent.com 檔案內容（gh 不可用時的備案） |
| `Write` | 將下載的 MD 檔寫入本地 references 目錄 |
| `Bash (ls)` | 確認本地已存在的參考檔清單 |

---

## 執行步驟

### 步驟 1：解析 Repo 資訊

從 `$ARGUMENTS` 提取 `{owner}/{repo}`：

```
若輸入為完整 URL：https://github.com/owner/repo
→ 提取 owner = "owner"，repo = "repo"

若輸入為簡短格式：owner/repo
→ 直接使用
```

確認目標 repo 存在：

```bash
gh repo view {owner}/{repo} --json name,description,defaultBranchRef
→ 取得 repo 名稱、描述、預設分支（通常為 main 或 master）
→ 若無法存取：告知使用者確認 repo 是否公開，或先執行 gh auth login
```

---

### 步驟 2：偵測 Skill 目錄位置

在 repo 根目錄搜尋常見的 Skill 存放路徑：

```bash
# 依優先順序嘗試以下路徑
gh api repos/{owner}/{repo}/contents/.claude/commands --jq '.[].name' 2>/dev/null
gh api repos/{owner}/{repo}/contents/skills --jq '.[].name' 2>/dev/null
gh api repos/{owner}/{repo}/contents/commands --jq '.[].name' 2>/dev/null
gh api repos/{owner}/{repo}/contents --jq '.[].name' 2>/dev/null

→ 找到含有 .md 檔案的目錄即為目標
→ 若有多個候選目錄，列出讓使用者選擇
```

---

### 步驟 3：列出所有 Skill 檔案

取得目標目錄下所有 `.md` 檔清單：

```bash
gh api repos/{owner}/{repo}/contents/{skill_dir} \
  --jq '[.[] | select(.name | endswith(".md")) | {name: .name, path: .path, size: .size}]'

→ 若有子資料夾，遞迴列出（最多 2 層）
→ 排除 README.md、CHANGELOG.md、LICENSE.md 等非 Skill 文件
```

顯示偵測結果供使用者確認：

```
🔍 偵測結果：
  Repo：{owner}/{repo}
  Skill 目錄：{skill_dir}
  發現 {N} 個 .md 技能檔

  📄 清單：
    - skill_a.md
    - skill_b.md
    ...

> 確認後開始下載？（可指定只下載部分檔案）
```

---

### 步驟 4：下載並儲存技能檔

確認本地儲存目錄，建立 per-repo 子目錄：

```
本地路徑：{MCP_ROOT}/Skills/references/{owner}--{repo}/
```

逐一下載每個 `.md` 檔：

```bash
# 取得檔案內容（base64 解碼）
gh api repos/{owner}/{repo}/contents/{file_path} \
  --jq '.content' | base64 -d

→ 寫入 {MCP_ROOT}/Skills/references/{owner}--{repo}/{filename}.md
```

若 `gh api` 無法取得內容，改用 `WebFetch`：

```
URL：https://raw.githubusercontent.com/{owner}/{repo}/main/{file_path}
→ 直接取得純文字內容
→ 寫入本地檔案
```

---

### 步驟 5：差異比對（可選）

下載完成後，詢問是否進行差異分析：

> 是否要比對下載的 Skills 與現有 Skills 的差異，找出值得引入的新功能？

若使用者同意：

```
讀取 ~/.claude/commands/*.md 的所有標題行（# /name — 說明）
比對下載的 Skills：
  1. 全新技能（本地沒有對應的功能） → 標記為「值得學習」
  2. 功能重疊的技能 → 列出差異點，標記「有改進空間」
  3. 本地已有且更完整的技能 → 標記「已涵蓋，可跳過」
```

---

### 步驟 6：產出學習報告

```
✅ GitHub Skill 匯入完成！

📦 來源：{owner}/{repo}
📁 儲存位置：Skills/references/{owner}--{repo}/
📥 下載數量：{N} 個技能檔

📊 差異比對摘要：（若有執行）
  🆕 全新技能（{n} 個）：
    - /skill_name — 說明
    ...

  🔄 有改進空間（{n} 個）：
    - /skill_name — 差異描述
    ...

  ✓ 已涵蓋（{n} 個）：略

💡 建議後續動作：
  - 執行 /learn_claude_skill 從參考檔中萃取可用模式
  - 或直接閱讀 Skills/references/{owner}--{repo}/ 中的檔案
```

---

### 步驟 7：研究報告（可選）

下載與差異比對完成後，詢問使用者：

> 是否要產出完整的**參考庫研究報告**（RESEARCH_REPORT.md）？
> 報告會深入分析外部 Skill 的設計模式、與本地 Skill 的功能比對、以及可吸收的通用模式，存放於 `Skills/references/{owner}--{repo}/RESEARCH_REPORT.md` 供日後參考。

若使用者同意，執行 `/learn_claude_skill` 的**參考庫研究模式**（步驟 R2–R4），將報告存為：

```
{MCP_ROOT}/Skills/references/{owner}--{repo}/RESEARCH_REPORT.md
```

報告結構：
- 層 1 — 結構分析（外部 Skill 的設計模式與可借鑑點）
- 層 2 — 功能比對（全新功能 / 有改進空間 / 已涵蓋 / 不適用）
- 層 3 — 可吸收的跨 Skill 通用模式
- 下載檔案統計

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| `gh: command not found` | GitHub CLI 未安裝 | 改用 WebFetch 抓 raw.githubusercontent.com |
| `HTTP 404` | repo 為私有或路徑錯誤 | 確認 repo 公開性；路徑改用 Step 2 自動偵測 |
| base64 解碼亂碼 | 檔案是二進位非文字 | 跳過該檔案 |
| `rate limit exceeded` | GitHub API 限流（未登入） | 執行 `gh auth login` 後重試 |

---

## 注意事項

- 下載的參考檔存於 `Skills/references/`，**不部署到 `~/.claude/commands/`**（純參考用，不觸發為指令）
- 若同一 repo 已有下載紀錄，詢問是否覆蓋或保留舊版
- 技能檔內容若有寫死的路徑、URL、API Key，僅供學習參考，不直接使用
- `Skills/references/` 應加入 `.gitignore`（避免將他人技能納入版控）
