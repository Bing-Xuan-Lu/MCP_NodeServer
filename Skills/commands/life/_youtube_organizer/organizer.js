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
