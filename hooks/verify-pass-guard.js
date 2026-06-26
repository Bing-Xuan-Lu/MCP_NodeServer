#!/usr/bin/env node
/**
 * Stop Hook — Verify Pass Guard（防「合計對就宣告全 PASS」的驗證偷懶）
 *
 * 問題：宣告「N/N PASS」「全部通過」這類多筆驗證結論時，只驗了 headline 合計
 *       （aggregate）就放行，沒逐行/逐格攤明細（breakdown）——合計對不代表每一格都對。
 *
 * 為何掛 Stop 而非 PreToolUse：PASS 宣告通常是回合結尾的純文字、後面沒接 tool call，
 *       PreToolUse 結構上抓不到。Stop hook 在回合結束時掃 assistant 最後一則訊息才攔得到。
 *
 * 機制：
 *   1. 讀 transcript 末端的「最後一則 assistant 文字」
 *   2. 命中「多筆/多項 PASS 宣告」pattern，且訊息內沒有逐行/逐格證據關鍵字 → 擋下回合
 *   3. 透過 {"decision":"block","reason":...} 把提醒餵回給 Claude，要求補明細逐格證據
 *   4. 防迴圈：stop_hook_active=true 直接放行；同一宣告（hash）不重複擋；無每場次數上限（每個新的未附明細 PASS 宣告都擋）
 *
 * 任何錯誤一律靜默放行（exit 0），絕不因 hook 異常卡住回合。
 */

import fs from 'fs';
import path from 'path';
import { HOME, CLAUDE_HOOK_DEBUG as DEBUG_MODE } from '../env.js';

const STATE_DIR = path.join(HOME, '.claude', 'verify-pass-guard-state');

// Windows Node 對 stdout/stderr 預設使用系統 ANSI codepage（zh-TW = cp950），
// 中文 BLOCK reason 寫出去會變 `??`。強制以 UTF-8 Buffer 寫，避免被 harness 重新解碼壞掉。
function writeStdoutUtf8(s) {
  process.stdout.write(Buffer.from(s, 'utf8'));
}
function writeStderrUtf8(s) {
  process.stderr.write(Buffer.from(s, 'utf8'));
}

function debug(msg) {
  if (DEBUG_MODE) writeStderrUtf8(`[verify-pass-guard] ${msg}\n`);
}

// ── 多筆/多項 PASS 宣告 pattern（語意上是「一批東西全過」的結論）──────
const PASS_CLAIM_PATTERNS = [
  // N/N PASS、7 / 7 通過、12/12 全過
  /(\d+)\s*\/\s*(\d+)\s*[^\n]{0,8}?(?:PASS|通過|皆通過|都通過|全過|正確|無誤)/i,
  // 全部 / 全數 / 所有 (case/測試/項目/筆/頁...) 都 PASS / 通過
  /(?:全部?|全數|所有|逐筆全|每一[筆項頁張個])\s*(?:的)?\s*(?:case|cases|測試|項目|功能|欄位|筆|頁|張|個|項)?\s*(?:都\s*|皆\s*|全\s*)?(?:PASS|通過|正確|無誤|OK)/i,
  // 全 PASS、全數通過（不含「全綠」：那是監控/CI 狀態燈用語，非資料逐筆驗證 PASS，會誤抓診斷訊息）
  /全\s*(?:PASS|數通過)/i,
  // N 筆/頁/張 全部/都/皆 通過
  /(\d+)\s*(?:筆|頁|張|個|項|case)\s*(?:全部?|都|皆)\s*(?:通過|PASS|正確|無誤|過)/i,
];

// ── 逐行/逐格證據關鍵字（出現代表已攤明細，放行）──────
const BREAKDOWN_EVIDENCE_RE =
  /(逐行|逐格|逐欄位|逐項|逐筆列|每一行|每一格|每個欄位|每筆明細|明細.{0,4}(?:逐|每|對照)|breakdown|per[-\s]?(?:row|line|field|item))/i;

function hasPassClaim(text) {
  return PASS_CLAIM_PATTERNS.some((re) => re.test(text));
}

function hasBreakdownEvidence(text) {
  return BREAKDOWN_EVIDENCE_RE.test(text);
}

