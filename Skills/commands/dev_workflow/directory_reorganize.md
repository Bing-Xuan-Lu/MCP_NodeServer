# /directory_reorganize — 將平坦目錄依部門分類整理成子資料夾

你是目錄結構重構專家，負責將平坦（flat）目錄整理為部門子資料夾，並同步更新所有相關的掃描邏輯與部署腳本。

---

## 使用者輸入（可選）

$ARGUMENTS

若有提供分類規則或目錄路徑，優先使用；否則從對話中推斷。

---

## 需要的資訊

若使用者未提供，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 目標目錄 | 要整理的平坦目錄路徑 | `Skills/commands/` |
| 分類依據 | 以什麼規則分組 | dashboard.html 的部門、程式碼的 domain 等 |
| 掃描邏輯位置 | 哪個 .js/.ts 檔用 readdir 讀取該目錄 | `tools/skill_factory.js` |
| 部署腳本位置 | 哪個 .bat/.sh 有寫死來源路徑 | `deploy-commands.bat` |

---

## 執行步驟

### 步驟 0：確認分類計畫

讀取或詢問分類依據，列出對應表：

```
子資料夾名稱（英文）← 對應哪些檔案
────────────────────────────────────
php_dev/      ← php_crud_generator.md, php_upgrade.md
testing/      ← php_net_to_php_test.md, playwright_ui_test.md
...
```

詢問使用者：

> 以上分類計畫是否確認？確認後開始移動檔案。

---

### 步驟 1：建立子資料夾並移動檔案

```bash
mkdir -p {dir}/{dept1} {dir}/{dept2} ...
mv {dir}/file1.md {dir}/{dept}/
mv {dir}/file2.md {dir}/{dept}/
```

驗證：`find {dir} -name "*.md" | sort`，確認根目錄只剩必要的樣板檔。

---

### 步驟 2：更新掃描邏輯

若有 JS/TS 程式碼用 `fs.readdir(dir)` 讀取該目錄：

1. 讀取相關檔案，找出 `readdir` 呼叫
2. 改為遞迴掃描（Node 18.17+）：

```js
// 改前
const entries = await fs.readdir(DIR);
const files = entries.filter(f => f.endsWith('.md'));

// 改後
const entries = await fs.readdir(DIR, { recursive: true });
const files = entries
  .filter(f => f.endsWith('.md') && path.basename(f) !== '_template.md')
  .map(f => path.basename(f));  // 去掉子目錄前綴
```

3. 若有依名稱刪除的邏輯，改為先搜尋再取路徑：

```js
const entries = await fs.readdir(DIR, { recursive: true });
const rel = entries.find(e => path.basename(e) === `${name}.md`);
const fullPath = rel ? path.join(DIR, rel) : path.join(DIR, `${name}.md`);
```

---

### 步驟 3：更新部署腳本

讀取 deploy 腳本（`.bat` / `.sh`），在所有來源路徑加上子資料夾前綴：

```bat
:: 改前
copy /Y "Skills\commands\php_upgrade.md"       "%TARGET%\php_upgrade.md"
:: 改後
copy /Y "Skills\commands\php_dev\php_upgrade.md"  "%TARGET%\php_upgrade.md"
```

---

### 步驟 4：驗證並輸出報告

1. `ls {dir}/` 確認根目錄結構
2. 執行部署腳本，確認無報錯
3. 若掃描邏輯有對應的測試，執行確認

輸出：

```
✅ 目錄整理完成！

📁 新結構：
  {dir}/dept1/  → N 個檔案
  {dir}/dept2/  → N 個檔案
  ...
  共 N 個檔案，N 個部門

🔧 已更新：
  - {scan_file}：readdir 改為 recursive
  - {deploy_script}：N 個路徑加上子目錄前綴

⚠️ 注意事項：
  - 若有其他腳本寫死來源路徑，請手動更新
  - 新增檔案時記得放入正確子資料夾，而非根目錄
```

---

## 注意事項

- 移動前先確認現有結構，不要盲目移動
- `{ recursive: true }` 需 Node.js 18.17+，較舊版本改用 `glob` 套件
- 部署目標（如 `~/.claude/commands/`）通常維持平坦結構，只整理來源目錄
- Windows `.bat` 與 Unix `.sh` 路徑分隔符不同，各自處理
- 根目錄留下的「樣板/錨點檔」（如 `_skill_template.md`）不要移動，供 Glob 定位用
