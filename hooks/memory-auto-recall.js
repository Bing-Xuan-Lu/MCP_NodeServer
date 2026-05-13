#!/usr/bin/env node
/**
 * PreToolUse Hook — Memory Auto Recall
 *
 * 解「memory 是軟提醒、對話跑久就被擠出 attention」的通用問題。
 *
 * 機制：
 *   1. 掃描當前專案 memory dir 所有 *.md 的 frontmatter `triggers` 欄位
 *   2. 依當前 tool_name / file_path / 近期 user prompt 比對
 *   3. 命中且 (從未注入 OR 距上次注入超過 reinject_after_tool_calls) → stdout 注入提醒
 *   4. session 內以 ~/.claude/memory-recall-state/{session}.json 追蹤
 *
 * 非阻擋（exit 0）；任何錯誤靜默失敗。
 *
 * frontmatter 範例：
 *   triggers:
 *     tools: [Edit, Write, mcp__*__apply_diff, mcp__*__create_file]
 *     path_patterns: ['_harness', 'autocalc', 'PricingService']
 *     prompt_keywords: [sheet, 公式, harness, mapping]
 *     reinject_after_tool_calls: 30
 *
 * 沒有 triggers 欄位的 memory 被本 hook 略過（向後相容）。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { HOME, CLAUDE_HOOK_DEBUG as DEBUG_MODE } from '../env.js';

const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const STATE_DIR = path.join(HOME, '.claude', 'memory-recall-state');
const DEFAULT_REINJECT_AFTER = 30;
const MAX_INJECT_PER_CALL = 3;        // 同次 tool call 最多注入幾條 memory，避免雜訊
const RECENT_PROMPT_BYTES = 8192;     // 從 transcript 末端讀多少 bytes 找最近 user prompt
const BODY_PREVIEW_LINES = 6;

function debug(msg) {
  if (DEBUG_MODE) process.stderr.write(`[memory-recall] ${msg}\n`);
}

// ── 找當前專案 memory dir（重用 session-start 邏輯）──────────
function findProjectMemoryDir() {
  const cwd = process.cwd().replace(/\\/g, '/');
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
      .filter(e => e.isDirectory())
      .map(e => e.name);

    const cwdLower = cwd.toLowerCase().replace(/[:\\]/g, '-').replace(/\//g, '-');
    const matched = projects.find(p => cwdLower.includes(p.toLowerCase().replace(/--/, '-')));
    if (matched) {
      const memDir = path.join(PROJECTS_DIR, matched, 'memory');
      if (fs.existsSync(memDir)) return memDir;
    }
  } catch {}
  return null;
}

// ── Minimal YAML frontmatter parser（只解析 triggers 區塊需要的子集）──
//   支援：
//     key: value
//     key: [a, b, c]
//     key:
//       - item
//       - item
//     key:
//       subkey: value
//       subkey: [a, b]
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const body = m[1];
  return parseYamlBlock(body);
}

function parseYamlBlock(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const result = {};
  const stack = [{ obj: result, indent: -1, key: null }];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

    const indent = line.match(/^ */)[0].length;
    const stripped = line.slice(indent);

    // 退棧到 indent 對應層級
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    // array item: "- xxx"
    if (stripped.startsWith('- ')) {
      const val = parseScalar(stripped.slice(2).trim());
      const arrKey = stack[stack.length - 1].key;
      if (arrKey && Array.isArray(parent[arrKey])) {
        parent[arrKey].push(val);
      }
      i++;
      continue;
    }

    // key: value 或 key:
    const kv = stripped.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const rawVal = kv[2];
      if (rawVal === '' || rawVal === undefined) {
        // 下一個非空行可能是子物件或陣列
        const nextLine = lines.slice(i + 1).find(l => l.trim() && !l.trim().startsWith('#'));
        if (nextLine && nextLine.slice(nextLine.match(/^ */)[0].length).startsWith('- ')) {
          parent[key] = [];
          stack.push({ obj: parent, indent, key });
        } else {
          parent[key] = {};
          stack.push({ obj: parent[key], indent, key: null });
        }
      } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        // inline array: [a, b, c]
        const items = rawVal.slice(1, -1).split(',').map(s => parseScalar(s.trim())).filter(s => s !== '');
        parent[key] = items;
      } else {
        parent[key] = parseScalar(rawVal);
      }
      i++;
      continue;
    }

    i++;
  }
  return result;
}

