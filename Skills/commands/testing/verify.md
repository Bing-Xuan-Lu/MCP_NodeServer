# /verify — 提交前七合一驗證並產出 PASS/FAIL 報告

你是提交前守門員，依序執行語法檢查、測試、Lint、git 狀態、AI 品質稽核七項驗證，產出一份可閱讀的 PASS/FAIL 報告。

---

## 使用者輸入

$ARGUMENTS

- `quick` — 只跑語法 + git status
- `full`（預設）— 全部七項（含 AI 品質稽核）
- `pre-commit` — 語法 + 測試 + console.log 稽核 + AI 品質稽核 + git status
- `pre-pr` — 全部 + 確認無 `*_internal*` 被 stage

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `run_php_script` | 執行 `php -l` 語法檢查（或透過 Docker `docker exec ... php -l`） |
| `run_php_test` | 執行 PHPUnit 測試套件 |
| `list_files_batch` | 掃描根目錄偵測專案類型（PHP/Node/混合） |
| `read_files_batch` | 批次讀取 `package.json`、`composer.json` 確認測試設定 |
| `tail_log` | 讀取 PHP error log 輔助診斷失敗原因 |

---

## 執行步驟

### 步驟 1：偵測專案類型

掃描根目錄判斷：

| 偵測到 | 類型 |
|--------|------|
| `*.php` + `vendor/` | PHP（PHPUnit）|
| `package.json` + `jest`/`vitest` | Node.js |
| `*.php` + `package.json` | PHP + Node 混合 |
| `docker-compose.yml` + PHP | Docker PHP 環境 |

---

### 步驟 2：執行六項驗證（依模式選擇執行項目）

**① 語法檢查**

```bash
# PHP
php -l {changed_files}
# 或透過 Docker：docker exec {container} php -l {file}

# Node.js
npx tsc --noEmit  # TypeScript
node --check {file}  # 純 JS
```

**② 測試**

```bash
# PHP
php vendor/bin/phpunit --testdox

# Node.js
npm test
npx playwright test  # 若有 E2E
```

**③ Lint**

```bash
# PHP
php vendor/bin/phpcs --standard=PSR12 {changed_files}  # 若有安裝

# Node.js
npm run lint  # 若有設定
```

**④ Console.log / var_dump 稽核**

```
Grep pattern="console\.log|var_dump|print_r|dd\(" 在所有變更檔案中
→ 列出非 test 目錄的結果
```

**⑤ Git Status**

```
git_status → 列出 staged / unstaged / untracked
git_diff → 確認最終變更摘要
```

**⑥（pre-pr 模式）敏感檔案確認**

```
確認 .env / *_internal* 未被 stage
確認 node_modules / vendor 未被 stage
```

**⑦ AI 品質稽核**（`full` / `pre-commit` 模式）

掃描變更檔案中 AI 生成程式碼的三類隱性問題：

#### A. 幻覺偵測（呼叫不存在的定義）

```
Grep pattern="function \w+\(" 在變更的 PHP/JS 檔案中，收集所有被呼叫的函數名稱
→ 確認每個呼叫在專案中有對應定義（同檔 or require/import）
→ 只在 git diff 呼叫端出現、但整個專案中找不到定義 → 標記 [HALLUCINATION?]

同理掃描 new ClassName() → 確認 class 在 use/require 中有引入
```

#### B. 硬編碼佔位符偵測

```
Grep pattern="password.*=.*['\"](?!.*\$)|TODO|FIXME|placeholder|example@|test123|admin123"
→ 排除 .env、config 範本、test 目錄
→ 在業務邏輯檔案中出現 → 標記 [HARDCODE?]
```

#### C. 語意漂移偵測（同名函數定義不一致）

```
Grep pattern="function {changed_function_name}" 全域搜尋
→ 若同名函數在多個檔案出現，比對參數數量是否一致
→ 不一致 → 標記 [DRIFT?]
```

> 注意：以上結果需人工確認，AI 無法保證判斷正確——標記 [?] 表示「值得人工看一眼」，不等同 FAIL。

---

### 步驟 3：產出報告

```
VERIFICATION: [PASS / FAIL]
============================
專案類型：{PHP / Node.js / 混合}
執行模式：{quick / full / pre-commit / pre-pr}

① 語法：     [OK / FAIL — N 個錯誤]
② 測試：     [OK — N/N passed / FAIL — N failed]
③ Lint：     [OK / N issues / 未設定（略過）]
④ 偵錯輸出： [OK / N 個 console.log/var_dump]
⑤ Git：      [staged: N / unstaged: N / untracked: N]
⑥ 敏感檔：  [OK / ⚠️ {filename} 不應被 stage]
⑦ AI 品質： [OK / ⚠️ HALLUCINATION? N 處 / HARDCODE? N 處 / DRIFT? N 處]

============================
可提交：[YES / NO]

需修正：
  - {具體問題}
```

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| PHP syntax check 找不到 php | 不在 Docker 容器內 | 改用 MCP `run_php_script` 或 `docker exec` |
| PHPUnit 找不到 | vendor 未安裝 | `composer install` |
| npm test 失敗 | node_modules 未安裝 | `npm install` 後重試 |

---

## 注意事項

- 若某項工具不存在（如 PHPUnit 未安裝），標記「未設定（略過）」而非失敗
- 只掃有變更的檔案（git diff），不跑整個專案的全量掃描
- Docker 環境：PHP 語法檢查需在容器內執行

## 禁止的目標替換行為（Reward Hacking 防護）

驗證的目的是**如實反映程式碼品質**，而非讓報告看起來通過：

- ❌ 語法錯誤無法修復 → 不得跳過或標 OK
- ❌ 測試失敗 → 不得刪除測試、修改斷言期望值、或 catch exception 讓它靜默通過
- ❌ `⑦ AI 品質` 發現硬編碼 → 不得自行修改程式碼後重跑讓結果變 OK，應標 FAIL 回報

正確做法：**如實記錄所有失敗項目，報告 FAIL，等使用者決定如何修復。**
