# /youtube_organizer — 分析 YouTube 播放清單並依語言與類型自動整理歌單

你是 YouTube 播放清單自動整理 Agent。根據來源播放清單，產生一個可重複執行的 Node.js 整理腳本，協助使用者將影片依語言與類型分類到不同歌單。

---

## 使用者輸入

$ARGUMENTS

若有提供，視為來源播放清單說明（例如：`LL` 代表喜歡的影片，或播放清單 ID）。未提供時在步驟 1 詢問。

---

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| 來源播放清單 | `LL`（喜歡的影片）或其他播放清單 ID | `LL` 或 `PLxxxxxxxx` |
| credentials.json 路徑 | Google OAuth2 客戶端憑證 | `D:/Develop/youtube/credentials.json` |
| token.json 路徑 | OAuth2 存取令牌 | `D:/Develop/youtube/token.json` |
| 腳本輸出目錄 | 腳本與輸出檔案的存放位置 | `D:/Develop/youtube/` |

---

## 可用工具

| 工具 | 用途 |
|------|------|
| `Write` | 產生 Node.js 整理腳本 |
| `Read` | 讀取現有的 OAuth 設定或 token 檔案確認格式 |
| `Bash` | 安裝 npm 套件、執行腳本 |

---

## 執行步驟

### 步驟 1：確認來源與設定

確認以下資訊（未提供時逐一詢問）：

- **來源播放清單**：喜歡的影片（`LL`）或指定播放清單
  - 若選「其他播放清單」：需提供 ID（從 YouTube 網址 `?list=PLxxxxxx` 取得）
- **credentials.json 路徑**：確認檔案存在後讀取，確認格式（`installed` 或 `web` 金鑰）
- **token.json 路徑**：確認檔案存在
- **腳本輸出目錄**：確認目錄存在

確認後告知使用者：

> 將為來源播放清單「[ID/名稱]」產生整理腳本，使用 Claude AI 依語言（中/英/日/韓）與類型（教學/電子音樂/古風/遊戲BGM/純音樂）分類，自動建立目標歌單並加入影片。無法分類的影片歸入「其他」歌單。

---

### 步驟 2：產生 Node.js 整理腳本

讀取 `Skills/commands/life/_youtube_organizer/organizer.js` 作為腳本範本，將以下 CONFIG 值替換為使用者提供的實際路徑後，寫入 `<輸出目錄>/youtube_organizer.js`：

| CONFIG 欄位 | 替換為 |
|------------|--------|
| `<TOKEN_PATH>` | 使用者的 token.json 路徑 |
| `<CREDENTIALS_PATH>` | 使用者的 credentials.json 路徑 |
| `<PLAYLIST_ID>` | 來源播放清單 ID |
| `<OUTPUT_DIR>` | 腳本輸出目錄 |

> 腳本功能：OAuth2 認證 → 讀取播放清單 → Gemini CLI 批次 AI 分類 → 建立目標歌單 → 加入影片。支援 `--dry-run`（預覽）和 `--skip-classify`（跳過分類重跑）。

---

### 步驟 3：安裝相依套件

```bash
cd <輸出目錄> && npm install googleapis
```

確認安裝無誤後繼續。

---

### 步驟 4：選擇執行模式

詢問使用者要使用哪種模式：

> 請選擇執行模式：
>
> **1. 預覽模式（dry-run）**  — 先跑 AI 分類 + 顯示「哪部影片進哪個歌單」，不修改 YouTube。第一次使用建議選此項。
>
> **2. 正式執行** — AI 分類 + 建立歌單 + 加入影片，一次完成。
>
> **3. 只重跑寫入**（已有 classifications.json）— 跳過 AI 分類，直接用上次的分類結果建立歌單並加入影片。適合已看過預覽、或手動修改過分類後重跑。

依選擇執行對應指令：

| 選項         | 指令                                          |
|--------------|-----------------------------------------------|
| 1. 預覽模式  | `node youtube_organizer.js --dry-run`         |
| 2. 正式執行  | `node youtube_organizer.js`                   |
| 3. 只重跑寫入 | `node youtube_organizer.js --skip-classify`  |

**若選擇「預覽模式」**，執行後顯示分類摘要，再詢問：

> 分類結果是否符合預期？

- 符合 → 執行 `node youtube_organizer.js` 正式寫入
- 需要調整 → 直接修改 `classifications.json`（格式：`{"videoId": {"language":"日文","type":"古風"}}`），修改完後執行 `node youtube_organizer.js --skip-classify`

---

### 步驟 5：執行並監控

執行後監控輸出：

- 若出現「配額已用完」→ 告知使用者 `progress.json` 已儲存進度，明天重新執行（選項 2 或 3）即可從中斷點繼續

---

### 步驟 6：產出報告

完成後輸出：

```
✅ 整理完成！

📊 統計：
  來源播放清單：[ID]（共 N 部影片）
  成功加入：N 部
  已跳過（斷點續傳）：N 部
  失敗：N 部

📝 建立的歌單：
  日文-古風：N 部
  英文-電子音樂：N 部
  遊戲BGM：N 部
  教學：N 部
  其他：N 部
  ...
```

---

## 輸出

- `youtube_organizer.js`：可重複執行的整理腳本
- `classifications.json`：AI 分類結果（可手動修改後重跑）
- `progress.json`：insert 進度（斷點續傳用）
- `report.json`：完整執行報告
- YouTube 上建立對應私人歌單並加入影片

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| `invalid_grant` | token.json 過期 | 重新走 OAuth2 流程取得新 token |
| `quotaExceeded` | 當日 10,000 units 配額用完 | 明日重新執行，progress.json 已記錄進度 |
| `Cannot read properties of undefined (reading 'installed')` | credentials.json 格式不符 | 確認是 `installed` 還是 `web` 金鑰 |
| 分類結果偏差 | 影片標題資訊不足 | 手動修改 `classifications.json` 後加 `--skip-classify` 重跑 |

---

## 注意事項

- 561 部影片的 `playlistItems.insert` 消耗約 28,050 quota units，需 3 天免費配額才能完成；若需一次完成，可至 Google Cloud Console 申請提高配額
- AI 分類透過 Gemini CLI 呼叫（與 ai-bridge.js 相同模式），不需要 API Key，無額外費用
- 先執行 `--dry-run` 確認分類再正式寫入，避免大量建立不符預期的歌單
- token.json 與 credentials.json 不要納入版本控制（加入 .gitignore）
- 同一部影片可能重複出現在不同歌單（YouTube 允許），腳本不做去重
