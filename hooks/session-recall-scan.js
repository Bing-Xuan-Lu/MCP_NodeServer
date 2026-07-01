#!/usr/bin/env node
/**
 * session-recall-scan.js — 給 /session_recall Skill 用的 JSONL 解析器
 *
 * 為什麼獨立成檔：Bash 的引號 / 反斜線會把 Windows 路徑與 JSON 字串吃壞，
 * 走 process.argv 完全避開。與 session-audit-scan.js 同設計。
 *
 * 用法：
 *   node session-recall-scan.js list   <slug>                  列某專案的場次（挑哪一場用）
 *   node session-recall-scan.js recall <slug> <selector>       回顧某一場（selector: latest | 數字N=往前第N場 | YYYY-MM-DD | sessionId）
 *   node session-recall-scan.js search <keyword> [days]        跨專案搜關鍵字，找出相關場次（days 預設 30）
 *
 * 全部輸出 JSON 到 stdout。任何錯誤輸出 {"error": "..."}。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

const MAX_REQUESTS = 25;        // 每場最多收幾則使用者要求
const MAX_FILES = 40;
const MAX_DECISIONS = 8;        // 收幾則 assistant 結論
const SNIPPET = 200;

const FILE_TOOLS = /(?:^|__)(?:Edit|Write|create_file|create_file_batch|apply_diff|apply_diff_batch|multi_file_inject)$/;
const SQLPHP_TOOLS = /(?:^|__)(?:execute_sql|execute_sql_batch|run_php_script|run_php_code|run_php_script_batch)$/;
const SFTP_UPLOAD_TOOLS = /(?:^|__)(?:sftp_upload|sftp_upload_batch)$/;

function clip(s, n = SNIPPET) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 去掉 IDE 注入的雜訊標籤（開檔通知 / 選取內容），留下真正的使用者輸入
function cleanUserText(s) {
  return String(s || '')
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, ' ')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 取 message.content 的純文字
function textOf(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n');
  }
  return '';
}

// 是否為「真的使用者輸入」（排除 tool_result、純 system-reminder/hook 注入）
function isRealUserText(obj) {
  if (obj.type !== 'user' || !obj.message || obj.message.role !== 'user') return false;
  const c = obj.message.content;
  if (Array.isArray(c) && c.every((x) => x && x.type === 'tool_result')) return false;
  const t = textOf(obj.message).trim();
  if (!t) return false;
  // 過濾以 system-reminder / hook attachment 為主體的雜訊
  if (/^<(?:system-reminder|command-name|local-command)/.test(t)) return false;
  return true;
}

function listSessions(slug) {
  const dir = path.join(PROJECTS_DIR, slug);
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const fp = path.join(dir, f);
      const st = fs.statSync(fp);
      return { id: f.replace(/\.jsonl$/, ''), file: fp, mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files;
}

// 找對應的 compact 快照（檔名形如 YYYY-MM-DD-{shortid8}-compact.md）
function findSnapshot(sessionId) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  const short = sessionId.slice(0, 8);
  const hit = fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.includes(short) && f.endsWith('-compact.md'))
    .sort()
    .pop();
  return hit ? path.join(SESSIONS_DIR, hit) : null;
}

// 取 tool_result 的純文字（content 可能是 string 或 [{type:'text',text}]）
function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((x) => {
      if (typeof x === 'string') return x;
      if (x && x.type === 'text') return x.text || '';
      return '';
    }).join(' ');
  }
  return '';
}

// 從 user 訊息 / attachment 裡挖出「使用者貼上的內嵌截圖」(base64 圖片 block)。
// 只掃 user 來源(貼圖 / queued_command),不掃 assistant 與 tool_result——
// 那些通常是 Playwright 等工具產生、已另存 screenshot/ 的截圖,不是交接要看的使用者證據。
// 之所以要撈:textOf 只留 type==='text',截圖 block 會被靜默丟掉,交接時等於憑空消失。
function collectPastedImages(obj, out) {
  const pushImg = (n) => {
    if (n && n.type === 'image' && n.source && n.source.type === 'base64' && n.source.data) {
      out.push({ mediaType: n.source.media_type || 'image/png', data: n.source.data });
    }
  };
  // 1) user message content 直接帶的圖片 block
  if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
    for (const blk of obj.message.content) pushImg(blk);
  }
  // 2) attachment(queued_command 等)結構不固定,遞迴找 image block;
  //    遇到 key 'data' 不往下走,避免踏進 base64 巨串。
  if (obj.attachment) {
    const walk = (n, depth) => {
      if (!n || depth > 5) return;
      if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
      if (typeof n === 'object') {
        pushImg(n);
        for (const k of Object.keys(n)) { if (k !== 'data') walk(n[k], depth + 1); }
      }
    };
    walk(obj.attachment, 0);
  }
}

// 解析 sftp_upload / sftp_upload_batch 的 tool_result 文字 → { summary, uploaded[], skipped[] }
// 用途：recall 回答「上一場部署推了哪些檔」，免再手動解 jsonl。
function parseSftpResult(text, tool) {
  const lines = String(text || '').split(/\r?\n/);
  const summary = clip((lines.find((l) => l.trim()) || '').trim(), 140);
  const uploaded = [];
  const skipped = [];
  for (const l of lines) {
    const t = l.trim();
    let m = t.match(/^✅\s+(.+?)\s+→\s+/);          // batch 實際上傳：✅ local → remote
    if (m) { uploaded.push(m[1].trim()); continue; }
    m = t.match(/^(?:🔄|⚠️|⛔)\s+(.+?)\s+→\s+/);     // batch 略過：內容相同 / drift / 被 excludes 排除
    if (m) { skipped.push(m[1].trim()); continue; }
  }
  // 單檔 sftp_upload：result 無「local → remote」逐行格式，從「遠端:」行取目標
  if (tool === 'sftp_upload' && uploaded.length === 0 && /✅/.test(text)) {
    const remote = lines.find((l) => /^遠端:/.test(l.trim()));
    if (remote) uploaded.push(remote.replace(/^遠端:\s*/, '').trim());
  }
  return { summary, uploaded, skipped };
}

