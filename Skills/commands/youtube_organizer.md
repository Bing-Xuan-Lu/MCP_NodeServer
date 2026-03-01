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

將以下腳本寫入 `<輸出目錄>/youtube_organizer.js`，並依使用者提供的路徑填入 CONFIG 區設定值。

```javascript
/**
 * youtube_organizer.js
 * YouTube 播放清單自動整理腳本
 *
 * 使用方式：
 *   node youtube_organizer.js              # 正式執行
 *   node youtube_organizer.js --dry-run    # 只分類不寫入 YouTube
 *   node youtube_organizer.js --skip-classify  # 跳過分類（用現有 classifications.json）
 */

const { google } = require('googleapis');
const { spawn }  = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ============================================================
// Gemini CLI 呼叫（移植自 ai-bridge.js，不需要 API Key）
// ============================================================
const CLI_TIMEOUT = 120000;

function callCLI(command, args, prompt) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `yt-org-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf-8');

    let fd;
    try { fd = fs.openSync(tmpFile, 'r'); } catch (e) { return reject(e); }

    const proc = spawn(command, args, {
      stdio: [fd, 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env }
    });
    fs.closeSync(fd);

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      try { fs.unlinkSync(tmpFile); } catch {}
      reject(new Error(`${command} 超時 (${CLI_TIMEOUT / 1000}s)`));
    }, CLI_TIMEOUT);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', err => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
      reject(new Error(`找不到 ${command}：${err.message}`));
    });

    proc.on('close', code => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch {}
      const result = stdout.trim();
      if (result) {
        resolve(result);
      } else {
        reject(new Error(`${command} 無輸出 (exit ${code}): ${stderr.substring(0, 300)}`));
      }
    });
  });
}

async function askGemini(prompt) {
  try {
    return await callCLI('gemini', [], prompt);
  } catch (err) {
    if (err.message.includes('找不到')) throw err;
    console.warn('  gemini stdin 失敗，改用 -p 模式...');
    return await callCLI('gemini', ['-p', prompt.substring(0, 8000)], '');
  }
}

// ============================================================
// 設定區（依照環境修改）
// ============================================================
const CONFIG = {
  tokenPath: '<TOKEN_PATH>',
  credentialsPath: '<CREDENTIALS_PATH>',
  sourcePlaylistId: '<PLAYLIST_ID>',
  outputDir: '<OUTPUT_DIR>',
  batchSize: 30,

  getPlaylistName(language, type) {
    if (type === '教學' || type === '非音樂') return type;
    if (type === '其他') return '其他';
    return `${language}-${type}`;
  }
};

// ============================================================
// OAuth2 認證
// ============================================================
async function authenticate() {
  const creds = JSON.parse(fs.readFileSync(CONFIG.credentialsPath));
  const { client_secret, client_id, redirect_uris } =
    creds.installed || creds.web;
  const oAuth2Client = new google.auth.OAuth2(
    client_id, client_secret, redirect_uris[0]
  );
  oAuth2Client.setCredentials(
    JSON.parse(fs.readFileSync(CONFIG.tokenPath))
  );
  return oAuth2Client;
}

// ============================================================
// Phase 2：讀取播放清單
// ============================================================
async function fetchPlaylistVideos(youtube, playlistId) {
  const videos = [];
  let pageToken = null;

  do {
    const res = await youtube.playlistItems.list({
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: 50,
      pageToken
    });
    for (const item of res.data.items) {
      videos.push({
        videoId: item.contentDetails.videoId,
        title: item.snippet.title,
        description: (item.snippet.description || '').substring(0, 150)
      });
    }
    pageToken = res.data.nextPageToken;
    console.log(`  已讀取 ${videos.length} 部...`);
  } while (pageToken);

  return videos;
}

async function enrichVideoDetails(youtube, videos) {
  for (let i = 0; i < videos.length; i += 50) {
    const chunk = videos.slice(i, i + 50);
    const res = await youtube.videos.list({
      part: 'snippet',
      id: chunk.map(v => v.videoId).join(',')
    });
    for (const item of res.data.items) {
      const v = videos.find(x => x.videoId === item.id);
      if (v) {
        v.tags = (item.snippet.tags || []).slice(0, 10);
        v.audioLanguage = item.snippet.defaultAudioLanguage || '';
      }
    }
  }
  return videos;
}

