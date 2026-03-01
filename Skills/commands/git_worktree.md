# /git_worktree — 建立隔離 Git Worktree 並設定開發環境

你是 Git Worktree 管理專家，負責建立隔離的工作區，讓使用者能同時在多個分支上開發，而不需切換分支或影響主工作區。

---

## 使用者輸入

$ARGUMENTS

若 `$ARGUMENTS` 提供了分支名稱，則使用該名稱建立 worktree。否則詢問使用者。

---

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 分支名稱 | 新 worktree 要使用的分支名稱 | `feature/add-login` |
| Worktree 目錄 | 存放 worktree 的位置（可自動偵測） | `.worktrees/` |

---

## 執行步驟

### 步驟 1：確認 Worktree 存放目錄

依照以下優先順序決定 worktree 目錄位置：

1. 檢查專案根目錄是否有 `.worktrees/` 或 `worktrees/` 目錄
2. 讀取 `CLAUDE.md` 是否有指定偏好路徑
3. 都沒有時，詢問使用者（建議使用 `.worktrees/`）

```bash
ls .worktrees/ 2>/dev/null || ls worktrees/ 2>/dev/null
```

---

### 步驟 2：確認目錄已被 .gitignore 排除

**重要：** 若 worktree 目錄在專案內，必須確認已加入 `.gitignore`，避免意外提交 worktree 內容。

```bash
cat .gitignore | grep worktree
```

若未忽略，詢問使用者是否自動加入 `.gitignore`，確認後加入。

---

### 步驟 3：偵測專案資訊並建立 Worktree

```bash
# 建立 worktree（若分支不存在則同時建立）
git worktree add .worktrees/<branch-name> -b <branch-name>

# 或掛載已有分支
git worktree add .worktrees/<branch-name> <branch-name>

# 確認建立結果
git worktree list
```

---

### 步驟 4：安裝依賴套件

依照專案類型自動偵測並安裝：

| 專案類型 | 偵測依據 | 安裝指令 |
|----------|----------|----------|
| Node.js | `package.json` 存在 | `npm install` |
| PHP Composer | `composer.json` 存在 | `composer install` |
| Python | `requirements.txt` 存在 | `pip install -r requirements.txt` |

在 worktree 目錄內執行對應安裝指令。

---

### 步驟 5：執行基線測試

在 worktree 目錄內執行現有測試，確認起始狀態乾淨：

```bash
cd .worktrees/<branch-name>
# 依專案類型執行測試
# npm test / php vendor/bin/phpunit / python -m pytest
```

若測試失敗：列出失敗項目，詢問使用者是否仍要繼續（失敗可能來自 main 既有問題）。

---

### 步驟 6：產出報告

```
✅ Worktree 建立完成！

📊 統計：
  分支名稱：<branch-name>
  Worktree 路徑：.worktrees/<branch-name>
  依賴套件：已安裝
  基線測試：✓ 全部通過 / ⚠️ N 個失敗

📝 後續指令：
  進入 worktree：cd .worktrees/<branch-name>
  列出所有 worktree：git worktree list
  清除 worktree：git worktree remove .worktrees/<branch-name>
```

---

## 注意事項

- 絕對不能跳過步驟 2 的 .gitignore 驗證（避免意外提交 worktree 內容）
- 不能假設目錄位置，未有明確設定時必須詢問使用者
- 基線測試失敗時，不能自動繼續，必須等使用者確認
- worktree 目錄名稱建議與分支名稱一致，方便辨識
- 此 Skill 完成後，可搭配 `/tdd` 在 worktree 內進行測試驅動開發
