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

// 解析單場 jsonl → recap 物件
function recallSession(slug, sess) {
  const raw = fs.readFileSync(sess.file, 'utf-8');
  const lines = raw.trim().split(/\r?\n/);

  const userRequests = [];
  const filesModified = new Map(); // path -> count
  const toolsUsed = new Map();
  const sqlPhpRun = [];
  const assistantTexts = [];
  let lastTodos = null;
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
      if (cleaned) userRequests.push(clip(cleaned, 220));
    }

    if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (block.type === 'text' && block.text && block.text.trim()) {
          assistantTexts.push(clip(block.text, 260));
        }
        if (block.type === 'tool_use') {
          const name = block.name || '';
          const short = name.split('__').pop();
          toolsUsed.set(short, (toolsUsed.get(short) || 0) + 1);
          const inp = block.input || {};
          if (FILE_TOOLS.test(name)) {
            const fp = inp.file_path || inp.path || (inp.target && inp.target.path) || '';
            if (fp) filesModified.set(fp, (filesModified.get(fp) || 0) + 1);
          }
          if (SQLPHP_TOOLS.test(name)) {
            const q = inp.sql || inp.query || inp.code || inp.script_path || inp.file_path || '';
            if (q) sqlPhpRun.push({ tool: short, snippet: clip(q, 120) });
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
  }

  return {
    slug,
    sessionId: sess.id,
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
    topTools: [...toolsUsed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => ({ tool: t, count: n })),
    lastTodos,
    // 取最後幾則 assistant 文字當「收尾結論」（最能代表這場做完什麼）
    closingNotes: assistantTexts.slice(-MAX_DECISIONS),
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

// 跨專案關鍵字搜尋
function search(keyword, days) {
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return { error: 'empty keyword' };
  const cutoff = Date.now() - days * 86400000;
  const results = [];
  if (!fs.existsSync(PROJECTS_DIR)) return { matches: [] };
  for (const slug of fs.readdirSync(PROJECTS_DIR)) {
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

// ── main ───────────────────────────────────────────
function main() {
  const [, , mode, a, b] = process.argv;
  try {
    if (mode === 'list') {
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
      process.stdout.write(JSON.stringify(search(a, days), null, 2));
    } else {
      process.stdout.write(JSON.stringify({ error: 'usage: list <slug> | recall <slug> <selector> | search <keyword> [days]' }));
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}

main();