// ============================================================
// Phase 3：Gemini CLI 批次分類
// ============================================================
async function classifyVideos(videos) {
  const classifyFile = path.join(CONFIG.outputDir, 'classifications.json');
  let existing = {};

  if (fs.existsSync(classifyFile)) {
    existing = JSON.parse(fs.readFileSync(classifyFile));
    console.log(`  載入已有分類 ${Object.keys(existing).length} 部`);
  }

  const toClassify = videos.filter(v => !existing[v.videoId]);
  console.log(`  需要分類：${toClassify.length} 部`);

  for (let i = 0; i < toClassify.length; i += CONFIG.batchSize) {
    const batch    = toClassify.slice(i, i + CONFIG.batchSize);
    const batchNum = Math.floor(i / CONFIG.batchSize) + 1;
    const total    = Math.ceil(toClassify.length / CONFIG.batchSize);
    console.log(`  分類批次 ${batchNum}/${total}（${batch.length} 部）...`);

    const prompt = `你是 YouTube 影片分類專家。根據以下影片資訊判斷語言與類型。

影片清單：
${JSON.stringify(batch.map(v => ({
  id: v.videoId,
  title: v.title,
  desc: v.description,
  tags: v.tags,
  lang: v.audioLanguage
})))}

分類規則：
語言：中文 | 英文 | 日文 | 韓文 | 其他
類型：教學 | 電子音樂 | 古風 | 遊戲BGM | 純音樂（無人聲純器樂）| 其他音樂 | 非音樂 | 其他

無法判斷一律歸入：{"language":"其他","type":"其他"}

只回傳 JSON 陣列，不含其他說明：
[{"id":"videoId","language":"語言","type":"類型"}]`;

    try {
      const raw   = await askGemini(prompt);
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        const results = JSON.parse(match[0]);
        for (const r of results) {
          existing[r.id] = { language: r.language, type: r.type };
        }
      } else {
        console.warn('  ⚠️  此批次回應無法解析，跳過');
      }
    } catch (err) {
      console.error(`  ❌ Gemini 呼叫失敗：${err.message}`);
      console.error('  已儲存目前進度，可重新執行繼續');
      fs.writeFileSync(classifyFile, JSON.stringify(existing, null, 2));
      process.exit(1);
    }

    // 每批次後儲存（防止中途失敗遺失）
    fs.writeFileSync(classifyFile, JSON.stringify(existing, null, 2));
  }

  return existing;
}

