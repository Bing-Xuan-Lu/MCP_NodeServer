#!/usr/bin/env node
/**
 * PreToolUse Hook — MCP Down Guard（MCP 斷線守門員）
 *
 * 問題：MCP Server 斷線後（timeout / connection refused / server failed），
 *       MCP 工具（mcp__*）全部不可用，但內建工具（Read/Grep/Edit/Bash/TodoWrite）
 *       依然可用。Claude 會自動退回去用 Grep 散搜 PHP/JS、用 Bash docker mysql 等等，
 *       這正是 CLAUDE.md 明令禁止的「繞道」模式。
 *
 * 機制：
 *   1. 掃 transcript 末段 ~30 步，找最近一次 mcp__* 工具呼叫的 tool_result
 *   2. 若該結果含 MCP 斷線特徵字串（timeout / connection / server disconnected 等）
 *      且其後沒有任何 mcp__* 成功呼叫 → 判定 MCP 仍斷線
 *   3. 斷線狀態下：
 *      - TodoWrite 放行（讓 Claude 標記停止 / 規劃）
 *      - 其餘所有工具 BLOCK，要求 Claude 用純文字回報使用者並等 Reconnect
 *   4. MCP 恢復後（成功呼叫 mcp__* 一次）自動解除封鎖
 *
 * 為什麼 hook 能擋（即使 MCP 斷線）：
 *   hook 是 Claude Code 本體 spawn `node hooks/mcp-down-guard.js`，跟 MCP Server 完全
 *   獨立。MCP 斷線只影響 mcp__* 工具，hook 程序照跑。
 *
 * 任何錯誤一律靜默放行（exit 0），絕不因 hook 異常卡住工作流。
 */

import fs from 'fs';
import { CLAUDE_HOOK_DEBUG as DEBUG_MODE } from '../env.js';

const SCAN_DEPTH = 60;          // 掃 transcript 末段幾則 entry（不是 tool call 數，是 jsonl 行數）
const ALLOWLIST = new Set([     // MCP 斷線時仍允許的工具
  'TodoWrite',                  // 讓 Claude 標記 stop / 規劃
]);

// MCP 斷線特徵字串（出現在 tool_result 內容裡才算）— 硬證據：mcp__ 工具實際被呼叫且失敗
const MCP_DOWN_PATTERNS = [
  /MCP server\s+"[^"]*"\s+(?:connection\s+)?(?:timed out|failed|disconnected)/i,
  /MCP\s+(?:server|connection)\s+(?:timeout|timed out|failed|disconnected|not connected)/i,
  /connection\s+timed\s+out\s+after\s+\d+\s*ms/i,
  /ECONNREFUSED|ETIMEDOUT|EPIPE/,
  /failed to (?:start|connect to)\s+MCP/i,
  /MCP server crashed/i,
  /not connected to MCP/i,
  /server transport closed/i,
];

// Claude 自己「宣稱 MCP 現在不可用」的敘述（軟證據）。用於捕捉「工具從 deferred 清單消失、
// 根本沒被呼叫、因此沒有失敗 tool_result」的故障模式——這正是本 guard 原本的盲點。
// 僅在「最近完全沒有 mcp__ 成功呼叫（unknown 狀態）」＋「當前正跑 DB/PHP/HTTP 繞道指令」時才配合觸發，
// 避免把「純粹在分析/討論 MCP 斷線」的 meta 情境誤擋。
const MCP_DOWN_NARRATION = [
  /MCP.{0,10}(?:斷線|掉線|沒連上|沒連線|失效|不可用|掛了|全部失效|全失效)/,
  /(?:deferred|工具)\s*清單.{0,12}(?:只(?:有|剩)|沒有|少了|不見|沒出現)/,
  /heartbeat\s*(?:停|沒|未|過期|stale)/i,
  /(?:execute_sql|run_php|gsheet_|run_python).{0,20}(?:失效|不可用|無法|全部失效|用不了)/,
  /MCP\s+(?:tools?|工具).{0,10}(?:全部)?(?:不可用|失效|用不了|沒了)/i,
];

// 當前正要執行的「DB/PHP/HTTP 繞道」Bash 指令特徵（MCP 斷線時 Claude 最常改用的旁路）。
// 一般 Bash（git/node/ls/diff/一般 grep）不在此列，避免誤擋 meta 維護工作。
const BYPASS_BASH_PATTERNS = [
  /docker\s+exec[^\n]*\b(?:mysql|php|python|psql|mariadb)/i,
  /\bmysql\s+-/i,
  /\bmysqldump\b/i,
  /\bpsql\s+-/i,
  /\bcurl\s+(?:-|https?:|localhost|127\.)/i,
  /\bphp\s+-r\b/i,
];

