#!/usr/bin/env node
/**
 * PreToolUse Hook — Entry-Search Memory Gate（開場找入口硬 gate）
 *
 * 解的問題：每場 session 開頭接到「查/改 X 功能」就直接 Grep/Glob 散搜找入口檔，
 *           不先讀 project memory（明明 reference_* / ops_index 早就記了入口鏈）。
 *           memory-auto-recall 只「注入提醒」沒強制力，照樣被無視 → 使用者得一直喊「翻記憶」。
 *
 * 機制（只在開場、只攔 Grep/Glob）：
 *   - 本場 transcript 的 tool 呼叫數 > EARLY_LIMIT（已過開場、已定向）→ 放行
 *   - 本場已讀過任一 project memory 檔，或呼叫過 session_recall/session_search → 放行（永久解除）
 *   - 否則：BLOCK，並在訊息裡動態列出跟最近 prompt 最相關的記憶檔，逼先翻記憶
 *
 * 解除方式：read_file/Read 任一 memory 檔（含 ops_index.md），或 session_recall。讀過即解除本場攔截。
 *
 * BLOCK = stderr 寫原因 + exit(2)（與 repetition-detector 同慣例）。任何錯誤靜默放行（exit 0）。
 *
 * ENV：
 *   CLAUDE_ENTRY_GATE_DISABLE=1     全域停用
 *   CLAUDE_ENTRY_GATE_EARLY_LIMIT   開場判定的 tool 呼叫數上限（預設 12）
 *   CLAUDE_ENTRY_GATE_MIN_FILES     memory 檔少於此數就不啟用（預設 8）
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = process.env.USERPROFILE || process.env.HOME;
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const EARLY_LIMIT = parseInt(process.env.CLAUDE_ENTRY_GATE_EARLY_LIMIT || '12', 10);
const MIN_MEM_FILES = parseInt(process.env.CLAUDE_ENTRY_GATE_MIN_FILES || '8', 10);
const DEBUG = process.env.CLAUDE_HOOK_DEBUG === '1';

function debug(msg) { if (DEBUG) process.stderr.write(`[entry-gate] ${msg}\n`); }

// ── 找當前專案 memory dir（沿用 memory-auto-recall 的 cwd→slug 推導）──
function findProjectMemoryDir(cwd) {
  cwd = (cwd || process.cwd()).replace(/\\/g, '/');
  const parts = cwd.split('/').filter(Boolean);
  const candidates = [];
  if (parts.length >= 2) {
    const drive = parts[0].replace(':', '').toLowerCase();
    const rest = parts.slice(1).join('-');
    candidates.push(`${drive}--${rest}`);
    const restHyphen = rest.replace(/_/g, '-');
    if (restHyphen !== rest) candidates.push(`${drive}--${restHyphen}`);
    candidates.push(`${drive}--${parts[1]}`);
    const p1Hyphen = parts[1].replace(/_/g, '-');
    if (p1Hyphen !== parts[1]) candidates.push(`${drive}--${p1Hyphen}`);
  }
  for (const id of candidates) {
    const memDir = path.join(PROJECTS_DIR, id, 'memory');
    if (fs.existsSync(memDir)) return memDir;
  }
  if (!fs.existsSync(PROJECTS_DIR)) return null;
  try {
    const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name);
    const cwdLower = cwd.toLowerCase().replace(/[:\\]/g, '-').replace(/\//g, '-');
    const matched = projects.find(p => cwdLower.includes(p.toLowerCase().replace(/--/, '-')));
    if (matched) {
      const memDir = path.join(PROJECTS_DIR, matched, 'memory');
      if (fs.existsSync(memDir)) return memDir;
    }
  } catch {}
  return null;
}

// ── 列出 memory dir 下的 .md（含子目錄，排除 reports/_private）──
function listMemoryFiles(memDir) {
  const out = [];
  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'reports' || e.name === '_private' || e.name.startsWith('.')) continue;
        walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push({ file: e.name, rel: rel ? `${rel}/${e.name}` : e.name, full: path.join(dir, e.name) });
      }
    }
  }
  walk(memDir, '');
  return out;
}

// ── 掃 transcript：本場 tool 呼叫數 + 是否已查過記憶 + 最近 user prompt ──
function scanTranscript(transcriptPath, memDirNorm) {
  const res = { toolCalls: 0, memoryConsulted: false, promptText: '' };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return res;
  let text;
  try { text = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return res; }
  const lines = text.split('\n').filter(Boolean);
  const recentPrompts = [];
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    // user prompt 文字（取最後幾筆）
    const um = obj.message;
    if (obj.type === 'user' && um) {
      let content = '';
      if (typeof um.content === 'string') content = um.content;
      else if (Array.isArray(um.content)) {
        content = um.content.filter(c => c && c.type === 'text').map(c => c.text).join(' ');
      }
      // 排除 tool_result 偽 user 訊息與 hook 注入
      if (content && !/^\s*\[/.test(content) && !/hookSpecificOutput|tool_use_id/.test(line)) {
        recentPrompts.push(content);
        if (recentPrompts.length > 6) recentPrompts.shift();
      }
    }

    // assistant tool_use：計數 + 偵測查記憶動作
    const am = obj.message;
    if (obj.type === 'assistant' && am && Array.isArray(am.content)) {
      for (const c of am.content) {
        if (!c || c.type !== 'tool_use') continue;
        res.toolCalls++;
        const nm = String(c.name || '');
        const inp = c.input || {};
        // 呼叫 recall 類工具 → 視為已查記憶
        if (/session_recall|session_search/i.test(nm)) { res.memoryConsulted = true; continue; }
        // Read / read_file 命中 memory 目錄 → 視為已查記憶
        if (/(^|_)read_file$|^Read$/i.test(nm) || /read_files_batch/i.test(nm)) {
          const p = String(inp.file_path || inp.path || '').replace(/\\/g, '/').toLowerCase();
          const ps = Array.isArray(inp.file_paths) ? inp.file_paths.join('|').replace(/\\/g, '/').toLowerCase() : '';
          const blob = (p + '|' + ps);
          if (blob.includes(memDirNorm) || /\.claude\/projects\/[^|]*\/memory\//.test(blob)) {
            res.memoryConsulted = true;
          }
        }
      }
    }
  }
  res.promptText = recentPrompts.join('\n');
  return res;
}

// ── 判斷此 Grep/Glob 是否「找入口式」搜尋（要攔的對象）──
function isEntrySearch(toolName, input) {
  if (toolName === 'Glob') return true;                       // Glob 找檔案 = 典型找入口
  if (toolName !== 'Grep') return false;
  const pat = String(input.pattern || '');
  if (!pat) return false;
  // 含中文/自然語句（字串、註解、SQL 文字搜尋）→ CLAUDE.md 允許，放行
  if (/[一-鿿]/.test(pat)) return false;
  if (/\s/.test(pat) && !/function\s|class\s|->|::/.test(pat)) return false;
  // 程式碼 scope（限定 .php/.js/.ts/.vue 等）或 identifier 樣式 → 視為找入口/符號
  const codeScope = /\b(php|js|ts|jsx|tsx|vue|java|go|py)\b/i.test(String(input.type || '')) ||
                    /\.(php|js|ts|jsx|tsx|vue)\b/i.test(String(input.glob || ''));
  const identifierish = /^[A-Za-z_][\w$]*([:>\-\.\\][\w$]*)*$/.test(pat) ||
                        /function\s|class\s|->|::|=>/.test(pat);
  return codeScope || identifierish;
}

// ── 依最近 prompt 關鍵字，挑最相關的記憶檔 ──
function rankRelevant(memFiles, promptText, max = 8) {
  // 抽 prompt 的可比對 token：英數識別字 + 檔名片段
  const toks = (promptText.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []);
  const tokSet = new Set(toks);
  const scored = memFiles.map(m => {
    const base = m.file.replace(/\.md$/, '').toLowerCase();
    const segs = base.replace(/^(project|reference|feedback|user)_/, '').split(/[_\-]/).filter(Boolean);
    let score = 0;
    for (const s of segs) if (s.length >= 3 && tokSet.has(s)) score += 2;
    for (const s of segs) if (s.length >= 4 && [...tokSet].some(t => t.includes(s) || s.includes(t))) score += 1;
    // 入口地圖類永遠優先
    if (/^ops_index|codemap|^index/.test(base)) score += 100;
    if (base.startsWith('reference_')) score += 0.5;
    return { ...m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(s => s.score > 0).slice(0, max);
  // 即使零命中也至少給 ops_index / 幾個 reference_
  if (top.length === 0) {
    return scored.filter(s => /^ops_index|codemap/.test(s.file) || s.file.startsWith('reference_')).slice(0, max);
  }
  return top;
}

// ── 主程式 ──
let input = '';
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    if (process.env.CLAUDE_ENTRY_GATE_DISABLE === '1') process.exit(0);
    const data = JSON.parse(input || '{}');
    const toolName = data.tool_name || '';
    if (toolName !== 'Grep' && toolName !== 'Glob') process.exit(0);

    const toolInput = data.tool_input || {};
    if (!isEntrySearch(toolName, toolInput)) { debug('not entry-search, pass'); process.exit(0); }

    const memDir = findProjectMemoryDir(data.cwd);
    if (!memDir) { debug('no memory dir'); process.exit(0); }
    const memFiles = listMemoryFiles(memDir);
    if (memFiles.length < MIN_MEM_FILES) { debug(`too few memory files (${memFiles.length})`); process.exit(0); }

    const memDirNorm = memDir.replace(/\\/g, '/').toLowerCase();
    const scan = scanTranscript(data.transcript_path, memDirNorm);

    if (scan.memoryConsulted) { debug('memory already consulted, pass'); process.exit(0); }
    if (scan.toolCalls > EARLY_LIMIT) { debug(`past opening phase (${scan.toolCalls}), pass`); process.exit(0); }

    // ── BLOCK：列出相關記憶檔 ──
    const relevant = rankRelevant(memFiles, scan.promptText);
    const memDirShow = memDir.replace(/\\/g, '/');
    const lines = [];
    lines.push(`🛑 開場找入口前請先翻記憶（這是硬攔截，不是建議）`);
    lines.push(`   你在本場一開頭就用 ${toolName} 散搜找入口，但還沒讀過任何 project memory。`);
    lines.push(`   這個專案的 memory 有 ${memFiles.length} 個檔，入口鏈/handler 多半已記錄。`);
    lines.push(``);
    lines.push(`   先 read_file 讀下列最相關的記憶（或用 session_recall 回顧上一場）：`);
    for (const r of relevant) {
      lines.push(`     • ${memDirShow}/${r.rel}`);
    }
    lines.push(``);
    lines.push(`   確認入口真的不在記憶裡，再回來搜。讀任一 memory 檔即自動解除本場攔截。`);
    lines.push(`   （若這次純粹是找字串/SQL/註解而非找入口，本攔截不該觸發 → 到 MCP_Server 回報調規則；`);
    lines.push(`    或臨時 CLAUDE_ENTRY_GATE_DISABLE=1 關閉。）`);
    process.stderr.write(lines.join('\n') + '\n');
    process.exit(2);
  } catch (err) {
    debug(`error: ${err.message}`);
    process.exit(0);
  }
});
