#!/usr/bin/env node
/**
 * PreToolUse Hook — TodoWrite Reminder Escalator
 *
 * 問題：Claude Code 內建會在多步驟任務時注入 system-reminder
 *       "The TodoWrite tool hasn't been used recently..."
 *       但這只是「軟提醒」，Claude 經常無視（特別是已經在做事的中途）。
 *
 * 對策：本 hook 統計 transcript 中累計多少則 TodoWrite reminder「自上次 TodoWrite 呼叫後」
 *       出現。達門檻（預設 10）→ BLOCK 下一個非 TodoWrite call，強制要求建立 todo list
 *       後才能繼續，把軟提醒升級為硬攔截。
 *
 * 機制：
 *   1. 掃 transcript（末段 ~200 行）
 *   2. 從最後一次 TodoWrite tool_use 之後開始往後數，計算 system-reminder 含
 *      "TodoWrite tool hasn't been used" 的次數
 *   3. 若該計數 ≥ THRESHOLD 且當前要呼叫的工具不是 TodoWrite → BLOCK
 *   4. 使用者明確說「不需要 todo」可加 `# no-todo: <reason>` 在 prompt 旁路（暫未實作 prompt 偵測，
 *      先靠呼叫 TodoWrite 清空計數）
 *
 * 任何錯誤一律靜默放行（exit 0）。
 */

import fs from 'fs';
import { CLAUDE_HOOK_DEBUG as DEBUG_MODE } from '../env.js';

const SCAN_TAIL = 300;             // 掃 transcript 末段幾行
const THRESHOLD = 10;              // ≥10 次未理會 → BLOCK
const REMINDER_PATTERN = /TodoWrite tool hasn't been used recently/i;

function debug(msg) {
  if (DEBUG_MODE) process.stderr.write(`[todowrite-escalator] ${msg}\n`);
}

function allow() { process.exit(0); }

/** 把任意 block 內容展平成字串 */
function flatText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (b?.type === 'text') return b.text || '';
      if (b?.type === 'tool_result') return flatText(b.content);
      return '';
    })
    .join('\n');
}

/**
 * 數「自最後一次 TodoWrite 之後」reminder 出現次數
 * @returns {number}
 */
function countRemindersSinceLastTodo(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;
  let lines;
  try {
    lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split(/\r?\n/);
  } catch { return 0; }

  const tail = lines.slice(-SCAN_TAIL);

  // 從尾往前找最後一次 TodoWrite tool_use 的 index
  let lastTodoIdx = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(tail[i]);
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        const hasTodo = obj.message.content.some(
          (b) => b?.type === 'tool_use' && b.name === 'TodoWrite'
        );
        if (hasTodo) { lastTodoIdx = i; break; }
      }
    } catch { /* skip */ }
  }

  // 從 lastTodoIdx+1（或 0）往後掃，數 reminder 次數
  let count = 0;
  for (let i = Math.max(0, lastTodoIdx + 1); i < tail.length; i++) {
    let obj;
    try { obj = JSON.parse(tail[i]); } catch { continue; }
    // system-reminder 可能出現在 user message content（text block 或 tool_result text）
    if (obj.type === 'user' && obj.message?.content) {
      const txt = flatText(obj.message.content);
      // 一則 user message 可能含多個 reminder（每個 tool_result 後接一個）
      const matches = txt.match(/TodoWrite tool hasn't been used recently/gi);
      if (matches) count += matches.length;
    }
  }
  return count;
}

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const toolName = data.tool_name || '';
    const transcriptPath = data.transcript_path || '';

    // TodoWrite 自己呼叫 → 放行（也代表計數即將重置）
    if (toolName === 'TodoWrite') {
      debug('pass: TodoWrite call itself');
      return allow();
    }

    const count = countRemindersSinceLastTodo(transcriptPath);
    debug(`reminders since last TodoWrite = ${count}`);

    if (count < THRESHOLD) return allow();

    const reason =
      `🛑 [TodoWrite Escalator] BLOCKED：自上次 TodoWrite 後系統已提醒 ${count} 次（門檻 ${THRESHOLD}）仍未建立 / 更新 todo list。\n\n` +
      `  系統的提醒不是裝飾——${count} 次提醒代表你正在做多步驟任務但缺乏軌跡：\n` +
      `    - 容易忘記未完成項目\n` +
      `    - 使用者無法看到進度\n` +
      `    - 中途切斷沒辦法接續\n\n` +
      `  → 請立刻呼叫 TodoWrite 建立 / 更新清單，把當前任務拆成可勾選的步驟。\n` +
      `  → 清單建立後本攔截自動解除。\n` +
      `  → 若任務真的單純不需要 todo（例如純查詢回答），用 TodoWrite 建一筆 completed 標記即可解封。`;

    process.stdout.write(reason);
    debug(`BLOCK: ${toolName} (reminders=${count})`);
    process.exit(2);
  } catch (e) {
    debug(`error (ignored): ${e.message}`);
    process.exit(0);
  }
});
