# /skill_audit — 審查 Skill 耦合與重疊，建議合併或淘汰

你是技能庫審計師，系統性掃描所有已部署的 Skills，找出功能重疊、命名混淆、可合併的技能，產出優先行動清單。

適用時機：技能越來越多但不知道用哪個、懷疑有重複功能、定期清理技能庫時。

---

## 執行步驟

### 步驟 1：掃描所有已部署技能

讀取所有 Skill 的標題與說明：

```bash
# 取得每個 Skill 的第一行（標題）
grep -h "^# /" ~/.claude/commands/*.md 2>/dev/null | sort
```

同時取得 Skills/commands/ 的完整子資料夾結構（確認有無遺漏未部署的 Skill）：

```bash
find {MCP_ROOT}/Skills/commands -name "*.md" | grep -v "_skill_template" | sort
```

**格式健康檢查（新增）：**

```bash
# D — 找出標題不符合 "# /name —" 格式的已部署檔案（格式異常 = 不被 grep 偵測到）
for f in ~/.claude/commands/*.md; do
  first=$(head -1 "$f" 2>/dev/null)
  echo "$first" | grep -qE "^# /[a-z_]+ —" || echo "❌ $(basename $f): $first"
done

# E — 找出誤部署的伴隨參考檔（_steps.md 結尾的不應獨立部署）
ls ~/.claude/commands/*_steps.md 2>/dev/null && echo "⚠️ 上列為伴隨參考檔，不應出現在 commands/"
```

---

### 步驟 2：分組與相似度分析

將技能依操作對象分組，識別以下三種問題模式：

**A — 功能重疊（最優先）**
- 操作對象相同（如都處理 PHP CRUD、都操作 Docker）
- 流程步驟超過 50% 相同
- 差異僅在參數或輸入格式不同

**B — 命名混淆**
- 兩個技能看名稱無法分辨差異
- 沒有清楚的「何時用 A 而不是 B」說明
- 說明行（`# /name — 說明`）沒有回答觸發條件

**C — 使用率偏低**
- 技能描述過於特定（難以泛用）
- 與其他技能相比差異不足以支撐獨立存在

**D — 標題格式異常（新增）**

- 第一行不是 `# /skill-name — 說明` 格式
- 後果：`grep "^# /"` 掃描時完全隱形，skill_audit 偵測不到
- 常見原因：舊版 Skill 未按範本撰寫、手動建立未遵守格式

**E — 誤部署的伴隨參考檔（新增）**

- `~/.claude/commands/` 中出現 `*_steps.md`（或其他輔助說明檔）
- 後果：佔用技能名額，卻無法被觸發執行
- 應只存在於 `Skills/commands/`，由主 Skill 引用即可

**F — 公開 Skill 誤放位置**

- 技能名稱含 `_internal` 後綴，卻存放在 `Skills/commands/{dept}/`（非 `_internal/` 資料夾）
- 或：技能內容含客戶真實資訊（專案名、資料表名），卻未放在 `_internal/`
- 後果：客戶資訊外洩進版控；佔用公開技能名額（上限 60 個）
- 偵測指令：

```bash
# F — 找出誤放在公開部門的 _internal 命名 Skill
find {MCP_ROOT}/Skills/commands -name "*_internal*.md" | grep -v "/_internal/"
```

---

### 步驟 3：產出審計報告

```
📋 Skill 耦合審計報告

📊 統計：
  已部署技能：N 個（上限 60 個，目前使用率 N%）
  疑似重疊：X 組
  命名混淆：Y 個
  標題格式異常：D 個（對 skill_audit 掃描不可見）
  誤部署參考檔：E 個
  誤放公開部門的私有 Skill：F 個
  建議動作：Z 個

🔍 詳細分析：

【重疊組 1】問題類型：A — 功能重疊
  /skill_a — 說明 A
  /skill_b — 說明 B
  重疊點：兩者都用於...，步驟幾乎相同
  建議：將 B 合併入 A（在 A 加入 [模式參數]）
  優先：高

【命名混淆 1】問題類型：B — 命名混淆
  /skill_c — 說明 C
  /skill_d — 說明 D
  混淆點：名稱相近，難以判斷何時用哪個
  建議：改善 skill_c 的說明行，加入「當 X 時用此，當 Y 時改用 /skill_d」
  優先：中

📝 行動清單（依優先排序）：
| 優先 | 動作 | 技能 | 說明 |
|------|------|------|------|
| 高   | 合併 | /b → /a | 重疊度 >70% |
| 中   | 改說明 | /c | 觸發條件不清楚 |
| 低   | 觀察 | /d | 偶有差異但可保留 |
```