/** 當前工具是否為 DB/PHP/HTTP 繞道指令（Bash + 特徵 command） */
function isBypassTool(toolName, toolInput) {
  if (toolName !== 'Bash') return false;
  const cmd = toolInput?.command || '';
  return BYPASS_BASH_PATTERNS.some((re) => re.test(cmd));
}

function debug(msg) {
  if (DEBUG_MODE) process.stderr.write(`[mcp-down-guard] ${msg}\n`);
}

function allow() {
  process.exit(0);
}

/** 把 content（可能是 string / array of blocks）展平成單一字串 */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (b?.type === 'text') return b.text || '';
      if (b?.type === 'tool_result') return flattenContent(b.content);
      return '';
    })
    .join('\n');
}

/**
 * 從 transcript 找最近的 mcp__* 工具呼叫狀態（三態）
 * @returns {{status:'down', lastFailTool, lastFailReason} | {status:'healthy'} | {status:'unknown'}}
 *   down    = 最近一次 mcp__* 呼叫失敗且含斷線特徵（硬證據）
 *   healthy = 最近一次 mcp__* 呼叫成功（server 證實活著）
 *   unknown = 末段窗口內完全沒有 mcp__* 結果（工具可能從清單消失、沒被呼叫）
 */
function scanMcpState(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { status: 'unknown' };
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split(/\r?\n/);
  } catch {
    return { status: 'unknown' };
  }
  if (lines.length === 0) return { status: 'unknown' };

  // 只掃末段 SCAN_DEPTH 行，倒序找
  const tail = lines.slice(-SCAN_DEPTH);

  // 先建立 tool_use_id → toolName 對照（往前找 assistant 的 tool_use 區塊）
  const useIdToName = new Map();
  for (const line of tail) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const b of obj.message.content) {
          if (b?.type === 'tool_use' && b.id && b.name) {
            useIdToName.set(b.id, b.name);
          }
        }
      }
    } catch { /* skip malformed */ }
  }
  debug(`useIdToName size=${useIdToName.size} keys=${[...useIdToName.keys()].slice(0,3).join(',')}`);

  // 倒序找最近一次有結果的 mcp__* 工具呼叫
  for (let i = tail.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(tail[i]); } catch { continue; }
    if (obj.type !== 'user') continue;
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const toolName = useIdToName.get(block.tool_use_id) || '';
      debug(`tool_result use_id=${block.tool_use_id} resolved name="${toolName}" is_error=${block.is_error}`);
      if (!toolName.startsWith('mcp__')) continue;

      const resultText = flattenContent(block.content);
      const isError = block.is_error === true;
      const looksMcpDown = MCP_DOWN_PATTERNS.some((re) => re.test(resultText));

      if (isError && looksMcpDown) {
        const m = resultText.match(/(connection timed out[^\n.]{0,40}|MCP server[^\n.]{0,80}|ECONNREFUSED|ETIMEDOUT|not connected[^\n.]{0,40})/i);
        return {
          status: 'down',
          lastFailTool: toolName,
          lastFailReason: (m ? m[0] : resultText.slice(0, 120)).trim(),
        };
      }
      // 最近一次有結果的 mcp__* 呼叫是成功的 → MCP 證實正常
      return { status: 'healthy' };
    }
  }

  // 整段窗口都沒看到 mcp__* 結果 → 無法從呼叫記錄判斷（可能工具已從清單消失）
  return { status: 'unknown' };
}

/**
 * 掃最近一則 assistant 訊息文字，判斷 Claude 是否剛宣稱 MCP 不可用（軟證據）。
 * 只看「最後一則 assistant 訊息」，避免更早的分析/討論文字誤判。
 * @returns {string|null} 命中的敘述片段，或 null
 */
