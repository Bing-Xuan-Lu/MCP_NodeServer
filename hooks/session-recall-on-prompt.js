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
  // 2. 非泛用檔名
  const files = [];
  for (const m of prompt.matchAll(/\b[\w-]{2,}\.(?:php|js|jsx|ts|tsx|vue|css|scss|py|sql)\b/gi)) files.push(m[0]);
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
    if (keywords.length === 0) return allow(); // 抽不到具體關鍵字 → 不亂注入

    const slug = resolveSlug();
    if (!slug) return allow();

    // 依關鍵字優先序搜，聚合每場 hits；第一個有效關鍵字夠用就停
    const bySession = {};   // sessionId -> { hits, date, snippet, kw }
    let usedKw = '';
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
    if (ranked.length === 0) return allow();

    const injected = loadInjected();
    // 同主題（關鍵字）已注入過、或整場已達上限 → 靜默，不洗版
    if (injected.count >= MAX_INJECT) return allow();
    if (usedKw && injected.kws.has(usedKw.toLowerCase())) return allow();
    const top = ranked.find((x) => !injected.sids.has(x.sessionId));
    if (!top) return allow(); // 候選場次都注入過了

    // 拿那場的細節（動過的檔 / 失敗呼叫 / 未完成）
    const rec = runRecall(slug, top.sessionId) || {};
    const files = (rec.filesModified || []).slice(0, 3).map((f) => `${(f.file || '').split(/[\\/]/).pop()}×${f.edits}`).join('、');
    const failedN = rec.failedCallTotal || (rec.failedCalls || []).length || 0;
    const pend = (rec.lastTodos || []).filter((t) => t.status && t.status !== 'completed');
    const date = (top.date || '').slice(0, 16).replace('T', ' ');

    const lines = [];
    lines.push('<user-prompt-submit-hook>');
    lines.push(`🧠 [歷史相關] 你以前處理過「${usedKw}」——別從零重推，先看這場做到哪、哪些失敗過：`);
    lines.push(`  • ${date} · session \`${top.sessionId.slice(0, 8)}\` · 命中 ${top.hits} 次`);
    if (files) lines.push(`    動過：${files}`);
    if (failedN > 0) lines.push(`    ⚠️ 那場有 ${failedN} 個失敗/被擋呼叫（避免重踩，細節用 session_recall 看）`);
    if (pend.length) lines.push(`    未完成：${pend.slice(0, 3).map((t) => t.content).join('；')}`);
    if (top.snippet) lines.push(`    ↳ ${top.snippet}`);
    lines.push(`  → 需要完整經過：session_recall(project="${slug.replace(/^d--/, '').replace(/^Project-/, '')}", selector="${top.sessionId.slice(0, 8)}")`);
    lines.push('</user-prompt-submit-hook>');

    if (usedKw) injected.kws.add(usedKw.toLowerCase());
    injected.sids.add(top.sessionId);
    injected.count += 1;
    saveInjected(injected);
    process.stdout.write(lines.join('\n') + '\n');
    return allow();
  } catch {
    return allow();
  }
});
