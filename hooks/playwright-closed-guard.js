#!/usr/bin/env node
/**
 * PreToolUse Hook — Playwright Closed Guard（瀏覽器已關閉守門員）
 *
 * 問題：使用者手動關掉 Playwright 瀏覽器視窗（或瀏覽器 crash）後，browser context 死掉，
 *       之後每次 browser_navigate / browser_interact 都回
 *       「Target page, context or browser has been closed」。
 *       Claude 收到的只是一行錯誤字串，會當成「這個 browser 壞了，換一個再試」，
 *       於是不斷盲試（換 frontend-a / frontend-b、重發 navigate）→ 在原地打轉燒 token。
 *       現有 mcp-down-guard 只認「MCP server 整個斷線」，不認「Playwright 還連著但 context 被關」。
 *
 * 機制：
 *   1. 只攔 browser_* 工具呼叫（其餘一律放行）
 *   2. 掃 transcript 末段，蒐集 browser_* 的 tool_result，數「結尾連續幾次」是
 *      "...has been closed" 這類關閉特徵
 *   3. 連續關閉次數 >= THRESHOLD（預設 2）時 BLOCK 下一個 browser 呼叫，
 *      引導正確復原（先 browser_close 重置 → 再 browser_navigate 重開）或停下問使用者
 *   4. browser_close 永遠放行（它正是復原的重置步驟）；
 *      一旦 browser_close 成功（最近一筆 browser 結果不再是關閉錯誤）→ 鏈中斷、自動解除
 *
 * 為什麼 hook 能擋：hook 是 Claude Code 本體 spawn 的獨立 node 程序，跟 Playwright MCP 無關。
 *
 * 任何錯誤一律靜默放行（exit 0），絕不因 hook 異常卡住工作流。
 */

import fs from 'fs';

const SCAN_DEPTH = 80;   // 掃 transcript 末段幾則 jsonl 行
const THRESHOLD = 2;     // 結尾連續關閉次數達此值即擋下一個 browser 呼叫（可由 env 覆寫）
const DEBUG_MODE = process.env.CLAUDE_HOOK_DEBUG === '1' || process.env.CLAUDE_HOOK_DEBUG === 'true';

// 瀏覽器 context 已關閉的特徵字串（出現在 browser_* 的 tool_result 內才算）
const BROWSER_CLOSED_PATTERNS = [
  /Target page,?\s*context or browser has been closed/i,
  /(?:page|context|browser)\s+has been closed/i,
  /browser(?:Backend)?\.?callTool[^\n]*closed/i,
  /Target closed/i,
  /Session closed/i,
];

function debug(msg) {
  if (DEBUG_MODE) process.stderr.write(`[playwright-closed-guard] ${msg}\n`);
}

function allow() {
  process.exit(0);
}

/** 是否為 browser_* 工具（含 playwright MCP 與本系統 MCP 的 browser_*） */
function isBrowserTool(toolName) {
  return /browser_[a-z_]+/i.test(toolName || '');
}

/** 把 content（string / array of blocks）展平成單一字串 */
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
 * 掃 transcript，回傳結尾「連續關閉」的 browser_* 結果筆數。
 * @returns {{ consecutiveClosed: number, total: number }}
 */
function scanBrowserState(transcriptPath) {
  const empty = { consecutiveClosed: 0, total: 0 };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return empty;
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split(/\r?\n/);
  } catch {
    return empty;
  }
  if (lines.length === 0) return empty;

  const tail = lines.slice(-SCAN_DEPTH);

  // tool_use_id → toolName 對照
  const useIdToName = new Map();
  for (const line of tail) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const b of obj.message.content) {
          if (b?.type === 'tool_use' && b.id && b.name) useIdToName.set(b.id, b.name);
        }
      }
    } catch { /* skip malformed */ }
  }

  // 依時間順序蒐集 browser_* 的結果（是否為「關閉」特徵）
  const browserResults = [];
  for (const line of tail) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'user') continue;
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const name = useIdToName.get(block.tool_use_id) || '';
      if (!isBrowserTool(name)) continue;
      const text = flattenContent(block.content);
      const closed = BROWSER_CLOSED_PATTERNS.some((re) => re.test(text));
      browserResults.push(closed);
    }
  }

  // 結尾連續關閉次數（遇到任一非關閉的 browser 結果就中斷 → 視為已復原）
  let consecutive = 0;
  for (let i = browserResults.length - 1; i >= 0; i--) {
    if (browserResults[i]) consecutive++;
    else break;
  }
  debug(`browserResults=${browserResults.length} consecutiveClosed=${consecutive}`);
  return { consecutiveClosed: consecutive, total: browserResults.length };
}

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const toolName = data.tool_name || '';
    const transcriptPath = data.transcript_path || '';

    // 非 browser 工具 → 放行
    if (!isBrowserTool(toolName)) {
      debug(`pass: ${toolName} (not a browser tool)`);
      return allow();
    }

    // browser_close 永遠放行（復原的重置步驟）
    const shortName = toolName.includes('__') ? toolName.split('__').pop() : toolName;
    if (shortName === 'browser_close') {
      debug(`pass: ${toolName} (browser_close — recovery reset, always allowed)`);
      return allow();
    }

    const threshold = parseInt(process.env.CLAUDE_BROWSER_CLOSED_THRESHOLD, 10) || THRESHOLD;
    const { consecutiveClosed } = scanBrowserState(transcriptPath);
    if (consecutiveClosed < threshold) {
      debug(`pass: ${toolName} (consecutiveClosed=${consecutiveClosed} < ${threshold})`);
      return allow();
    }

    const reason =
      `🛑 [Playwright Closed Guard] 偵測到瀏覽器已被關閉：連續 ${consecutiveClosed} 次 browser 呼叫都回「Target page, context or browser has been closed」。\n\n` +
      `  盲目重試 browser_navigate / browser_interact 不會復原 —— 這個瀏覽器實例（被手動關掉或 crash）已經死了，再試只是原地打轉燒 token。\n\n` +
      `  正確復原步驟：\n` +
      `    1. 先呼叫 browser_close（重置 Playwright 的 browser 狀態，本 hook 一律放行）\n` +
      `    2. 再呼叫 browser_navigate 重開新頁\n` +
      `  或：停下來用純文字問使用者「瀏覽器被關了，要我重開嗎？」，不要繼續盲試。\n\n` +
      `  解除：成功的 browser_close 之後（最近一筆 browser 結果不再是關閉錯誤）自動解除。`;

    process.stdout.write(reason);
    debug(`BLOCK: ${toolName} (consecutiveClosed=${consecutiveClosed})`);
    process.exit(2); // PreToolUse 用 exit 2 表示阻擋
  } catch (e) {
    debug(`error (ignored): ${e.message}`);
    process.exit(0);
  }
});
