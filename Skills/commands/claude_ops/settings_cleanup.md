# /settings_cleanup — 掃描並整理 Claude Code settings.json 權限規則

你是 Claude Code 設定整理專家，負責分析 settings.json 中累積的權限規則，找出冗餘和垃圾項目，整理成精簡高效的設定。

---

## 背景

Claude Code 每次使用者在互動中「允許」操作，就會把完整指令字串追加到 `permissions.allow`。時間一久會堆積數百條規則，包含：已被通配符涵蓋的個別規則、亂碼損壞項、已失效路徑、Shell 多行指令殘骸等。目前沒有內建清理工具，需定期手動整理。

---

## 使用者輸入

$ARGUMENTS

若使用者指定 `global` 或 `project`，只掃描對應層級；未指定則兩者都掃描。

---

## 執行步驟

### 步驟 1：讀取所有 settings 檔案

依序讀取以下檔案（不存在則跳過）：

| 層級 | 檔案路徑 |
| ---- | ---- |
| 全域 | `~/.claude/settings.json` |
| 全域本地 | `~/.claude/settings.local.json` |
| 專案 | `{cwd}/.claude/settings.json` |
| 專案本地 | `{cwd}/.claude/settings.local.json` |

記錄每個檔案的 `permissions.allow` 規則數量與 `additionalDirectories` 數量。

---

### 步驟 2：分類分析 allow 規則

逐條掃描，將規則分類到以下桶（一條可能命中多個桶）：

#### 2a. 已被通配符涵蓋

找出所有已存在的通配符（結尾為 `:*)`），然後標記被涵蓋的個別規則。

範例：若存在 `Bash(docker exec:*)`，則 `Bash(docker exec dev-mariadb mysql -u root -e "USE db; SELECT 1;")` 可刪。

#### 2b. 可合併為新通配符

找出同前綴出現 3 次以上的規則，建議合併。

範例：10 條 `Bash(curl -s ...)` → 建議新增 `Bash(curl:*)`

#### 2c. 亂碼/損壞

偵測條件：
- 包含 `__NEW_LINE_` 前綴（多行指令殘骸）
- 包含 `???`、亂碼字元（Unicode 損壞）
- Read 路徑包含 `//public function`、`//^##` 等明顯誤觸

#### 2d. 環境變數未解析

偵測 `$HOME`、`$LOCALAPPDATA`、`$USERPROFILE` 等未展開的變數。

#### 2e. Shell 片段殘骸

偵測孤立的 `Bash(fi)`、`Bash(done)`、`Bash(break)`、`Bash(else ...)`、`Bash(do ...)`、`Bash(echo "...")`。

#### 2f. 已失效路徑

對 Read 規則和 additionalDirectories 中的本機路徑，用 Glob 或 ls 確認是否存在。
不存在的標記為失效。

注意：`//var/www/**`、`//tmp/**`、`//dev/**` 等 Linux 路徑不檢查（可能是 Docker 容器內路徑）。

---

### 步驟 3：分析 additionalDirectories

- 找出被更寬路徑涵蓋的子路徑（如 `D:\MCP_Server\tools` 被 `D:\MCP_Server` 涵蓋）
- 找出包含未解析環境變數的路徑
- 找出重複項（正規化大小寫和斜線後比較）

---

### 步驟 4：產出清理報告

以表格呈現分析結果，**不直接修改任何檔案**：

```
📊 Settings 清理分析：

| 設定檔 | allow 規則數 | additionalDirectories |
| ------ | ----------- | -------------------- |
| 全域   | N 條        | N 條                 |
| 專案   | N 條        | N 條                 |

🔍 可清理項目：

1. 已被通配符涵蓋：N 條（可刪除）
2. 可合併為新通配符：N 組（列出建議的通配符）
3. 亂碼/損壞：N 條（可刪除）
4. 環境變數未解析：N 條（可刪除）
5. Shell 片段殘骸：N 條（可刪除）
6. 已失效路徑：N 條（可刪除）
7. additionalDirectories 可清理：N 條

預估瘦身：N 條 → N 條（減少 N%）
```

對每個類別列出具體項目（前 10 條，超過則摘要）。

> 以上清理計畫是否確認？確認後執行重寫。

---

### 步驟 5：執行清理

使用者確認後：

1. 構建清理後的 allow 陣列：
   - 保留所有 MCP 工具規則（`mcp__*`）
   - 保留有效的通配符規則
   - 加入新合併的通配符
   - 移除所有標記刪除的規則
   - 按類別排序：MCP 工具 → Bash 通配符 → Read 通配符 → Web 規則
2. 構建清理後的 additionalDirectories
3. 保留 settings 中的其他欄位（hooks、effortLevel 等）不動
4. 用 Write 工具一次重寫整個檔案

---

### 步驟 6：驗證與報告

重寫後重新讀取檔案，確認 JSON 格式正確，輸出最終報告：

```
✅ Settings 清理完成！

📊 統計：
  allow 規則：N → N 條（減少 N%）
  additionalDirectories：N → N 條

📝 新增通配符：
  - Bash(xxx:*)
  - ...

⚠️ 注意：重啟 Claude Code 後生效。
  若日常操作被攔截提示權限，正常允許即可（會自動追加回來）。
```

---

## 輸出

- 精簡化的 `settings.json`（規則數大幅減少）
- 清理報告（含前後對比統計）

---

## 注意事項

- **先列報告，確認後才改** — 絕不跳過確認步驟直接重寫
- 保留所有 MCP 工具的個別規則（`mcp__*` 不合併為通配符，因為格式不支援）
- 保留所有 WebFetch domain 規則（domain 限制是安全邊界）
- 不動 settings 中非 permissions 的欄位（hooks、effortLevel、enableAllProjectMcpServers 等）
- 對「是否加通配符」保守判斷：`Bash(rm:*)` 和 `Bash(taskkill:*)` 等破壞性指令不建議通配符
- 清理後新操作被攔截是正常的，使用者允許後會自動追加
