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

// MCP 斷線特徵字串（出現在 tool_result 內容裡才算）
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
 * 從 transcript 找最近的 mcp__* 工具呼叫狀態
 * @returns {null | {downSince: string, lastFailTool: string, lastFailReason: string}}
 *   null = MCP 看起來正常（或無 mcp__ 紀錄）
 *   非 null = MCP 看起來斷線中
 */
function scanMcpState(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split(/\r?\n/);
  } catch {
    return null;
  }
  if (lines.length === 0) return null;

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
          lastFailTool: toolName,
          lastFailReason: (m ? m[0] : resultText.slice(0, 120)).trim(),
        };
      }
      // 最近一次有結果的 mcp__* 呼叫是成功的 → MCP 正常
      return null;
    }
  }

  // 整段窗口都沒看到 mcp__* 結果 → 視為正常（無證據判斷斷線）
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
    if (!state) {
      debug('pass: MCP looks healthy / no recent mcp__ call');
      return allow();
    }

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
    debug(`BLOCK: ${toolName} (mcp down: ${state.lastFailTool})`);
    // PreToolUse 用 exit code 2 表示阻擋
    process.exit(2);
  } catch (e) {
    debug(`error (ignored): ${e.message}`);
    process.exit(0);
  }
});
