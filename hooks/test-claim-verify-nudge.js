#!/usr/bin/env node
/**
 * Stop Hook — Test-Claim Verify Nudge（宣稱「測完/可以用了」但本回合沒真的驗證 → 提醒）
 * source-verified: 仿 verify-pass-guard.js / commit-nag-guard.js 樣板。
 *
 * 問題（使用者原話）：「每次說測試完，每次都有問題」「測試 skill 從來沒發動」。
 *   AI 常只讀 code / 只跑 php -l 語法檢查 / 純嘴巴，就宣稱「測試完成、可以用了、沒問題」，
 *   卻沒用任何實際驗證工具打過實際頁面或資料。/verify、/tdd 這類 skill 是使用者手動觸發，
 *   AI 不會自發跑，所以驗證這一步常被跳過。
 *
 * 與 verify-pass-guard 的分工：
 *   - verify-pass-guard 抓「N/N PASS / 全數通過」多筆宣告缺逐格明細（有驗但粒度/範圍不夠）。
 *   - 本 hook 抓「測完了 / 可以用了 / 沒問題」但這回合**完全沒跑任何實際驗證工具**（根本沒驗）。
 *
 * 機制：
 *   1. 讀 transcript：最後一則 assistant 文字 + 自「最後一則真人 user 訊息」以來的所有 tool_use
 *   2. assistant 有「完成/測過/可以用了」宣稱，且該回合的 tool_use 裡沒有任何「實際驗證工具」
 *      （browser 互動 / HTTP / SQL / run_php_test / page_audit / 非 lint 的 run_php_*）→ 擋，提醒先實測或 /verify
 *   3. 誠實說「還沒測 / 未驗證」→ 放行（鼓勵誠實，同 self-admission 精神）
 *   4. 防迴圈：stop_hook_active 放行；同訊息 hash 不重複擋
 *
 * 任何錯誤一律靜默放行（exit 0）。
 */

import fs from 'fs';
import path from 'path';
import { HOME, CLAUDE_HOOK_DEBUG as DEBUG_MODE } from '../env.js';

const STATE_DIR = path.join(HOME, '.claude', 'test-claim-nudge-state');

function writeStdoutUtf8(s) { process.stdout.write(Buffer.from(s, 'utf8')); }
function writeStderrUtf8(s) { process.stderr.write(Buffer.from(s, 'utf8')); }
function debug(msg) { if (DEBUG_MODE) writeStderrUtf8(`[test-claim-verify-nudge] ${msg}\n`); }

// ── 「測完 / 可以用了 / 沒問題」宣稱 pattern ──────
const DONE_CLAIM_PATTERNS = [
  /(?:測試?|功能)?\s*(?:測試?|驗證)\s*(?:完成|完畢|過了?|好了?|OK|通過)/i,
  /(?:已|都)\s*(?:測試?|驗證)\s*(?:過|完|好)/,
  /(?:可以|能夠?|沒問題可以)\s*(?:正常)?\s*(?:使用|用了|上線|部署|上版|交付)/,
  /(?:功能|一切|運作)\s*(?:都)?\s*(?:正常|沒問題|無誤|OK)/i,
  /(?:沒(?:有)?問題了?|沒(?:有)?錯誤了?|不會(?:再)?出錯了?)/,
  /(?:修好了?|搞定了?|處理完了?)(?:，|,|。|！|!|\s)*(?:測試?|驗證)/,
];

// ── 誠實承認「還沒測 / 未驗證」→ 放行 ──────
const NOT_YET_TESTED_RE =
  /(?:還沒|尚未|未|沒有?)\s*(?:實際)?\s*(?:測試?|驗證|跑過|打過|端到端)|建議(?:你)?\s*(?:再)?(?:實)?測|需(?:要)?(?:你)?(?:實際)?測(?:試)?|請(?:你)?(?:幫忙)?測(?:試)?一?下|尚待驗證|待測/;

// ── 實際驗證工具（用了任一即代表這回合有真的驗證）──────
const STRONG_VERIFY_TOOLS = new Set([
  'browser_interact',
  'page_audit',
  'send_http_request',
  'send_http_requests_batch',
  'execute_sql',
  'execute_sql_batch',
  'run_php_test',
  'css_inspect',
  'css_computed_winner',
  'element_measure',
]);
// Playwright MCP 的互動類（前綴比對）
const PLAYWRIGHT_VERIFY_RE = /browser_(?:click|navigate|evaluate|snapshot|fill_form|type|take_screenshot|wait_for|select_option|hover|press_key|run_code)/;
// run_php_code / run_php_script：非 lint 才算驗證
const RUN_PHP_RE = /run_php_(?:code|script|script_batch)$/;

function toolBase(name) {
  // 去掉 mcp__project-migration-assistant-pro__ / mcp__playwright-xxx__ 前綴
  const m = String(name || '').split('__');
  return m[m.length - 1];
}

