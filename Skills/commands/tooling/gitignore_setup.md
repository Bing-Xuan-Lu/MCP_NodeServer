---
name: gitignore_setup
description: |
  掃描專案目錄，自動識別不應上傳 Git 的檔案類型，並補全 .gitignore 規則。涵蓋：機密檔偵測（.env、金鑰、憑證）、建置產出物、OS/IDE 暫存檔、語言特定忽略規則（PHP/Node/Python/Docker）、已追蹤但應忽略的檔案提示。
  當使用者說「.gitignore 設定」「不想 commit 這個」「檢查 gitignore」「有什麼不應該推上去」，或要初始化新專案的版控時使用。
---

# /gitignore_setup — 掃描專案並自動補全 .gitignore 規則

你是版控安全專家，掃描專案目錄後，找出所有不應進入 Git 的檔案類型，與現有 .gitignore 比對後產出補充清單，並在使用者確認後自動更新。

---

## 使用者輸入

$ARGUMENTS

格式（可選）：`[專案路徑或特殊排除需求]`

範例：
- `/gitignore_setup` — 掃描目前工作目錄
- `/gitignore_setup D:\Develop\myapp` — 掃描指定路徑
- `/gitignore_setup 不要忽略 dist/` — 排除特定規則

---

## 可用工具

- **目錄掃描**：`list_files_batch`, `get_folder_contents`
- **檔案讀取**：`read_file`, `read_files_batch`
- **修改寫入**：`apply_diff`, `create_file`

## 執行步驟

### 步驟 1：讀取現況

讀取現有 `.gitignore`（若不存在則視為空白），並執行以下掃描：

```bash
# 取得現有 .gitignore 內容
cat .gitignore 2>/dev/null || echo "(無 .gitignore)"

# 列出所有未追蹤檔案（git status 的 Untracked 區段）
git status --porcelain | grep "^??" | head -60

# 列出已追蹤但名稱疑似應忽略的檔案
git ls-files | grep -Ei "\.(env|log|key|pem|p12|pfx|crt|cer)$|^vendor/|^node_modules/|^\.DS_Store$|Thumbs\.db"
```

---

### 步驟 2：分析應忽略的模式

依以下分類逐一比對，標記「已涵蓋 ✅」或「缺少 ❌」：

**機密與憑證**
```
.env
.env.*
*.key
*.pem
*.p12
*.pfx
*.cer
*.crt
credentials.json
secrets.json
*.secret
```

**OS / IDE 暫存**
```
.DS_Store
Thumbs.db
desktop.ini
.vscode/
.idea/
*.suo
*.user
*.swp
*~
```

**Node.js 專案**
```
node_modules/
dist/
.npm/
*.tgz
```

**PHP 專案**
```
vendor/
*.cache
```

**Python 專案**（若有 .py 檔）
```
__pycache__/
*.pyc
.venv/
*.egg-info/
```

**Docker**
```
.env.docker
docker-compose.override.yml
```

**Log / 暫存**
```
*.log
logs/
tmp/
temp/
*.tmp
*.bak
```

**建置產出物**（依專案實際情況判斷）
```
build/
out/
*.min.js（若由打包工具產生）
```

---

### 步驟 3：比對並產出差異清單

列出「建議新增」的規則，格式：

```
📋 .gitignore 分析結果

目前規則：N 條
建議新增：N 條
⚠️  已追蹤但應忽略：N 個（需手動 git rm --cached）

建議新增的規則：

【機密與憑證】
  ❌ .env               → 環境變數，含 DB 密碼/API Key
  ❌ *.pem              → SSL 私鑰

【OS / IDE】
  ❌ .DS_Store          → macOS 系統檔
  ✅ .idea/             → 已涵蓋

【Node.js】
  ✅ node_modules/      → 已涵蓋
  ❌ dist/              → 打包輸出目錄

...（以此類推）

⚠️  以下檔案已被 Git 追蹤，加入 .gitignore 後需執行 git rm --cached：
  - config/.env.local
  - logs/app.log
```

詢問使用者：

> 以上規則是否確認新增？（可指定排除哪幾條，或全部確認）

---

### 步驟 4：更新 .gitignore

依使用者確認的規則，將新增內容**附加**（不覆蓋原有內容）到 .gitignore：

```
# --- Auto-added by /gitignore_setup [日期] ---

# 機密與憑證
.env
.env.*
*.key
*.pem

# OS / IDE
.DS_Store
Thumbs.db
.vscode/

# ... （依確認清單）

# --- End ---
```

---

### 步驟 5：處理已追蹤的應忽略檔案

若步驟 3 發現已追蹤但應忽略的檔案，逐一列出並提示：

```bash
# 從追蹤中移除（不刪除本機檔案）
git rm --cached <檔案路徑>
```

> ⚠️ `git rm --cached` 只是從追蹤清單移除，不影響本機檔案。執行後需 commit 才生效。

詢問使用者是否要一次執行，或逐一確認。

---

### 步驟 6：產出報告

```
✅ .gitignore 更新完成！

📊 統計：
  原有規則：N 條
  新增規則：N 條
  目前總計：N 條

📝 新增內容：
  - .env（機密）
  - *.log（日誌）
  - dist/（建置產出）
  - ...

⚠️  需後續處理：
  - 執行 git rm --cached 移除 N 個已追蹤檔案
  - 執行 git commit 記錄 .gitignore 變更
```

---

## 注意事項

- 只**附加**新規則到 .gitignore，不修改或刪除原有規則
- `dist/`、`build/` 等產出目錄，確認是否為打包工具自動產生再決定是否忽略（手寫的靜態資源不應忽略）
- 已追蹤的檔案加入 .gitignore 後**不會自動停止追蹤**，必須另外執行 `git rm --cached`
- 若使用者指定排除某條規則（如「dist/ 要保留」），照樣遵從，不強制加入
- 機密類規則（.env、*.key）屬高優先，即使使用者猶豫也要明確告知風險