// ============================================================
// Phase 4：取得或建立目標歌單
// ============================================================
async function getOrCreatePlaylists(youtube, classifications, dryRun) {
  const needed = new Set();
  for (const c of Object.values(classifications)) {
    needed.add(CONFIG.getPlaylistName(c.language, c.type));
  }

  // 取得現有歌單
  const existing = {};
  let pageToken = null;
  do {
    const res = await youtube.playlists.list({
      part: 'snippet', mine: true, maxResults: 50, pageToken
    });
    for (const pl of res.data.items) {
      existing[pl.snippet.title] = pl.id;
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const playlistMap = {};
  for (const name of needed) {
    if (existing[name]) {
      playlistMap[name] = existing[name];
      console.log(`  已有歌單：${name}`);
    } else if (dryRun) {
      playlistMap[name] = 'DRY_RUN';
      console.log(`  [dry-run] 將建立：${name}`);
    } else {
      const res = await youtube.playlists.insert({
        part: 'snippet,status',
        requestBody: {
          snippet: { title: name },
          status: { privacyStatus: 'private' }
        }
      });
      playlistMap[name] = res.data.id;
      console.log(`  建立歌單：${name}`);
    }
  }
  return playlistMap;
}

// ============================================================
// Phase 5：加入歌單
// ============================================================
async function insertToPlaylists(youtube, videos, classifications, playlistMap, dryRun) {
  const progressFile = path.join(CONFIG.outputDir, 'progress.json');
  let progress = fs.existsSync(progressFile)
    ? JSON.parse(fs.readFileSync(progressFile))
    : {};

  const stats = { added: 0, skipped: 0, failed: 0 };
  const addedDetail = {};

  for (const video of videos) {
    if (progress[video.videoId] === 'done') {
      stats.skipped++;
      continue;
    }

    const c = classifications[video.videoId] || { language: '其他', type: '其他' };
    const playlistName = CONFIG.getPlaylistName(c.language, c.type);
    const playlistId = playlistMap[playlistName];

    addedDetail[playlistName] = (addedDetail[playlistName] || 0) + 1;

    if (dryRun) {
      console.log(`  [dry-run] ${video.title} → ${playlistName}`);
      stats.added++;
      continue;
    }

    try {
      await youtube.playlistItems.insert({
        part: 'snippet',
        requestBody: {
          snippet: {
            playlistId,
            resourceId: { kind: 'youtube#video', videoId: video.videoId }
          }
        }
      });
      progress[video.videoId] = 'done';
      fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
      stats.added++;
      console.log(`  ✓ ${video.title} → ${playlistName}`);
    } catch (err) {
      const isQuota = err.code === 403 ||
        (err.errors && err.errors[0]?.reason === 'quotaExceeded');
      if (isQuota) {
        console.error('\n配額已用完，進度已儲存，明天重新執行即可繼續。');
        fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
        process.exit(0);
      }
      stats.failed++;
      console.error(`  ✗ ${video.title}：${err.message}`);
    }
  }

  return { stats, addedDetail };
}

// ============================================================
// 主程式
// ============================================================
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const skipClassify = process.argv.includes('--skip-classify');

  if (dryRun) console.log('[Dry-run 模式：不修改 YouTube]\n');

  console.log('Phase 1：OAuth2 認證...');
  const auth = await authenticate();
  const youtube = google.youtube({ version: 'v3', auth });

  console.log('Phase 2：讀取播放清單...');
  let videos = await fetchPlaylistVideos(youtube, CONFIG.sourcePlaylistId);
  videos = await enrichVideoDetails(youtube, videos);
  console.log(`  共 ${videos.length} 部影片\n`);

  console.log('Phase 3：AI 分類...');
  let classifications;
  if (skipClassify) {
    const f = path.join(CONFIG.outputDir, 'classifications.json');
    classifications = JSON.parse(fs.readFileSync(f));
    console.log(`  載入現有分類 ${Object.keys(classifications).length} 部`);
  } else {
    classifications = await classifyVideos(videos);
  }

  // 顯示分類摘要
  const summary = {};
  for (const c of Object.values(classifications)) {
    const name = CONFIG.getPlaylistName(c.language, c.type);
    summary[name] = (summary[name] || 0) + 1;
  }
  console.log('\n分類摘要：');
  for (const [name, count] of Object.entries(summary).sort()) {
    console.log(`  ${name}: ${count} 部`);
  }

  if (dryRun) {
    console.log('\n✅ Dry-run 完成，確認分類無誤後執行：node youtube_organizer.js');
    return;
  }

  console.log('\nPhase 4：建立歌單...');
  const playlistMap = await getOrCreatePlaylists(youtube, classifications, false);

  console.log('\nPhase 5：加入歌單...');
  const { stats, addedDetail } = await insertToPlaylists(
    youtube, videos, classifications, playlistMap, false
  );

  // 輸出報告
  fs.writeFileSync(
    path.join(CONFIG.outputDir, 'report.json'),
    JSON.stringify({ stats, addedDetail, classifications }, null, 2)
  );

  console.log('\n✅ 整理完成！');
  console.log(`  成功加入：${stats.added} 部`);
  console.log(`  已跳過（之前完成）：${stats.skipped} 部`);
  console.log(`  失敗：${stats.failed} 部`);
  console.log('\n建立的歌單：');
  for (const [name, count] of Object.entries(addedDetail).sort()) {
    console.log(`  ${name}：${count} 部`);
  }
}

main().catch(console.error);
```

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
