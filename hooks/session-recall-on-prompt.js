#!/usr/bin/env node
/**
 * UserPromptSubmit Hook — 按「相關性」自動 recall 過往對話
 *
 * 緣由：session_search / session_recall 是被動工具，Claude 不會自己想到用，
 *       使用者得每次手動提醒；而 session-start 只塞「上一場」（時間最近）——
 *       但長任務（如報價 bug）的相關上下文常在「上上場 / 5 場前」，按時間撈會撈錯。
 *
 * 對策：在「使用者送出指令」時（這時才知道主題），從 prompt 抽出關鍵字
 *       （檔名 / PascalCase 識別字 / URL 路徑段），用關鍵字搜「本專案」全部歷史，
 *       找出**最相關**那場（不是最近那場），注入它的「動過的檔 / 失敗呼叫 / 未完成 / 片段」，
 *       讓 Claude 不必從零重推、也不會重踩上次踩過的坑。
 *
 * 精準優先、寧缺勿濫：
 *   - prompt 抽不到夠具體的關鍵字 → 靜默不注入（不對模糊指令亂噴）。
 *   - 同一場在同一個當前對話只注入一次（state 去重）。
 *   - 命中數太低（< 2）不注入。
 *
 * 輸出：<user-prompt-submit-hook> 包裹的文字（注入 context）。任何錯誤一律靜默 exit 0。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SCAN = path.join(os.homedir(), '.claude', 'hooks', 'session-recall-scan.js');
const STATE_DIR = path.join(os.homedir(), '.claude', '.hook-state');
const SEARCH_DAYS = 60;
const MIN_HITS = 2;
const GENERIC_FILES = new Set(['index.php', 'list.php', 'update.php', 'detail.php', 'header.php', 'footer.php', 'config.php', 'common.php', 'function.php', 'index.js']);
// 「接續上一場」延續詞：使用者明說要接上次 / 還沒做完時，即使抽不到具體關鍵字，
// 也按時間 recall 上一場（解：純「上一場…沒看完」這類訊息因無關鍵字被靜默略過，逼 Claude 裸 Glob 重找）
const CONTINUATION_RE = /(上一?場|上次|上個\s*(?:對話|session)|前一場|剛剛那場|之前那場|還沒(?:看完|做完|寫完|處理完|跑完)|沒(?:看完|做完|寫完)|繼續(?:上次|之前|剛剛|上一場|未完|那場)|接著(?:上次|之前)|做到一半|寫到一半)/i;

function allow() { process.exit(0); }

// cwd → slug（D:\Project\{ProjectFolder} → d--Project-{ProjectFolder}），驗證存在 / fuzzy 兜底
function resolveSlug() {
  const cwd = process.cwd().replace(/\\/g, '/');
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const drive = parts[0].replace(':', '').toLowerCase();
  const rest = parts.slice(1).join('-').replace(/_/g, '-');
  const candidate = `${drive}--${rest}`;
  if (!fs.existsSync(PROJECTS_DIR)) return null;
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  if (dirs.includes(candidate)) return candidate;
  // fuzzy：用最後一段（專案名）比對
  const base = parts[parts.length - 1].toLowerCase().replace(/[_-]/g, '');
  return dirs.find((d) => d.toLowerCase().replace(/[_-]/g, '').endsWith(base)) || null;
}

// 從 prompt 抽出「夠具體」的關鍵字，依精準度排序
function extractKeywords(prompt) {
  const out = [];
  const seen = new Set();
  const push = (k) => { const lk = k.toLowerCase(); if (k && !seen.has(lk)) { seen.add(lk); out.push(k); } };

  // 1. PascalCase 識別字（MyService、SomeTrait）— 最精準
  for (const m of prompt.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) push(m[0]);
  // 2. 非泛用檔名（含資料/文件類副檔名與中文檔名，如「測試輸入資料.xlsx」）
  const files = [];
  for (const m of prompt.matchAll(/[\p{L}\p{N}_-]{2,}\.(?:php|js|jsx|ts|tsx|vue|css|scss|py|sql|xlsx|xls|csv|docx|doc|pptx|ppt|pdf|txt|json|md|html|htm|xml)\b/giu)) files.push(m[0]);
  for (const f of files) if (!GENERIC_FILES.has(f.toLowerCase())) push(f);
  // 3. URL 路徑最後一段（去 query）
  for (const m of prompt.matchAll(/https?:\/\/[^\s]+/g)) {
    const seg = m[0].split('?')[0].replace(/\/+$/, '').split('/').pop();
    if (seg && /[\w-]{3,}/.test(seg) && !/^\d+$/.test(seg)) push(seg);
  }
  // 4. 泛用檔名（墊底，只有前面都沒抽到時才用）
  for (const f of files) if (GENERIC_FILES.has(f.toLowerCase())) push(f);

  return out.slice(0, 3);
}

function runSearch(kw, slug) {
  try {
    const out = execFileSync(process.execPath, [SCAN, 'search', kw, String(SEARCH_DAYS), slug],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    return JSON.parse(out);
  } catch { return null; }
}
function runRecall(slug, sessionId) {
  try {
    const out = execFileSync(process.execPath, [SCAN, 'recall', slug, sessionId],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    return JSON.parse(out);
  } catch { return null; }
}

const MAX_INJECT = 4;   // 整場最多注入幾次 recall（避免洗版）
function injectedKey() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID || 'cur';
  return path.join(STATE_DIR, `recall-${sid.slice(0, 12)}.json`);
}
function loadInjected() {
  try {
    const j = JSON.parse(fs.readFileSync(injectedKey(), 'utf8'));
    return { kws: new Set(j.kws || []), sids: new Set(j.sids || []), count: j.count || 0 };
  } catch { return { kws: new Set(), sids: new Set(), count: 0 }; }
}
function saveInjected(st) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(injectedKey(), JSON.stringify({ kws: [...st.kws], sids: [...st.sids], count: st.count }));
  } catch { /* ignore */ }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const prompt = (data.prompt || '').trim();
    if (!prompt || prompt.length < 4) return allow();
    if (prompt.startsWith('<') || prompt.startsWith('/')) return allow(); // 系統注入 / 斜線指令略過

    const keywords = extractKeywords(prompt);
    const wantsPrev = CONTINUATION_RE.test(prompt);
    // 既無具體關鍵字、也沒有「接續上一場」延續詞 → 不亂注入
    if (keywords.length === 0 && !wantsPrev) return allow();

    const slug = resolveSlug();
    if (!slug) return allow();

    const injected = loadInjected();
    if (injected.count >= MAX_INJECT) return allow(); // 整場已達注入上限 → 靜默不洗版
    const curId = process.env.CLAUDE_CODE_SESSION_ID || '';

    // ── 路徑 A：關鍵字相關性搜尋（找「最相關」那場，不一定是最近）──
    let top = null, usedKw = '', framing = 'relevance';
    if (keywords.length > 0) {
      const bySession = {};   // sessionId -> { hits, date, snippet, kw }
      for (const kw of keywords) {
        const res = runSearch(kw, slug);
        if (!res || !Array.isArray(res.matches) || res.matches.length === 0) continue;
        usedKw = usedKw || kw;
        for (const m of res.matches) {
          const e = bySession[m.sessionId] || { hits: 0, date: m.date, snippet: m.snippet, kw };
          e.hits += m.hits;
          bySession[m.sessionId] = e;
        }
        if (Object.keys(bySession).length > 0) break; // 第一個命中的關鍵字就夠
      }
      const ranked = Object.entries(bySession)
        .map(([sid, e]) => ({ sessionId: sid, ...e }))
        .sort((a, b) => b.hits - a.hits)
        .filter((x) => x.hits >= MIN_HITS);
      // 同主題（關鍵字）已注入過 → 不走關鍵字路徑（仍可能走延續詞 fallback）
      if (!(usedKw && injected.kws.has(usedKw.toLowerCase()))) {
        top = ranked.find((x) => !injected.sids.has(x.sessionId)) || null;
      }
    }

    // ── 路徑 B：延續詞 fallback（上一場 / 繼續 / 還沒看完…）──
    // 關鍵字沒命中、但使用者明說要接續 → 按時間 recall「上一場」，避免裸 Glob 從零重找。
    let prevRec = null;
    if (!top && wantsPrev && !injected.kws.has('__prev__')) {
      prevRec = runRecall(slug, 'prev');
      const pid = prevRec && prevRec.sessionId;
      // 防單一 session 自我注入：pickSession('prev') 在無上一場時可能回退成當前對話
      if (pid && pid !== curId && !injected.sids.has(pid)) {
        top = { sessionId: pid, hits: 0, date: prevRec.date, snippet: '', kw: '' };
        framing = 'continuation';
      }
    }

    if (!top) return allow();

    // 取那場細節（continuation 路徑已有 prevRec，relevance 路徑現拿）
    const rec = prevRec || runRecall(slug, top.sessionId) || {};
    const files = (rec.filesModified || []).slice(0, 3).map((f) => `${(f.file || '').split(/[\\/]/).pop()}×${f.edits}`).join('、');
    const failedN = rec.failedCallTotal || (rec.failedCalls || []).length || 0;
    const pend = (rec.lastTodos || []).filter((t) => t.status && t.status !== 'completed');
    const date = (top.date || rec.date || '').slice(0, 16).replace('T', ' ');
    const sid8 = top.sessionId.slice(0, 8);

    const lines = ['<user-prompt-submit-hook>'];
    if (framing === 'continuation') {
      const topic = (rec.userRequests && rec.userRequests[0]) ? String(rec.userRequests[0]).replace(/\s+/g, ' ').slice(0, 80) : '';
      lines.push('🧠 [接續上一場] 你提到要接上一場 / 還沒做完——先看上一場做到哪、有沒有未完成的，別從零重找或自己湊資料：');
      lines.push(`  • ${date} · session \`${sid8}\`（上一場）`);
      if (topic) lines.push(`    上一場開頭：${topic}`);
    } else {
      lines.push(`🧠 [歷史相關] 你以前處理過「${usedKw}」——別從零重推，先看這場做到哪、哪些失敗過：`);
      lines.push(`  • ${date} · session \`${sid8}\` · 命中 ${top.hits} 次`);
    }
    if (files) lines.push(`    動過：${files}`);
    if (failedN > 0) lines.push(`    ⚠️ 那場有 ${failedN} 個失敗/被擋呼叫（避免重踩，細節用 session_recall 看）`);
    if (pend.length) lines.push(`    未完成：${pend.slice(0, 3).map((t) => t.content).join('；')}`);
    if (top.snippet) lines.push(`    ↳ ${top.snippet}`);
    lines.push(`  → 需要完整經過：session_recall(project="${slug.replace(/^d--/, '').replace(/^Project-/, '')}", selector="${sid8}")`);
    lines.push('</user-prompt-submit-hook>');

    if (usedKw) injected.kws.add(usedKw.toLowerCase());
    if (framing === 'continuation') injected.kws.add('__prev__');
    injected.sids.add(top.sessionId);
    injected.count += 1;
    saveInjected(injected);
    process.stdout.write(lines.join('\n') + '\n');
    return allow();
  } catch {
    return allow();
  }
});
