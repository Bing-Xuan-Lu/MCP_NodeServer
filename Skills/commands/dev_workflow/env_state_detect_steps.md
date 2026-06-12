# env_state_detect_steps — 動手前先偵測環境/狀態（跨領域共用參考）

> 這是**共用參考檔**，不獨立部署成 `/指令`。由各領域 Skill（PHP 升級/測試、DB 遷移、Python、部署、UI 測試…）在「動手前」引用。
>
> 通則：**很多 MCP 工具都有「當前狀態/設定」，動手前沒先確認就用預設值，會打到錯的目標或 runtime 才爆。** 動任何一類工具前，先跑對應領域那一段把狀態釘住，再帶進工具參數。
>
> 由來：lint 閘曾寫死 PHP 8.4 對 5.x 舊站台整批誤判；同類陷阱在 DB（沒先確認連哪個庫）、Python（容器/套件沒裝）、SFTP（推錯機器）、Browser（沒登入）都會發生。這份把「先確認狀態」標準化成跨領域紀律。

---

## 開場通則

動手前問自己一句：**「這個操作有沒有『當前狀態』？我確認了沒，還是在賭預設值？」** 有就先確認再動。確認結果用一句白話回報使用者（如「目前連的是 X 庫，PHP 用 dev-phpYY 容器」），再開始。

---

## PHP — 哪個版本 / 哪個容器

**該確認**：專案目標 PHP 版本 → 對應容器。**沒確認後果**：舊站用 php84 → `$s{0}`、`mysql_*`、`each()` 等 runtime fatal。

1. 找專案根（`composer.json` / `.git` / `config.php` 那層）。
2. 定版本：`composer.json` 的 `require.php` 最權威；沒有就用 Grep 純文字掃 5.x 專屬寫法（`$\w+\{[0-9]`、`mysql_(connect|query)`、`ereg`、`each\s*\(`、`create_function`、短標籤 `<?`），命中→舊版（≤5.6）；現代乾淨→預設最新，**維持 vs 升級的意圖推不出來時要問**。
3. 挑容器：**動態 `docker ps` + `docker exec <name> php -r "echo PHP_VERSION;"`**（不寫死容器名，跨環境通用），挑「>= 目標版本」中最接近的。可參考 `~/.claude/php-containers-cache.json`（hook 已快取）。
4. 後續 `run_php_*` / `run_php_test` 帶 `container`。lint（`php -l`）不必先偵測，`llm-judge` hook 已用漸進式回退自動處理。

## DB — 現在連的是哪個資料庫

**該確認**：`set_database` 設了沒、連的是哪個庫。**沒確認後果**：`execute_sql` 打到錯的庫，或「未設定連線」報錯空轉。

- 動 `execute_sql` / `execute_sql_batch` / `get_db_schema*` 前，先 `get_current_db` 確認當前連線；沒設或設錯 → `set_database`（或 `load_db_connection` 載既有設定）。
- DB 連線只在當次對話有效，**重啟/換場後一定要重設**，不要假設上一場的連線還在。

## Python — 容器在不在、套件裝了沒

**該確認**：`python_runner` 容器有沒有起來、需要的套件（ffmpeg / faster-whisper）在不在。**沒確認後果**：跑到一半才發現容器沒裝套件、整段重來。

- 用 `run_python_script` 前，需要特定套件（如 `read_video` 的 ffmpeg/whisper）時先確認容器與套件就緒；缺則先 `docker exec python_runner pip install ...`（禁直接在 Bash 跑 `python`/`pip`，那是 Store stub）。

## SFTP / 遠端 — 連的是哪台

**該確認**：用哪個 `sftp_preset`、目標是測試機還是正式機。**沒確認後果**：部署推錯機器，覆蓋線上設定檔。

- 部署/上傳前先確認 preset 與目標主機；環境設定檔（DB 連線、`.env`）禁覆蓋。

## Browser — 登入 session 在不在 / 哪個 page

**該確認**：要測的頁面是否需登入、目前 session/page 狀態。**沒確認後果**：沒登入 → 測試整批失敗或被導去登入頁。

- 跑需登入的 UI 測試前，先 `browser_restore_session` 或確認已登入；page 被關掉先重新 navigate。

---

## 注意事項

- 容器名 / 主機 / DB 一律靠工具動態查（`docker ps`、`get_current_db`、`sftp_preset`），禁寫死、禁賭預設值。
- 「維持現狀 vs 升級/切換」是使用者意圖，查不出來就問，不要自己假設。
- 同一輪對話、同一專案，狀態偵測一次即可沿用，不必每步重跑。
- 本參考只負責「把狀態釘住」，不負責改 code / 跑遷移；那些見各領域主 Skill。