// markdown 逐列表格 = 已攤明細：有分隔列 |---|---| 且其後至少 2 行資料列。
// 用表格逐列列「項目 / 實際 / 預期」本來就是逐格證據，不該被當成裸 headline 而擋。
function hasTabularBreakdown(text) {
  const lines = text.split(/\r?\n/);
  const sepRe = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;
  const rowRe = /^\s*\|.*\|.*$/;
  let hasSep = false;
  let dataRows = 0;
  for (const ln of lines) {
    if (sepRe.test(ln)) { hasSep = true; continue; }
    if (hasSep && rowRe.test(ln)) dataRows++;
  }
  return hasSep && dataRows >= 2;
}

// ── 讀 transcript 最後一則 assistant 的純文字內容 ──────
function readLastAssistantText(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
          const c = obj.message.content;
          if (typeof c === 'string') return c;
          if (Array.isArray(c)) {
            return c
              .filter((x) => x?.type === 'text')
              .map((x) => x.text || '')
              .join('\n');
          }
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* unreadable transcript → 放行 */
  }
  return '';
}

// ── session 狀態（防迴圈 + 去重 + 次數上限）──────
function loadState(sessionId) {
  try {
    const f = path.join(STATE_DIR, `${sessionId}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch {
    /* ignore */
  }
  return { blocks: 0, lastHash: '' };
}

function saveState(sessionId, state) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, `${sessionId}.json`), JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

// 簡易 hash（同一段宣告文字 → 同 hash，避免對同一回合重複擋）
function quickHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

function allow() {
  process.exit(0);
}

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const sessionId = data.session_id || 'default';
    const transcriptPath = data.transcript_path || '';

    // 防迴圈：上一次就是被本 hook 擋下後繼續的 → 不再擋
    if (data.stop_hook_active) {
      debug('stop_hook_active → 放行');
      return allow();
    }

    const text = readLastAssistantText(transcriptPath);
    if (!text.trim()) return allow();

    if (!hasPassClaim(text)) {
      debug('無 PASS 宣告 → 放行');
      return allow();
    }
    if (hasBreakdownEvidence(text) || hasTabularBreakdown(text)) {
      debug('已含逐行/逐格證據或 markdown 逐列表格 → 放行');
      return allow();
    }

    const state = loadState(sessionId);
    const claimHash = quickHash(text.slice(-600)); // 取訊息尾段做指紋
    const seen = Array.isArray(state.hashes) ? state.hashes : (state.lastHash ? [state.lastHash] : []);

    if (seen.includes(claimHash)) {
      debug('同一宣告已擋過 → 放行');
      return allow();
    }

    state.blocks = (state.blocks || 0) + 1;
    seen.push(claimHash);
    state.hashes = seen.slice(-100);
    saveState(sessionId, state);

    const reason =
      '🛑 [Verify Pass Guard] 你宣告了多筆/多項「PASS / 全部通過」，但這則訊息看不到逐行/逐欄位的實際值對照。\n\n' +
      '  合計（aggregate / headline 單一數字）對 ≠ 明細（breakdown 每一行/每一格）對。\n' +
      '  前車之鑑：某專案 部分退貨單只驗 refund_amount=245 合計就宣告 7/7 PASS，漏掉「運費」那行顯示 $0 的破綻。\n\n' +
      '  請在結束前補上：\n' +
      '    1. 明細類畫面（退款/報價/訂單明細等）逐格列「實際顯示值 vs 預期值」，每一格都要有\n' +
      '    2. N 筆 case 各自的明細，不能抽驗一筆就推論全過\n' +
      '  若該畫面確實沒有明細層、只有單一數字，請明確說明「此 case 無明細需驗，僅 headline」即可結束。\n' +
      `  （本 session 第 ${state.blocks} 次；每個未附明細的 PASS 宣告都會擋，直到逐格列證據或明確說明此 case 無明細可驗）`;

    // Stop hook：以 JSON decision=block 餵回 reason，要求 Claude 繼續處理
    writeStdoutUtf8(JSON.stringify({ decision: 'block', reason }));
    debug(`BLOCK stop (#${state.blocks})`);
    process.exit(0);
  } catch (e) {
    debug(`error (ignored): ${e.message}`);
    process.exit(0);
  }
});
