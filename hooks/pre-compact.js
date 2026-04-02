#!/usr/bin/env node
/**
 * PreCompact Hook — context 壓縮前自動存快照
 *
 * 比 SessionEnd 更可靠：大部分對話不會正式結束（/exit），
 * 而是 context 滿了自動壓縮繼續，PreCompact 才是真正的存檔點。
 *
 * 做的事：
 * 1. 解析 transcript，擷取使用者訊息 + 使用工具 + 修改檔案
 * 2. 存快照到 ~/.claude/sessions/
 * 3. 偵測踩坑模式（重試 5+ 次、error-then-fix）
 * 4. 靜默失敗：不影響壓縮繼續進行
 *
 * 輸入（stdin JSON）：
 * { session_id, transcript_path, trigger }
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || process.env.USERPROFILE;
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const LEARNED_DIR = path.join(HOME, '.claude', 'skills', 'learned');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// === 找最近的 transcript（fallback 用）===
function findFallbackTranscript(originalPath) {
  const projectsDir = path.join(HOME, '.claude', 'projects');
  const searchDirs = [];

  if (originalPath) {
    const dir = path.dirname(originalPath);
    if (fs.existsSync(dir)) searchDirs.push(dir);
  }

  if (fs.existsSync(projectsDir)) {
    try {
      fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .forEach(e => searchDirs.push(path.join(projectsDir, e.name)));
    } catch (e) {}
  }

  let bestFile = null;
  let bestMtime = 0;

  for (const dir of searchDirs) {
    try {
      fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).forEach(f => {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (stat.mtimeMs > bestMtime) { bestMtime = stat.mtimeMs; bestFile = fp; }
      });
    } catch (e) {}
  }

  // 只接受 10 分鐘內的 transcript
  return (bestFile && (Date.now() - bestMtime) < 10 * 60 * 1000) ? bestFile : null;
}

// === 解析 transcript ===
function parseTranscript(transcriptPath) {
  if (!transcriptPath) return null;

  let actualPath = transcriptPath;
  if (!fs.existsSync(transcriptPath)) {
    actualPath = findFallbackTranscript(transcriptPath);
    if (!actualPath) return null;
  }

  const lines = fs.readFileSync(actualPath, 'utf-8').trim().split('\n');
  const userMessages = [];
  const toolsUsed = new Set();
  const filesModified = new Set();
  const toolCalls = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const msg = entry.message;
      if (!msg) continue;

      // 使用者訊息
      if (entry.type === 'user' && msg.content) {
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
            : '';
        const cleaned = text
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (cleaned && cleaned.length > 3) {
          userMessages.push(cleaned.substring(0, 200));
        }
      }

      // 工具呼叫
      if (entry.type === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            toolsUsed.add(block.name);
            const fp = block.input?.file_path || block.input?.path || '';
            toolCalls.push({
              name: block.name,
              target: typeof fp === 'string' ? path.basename(fp) : '',
              id: block.id,
            });
            if (['Edit', 'Write'].includes(block.name) && block.input?.file_path) {
              filesModified.add(path.basename(block.input.file_path));
            }
          }
          if (block.type === 'tool_result' && block.content) {
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
                : '';
            const lastCall = toolCalls[toolCalls.length - 1];
            if (lastCall) {
              lastCall.hasError = /error|Error|failed|Failed|not found|does not exist|TypeError/.test(resultText);
              lastCall.resultSnippet = resultText.substring(0, 150);
            }
          }
        }
      }
    } catch (e) {}
  }

  return { userMessages, toolsUsed: [...toolsUsed], filesModified: [...filesModified], toolCalls };
}

// === 踩坑偵測 ===
function detectPitfalls(parsed) {
  if (!parsed?.toolCalls) return [];
  const pitfalls = [];
  const skipTools = new Set(['TodoWrite', 'Agent', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);

  // 訊號 1：同工具同目標重試 5+ 次
  const retryMap = new Map();
  for (const call of parsed.toolCalls) {
    if (skipTools.has(call.name)) continue;
    const key = `${call.name}:${call.target}`;
    retryMap.set(key, (retryMap.get(key) || 0) + 1);
  }
  for (const [key, count] of retryMap) {
    if (count >= 5) {
      const [tool, target] = key.split(':');
      pitfalls.push({ type: 'retry', description: `${tool} 對 ${target || '同一目標'} 重試了 ${count} 次` });
    }
  }

  // 訊號 2：失敗後成功（error-then-fix）
  for (let i = 0; i < parsed.toolCalls.length; i++) {
    const call = parsed.toolCalls[i];
    if (!call.hasError) continue;
    for (let j = i + 1; j < parsed.toolCalls.length; j++) {
      const later = parsed.toolCalls[j];
      if (later.name === call.name && later.target === call.target && !later.hasError) {
        pitfalls.push({ type: 'error-then-fix', description: `${call.name} 對 ${call.target} 先失敗後成功` });
        break;
      }
    }
  }

  // 訊號 3：大量檔案修改（> 8 個 Write/Edit 目標）→ 提醒逐一確認
  const editedFiles = parsed.toolCalls
    .filter(c => ['Edit', 'Write'].includes(c.name) && c.target)
    .map(c => c.target);
  const uniqueEdited = new Set(editedFiles);
  if (uniqueEdited.size > 8) {
    pitfalls.push({ type: 'mass-change', description: `本次 session 修改了 ${uniqueEdited.size} 個不同檔案，建議逐一確認變更正確性` });
  }

  return pitfalls;
}

// === 清舊 pitfall 紀錄（只保留 7 天內）===
function gcOldPitfalls() {
  if (!fs.existsSync(LEARNED_DIR)) return;
  try {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000;
    fs.readdirSync(LEARNED_DIR)
      .filter(f => f.startsWith('auto-pitfall-') && f.endsWith('.md'))
      .map(f => ({ path: path.join(LEARNED_DIR, f), mtime: fs.statSync(path.join(LEARNED_DIR, f)).mtimeMs }))
      .filter(f => (now - f.mtime) > maxAge)
      .forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
  } catch (e) {}
}

// === 存踩坑紀錄 ===
function savePitfalls(pitfalls) {
  if (pitfalls.length === 0) return;
  ensureDir(LEARNED_DIR);

  const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const slug = `auto-pitfall-${dateStr}`;
  let filename = `${slug}.md`;

  if (fs.existsSync(path.join(LEARNED_DIR, filename))) {
    filename = `${slug}-${Math.random().toString(36).substring(2, 5)}.md`;
  }

  const content = `# 踩坑紀錄 ${new Date().toISOString().split('T')[0]}

## 偵測到的問題

${pitfalls.map(p => `### ${p.type}\n- ${p.description}`).join('\n\n')}

## 教訓
（下次 session 開始時自動讀取提醒）
`;
  fs.writeFileSync(path.join(LEARNED_DIR, filename), content, 'utf-8');
}

// === 主程式 ===
function main(inputData) {
  try {
    let data;
    try { data = JSON.parse(inputData); } catch (e) { return; }

    const parsed = parseTranscript(data.transcript_path);
    if (!parsed || parsed.userMessages.length === 0) return;

    ensureDir(SESSIONS_DIR);

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].substring(0, 5);
    const shortId = (data.session_id || '').substring(0, 8) || Math.random().toString(36).substring(2, 6);
    const filename = `${dateStr}-${shortId}-compact.md`;
    const triggerLabel = (data.trigger === 'auto') ? 'auto（context 已滿）' : 'manual（/compact）';

    const recentMessages = parsed.userMessages.slice(-8);
    const titleHint = parsed.userMessages.filter(m => m.length > 5).slice(0, 3).join(' ').substring(0, 60);

    const summary = `# Compact 快照：${dateStr}
**時間：** ${timeStr}
**觸發：** ${triggerLabel}
**訊息數：** ${parsed.userMessages.length}
**標題：** ${titleHint}

## 最近的要求（後 8 則）
${recentMessages.map(m => `- ${m}`).join('\n')}

## 使用的工具
${parsed.toolsUsed.join(', ') || '無'}

## 修改的檔案
${parsed.filesModified.length > 0 ? parsed.filesModified.map(f => `- ${f}`).join('\n') : '無'}
`;

    fs.writeFileSync(path.join(SESSIONS_DIR, filename), summary, 'utf-8');

    // 踩坑偵測
    const pitfalls = detectPitfalls(parsed);
    if (pitfalls.length > 0) savePitfalls(pitfalls);

    // 清舊 pitfall
    gcOldPitfalls();

    // 清理舊快照（只保留最近 20 份）
    try {
      const snapshots = fs.readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith('-compact.md') || f.endsWith('-session.md'))
        .map(f => ({ path: path.join(SESSIONS_DIR, f), mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      snapshots.slice(20).forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
    } catch (e) {}

  } catch (err) {
    process.stderr.write(`[pre-compact] error: ${err.message}\n`);
  }
}

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => main(input));
