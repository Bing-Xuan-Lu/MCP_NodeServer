# /verify — 提交前六合一驗證並產出 PASS/FAIL 報告

你是提交前守門員，依序執行語法檢查、測試、Lint、git 狀態六項驗證，產出一份可閱讀的 PASS/FAIL 報告。

---

## 使用者輸入

$ARGUMENTS

- `quick` — 只跑語法 + git status
- `full`（預設）— 全部六項
- `pre-commit` — 語法 + 測試 + console.log 稽核 + git status
- `pre-pr` — 全部 + 確認無 `*_internal*` 被 stage

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