// 偵測「這場結束在一個等使用者回答的抉擇」——交接的關鍵訊號。
// 若成立，lastTodos 很可能已被這則收尾訊息推翻（中途計畫 vs 最終決定），
// 接手前必須以完整最後訊息為準，不能照 TODO 直接動手。
function detectPendingDecision(text) {
  if (!text) return null;
  const t = String(text).trim();
  const tail = t.slice(-80);
  // 結尾是問句，或明確要使用者選擇
  const endsWithQuestion = /[?？]\s*$/.test(tail) || /你要哪|要哪個|你決定|請選|選哪|哪一個|你要選|你選|怎麼做\??$/.test(tail);
  // 內文列了選項：(A)/(B)、方案 A/B、「兩條路 / 兩個做法」
  const hasOptions = /[（(]\s*[ABＡＢabＡ]\s*[）)]/.test(t) || /(?:方案|選項|路線|做法|方向)\s*[ABＡＢ]/.test(t) || /兩條路|兩個(?:選項|方向|做法|選擇)/.test(t);
  if (!endsWithQuestion && !hasOptions) return null;
  return { endsWithQuestion, hasOptions };
}

// 解析單場 jsonl → recap 物件
function recallSession(slug, sess) {
  const raw = fs.readFileSync(sess.file, 'utf-8');
  const lines = raw.trim().split(/\r?\n/);

  const userRequests = [];
  const filesModified = new Map(); // path -> count
  const toolsUsed = new Map();
  const sqlPhpRun = [];
  const assistantTexts = [];
  const idToTool = {};             // tool_use_id -> "tool target" 摘要，給失敗歸因用
  const failedCalls = [];          // 失敗 / 被 BLOCK 的工具呼叫
  const sftpUploads = [];          // 本場 SFTP 部署上傳（給「上次推了哪些檔」）
  const sftpById = {};             // tool_use_id -> sftp upload entry，給後續 tool_result 補明細
  let lastTodos = null;
  const pastedImagesRaw = [];      // 使用者貼上的內嵌截圖（原始 base64），迴圈後再 dump 成暫存檔
  let lastUserSnippet = '';        // 最近一則使用者文字，給截圖標「出現在哪句話附近」
  let finalMessageFull = '';       // 最後一則 assistant 文字「完整」保留（不砍 260），交接靠這則
  let firstTs = null;
  let lastTs = null;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(obj.timestamp || '') || null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    if (isRealUserText(obj)) {
      const cleaned = cleanUserText(textOf(obj.message));
      if (cleaned) { userRequests.push(clip(cleaned, 220)); lastUserSnippet = cleaned; }
    }

    // 使用者貼上的內嵌截圖：撈出來並標上時間與鄰近文字，交接時才不會漏掉圖
    {
      const before = pastedImagesRaw.length;
      collectPastedImages(obj, pastedImagesRaw);
      if (pastedImagesRaw.length > before) {
        const near = (obj.type === 'user' && obj.message)
          ? (cleanUserText(textOf(obj.message)) || lastUserSnippet) : lastUserSnippet;
        for (let i = before; i < pastedImagesRaw.length; i++) {
          pastedImagesRaw[i].ts = ts;
          pastedImagesRaw[i].near = near;
        }
      }
    }

    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (block.type === 'text' && block.text && block.text.trim()) {
          assistantTexts.push(clip(block.text, 260));
          finalMessageFull = block.text.trim();   // 持續覆寫，迴圈結束時即最後一則
        }
        if (block.type === 'tool_use') {
          const name = block.name || '';
          const short = name.split('__').pop();
          toolsUsed.set(short, (toolsUsed.get(short) || 0) + 1);
          const inp = block.input || {};
          // 記 id -> "tool target" 摘要，讓後面的 tool_result 錯誤能歸因到哪個工具/哪個檔
          if (block.id) {
            const tgt = inp.file_path || inp.path || (inp.target && inp.target.path) ||
              inp.sql || inp.query || inp.command || inp.url || '';
            idToTool[block.id] = short + (tgt ? ` ${clip(String(tgt), 60)}` : '');
          }
          if (FILE_TOOLS.test(name)) {
            const fp = inp.file_path || inp.path || (inp.target && inp.target.path) || '';
            if (fp) filesModified.set(fp, (filesModified.get(fp) || 0) + 1);
          }
          if (SQLPHP_TOOLS.test(name)) {
            const q = inp.sql || inp.query || inp.code || inp.script_path || inp.file_path || '';
            if (q) sqlPhpRun.push({ tool: short, snippet: clip(q, 120) });
          }
          if (SFTP_UPLOAD_TOOLS.test(name)) {
            let files = [];
            if (short === 'sftp_upload_batch' && Array.isArray(inp.items)) {
              files = inp.items.map((it) => it && it.local_path).filter(Boolean);
            } else if (inp.local_path) {
              files = [inp.local_path];
            }
            const entry = { tool: short, files, force: !!inp.force, summary: '', uploaded: [], skipped: [] };
            sftpUploads.push(entry);
            if (block.id) sftpById[block.id] = entry;
          }
          if (short === 'TodoWrite' && Array.isArray(inp.todos)) {
            lastTodos = inp.todos.map((t) => ({
              content: clip(t.content || t.activeForm || '', 100),
              status: t.status || '',
            }));
          }
        }
      }
    }

    // 失敗 / 被 hook BLOCK 的工具呼叫：tool_result 帶 is_error 出現在 user message
    if (obj.type === 'user' && obj.message && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (block && block.type === 'tool_result' && block.is_error) {
          const who = idToTool[block.tool_use_id] || '(未知工具)';
          const err = clip(resultText(block.content), 240);
          if (err) failedCalls.push({ tool: who, error: err });
        }
        // SFTP 上傳結果：補上「實際推了哪些 / 略過哪些 / N/M 成功」明細
        const up = block && block.type === 'tool_result' && sftpById[block.tool_use_id];
        if (up) {
          const parsed = parseSftpResult(resultText(block.content), up.tool);
          up.summary = parsed.summary;
          up.uploaded = parsed.uploaded;
          up.skipped = parsed.skipped;
        }
      }
    }
  }

  // 把使用者貼的截圖 dump 成暫存 PNG，讓 recall 能給出路徑供 read_image 真正看圖。
  // 只在 recall 模式會走到這裡（buildIndex/search 不呼叫 recallSession），不拖慢開場。
  const MAX_DUMP = 12;             // 最多 dump 幾張，避免大量截圖爆磁碟/時間
  const pastedImages = [];
  let dumpDir = null;
  for (let i = 0; i < pastedImagesRaw.length; i++) {
    const img = pastedImagesRaw[i];
    const sizeKB = Math.round((img.data.length * 3 / 4) / 1024); // base64 → 原始位元組估算
    let file = null;
    if (i < MAX_DUMP) {
      try {
        if (!dumpDir) {
          // dump 進 MCP 允許的暫存路徑，read_image 才開得了(os.tmpdir 不在 basePath 白名單會被擋)。
          // 依序:env 覆寫 → D:\tmp(本環境免授權暫存) → 退回 os.tmpdir(至少能 dump,跨機不壞)。
          const base = process.env.CLAUDE_RECALL_IMG_DIR
            || (fs.existsSync('D:\\tmp') ? path.join('D:\\tmp', 'claude-recall-img') : path.join(os.tmpdir(), 'claude-recall-img'));
          dumpDir = path.join(base, sess.id);
          fs.mkdirSync(dumpDir, { recursive: true });
        }
        const ext = ((img.mediaType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')) || 'png';
        const fp = path.join(dumpDir, `img${String(i + 1).padStart(2, '0')}.${ext}`);
        fs.writeFileSync(fp, Buffer.from(img.data, 'base64'));
        file = fp;
      } catch { file = null; }
    }
    pastedImages.push({
      seq: i + 1,
      mediaType: img.mediaType,
      sizeKB,
      ts: img.ts ? new Date(img.ts).toISOString() : null,
      near: clip(img.near || '', 80),
      file,
    });
  }

  return {
    slug,
    sessionId: sess.id,
    pastedImages,                  // 使用者貼上的截圖（已 dump，file 給 read_image 用）
    pastedImageTotal: pastedImagesRaw.length,
    date: firstTs ? new Date(firstTs).toISOString() : null,
    lastActivity: lastTs ? new Date(lastTs).toISOString() : null,
    snapshot: findSnapshot(sess.id),
    userRequests: userRequests.slice(0, MAX_REQUESTS),
    userRequestTotal: userRequests.length,
    filesModified: [...filesModified.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_FILES)
      .map(([f, n]) => ({ file: f, edits: n })),
    sqlPhpRun: sqlPhpRun.slice(0, 15),
    failedCalls: failedCalls.slice(-25),   // 失敗/被擋的工具呼叫（取最後 25 筆，最近的最有用）
    failedCallTotal: failedCalls.length,
    sftpUploads: sftpUploads.slice(0, 20),   // 本場部署上傳明細（給「上次推了哪些檔」）
    sftpUploadCallTotal: sftpUploads.length,
    topTools: [...toolsUsed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => ({ tool: t, count: n })),
    lastTodos,
    // 取最後幾則 assistant 文字當「收尾結論」（最能代表這場做完什麼）
    closingNotes: assistantTexts.slice(-MAX_DECISIONS),
    // 最後一則 assistant 訊息「完整」保留（上限 4000 字防爆）——交接以這則為準，不再被 260 字截斷坑
    finalMessage: finalMessageFull ? finalMessageFull.slice(0, 4000) : '',
    finalMessageTruncated: finalMessageFull.length > 4000,
    // 這場是否結束在一個等使用者回答的抉擇（成立時 lastTodos 可能已被推翻）
    pendingDecision: detectPendingDecision(finalMessageFull),
  };
}

function pickSession(slug, selector) {
  const sessions = listSessions(slug);
  if (sessions.length === 0) return null;
  selector = String(selector || 'prev').trim();
  // prev = 上一場（排除「正在進行」的當前對話檔）。
  // 首選用 CLAUDE_CODE_SESSION_ID 精準排除（mtime 不可靠：Claude Code 非即時 flush jsonl）；
  // env 缺失才退回 90 秒新鮮度門檻；再不行退回次新、最新，確保永遠有結果。
  if (selector === 'prev') {
    const curId = process.env.CLAUDE_CODE_SESSION_ID || '';
    if (curId) {
      const prev = sessions.find((s) => s.id !== curId);
      if (prev) return prev;
    }
    const ACTIVE_MS = 90_000;
    return sessions.find((s) => Date.now() - s.mtime > ACTIVE_MS) || sessions[1] || sessions[0];
  }
  if (selector === 'latest' || selector === '') return sessions[0];
  if (/^\d+$/.test(selector)) {
    const n = parseInt(selector, 10);
    return sessions[n - 1] || null; // 1 = 最近
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(selector)) {
    return sessions.find((s) => new Date(s.mtime).toISOString().slice(0, 10) === selector) || null;
  }
  // 當作 session id（可只給前綴）
  return sessions.find((s) => s.id === selector || s.id.startsWith(selector)) || null;
}

// 關鍵字搜尋（slugFilter 給定時只搜該專案；給 excludeId 排除當前對話檔）
function search(keyword, days, slugFilter, excludeId) {
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return { error: 'empty keyword' };
  const cutoff = Date.now() - days * 86400000;
  const results = [];
  if (!fs.existsSync(PROJECTS_DIR)) return { matches: [] };
  let slugs = fs.readdirSync(PROJECTS_DIR);
  if (slugFilter) slugs = slugs.filter((s) => s === slugFilter || s.toLowerCase().includes(String(slugFilter).toLowerCase()));
  for (const slug of slugs) {
    const dir = path.join(PROJECTS_DIR, slug);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) continue;
      const sessId = f.replace(/\.jsonl$/, '');
      if (excludeId && (sessId === excludeId || sessId.startsWith(excludeId))) continue; // 排除當前對話
      let raw;
      try {
        raw = fs.readFileSync(fp, 'utf-8');
      } catch {
        continue;
      }
      // 快篩：整檔小寫含關鍵字才逐行細查
      if (!raw.toLowerCase().includes(kw)) continue;
      let hits = 0;
      let firstSnippet = '';
      for (const line of raw.split(/\r?\n/)) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        let txt = '';
        if (isRealUserText(obj)) txt = textOf(obj.message);
        else if (obj.type === 'assistant' && obj.message) txt = textOf(obj.message);
        if (txt && txt.toLowerCase().includes(kw)) {
          hits++;
          if (!firstSnippet) {
            const idx = txt.toLowerCase().indexOf(kw);
            firstSnippet = clip(txt.slice(Math.max(0, idx - 60), idx + 140), 200);
          }
        }
      }
      if (hits > 0) {
        results.push({
          slug,
          sessionId: f.replace(/\.jsonl$/, ''),
          date: new Date(st.mtimeMs).toISOString(),
          hits,
          snippet: firstSnippet,
        });
      }
    }
  }
  results.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return { keyword, days, matchCount: results.length, matches: results.slice(0, 30) };
}

