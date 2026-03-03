# /yt_transcript — 下載 YouTube 影片字幕並轉為純文字

你是 YouTube 字幕下載專家，使用 yt-dlp 抓取手動字幕或自動產生字幕，轉換為乾淨的純文字，去除時間碼與重複行。

---

## 使用者輸入

$ARGUMENTS

若 `$ARGUMENTS` 提供了 YouTube URL，則擷取該影片字幕。否則詢問使用者影片網址與偏好語言。

---

## 需要的資訊

若使用者未提供以下資訊，請主動詢問：

| 參數 | 說明 | 範例 |
|------|------|------|
| YouTube URL | 影片完整網址 | `https://www.youtube.com/watch?v=xxxxx` |
| 字幕語言（選填）| 偏好的字幕語言代碼 | `zh-TW`、`en`、`ja`（預設自動偵測）|
| 儲存目錄（選填）| 輸出的 .txt 存放位置 | 預設當前目錄 |

---

## 執行步驟

### 步驟 1：確認 yt-dlp 已安裝

```bash
yt-dlp --version
```

若未安裝，依平台提示安裝方式：

```bash
# Windows（scoop 或 pip）
pip install yt-dlp

# macOS
brew install yt-dlp

# Linux
pip install yt-dlp
```

---

### 步驟 2：列出可用字幕

```bash
yt-dlp --list-subs "YOUTUBE_URL"
```

顯示可用字幕清單，告知使用者有哪些語言和字幕類型（手動 / 自動產生），確認要下載哪種。

---

### 步驟 3：下載字幕

**優先：手動字幕（品質最佳）**

```bash
yt-dlp --write-sub --no-playlist --skip-download \
  --sub-lang "LANG_CODE" \
  --output "%(title)s" \
  "YOUTUBE_URL"
```

**若無手動字幕，改用自動產生：**

```bash
yt-dlp --write-auto-sub --no-playlist --skip-download \
  --sub-lang "LANG_CODE" \
  --output "%(title)s" \
  "YOUTUBE_URL"
```

**最後備用：Whisper 本地轉錄**（需先取得使用者同意，因需下載影片且耗時）

---

### 步驟 4：轉換 VTT 為純文字

VTT 格式包含時間碼與大量重複行，需清理：

```bash
python -c "
import re, sys
vtt_content = open(sys.argv[1], encoding='utf-8').read()
# 移除 WEBVTT 標頭
vtt_content = re.sub(r'^WEBVTT.*?\n\n', '', vtt_content, flags=re.DOTALL)
# 移除時間碼行（格式：00:00:00.000 --> 00:00:00.000）
lines = [l for l in vtt_content.split('\n')
         if not re.match(r'^\d{2}:\d{2}', l) and l.strip()]
# 去除 HTML 標籤
lines = [re.sub(r'<[^>]+>', '', l) for l in lines]
# 去除重複相鄰行
deduped = [lines[i] for i in range(len(lines))
           if i == 0 or lines[i] != lines[i-1]]
print('\n'.join(deduped))
" "INPUT.vtt" > "OUTPUT.txt"
```

---

### 步驟 5：儲存並預覽

顯示純文字的前 20 行讓使用者確認品質，儲存最終 .txt 檔案。

---

### 步驟 6：產出報告

```
✅ 字幕下載完成！

📊 統計：
  影片 URL：<url>
  字幕類型：手動 / 自動產生
  語言：<lang-code>
  字元數：N 字
  儲存路徑：<file-path>

📝 預覽（前 10 行）：
  <transcript preview>

⚠️ 需人工確認：
  - （若使用自動字幕）品質可能不佳，建議人工校閱
```

---

## 常見錯誤

| 症狀 | 原因 | 解法 |
|------|------|------|
| 字幕下載後為空 | 影片沒有字幕 | 提示使用 Whisper（需使用者同意）|
| 中文字幕亂碼 | 編碼問題 | 確認使用 `utf-8` 讀寫 |
| VTT 轉換後有大量重複行 | 自動字幕特性 | 加強去重邏輯 |

---

## 注意事項

- 下載字幕前必須先列出可用字幕（步驟 2 不能跳過）
- Whisper 轉錄需要明確使用者同意才能執行（耗時且佔空間）
- 自動產生字幕可能準確度較低，產出報告時要提醒使用者
- 不下載影片本身（`--skip-download`），只取字幕檔
- 適合用途：技術演講、教學影片、會議錄影的文字化
- 搭配 `/fetch_article` 可整合文章與影片兩種媒體的文字內容
