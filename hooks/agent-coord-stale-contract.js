#!/usr/bin/env node
/**
 * PreToolUse Hook — Agent-Coord Stale Contract Guard
 *
 * 場景：多 backend Claude（agent_coord）並行時，backend-X 在 api-contract channel post
 *       新訊息（DB schema / Model 介面 / status 值表變動），backend-Y 沒 poll 就動工，
 *       會撞到契約衝突（一個 agent 的假設與另一個 agent 的實作不一致，往往要使用者才抓得出）。
 *
 * 觸發時機：寫入類工具呼叫前（Edit / Write / apply_diff / create_file / execute_sql / run_php_script / ssh_exec）
 *
 * 偵測邏輯：
 *   1. 從 transcript 掃最近 200 條 message，找：
 *      a. 最近的 agent_coord 呼叫的 project 參數（決定 namespace）
 *      b. 最近的 agent_coord 呼叫的 agent_id 參數（決定自己是誰）
 *      c. 最近的 agent_coord(action="poll", channel="api-contract") 的 after_id（自己最後 poll 到哪）
 *   2. 讀 D:\Project\_coordination\{project}\api-contract.json
 *   3. 找出符合：message.agent !== self_id AND message.id > last_polled_after_id 的條目
 *   4. 若 ≥1 條未讀新契約 → 警告，要求先 poll
 *
 * 非阻擋：純警告（exit 0 + stderr 輸出），避免誤殺單 backend 流程。
 * 沒在用 agent_coord 的 session 完全靜默放行。
 */

import fs from 'fs';
import path from 'path';
import { CLAUDE_HOOK_DEBUG as DEBUG_MODE } from '../env.js';

const COORD_ROOT = 'D:\\Project\\_coordination';

// 寫入類工具白名單（觸發本 hook）— matcher 在 settings.json 設，但這裡再做一次硬比對
const TRIGGER_TOOLS = new Set([
  'Edit', 'Write',
  'mcp__project-migration-assistant-pro__apply_diff',
  'mcp__project-migration-assistant-pro__apply_diff_batch',
  'mcp__project-migration-assistant-pro__create_file',
  'mcp__project-migration-assistant-pro__create_file_batch',
  'mcp__project-migration-assistant-pro__multi_file_inject',
  'mcp__project-migration-assistant-pro__execute_sql',
  'mcp__project-migration-assistant-pro__execute_sql_batch',
  'mcp__project-migration-assistant-pro__run_php_script',
  'mcp__project-migration-assistant-pro__run_php_code',
  'mcp__project-migration-assistant-pro__ssh_exec',
]);

function writeStderrUtf8(s) {
  process.stderr.write(Buffer.from(s, 'utf8'));
}
function debug(msg) {
  if (DEBUG_MODE) writeStderrUtf8(`[agent-coord-stale-contract] ${msg}\n`);
}

function allow() {
  process.exit(0);
}

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const toolName = data.tool_name || '';
    if (!TRIGGER_TOOLS.has(toolName)) return allow();

    const transcriptPath = data.transcript_path || '';
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return allow();

    // 從 transcript 倒掃，找最近的 agent_coord 訊號
    let raw;
    try {
      raw = fs.readFileSync(transcriptPath, 'utf-8');
    } catch {
      return allow();
    }
    const lines = raw.trim().split(/\r?\n/);

    let project = null;
    let selfAgentId = null;
    let lastPolledAfterId = null;
    let lastPolledTimestamp = null;
    const SCAN_LIMIT = Math.min(lines.length, 400); // 至多掃 400 行

    for (let i = lines.length - 1, scanned = 0; i >= 0 && scanned < SCAN_LIMIT; i--, scanned++) {
      let obj;
      try { obj = JSON.parse(lines[i]); } catch { continue; }
      const msg = obj.message;
      if (!msg || msg.role !== 'assistant') continue;
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (!c || c.type !== 'tool_use') continue;
        const name = c.name || '';
        if (!name.endsWith('agent_coord')) continue;
        const inp = c.input || {};
        // 取得 namespace + 身分
        if (!project && inp.project) project = inp.project;
        if (!selfAgentId && inp.agent_id) selfAgentId = inp.agent_id;
        // 找最近一次 poll api-contract
        if (lastPolledAfterId === null &&
            inp.action === 'poll' &&
            inp.channel === 'api-contract') {
          lastPolledAfterId = (typeof inp.after_id === 'number') ? inp.after_id : 0;
          lastPolledTimestamp = obj.timestamp || null;
        }
      }
      if (project && selfAgentId && lastPolledAfterId !== null) break;
    }

    if (!project) {
      debug('no agent_coord project in transcript → 放行');
      return allow();
    }

    // 讀 api-contract.json
    const contractFile = path.join(COORD_ROOT, project.replace(/[^a-zA-Z0-9_-]/g, '_'), 'api-contract.json');
    if (!fs.existsSync(contractFile)) {
      debug(`no contract file: ${contractFile} → 放行`);
      return allow();
    }
    let contract;
    try {
      contract = JSON.parse(fs.readFileSync(contractFile, 'utf-8'));
    } catch {
      return allow();
    }
    const messages = Array.isArray(contract.messages) ? contract.messages : [];
    if (messages.length === 0) return allow();

    // 若從未 poll 過 → 用「自己第一次出現的 timestamp」近似當基準；先暫定 lastPolledAfterId=0
    const baselineAfterId = lastPolledAfterId === null ? 0 : lastPolledAfterId;

    const newMessages = messages.filter(m =>
      typeof m.id === 'number' &&
      m.id > baselineAfterId &&
      m.agent !== selfAgentId
    );

    if (newMessages.length === 0) {
      debug(`no new contract msgs (after_id=${baselineAfterId}) → 放行`);
      return allow();
    }

    // 組警告
    const preview = newMessages.slice(-3).map(m =>
      `  #${m.id} [${m.category || 'info'}] by ${m.agent} (${m.timestamp || '?'})\n    ${(m.message || '').slice(0, 120)}`
    ).join('\n');
    const newest = newMessages[newMessages.length - 1];
    const warn =
      `[Agent-Coord Stale Contract] ⚠️ 你（${selfAgentId || '?'}）即將動工，但 api-contract 有 ${newMessages.length} 則你還沒 poll 的變更：\n` +
      `${preview}\n` +
      `  → 先呼叫：agent_coord(action="poll", project="${project}", channel="api-contract", after_id=${baselineAfterId})\n` +
      `  → 確認新契約不衝突再動，避免跟其他 backend 撞邏輯（如 status 值表 / 欄位語意 / DB schema 變動）。\n` +
      `  （提示來自最近一次你 poll 的 after_id=${baselineAfterId}，contract 最新 id=${newest.id}）\n`;

    writeStderrUtf8(warn);
    debug(`warn issued: ${newMessages.length} new msgs`);
    process.exit(0);
  } catch (e) {
    debug(`error (ignored): ${e.message}`);
    process.exit(0);
  }
});
