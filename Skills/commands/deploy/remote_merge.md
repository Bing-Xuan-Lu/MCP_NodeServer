---
name: remote_merge
description: "從測試機合併（非覆蓋）特定檔案回本機，自動保留本地未提交改動。當使用者說「從測試機合併回來」「保留我的改動跟遠端合」「三方合併遠端檔」「merge 遠端不要蓋掉我的」時使用。"
---

# /remote_merge — 從測試機三方合併特定檔回本機（保留本地改動）

你是部署維運工程師。當測試機上某些檔被同事直接改過、而本機這些檔又有你尚未提交的改動時，用**三方合併（非覆蓋）**把兩邊併起來：自動合不衝突的部分、只標出真正撞在同一行的衝突，並保留本地檔原本的換行慣例。等同 WinMerge 三方合併的命令列版。

---

## 背景

- `sftp_pull` 是**直接覆蓋**（會蓋掉本地未提交改動）；`remote_diff` 只**看差異不動手**。當「遠端有同事改動」與「本地有自己改動」同時存在、又想兩邊都保留時，兩者都不適用——這正是本 Skill 的位置。
- 合併核心用 `git merge-file`（git 內建三方合併，等同 WinMerge）：以本機**工作目錄現檔**為「我方」、**git HEAD 版**為「共同祖先」、**遠端下載版**為「他方」。不衝突自動併、衝突標 `<<<<<<< ======= >>>>>>>`。
- **EOL 偵測一律用 node（數位元組 CR=13 / LF=10）**，禁用 `grep -c $'\r'`——Git Bash 下該指令回傳值忽 0 忽 N 不可靠，曾害人 sed→沒效→再 node 繞三四輪。
- **合併前三邊先 pre-normalize 成 LF**：本機（常 CRLF）、遠端下載版（常 LF）、git HEAD 版三邊的 EOL 通常不一致。`git merge-file` 是逐行比對，只要某行在三邊間有 CR 之差就整行被當「兩邊都改過」→ 整檔變假衝突。先把三邊各剝成純 LF 副本再合併，合併後再依步驟 4 偵測到的本機 EOL 還原（步驟 6）。只 post-normalize merged 救不了——假衝突在合併當下就已產生。

---

## 需要的資訊

| 參數 | 說明 | 範例 |
|------|------|------|
| 目標檔案 | 要合併的檔（可多個，相對 repo 根） | `admin/modules/order/list.php` |
| 測試機來源 | SFTP host / port / user / 密碼或私鑰 | `192.168.1.100` |
| 遠端專案根 | 遠端 repo 根目錄 | `/var/www/html_{project}` |
| 本機 repo | 本機 Git 專案路徑 | `{ProjectFolder}` |

> **測試機目標先查 project memory**（`reference_environments.md` 等記憶檔的「測試機 / 部署目標」欄）。記憶有就直接帶入，**別再多問使用者一輪**；記憶沒寫才問。

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `git_status` | 確認本機目標檔有未提交改動（沒有就不需合併，改用 sftp_pull） |
| `sftp_connect` | 建立 SFTP 連線 |
| `sftp_download` | 下載遠端版到暫存（他方） |
| `read_file` / `create_file` | 讀寫合併結果 |
| `file_diff` | 顯示合併結果差異供 review |
| Bash `git show` / `git merge-file` | 取 HEAD 共同祖先 + 三方合併（MCP git 工具不支援，走 Bash） |
| Bash `node` | EOL 偵測與正規化（禁 `grep -c $'\r'`） |

---

## 執行步驟

### 步驟 1：確認合併計畫 + 鎖定測試機目標

列出計畫；**測試機來源先查 project memory，記憶有就帶入不再問**：

```
三方合併計畫：
  目標檔：{files}
  我方（保留）：本機工作目錄現檔（含未提交改動）
  共同祖先：git HEAD 版
  他方（併入）：{user}@{host}:{remote_root}/{files}
  暫存：D:\tmp\{ProjectFolder}_remote\
```

先用 `git_status` 確認這些檔本機確實有未提交改動：

- 有 → 需要三方合併（繼續）。
- 沒有 → 直接 `/sftp_pull` 覆蓋即可，不必合併（告知使用者）。

> 確認後開始。

---

### 步驟 2：下載遠端版到暫存（他方）

```
sftp_connect(host, port, user, password/key)
sftp_download("{remote_root}/{file}", "D:/tmp/{ProjectFolder}_remote/{file}")
→ 每個目標檔各下載一份遠端版當「他方」
```

---

### 步驟 3：取共同祖先（git HEAD 版）

對每個檔，從 git 取出 HEAD 版當 base（MCP git 不支援 show，走 Bash）：

```bash
git -C "D:/Project/{ProjectFolder}" show HEAD:"{relpath}" > "D:/tmp/{ProjectFolder}_remote/{file}.base"
```

- 檔案在 HEAD 不存在（本地新檔）→ 用空檔當 base（`: > base`）。

---

### 步驟 4：偵測本地 EOL（用 node 數位元組，禁 grep -c $'\r'）

記下本機目標檔原本的換行慣例，合併後要還原：

```bash
node -e "const b=require('fs').readFileSync(process.argv[1]);let cr=0,lf=0;for(const x of b){if(x===13)cr++;else if(x===10)lf++;}console.log(cr>0&&cr>=lf?'CRLF':'LF')" "本機目標檔路徑"
→ 輸出 CRLF 或 LF（記住，步驟 6 用）
```

**為什麼不用 `grep -c $'\r'`**：Git Bash 下該指令回傳值忽 0 忽 N 不可靠，會誤導後續正規化。用位元組計數（CR=13、LF=10）才穩。

