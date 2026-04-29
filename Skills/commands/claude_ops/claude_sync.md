---
name: claude_sync
description: 同步 Claude Code 本機執行狀態（~/.claude/memory + ~/.claude/hooks）與專案 Git repo 的 memory/ 與 hooks/。當使用者說「同步 hook 回 git」「memory 推回 git」「換電腦後拉記憶」「hooks 改完要推上去」「git pull 後記得同步」時觸發。
---

# /claude_sync — 同步 Claude Code 本機狀態與專案 Git（memory + hooks）

你負責在「Git 專案」與「本機 Claude 執行路徑」之間同步：

- **memory/** — 跨對話記憶
- **hooks/** — Claude Code 執行的 PreToolUse / SessionStart 等鉤子

兩者性質都是「本機是執行用、Git 是版控/分享用」，必須一起同步，避免改了一邊忘了另一邊。

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `Glob` | 列出兩端的 memory/hooks 檔案清單 |
| `Read` | 讀取檔案內容做差異比對 |
| `Write` | 寫入新檔到目標端（pull/push 同步） |
| `Edit` | MEMORY.md 索引行的合併 |
| `Bash` | git pull / status / diff，本機 hooks 路徑檢查 |

---

## 四個同步位置

| 名稱 | 路徑 | 用途 |
|------|------|------|
| **Git memory** | `{project_root}/memory/` | 跨機器共享記憶 |
| **Git hooks** | `{project_root}/hooks/` | 版控鉤子（含 register_hooks.cjs） |
| **本機 memory（project）** | `~/.claude/projects/{encoded}/memory/` | 此專案的 Claude 自動記憶 |
| **本機 memory（global）** | `~/.claude/memory/` | 跨所有專案的全域記憶 |
| **本機 hooks** | `~/.claude/hooks/` | Claude Code 實際載入執行的鉤子 |

`{encoded}` = 專案路徑的 Claude 編碼（小寫磁碟代號 + `--` 分隔，例：`d--MCP-Server`）

---

## 執行流程

### Step 0：確認參數

若使用者未指定，詢問：

```
同步方向？
  pull  — Git → 本機（換電腦後更新本機）← 預設
  push  — 本機 → Git（把本機改動存回 git）
  status — 只顯示差異，不寫入

範圍？
  all     — memory + hooks（預設，最常見場景）
  memory  — 只同步 memory/（project 範圍）
  hooks   — 只同步 hooks/
  global  — 同步 ~/.claude/memory/（全域記憶，不含 hooks）
```

### Step 1：偵測路徑

**Git 路徑**：當前工作目錄即為 `{project_root}`，往下找 `memory/`、`hooks/`。

**本機 memory 路徑（project）**：

1. 專案絕對路徑（如 `D:\MCP_Server`）→ 編碼 `d--MCP-Server`
   - 磁碟代號保留原始大小寫
   - `:\` → `--`、`\` → `-`、`_` → `-`
2. 完整路徑：`~/.claude/projects/{encoded}/memory/`
3. **不要猜測**，用 Glob `~/.claude/projects/*/memory/` 列出實際路徑後匹配

**本機 memory 路徑（global）**：`~/.claude/memory/`

**本機 hooks 路徑**：`~/.claude/hooks/`（固定，無 project 區別）

### Step 2：Status（差異比對）

對每個範圍列出三種狀態：

```
=== Sync Status ===

[memory] Git: {git_memory_path}
         Local: {local_memory_path}
  [僅 Git 有] → pull 新增 N 個檔
  [僅本機有] → push 新增 M 個檔
  [兩端有差異] → 需比對 K 個檔
    - MEMORY.md  ← 索引，建議手動合併

[hooks] Git: {git_hooks_path}
        Local: {local_hooks_path}
  [僅 Git 有]    → pull 新增 N 個檔
  [僅本機有]    → push 新增 M 個檔
  [兩端有差異] → 需比對 K 個檔（用 diff 顯示前 20 行差異輔助判斷）

總計：Git memory {a} 檔 / 本機 memory {b} 檔
      Git hooks {c} 檔 / 本機 hooks {d} 檔
```

**hooks 差異特別處理**：hooks 是程式碼，兩端有差異時必須讓使用者看到 diff 才能決定方向，不可盲目覆蓋。

### Step 3：執行同步

#### Pull（Git → 本機）

```
memory：
  [僅 Git 有] → Read + Write 到本機
  [兩端有差異] → 預設跳過，列出「略過（兩端都有）：{檔案}」
                  MEMORY.md 走索引合併（見下）
                  使用者明確說「強制覆蓋」才直接 Write

hooks：
  [僅 Git 有] → Read + Write 到本機
  [兩端有差異] → 顯示 diff，讓使用者逐檔決定 (覆蓋/跳過/反向 push)
                  禁止盲目批次覆蓋（hooks 是程式碼，誤覆蓋會破壞執行環境）
```

**MEMORY.md 合併**：
1. Read 兩個 MEMORY.md
2. 找出本機有但 Git 沒有的索引行
3. 追加到 Git MEMORY.md 結尾（或請使用者手動合併）

#### Push（本機 → Git）

與 Pull 邏輯相同、方向相反。Push 完成後提示：

```
hooks 已更新到 git，記得：
  cd {project_root}
  git add memory/ hooks/
  git commit -m "sync: 同步本機 memory/hooks 到專案"
  git push
```

### Step 4：完成報告

```
同步完成（{pull/push}，範圍：{all/memory/hooks/global}）：

memory：
  新增 X 個 / 略過 Y 個 / MEMORY.md {已合併 / 請手動合併}

hooks：
  新增 X 個 / 覆蓋 Y 個 / 跳過 Z 個（差異需手動確認）

⚠️ 若 hooks 有變動，新對話 SessionStart 時才會生效
```

---

## 快速用法

```
/claude_sync                 ← pull + all（預設，換環境後執行）
/claude_sync push            ← 本機 memory + hooks 推回 git
/claude_sync status          ← 只看差異
/claude_sync pull memory     ← 只同步 memory
/claude_sync push hooks      ← 只把本機 hooks 改動推回 git（最常見場景）
/claude_sync pull global     ← 更新全域記憶
```

---

## 注意

- `memory/_private/` 下的機敏記憶**不同步**，永遠略過
- hooks 是程式碼，兩端有差異時 **必須顯示 diff** 讓使用者確認方向
- Git 路徑需是已 clone 的 repo，pull 前先 `git pull` 拿最新
- 全域 memory 若 `~/.claude/memory/` 不存在，自動建立並初始化空 `MEMORY.md`
- hooks 改動只在新對話生效（SessionStart 載入），當前對話仍用舊邏輯
