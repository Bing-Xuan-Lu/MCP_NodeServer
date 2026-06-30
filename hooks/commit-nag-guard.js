#!/usr/bin/env node
/**
 * Stop Hook — Commit Nag Guard（防「做完就主動提 commit/push 當收尾」）
 * source-verified: 仿本 session 已讀過的 verify-pass-guard.js 樣板，純新增獨立 Stop hook。
 *
 * 問題：CLAUDE.md 明令「禁止自動 commit/push，也不要做完就提 commit 當收尾」，
 *       但純文字規則在長對話裡會被注意力衰減 + 收尾反射蓋過（實際踩過：改完 hook 後
 *       主動問「要不要我 commit 起來」）。純靠自律守不住，故補一個 Stop hook 主動攔。
 *
 * 機制（仿 verify-pass-guard）：
 *   1. 讀 transcript 末端「最後一則 assistant 文字」與「最後一則 user 文字」
 *   2. 若 assistant 訊息出現「主動提 commit/push/git add」pattern
 *      且本回合 user 自己沒提過 commit/git → 擋下回合，要求拿掉那句
 *   3. 透過 {"decision":"block","reason":...} 餵回提醒
 *   4. 防迴圈：stop_hook_active 放行；同一訊息 hash 不重複擋
 *
 * 放行（避免誤擋，呼應「hook 不該過嚴」的教訓）：
 *   - user 最近一則訊息自己提到 commit/push/git/推版（使用者起的話題，回應不算 nag）
 *   - 只讀 git（status/diff/log）不算——pattern 只抓 add/commit/push
 *
 * 任何錯誤一律靜默放行（exit 0），絕不因 hook 異常卡住回合。
 */

import fs from 'fs';
import path from 'path';
import { HOME, CLAUDE_HOOK_DEBUG as DEBUG_MODE } from '../env.js';

const STATE_DIR = path.join(HOME, '.claude', 'commit-nag-guard-state');

function writeStdoutUtf8(s) { process.stdout.write(Buffer.from(s, 'utf8')); }
function writeStderrUtf8(s) { process.stderr.write(Buffer.from(s, 'utf8')); }
function debug(msg) { if (DEBUG_MODE) writeStderrUtf8(`[commit-nag-guard] ${msg}\n`); }

// ── 主動提 commit/push 的 nag pattern ──────
const COMMIT_NAG_PATTERNS = [
  /要不要(我|你)?.{0,14}(commit|push|git\s*(?:add|commit|push))/i,
  /要(我|不要我).{0,10}(commit|push)/i,
  /(幫你|幫我|我來|我幫你|需要我).{0,10}(commit|push)/i,
  /(可以|現在|接著|然後|要不要先|記得|別忘了|建議).{0,8}(commit|push)\s*(?:了|起來|上去|嗎|吧|喔)?/i,
  /commit\s*(?:起來|上去|一下|嗎|吧|了嗎)/i,
  /\bgit\s+(?:add|commit|push)\b/i,
];

// ── 使用者本回合自己起的 commit 話題 → 放行 ──────
const USER_COMMIT_TOPIC = /commit|push|\bgit\b|推版|推上去|推上版|推一版|送上去/i;

function extractText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x?.type === 'text').map((x) => x.text || '').join('\n');
  return '';
}

// 回傳最後一則 assistant 純文字，與最近數則 user 純文字（窗口）。
//   user 用窗口而非單則：slash 指令流程（如 /git_commit）中，觸發指令的 user 訊息
//   常在「選項回覆」之前 1~2 則，只看最後一則會漏判使用者其實本回合已起 commit 話題。
const USER_WINDOW = 6;
function readTranscriptTail(transcriptPath) {
  const result = { assistant: '', user: '', userWindow: '' };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return result;
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split(/\r?\n/);
    const userTexts = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      if (result.assistant && userTexts.length >= USER_WINDOW) break;
      let obj;
      try { obj = JSON.parse(lines[i]); } catch { continue; }
      const role = obj.message?.role;
      if (obj.type === 'assistant' && role === 'assistant' && !result.assistant) {
        result.assistant = extractText(obj.message.content);
      } else if (obj.type === 'user' && role === 'user' && userTexts.length < USER_WINDOW) {
        const t = extractText(obj.message.content);
        if (t) userTexts.push(t);
      }
    }
    result.user = userTexts[0] || '';
    result.userWindow = userTexts.join('\n');
  } catch { /* unreadable → 放行 */ }
  return result;
}

function loadState(sessionId) {
  try {
    const f = path.join(STATE_DIR, `${sessionId}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch { /* ignore */ }
  return { blocks: 0, hashes: [] };
}
function saveState(sessionId, state) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, `${sessionId}.json`), JSON.stringify(state));
  } catch { /* ignore */ }
}
function quickHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}
function allow() { process.exit(0); }

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const sessionId = data.session_id || 'default';

    if (data.stop_hook_active) { debug('stop_hook_active → 放行'); return allow(); }

    const { assistant, userWindow } = readTranscriptTail(data.transcript_path || '');
    if (!assistant.trim()) return allow();

    // 使用者本回合自己提到 commit/git（含 /git_commit 等 slash 指令）→ 我回應這話題不算主動 nag
    if (USER_COMMIT_TOPIC.test(userWindow)) { debug('user 起的 commit 話題（窗口）→ 放行'); return allow(); }

    if (!COMMIT_NAG_PATTERNS.some((re) => re.test(assistant))) {
      debug('無主動 commit/push 提示 → 放行');
      return allow();
    }

    const state = loadState(sessionId);
    const claimHash = quickHash(assistant.slice(-600));
    const seen = Array.isArray(state.hashes) ? state.hashes : [];
    if (seen.includes(claimHash)) { debug('同一訊息已擋過 → 放行'); return allow(); }

    state.blocks = (state.blocks || 0) + 1;
    seen.push(claimHash);
    state.hashes = seen.slice(-100);
    saveState(sessionId, state);

    const reason =
      '🛑 [Commit Nag Guard] 你在回合收尾主動提到 commit / push / git add，但這回合使用者沒有要求。\n\n' +
      '  CLAUDE.md 明令：禁止自動 commit/push，也「不要做完就提 commit 當收尾」——使用者要 commit/push 自己會開口。\n\n' +
      '  → 請把訊息裡主動提 commit / push / git add 的那句話拿掉，再結束回合。\n' +
      '  → 把檔案改到位即可，不需要催、也不需要提交建議。\n' +
      '  （若使用者其實這回合有提到 commit，這是誤擋，回報以便放寬 USER_COMMIT_TOPIC 判斷）';

    writeStdoutUtf8(JSON.stringify({ decision: 'block', reason }));
    debug(`BLOCK stop (#${state.blocks})`);
    process.exit(0);
  } catch (e) {
    debug(`error (ignored): ${e.message}`);
    process.exit(0);
  }
});