function parseScalar(s) {
  if (s === '') return '';
  // strip quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// ── 通配比對（支援 mcp__*__xxx 這類）────────────────────
function matchToolName(pattern, toolName) {
  if (!pattern || !toolName) return false;
  if (pattern === toolName) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(toolName);
}

// ── 載入並解析所有 memory ──────────────────────────────
function loadMemoriesWithTriggers(memDir) {
  if (!memDir || !fs.existsSync(memDir)) return [];
  const memories = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 跳過特殊資料夾
        if (e.name === 'reports' || e.name === '_private' || e.name.startsWith('.')) continue;
        walk(fp);
      } else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md') {
        try {
          const content = fs.readFileSync(fp, 'utf-8');
          const fm = parseFrontmatter(content);
          if (!fm || !fm.triggers) continue;
          // 取 body（frontmatter 之後）
          const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
          const body = bodyMatch ? bodyMatch[1].trim() : '';
          memories.push({
            name: fm.name || path.basename(e.name, '.md'),
            description: fm.description || '',
            triggers: fm.triggers,
            body,
            relPath: path.relative(memDir, fp).replace(/\\/g, '/'),
          });
        } catch (err) {
          debug(`parse failed: ${fp} — ${err.message}`);
        }
      }
    }
  }
  walk(memDir);
  return memories;
}

// ── 從 transcript 抓最近 user prompts（最後 N bytes 內）──
function getRecentPromptText(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - RECENT_PROMPT_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const text = buf.toString('utf-8');
    // 取最後 3 個 user message 的 content
    const lines = text.split('\n').filter(Boolean);
    const userMessages = [];
    for (let i = lines.length - 1; i >= 0 && userMessages.length < 3; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
          userMessages.unshift(obj.message.content);
        } else if (obj.role === 'user' && typeof obj.content === 'string') {
          userMessages.unshift(obj.content);
        }
      } catch {}
    }
    return userMessages.join('\n');
  } catch (err) {
    debug(`transcript read failed: ${err.message}`);
    return '';
  }
}

// ── 判斷單筆 memory 是否命中當前 context ────────────────
function memoryMatches(memory, ctx) {
  const t = memory.triggers || {};
  let hit = false;
  const reasons = [];

  // 1. tools 比對
  if (Array.isArray(t.tools) && t.tools.length > 0) {
    if (t.tools.some(p => matchToolName(p, ctx.toolName))) {
      hit = true;
      reasons.push(`tool=${ctx.toolName}`);
    } else {
      // tools 有設定但沒命中 → 不算命中（tools 是必要條件）
      return null;
    }
  }

  // 2. path_patterns 比對（命中其一即可）
  if (Array.isArray(t.path_patterns) && t.path_patterns.length > 0) {
    const pathHit = t.path_patterns.find(p =>
      ctx.argsText.toLowerCase().includes(String(p).toLowerCase())
    );
    if (pathHit) {
      hit = true;
      reasons.push(`path~${pathHit}`);
    } else if (!Array.isArray(t.prompt_keywords) || t.prompt_keywords.length === 0) {
      // 沒設 prompt_keywords 時 path 是必要；設了則 path 或 keyword 命中即可
      return null;
    }
  }

  // 3. prompt_keywords 比對
  if (Array.isArray(t.prompt_keywords) && t.prompt_keywords.length > 0) {
    const promptHit = t.prompt_keywords.find(k =>
      ctx.promptText.toLowerCase().includes(String(k).toLowerCase())
    );
    if (promptHit) {
      hit = true;
      reasons.push(`prompt~${promptHit}`);
    } else if (!Array.isArray(t.path_patterns) || t.path_patterns.length === 0) {
      return null;
    }
  }

  // 如果只設了 tools，光命中 tools 不夠（避免太雜訊）
  // 必須至少有一個 path 或 keyword 維度命中
  const hasPathOrKeyword =
    (Array.isArray(t.path_patterns) && t.path_patterns.length > 0) ||
    (Array.isArray(t.prompt_keywords) && t.prompt_keywords.length > 0);
  if (hasPathOrKeyword && reasons.filter(r => r.startsWith('path') || r.startsWith('prompt')).length === 0) {
    return null;
  }

  return hit ? { reasons } : null;
}