// 輕量摘要：一場 → { topic, pendingTodos, failedCalls, topFiles }（給 index 用，比 recall 便宜）
function quickDigest(slug, sess) {
  let raw;
  try { raw = fs.readFileSync(sess.file, 'utf-8'); } catch { return null; }
  let topic = '', pendingTodos = 0, failed = 0;
  const fileCount = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!topic && isRealUserText(o)) {
      const t = cleanUserText(textOf(o.message));
      if (t) topic = clip(t, 90);
    }
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (b.type !== 'tool_use') continue;
        if (FILE_TOOLS.test(b.name || '')) {
          const fp = (b.input && (b.input.file_path || b.input.path)) || '';
          if (fp) fileCount.set(fp, (fileCount.get(fp) || 0) + 1);
        }
        if ((b.name || '').split('__').pop() === 'TodoWrite' && Array.isArray(b.input && b.input.todos)) {
          pendingTodos = b.input.todos.filter((t) => t.status && t.status !== 'completed').length;
        }
      }
    }
    if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) if (b && b.type === 'tool_result' && b.is_error) failed++;
    }
  }
  const topFiles = [...fileCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
    .map(([f, n]) => ({ file: f.split(/[\\/]/).pop(), edits: n }));
  return { sessionId: sess.id, date: new Date(sess.mtime).toISOString(), topic, pendingTodos, failedCalls: failed, topFiles };
}