---

### 步驟 5：先 pre-normalize 三邊成 LF，再 git merge-file

**先把三邊各剝成純 LF 副本（`.lf`）再合併。** git merge-file 逐行比對，三邊（本機 CRLF／遠端 LF／git HEAD）EOL 不一致時每行都被當「兩邊都改」→ 整檔假衝突。原檔不動，合併用 `.lf` 副本，合併後步驟 6 再還原本機 EOL。

```bash
# (1) 三邊各產生一份純 LF 副本（byte-faithful 只剝 CR=13，不經文字編碼）
node -e "const fs=require('fs');for(const p of process.argv.slice(1)){const b=fs.readFileSync(p);const o=[];for(const x of b)if(x!==13)o.push(x);fs.writeFileSync(p+'.lf',Buffer.from(o));}" "本機目標檔" "{file}.base" "D:/tmp/{ProjectFolder}_remote/{file}"

# (2) 用三邊的 .lf 副本做三方合併（原檔不動）
git merge-file -p "本機目標檔.lf" "{file}.base.lf" "D:/tmp/{ProjectFolder}_remote/{file}.lf" > "{file}.merged"
echo "conflicts=$?"
```

- **(1) pre-normalize 只統一 EOL 給合併用，不動原檔**；merged 出來是純 LF，步驟 6 才依步驟 4 偵測到的本機 EOL 還原。
- `-p` 把結果輸出到 stdout（先不就地改檔）。
- exit code = 衝突數：`0` = 全自動併乾淨；`>0` = 有真衝突，merged 檔內含 `<<<<<<< ======= >>>>>>>` 標記。
- 「我方」放第一個參數（`.lf`）→ 本地未提交改動被保留為主，遠端改動併入其上。

---

### 步驟 6：還原 EOL 並寫回

用步驟 4 偵測到的 EOL 正規化 merged（先剝掉所有 CR，再依需要補 CRLF），byte-faithful，不用 sed：

```bash
node -e "const fs=require('fs');const p=process.argv[1],eol=process.argv[2];const b=fs.readFileSync(p);const out=[];for(let i=0;i<b.length;i++){if(b[i]===13)continue;if(b[i]===10&&eol==='CRLF'){out.push(13,10);}else out.push(b[i]);}fs.writeFileSync(p,Buffer.from(out))" "{file}.merged" "{步驟4偵測到的EOL}"
```

再把 `{file}.merged` 覆蓋回本機目標檔（無衝突直接覆蓋；有衝突也寫回，讓使用者就地解標記）。

---

### 步驟 7：列衝突供裁決（有衝突才需要）

- **無衝突**：報「全自動併入，0 衝突」。
- **有衝突**：用 `file_diff` 或讀 merged 檔，逐處列出衝突區塊行號 + 我方／他方兩邊內容，請使用者就地編輯解掉 `<<<<<<<` 標記。**不自動裁決、不自動 commit。**

---

### 步驟 8：產出報告

```
✅ 三方合併完成！

📊 合併結果：
  目標檔：{files}
  我方（本地未提交改動）：已保留
  他方（測試機改動）：N 處自動併入
  共同祖先：git HEAD
  EOL：{CRLF/LF}（已還原）

⚠️ 需人工裁決的真衝突：
  - {file} L{n}-{m}：本地「…」 vs 測試機「…」
  （無衝突時這段省略）

📝 後續：
  - 檢視合併結果，解掉任何 <<<<<<< 標記
  - 自行 git commit（本 Skill 不自動 commit）
```

---

## 輸出

- 本機目標檔已就地更新為「本地改動 + 測試機改動」的三方合併結果
- 換行慣例與原檔一致（CRLF/LF 已還原）
- 衝突清單（若有），含行號與兩邊內容
- 暫存 `D:\tmp\{ProjectFolder}_remote\` 保留供參考（用完可刪）

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| EOL 偵測忽 0 忽 N | 用了 `grep -c $'\r'`（Git Bash 不可靠） | 改用步驟 4 的 node 位元組計數 |
| 合併後整檔變一團 / 全是衝突 | ① 三邊 EOL 不一致（步驟 5 已 pre-normalize 解決；若仍發生，確認三邊 `.lf` 副本有生成且 merge-file 吃的是 `.lf`）② base 選錯：遠端部署版與本機 HEAD 差太遠 | EOL 已自動處理；若屬 base 問題，確認遠端從哪個 commit 部署，必要時用該 commit 當 base |
| 中文或內容變亂碼 | node 讀寫用了轉碼而非 byte 保真 | 步驟 6 用 Buffer 逐位元組處理，不經文字編碼 |
| 目標是圖片／壓縮檔 | 二進位檔不能三方合併 | 改用 `/sftp_pull` 取單檔 |

---

## 注意事項

- **不自動 commit**：合併完留在工作目錄，讓使用者 review 後自行提交。
- **設定檔不合併**：`config.php` / `.env` / DB 連線等，沿用部署保護原則，只提示不動。
- **base = git HEAD 是近似共同祖先**：實務可用；若遠端與 HEAD 差異大，衝突會變多。
- **測試機目標先查 project memory 再問**：記憶已寫部署目標就直接用，避免多問一輪。
- 暫存目錄 `D:\tmp\{ProjectFolder}_remote\` 不自動清，用完可刪。

**相關技能：**

- 直接覆蓋式拉回（不保留本地改動）→ `/sftp_pull`
- 只看差異不合併 → `/remote_diff`
- 把本機推上測試機 → `/sftp_deploy`