// ── session 狀態管理 ─────────────────────────────────
function getStatePath(sessionId) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  return path.join(STATE_DIR, `${sessionId || 'default'}.json`);
}

function readState(sessionId) {
  try {
    const p = getStatePath(sessionId);
    if (!fs.existsSync(p)) return { tool_call_count: 0, memories: {} };
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { tool_call_count: 0, memories: {} };
  }
}

function writeState(sessionId, state) {
  try {
    fs.writeFileSync(getStatePath(sessionId), JSON.stringify(state));
  } catch {}
}

// ── 格式化注入訊息 ───────────────────────────────────
function formatRecall(memory, reasons) {
  const bodyLines = memory.body.split('\n').slice(0, BODY_PREVIEW_LINES).join('\n');
  const more = memory.body.split('\n').length > BODY_PREVIEW_LINES ? '\n  ...（詳見 memory/' + memory.relPath + '）' : '';
  return [
    `🧠 [Memory recall] ${memory.name}`,
    `   ${memory.description}`,
    `   觸發：${reasons.join(', ')}`,
    bodyLines.split('\n').map(l => '   ' + l).join('\n') + more,
  ].join('\n');
}

// ── 主程式 ───────────────────────────────────────────
let input = '';
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const sessionId = data.session_id || 'default';
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const transcriptPath = data.transcript_path || '';

    const memDir = findProjectMemoryDir();
    if (!memDir) { debug('no memory dir'); process.exit(0); }

    const memories = loadMemoriesWithTriggers(memDir);
    if (memories.length === 0) { debug('no memories with triggers'); process.exit(0); }

    // 組 context
    const argsText = JSON.stringify(toolInput);
    const promptText = getRecentPromptText(transcriptPath);
    const ctx = { toolName, argsText, promptText };

    // 讀 / 更新狀態
    const state = readState(sessionId);
    state.tool_call_count = (state.tool_call_count || 0) + 1;
    state.memories = state.memories || {};

    // 過濾命中且需要注入的
    const hits = [];
    for (const mem of memories) {
      const matched = memoryMatches(mem, ctx);
      if (!matched) continue;

      const memState = state.memories[mem.name] || { last_inject_count: -Infinity, inject_count: 0 };
      const reinjectAfter = mem.triggers.reinject_after_tool_calls || DEFAULT_REINJECT_AFTER;
      const since = state.tool_call_count - memState.last_inject_count;
      const shouldInject = memState.last_inject_count === -Infinity || memState.last_inject_count === undefined || since >= reinjectAfter;

      if (shouldInject) {
        hits.push({ mem, reasons: matched.reasons });
        state.memories[mem.name] = {
          last_inject_count: state.tool_call_count,
          inject_count: (memState.inject_count || 0) + 1,
        };
      }
    }

    if (hits.length > 0) {
      const top = hits.slice(0, MAX_INJECT_PER_CALL);
      const out = top.map(h => formatRecall(h.mem, h.reasons)).join('\n\n');
      process.stdout.write(out + '\n');
      debug(`injected ${top.length} memory recall(s)`);
    }

    writeState(sessionId, state);
  } catch (err) {
    debug(`error: ${err.message}`);
  }
  process.exit(0);
});