---

### 步驟 4：執行選定的行動

詢問使用者要處理哪些條目（可一次選多個）。依使用者指示：

**合併（將 B 併入 A）**：
1. 讀取 A 和 B 的完整內容
2. 將 B 的差異功能作為新模式整合進 A
3. 刪除 B 的 MD 檔（`Skills/commands/{dept}/B.md`）
4. 刪除 B 的部署檔（`~/.claude/commands/B.md`）
5. 更新 dashboard.html：移除 B 的 tag，dept-count -1，totals -1
6. 重新部署 A（`cp ... ~/.claude/commands/A.md`）

**改善說明行**：
1. 用 Edit 工具修改目標 Skill 的第一行
2. 更新 dashboard.html 的 JS SKILLS desc
3. 重新部署

**刪除（功能已廢棄）**：
1. 刪除 MD 檔與部署檔
2. 更新 dashboard.html（移除 tag + 更新計數）

**修正標題格式（D 類問題）**：

選項一 — 逐一修正（適合 1～3 個檔案）：

1. Read source 檔（`Skills/commands/{dept}/skill.md`）
2. Edit 第一行，改為 `# /skill-name — 說明`
3. cp 更新後的檔案到 `~/.claude/commands/`

選項二 — 批次修正（適合 4 個以上）：

```python
# 用 run_python_script 一次修正全部格式異常的 Skill
# 傳入 anomalies：[{"source": "...", "deployed": "...", "correct_title": "# /xxx — 說明"}]
import shutil
for item in anomalies:
    lines = open(item["source"], encoding="utf-8").readlines()
    lines[0] = item["correct_title"] + "\n"
    open(item["source"], "w", encoding="utf-8").writelines(lines)
    shutil.copy(item["source"], item["deployed"])
print("批次修正完成")
```

詢問使用者對每個格式異常的 Skill 確認正確標題後執行。

**移除誤部署參考檔（E 類問題）**：

1. `rm ~/.claude/commands/*_steps.md`（只刪 deployed，保留 source）
2. 確認 source 檔仍存在於 `Skills/commands/{dept}/`

**私有化（F 類問題 — 公開 Skill 誤放位置）**：

1. `mv Skills/commands/{dept}/skill_internal.md Skills/commands/_internal/skill_internal.md`
2. `rm ~/.claude/commands/skill_internal.md`（刪除已部署的公開版本）
3. 確認 dashboard.html 無該技能 tag（私有 Skill 不列入 dashboard）；若有則移除並更新計數
4. 確認 `Skills/commands/_internal/` 已被 `.gitignore` 排除

---

### 步驟 5：完成報告

```
✅ Skill 審計完成

📊 處理結果：
  合併：N 組（刪除 N 個技能）
  說明改善：N 個
  保留觀察：N 個

📦 目前 Skill 總數：N 個（上限 60 個）

⚠️ 請重啟 Claude Code 讓變更生效
```

---

## 注意事項

- 不自動刪除，所有刪除動作必須經使用者確認
- `_internal` Skill 也列入分析，但不計入公開技能上限（60 個）；存放於 `Skills/commands/_internal/`，**可自由寫入客戶真實資訊**（不受佔位符規範限制）
- 合併後被刪除的技能，在 dashboard.html 計數 -1（section-total 和 header 都要更新）
- 若步驟 4 需要大量修改，建議配合 `/learn_claude_skill 改進 {skill}` 處理細節
- **Zero-byte 保護**：步驟 4 的所有 `cp` 操作前，確認來源檔案非空（`wc -c source.md` 應 > 0），避免空檔案覆蓋正式部署
- **建議排程**：每次執行 `/github_skill_import` 引入外部技能後，應執行一次審計，確認新技能不與現有技能重疊
