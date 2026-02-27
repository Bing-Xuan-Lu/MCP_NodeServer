# /git_commit — 產生繁體中文 Git Commit 訊息並提交

分析目前 Git 工作區的變更，自動產生條列式繁體中文 Commit 訊息，確認後提交。**不執行 push。**

---

## 流程

### 步驟 1：取得變更概況

執行以下指令，了解當前狀態：

```bash
git status
git diff --cached --stat
git diff --stat
```

**判斷提交範圍（重要）：**

- 若 `git diff --cached --stat` 有輸出 → **已有暫存檔案，只提交暫存內容**，不執行 `git add`
- 若 `git diff --cached --stat` 無輸出 → **無暫存，將全部變更加入暫存**（步驟 6 執行 `git add -A`）

### 步驟 2：讀取變更內容

依步驟 1 判斷的提交範圍，讀取對應的 diff：

**已有暫存** — 只讀暫存區的差異：

```bash
git diff --cached -- <file>
```

**無暫存（全部）** — 讀取工作區差異：

```bash
git diff HEAD -- <file>
```

**第三方套件／編譯產物目錄** — 只記錄目錄名稱，**不逐一讀取內部檔案**：

| 跳過不讀的目錄 | 說明 |
| --- | --- |
| `node_modules/` | Node.js 套件 |
| `vendor/` | PHP Composer 套件 |
| `packages/` | Monorepo 子套件 |
| `lib/` / `libs/` | 第三方函式庫 |
| `plugins/` / `plugin/` | 插件目錄 |
| `extensions/` | 擴充套件 |
| `.venv/` / `venv/` / `env/` | Python 虛擬環境 |
| `__pycache__/` | Python 快取 |
| `dist/` / `build/` / `out/` | 編譯輸出 |
| `public/assets/` / `static/` | 編譯後靜態資源 |
| `.next/` / `.nuxt/` / `.svelte-kit/` | 框架建置快取 |

**判斷原則**：若整個目錄下的檔案都不是由開發者直接編寫的（自動產生、下載或編譯的），直接跳過。
這些目錄只需記錄「第三方套件／編譯產物已更新」，不需要展開讀取內容。

### 步驟 3：分析並分類變更

將所有變更歸類：

- **新增功能**（新檔案、新函式、新路由）
- **修改功能**（現有邏輯調整）
- **修正問題**（Bug fix、錯誤處理）
- **設定調整**（config、env、json、yaml 變更）
- **依賴更新**（package.json、composer.json 等套件清單）
- **文件更新**（README、MD、註解）
- **重構**（不影響功能的程式碼整理）

### 步驟 4：產生 Commit 訊息

依變更內容，使用以下格式產生繁體中文訊息：

```
[動作] 主要變更摘要（一行，50字以內）

- 具體變更說明 1
- 具體變更說明 2
- 具體變更說明 3
```

**動作前綴規則：**

| 情境 | 前綴 |
| --- | --- |
| 加入新功能/檔案 | `新增` |
| 修改現有功能 | `修改` |
| 修正錯誤 | `修正` |
| 重構程式碼 | `重構` |
| 更新依賴套件 | `更新` |
| 更新文件 | `文件` |
| 混合多種變更 | `更新` |

**條列式說明規則：**

- 每條說明簡短具體，說明「做了什麼」而非「為什麼」
- 若涉及第三方套件目錄，只寫「更新 node_modules 依賴」，不列細項
- 最多列 7 條，超過時合併同類項目

**範例：**

```
新增 MCP Skill 自動學習功能

- 新增 tools/skill_factory.js，提供 save/list/delete_claude_skill 工具
- 新增 Skills/commands/learn_claude_skill.md 斜線指令
- 修改 index.js 加入 skillFactory 模組
- 修改 config.js 新增 Runtime 路徑白名單機制
```

### 步驟 5：顯示訊息並確認

將產生的 Commit 訊息完整顯示給使用者，並詢問：

> 以上為準備提交的 Commit 訊息，是否確認？
> - 確認提交
> - 修改訊息後提交
> - 取消

### 步驟 6：執行提交

使用者確認後，依步驟 1 的判斷執行：

**情況 A — 已有暫存，直接提交：**

```bash
git commit -m "$(cat <<'EOF'
[訊息內容]
EOF
)"
```

**情況 B — 無暫存，先全部加入再提交：**

```bash
git add -A
git commit -m "$(cat <<'EOF'
[訊息內容]
EOF
)"
```

提交成功後顯示 commit hash 與摘要，**不執行 `git push`**。

---

## 注意事項

- 若工作區沒有任何變更，告知使用者並結束
- 若有 untracked 檔案，詢問使用者是否要一併加入
- `_internal` 結尾的檔案屬於私有內容，commit 訊息中不列出完整路徑
- 不修改 `.gitignore` 中已忽略的檔案