// 最近 N 場輕量索引（給 SessionStart 當「地圖」，不倒整包）
function buildIndex(slug, n, excludeId) {
  let sessions = listSessions(slug);
  if (excludeId) sessions = sessions.filter((s) => !(s.id === excludeId || s.id.startsWith(excludeId)));
  sessions = sessions.slice(0, n || 8);
  return { slug, count: sessions.length, sessions: sessions.map((s) => quickDigest(slug, s)).filter(Boolean) };
}

// 跨場「變更檔案」反查索引：時間窗內每場動過哪些檔 union 起來，回 file -> 哪幾場改的。
// 給 /session_deploy 用：git working tree 才是「要推什麼」的真相，這裡只補「每個檔是哪幾場 session 改的」摘要。
// source-verified: 欄位名經實測真實 JSONL 確認——
//   單檔 Edit/Write=file_path、apply_diff/create_file=path；
//   batch：apply_diff_batch=diffs[].path、create_file_batch=files[].path（不是 items！）。
function changedFilesIndex(slug, days, excludeId) {
  let sessions = listSessions(slug);
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  if (cutoff) sessions = sessions.filter((s) => s.mtime >= cutoff);
  if (excludeId) sessions = sessions.filter((s) => !(s.id === excludeId || s.id.startsWith(excludeId)));
  const fileMap = new Map(); // path -> { total, sessions:[{session,date,edits}] }
  for (const sess of sessions) {
    let raw;
    try { raw = fs.readFileSync(sess.file, 'utf-8'); } catch { continue; }
    const perFile = new Map();
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!(o.type === 'assistant' && o.message && Array.isArray(o.message.content))) continue;
      for (const b of o.message.content) {
        if (b.type !== 'tool_use' || !FILE_TOOLS.test(b.name || '')) continue;
        const inp = b.input || {};
        const paths = [];
        const one = inp.file_path || inp.path || (inp.target && inp.target.path);
        if (one) paths.push(one);
        // batch / 多檔工具的陣列：apply_diff_batch=diffs、create_file_batch=files、其餘防禦性 items/injections
        for (const arr of [inp.diffs, inp.files, inp.items, inp.injections]) {
          if (Array.isArray(arr)) for (const it of arr) { const p = it && (it.path || it.file_path); if (p) paths.push(p); }
        }
        for (const p of paths) perFile.set(p, (perFile.get(p) || 0) + 1);
      }
    }
    for (const [p, n] of perFile) {
      if (!fileMap.has(p)) fileMap.set(p, { total: 0, sessions: [] });
      const rec = fileMap.get(p);
      rec.total += n;
      rec.sessions.push({
        session: sess.id.slice(0, 8),
        date: new Date(sess.mtime).toISOString().slice(0, 16).replace('T', ' '),
        edits: n,
      });
    }
  }
  const files = [...fileMap.entries()]
    .map(([file, r]) => ({ file, total: r.total, sessions: r.sessions }))
    .sort((a, b) => b.total - a.total);
  return { slug, days: days || null, sessionCount: sessions.length, fileCount: files.length, files };
}