function isVerificationTool(name, input) {
  const base = toolBase(name);
  if (STRONG_VERIFY_TOOLS.has(base)) return true;
  if (PLAYWRIGHT_VERIFY_RE.test(base)) return true;
  if (RUN_PHP_RE.test(base)) {
    // lint:true 只是語法檢查，不算功能驗證
    if (input && input.lint === true) return false;
    return true;
  }
  return false;
}

function extractText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x?.type === 'text').map((x) => x.text || '').join('\n');
  return '';
}

// 判斷一則 user-type 訊息是否為「真人訊息」（非 tool_result 回填）
function isHumanUserMsg(obj) {
  if (obj.type !== 'user' || obj.message?.role !== 'user') return false;
  const c = obj.message.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) return c.some((x) => x?.type === 'text');
  return false;
}

// 讀最後一則 assistant 文字，並收集「自最後一則真人 user 訊息以來」的所有 tool_use
function readTurn(transcriptPath) {
  const result = { assistant: '', tools: [] };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return result;
  let objs;
  try {
    objs = fs.readFileSync(transcriptPath, 'utf-8').trim().split(/\r?\n/)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return result; }

  // 找最後一則真人 user 訊息的 index
  let lastHumanIdx = -1;
  for (let i = objs.length - 1; i >= 0; i--) {
    if (isHumanUserMsg(objs[i])) { lastHumanIdx = i; break; }
  }

  // 最後一則 assistant 文字
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o.type === 'assistant' && o.message?.role === 'assistant') {
      const t = extractText(o.message.content);
      if (t) { result.assistant = t; break; }
    }
  }

  // 收集 lastHumanIdx 之後的 tool_use
  for (let i = lastHumanIdx + 1; i < objs.length; i++) {
    const o = objs[i];
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const item of o.message.content) {
        if (item?.type === 'tool_use') result.tools.push({ name: item.name, input: item.input });
      }
    }
  }
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

    const { assistant, tools } = readTurn(data.transcript_path || '');
    if (!assistant.trim()) return allow();

    // 沒有「測完/可以用了」宣稱 → 放行
    if (!DONE_CLAIM_PATTERNS.some((re) => re.test(assistant))) {
      debug('無測完宣稱 → 放行');
      return allow();
    }
    // 誠實說還沒測 → 放行
    if (NOT_YET_TESTED_RE.test(assistant)) {
      debug('誠實承認還沒測 → 放行');
      return allow();
    }
    // 這回合有跑實際驗證工具 → 放行
    if (tools.some((t) => isVerificationTool(t.name, t.input))) {
      debug('本回合有實際驗證工具 → 放行');
      return allow();
    }

    const state = loadState(sessionId);
    const claimHash = quickHash(assistant.slice(-600));
    const seen = Array.isArray(state.hashes) ? state.hashes : [];
    if (seen.includes(claimHash)) { debug('同一宣稱已擋過 → 放行'); return allow(); }

    state.blocks = (state.blocks || 0) + 1;
    seen.push(claimHash);
    state.hashes = seen.slice(-100);
    saveState(sessionId, state);

    const usedTools = tools.map((t) => toolBase(t.name)).filter(Boolean);
    const toolsNote = usedTools.length
      ? `本回合只用了：${[...new Set(usedTools)].join(', ')}（都不是實際驗證）`
      : '本回合完全沒有任何 tool call';

    const reason =
      '🛑 [Test-Claim Verify Nudge] 你宣稱「測完 / 可以用了 / 沒問題」，但這回合沒跑任何「實際驗證」工具。\n\n' +
      `  ${toolsNote}。\n` +
      '  讀 code、php -l 語法檢查、看 git diff —— 都只證明「寫出來了」，不證明「跑起來對」。\n\n' +
      '  結束前請至少做其一（挑對應這次改動的）：\n' +
      '    • 前端 / 互動 → browser_interact 實際點擊操作，並確認畫面/資料真的變了\n' +
      '    • 頁面能否正常渲染 / 後端有無 fatal → send_http_request 打實際 URL 看 200 + body 內容\n' +
      '    • 資料有沒有真的寫進去 / 值對不對 → execute_sql 撈出來逐格對\n' +
      '    • 一次跑完整驗收 → 跑 /verify skill\n' +
      '  若這次改動確實無法端到端測（如純設定檔 / 純文件），明確說「此改動無法實測，原因 X，未驗證」即可結束。\n' +
      `  （本 session 第 ${state.blocks} 次）`;

    writeStdoutUtf8(JSON.stringify({ decision: 'block', reason }));
    debug(`BLOCK stop (#${state.blocks})`);
    process.exit(0);
  } catch (e) {
    debug(`error (ignored): ${e.message}`);
    process.exit(0);
  }
});