function scanRecentDownNarration(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split(/\r?\n/);
  } catch {
    return null;
  }
  const tail = lines.slice(-12);
  // 倒序找最後一則含文字的 assistant 訊息
  for (let i = tail.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(tail[i]); } catch { continue; }
    if (obj.type !== 'assistant' || !Array.isArray(obj.message?.content)) continue;
    const text = obj.message.content
      .filter((b) => b?.type === 'text')
      .map((b) => b.text || '')
      .join('\n');
    if (!text.trim()) continue;          // 這則沒文字（純 tool_use）→ 再往前找
    for (const re of MCP_DOWN_NARRATION) {
      const m = text.match(re);
      if (m) return m[0];
    }
    return null;                          // 最後一則有文字的 assistant 訊息不含斷線敘述 → 視為無
  }
  return null;
}

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const toolName = data.tool_name || '';
    const transcriptPath = data.transcript_path || '';

    // 當前要呼叫的工具是 mcp__* → 直接放行，讓它自己撞 MCP 狀態（成功就解除封鎖）
    if (toolName.startsWith('mcp__')) {
      debug(`pass: ${toolName} (mcp call itself — allow probe)`);
      return allow();
    }

    // 短名單放行（TodoWrite 等）
    const shortName = toolName.includes('__') ? toolName.split('__').pop() : toolName;
    if (ALLOWLIST.has(toolName) || ALLOWLIST.has(shortName)) {
      debug(`pass: ${toolName} (allowlist)`);
      return allow();
    }

    const state = scanMcpState(transcriptPath);

    // healthy = 最近有 mcp__* 成功呼叫，server 證實活著 → 一律放行（narration 屬 meta 討論，不擋）
    if (state.status === 'healthy') {
      debug('pass: MCP proven healthy (recent successful mcp__ call)');
      return allow();
    }

    // down = 硬證據（mcp__* 呼叫失敗且含斷線特徵）→ 強封鎖所有非 allowlist 工具（原行為）
    if (state.status === 'down') {
      const reason =
        `🛑 [MCP Down Guard] 偵測到 MCP 斷線，禁止繼續用內建工具繞道。\n\n` +
        `  最近一次 \`${state.lastFailTool}\` 失敗：${state.lastFailReason}\n\n` +
        `  依規矩你必須：\n` +
        `    1. 立刻停下，不要再呼叫任何工具（含 Read / Grep / Edit / Bash）\n` +
        `    2. 用純文字告訴使用者「MCP 斷線了，無法繼續用 XX 工具完成 YY 任務」\n` +
        `    3. 請使用者點 Reconnect，或明確授權你用內建工具當 fallback\n\n` +
        `  解除方式：使用者 Reconnect 後，下次任何 mcp__* 工具成功呼叫即自動解除。\n` +
        `  允許工具：TodoWrite（用來標記停止 / 規劃下一步）。`;
      process.stdout.write(reason);
      debug(`BLOCK(hard): ${toolName} (mcp down: ${state.lastFailTool})`);
      return process.exit(2);
    }

    // unknown = 末段窗口內完全沒有 mcp__* 結果（工具可能從清單消失、根本沒被呼叫）。
    // 這是原本的盲點：沒有失敗 tool_result，舊邏輯會放行繞道。
    // 只有在「Claude 剛宣稱 MCP 不可用」且「當前正跑 DB/PHP/HTTP 繞道指令」時才擋，
    // 其餘（一般 Bash、Read/Edit、純討論）一律放行，避免誤殺。
    const narration = scanRecentDownNarration(transcriptPath);
    if (narration && isBypassTool(toolName, data.tool_input)) {
      const reason =
        `🛑 [MCP Down Guard] 你剛宣稱 MCP 不可用（「${narration}」），現在卻要用 Bash 跑 DB/PHP/HTTP 繞道。\n\n` +
        `  使用者明確規定：MCP 斷線就該停下、回報、等重連或重開，不准自作主張用 docker exec / mysql / curl 繞道。\n\n` +
        `  你該做的：\n` +
        `    1. 立刻停下，不要跑這條繞道指令\n` +
        `    2. 用純文字告訴使用者「MCP 工具現在不在清單/不可用，無法用 XX 完成 YY」\n` +
        `    3. 先直接呼叫一次目標 mcp__* 工具確認是否真的不可用（server 常常只是還在冷啟動）；\n` +
        `       若真的失敗，請使用者 Reconnect 或重開，不要繞道。\n\n` +
        `  解除方式：任何 mcp__* 工具成功呼叫一次即自動解除。\n` +
        `  （若你確定是 server 已死且任務非繞不可，需使用者明確授權。）`;
      process.stdout.write(reason);
      debug(`BLOCK(suspected): ${toolName} (narration="${narration}", bypass bash)`);
      return process.exit(2);
    }

    debug(`pass: status=${state.status}, narration=${narration ? 'yes' : 'no'}, bypass=${isBypassTool(toolName, data.tool_input)}`);
    return allow();
  } catch (e) {
    debug(`error (ignored): ${e.message}`);
    process.exit(0);
  }
});