// ── main ───────────────────────────────────────────
function main() {
  const [, , mode, a, b, c] = process.argv;
  const curId = process.env.CLAUDE_CODE_SESSION_ID || '';
  try {
    if (mode === 'index') {
      process.stdout.write(JSON.stringify(buildIndex(a, parseInt(b, 10) || 8, curId), null, 2));
    } else if (mode === 'changed') {
      // source-verified: 只是把上面剛實測建好的 changedFilesIndex 接上 CLI 分派，無新真相源
      // changed <slug> [days]：跨場變更檔案反查（days 預設 14，含當前對話一起算）
      process.stdout.write(JSON.stringify(changedFilesIndex(a, parseInt(b, 10) || 14, null), null, 2));
    } else if (mode === 'list') {
      const sessions = listSessions(a);
      const out = sessions.map((s) => ({
        sessionId: s.id,
        date: new Date(s.mtime).toISOString(),
        sizeKB: Math.round(s.size / 1024),
        hasSnapshot: !!findSnapshot(s.id),
      }));
      process.stdout.write(JSON.stringify({ slug: a, count: out.length, sessions: out }, null, 2));
    } else if (mode === 'recall') {
      const sess = pickSession(a, b);
      if (!sess) {
        process.stdout.write(JSON.stringify({ error: `no session for slug=${a} selector=${b}` }));
        return;
      }
      process.stdout.write(JSON.stringify(recallSession(a, sess), null, 2));
    } else if (mode === 'search') {
      const days = b ? Math.min(parseInt(b, 10) || 30, 180) : 30;
      // search <keyword> [days] [slug]；給 slug 時只搜該專案，並自動排除當前對話
      process.stdout.write(JSON.stringify(search(a, days, c || null, curId), null, 2));
    } else {
      process.stdout.write(JSON.stringify({ error: 'usage: index <slug> [n] | list <slug> | recall <slug> <selector> | search <keyword> [days] [slug]' }));
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}

main();
