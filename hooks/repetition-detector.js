#!/usr/bin/env node
/**
 * PreToolUse Hook — Repetition Detector（重複行為偵測）
 *
 * 追蹤同一 session 內的工具呼叫模式，當偵測到重複行為時注入提醒，
 * 促使 Claude 反思是否應改用批次工具或調整策略。
 *
 * 機制：每次 tool call 寫入 temp log，累計後比對模式。
 * 非阻擋式：只輸出提醒，不取消操作（exit 0）。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ── 設定 ──────────────────────────────────────────
const LOG_DIR = path.join(os.tmpdir(), 'claude_tool_logs');
const MAX_LOG_AGE_MS = 2 * 60 * 60 * 1000; // 2 小時後自動清除
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.svg']);

// ── 已知 batch 對應表（單一工具 → batch 建議）──────
const BATCH_HINTS = {
  'Read:image':        'read_images_batch（MCP 工具，支援縮放省 token）',
  'read_file:image':   'read_images_batch（MCP 工具，支援縮放省 token）',
  'Read:.pdf':         'read_pdf_files_batch',
  'read_file:.pdf':    'read_pdf_files_batch',
  'Read:.docx':        'read_word_files_batch',
  'read_file:.docx':   'read_word_files_batch',
  'Read:.pptx':        'read_pptx_files_batch',
  'read_file:.pptx':   'read_pptx_files_batch',
  'read_pdf_file':     'read_pdf_files_batch',
  'read_word_file':    'read_word_files_batch',
  'read_pptx_file':    'read_pptx_files_batch',
  'read_image':        'read_images_batch',
  'send_http_request': 'send_http_requests_batch',
  'execute_sql':       'execute_sql_batch',
  'sftp_upload':       'sftp_upload_batch',
  'sftp_download':     'sftp_download_batch',
  'sftp_list':         'sftp_list_batch',
  'sftp_delete':       'sftp_delete_batch',
  'run_php_script':    'run_php_script_batch',
};

// MCP 工具名稱去前綴：mcp__project-migration-assistant-pro__execute_sql → execute_sql
function shortName(toolName) {
  const match = toolName.match(/^mcp__[^_]+(?:__[^_]+)*__(.+)$/);
  return match ? match[1] : toolName;
}

function getEntryKey(entry) {
  const filePath = entry.args?.file_path || entry.args?.path || '';
  const ext = path.extname(filePath).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  return { tool: shortName(entry.tool), ext, isImage, filePath };
}

function getCategoryKey(entry) {
  const { tool, ext, isImage } = getEntryKey(entry);
  if (isImage) return `${tool}:image`;
  if (ext) return `${tool}:${ext}`;
  return tool;
}

function lookupBatchHint(entry) {
  const catKey = getCategoryKey(entry);
  // 先查 category key（如 Read:image, Read:.pdf）
  if (BATCH_HINTS[catKey]) return BATCH_HINTS[catKey];
  // 再查純工具名（如 execute_sql）
  if (BATCH_HINTS[entry.tool]) return BATCH_HINTS[entry.tool];
  return null;
}

// 重複模式定義
const PATTERNS = [
  {
    id: 'same_category_repeat',
    detect: (entry, history) => {
      // 同一工具 + 同類檔案（或同一 MCP 工具）超過閾值
      const catKey = getCategoryKey(entry);
      const count = history.filter(h => getCategoryKey(h) === catKey).length + 1;
      if (count < 3) return null;

      const batchHint = lookupBatchHint(entry);
      const displayName = shortName(entry.tool);
      const lines = [`[Repetition Detector] \u26a0\ufe0f ${displayName} 同類操作已執行 ${count} 次。請暫停思考：`];
      if (batchHint) {
        lines.push(`  - 建議改用 batch 工具：${batchHint}`);
      } else {
        lines.push('  - 是否有更高效的批次做法？');
      }
      lines.push('  - 這個重複模式是否值得自動化為新工具或 Skill？');
      lines.push('  - 當前策略本身是否需要調整？');
      return lines.join('\n') + '\n';
    },
  },
  {
    id: 'same_tool_high_volume',
    detect: (entry, history) => {
      // 同一工具（不分檔案類型）呼叫過多
      const count = history.filter(h => h.tool === entry.tool).length + 1;
      if (count < 6) return null;
      // 如果已被 same_category_repeat 捕捉就不重複提醒
      const catKey = getCategoryKey(entry);
      const catCount = history.filter(h => getCategoryKey(h) === catKey).length + 1;
      if (catCount >= 3) return null; // 已有更精準的提醒

      return `[Repetition Detector] \ud83d\udd01 工具 ${shortName(entry.tool)} 本次對話已呼叫 ${count} 次。是否該檢視整體策略？\n`;
    },
  },
  {
    id: 'exact_same_call',
    detect: (entry, history) => {
      // 完全相同的工具 + 參數
      const entryStr = JSON.stringify({ tool: entry.tool, args: entry.args });
      const count = history.filter(h =>
        JSON.stringify({ tool: h.tool, args: h.args }) === entryStr
      ).length + 1;
      if (count < 3) return null;
      return '[Repetition Detector] \u274c 完全相同的工具呼叫已執行 ' + count + ' 次，結果不會改變。請停下來重新思考策略。\n';
    },
  },
];

// ── 工具函式 ──────────────────────────────────────
function getLogPath(sessionId) {
  return path.join(LOG_DIR, `${sessionId || 'default'}.json`);
}

function readLog(logPath) {
  try {
    const raw = fs.readFileSync(logPath, 'utf-8');
    const data = JSON.parse(raw);
    // 過期檢查
    if (Date.now() - data.startedAt > MAX_LOG_AGE_MS) {
      fs.unlinkSync(logPath);
      return [];
    }
    return data.entries || [];
  } catch {
    return [];
  }
}

function writeLog(logPath, entries) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const data = {
    startedAt: entries.length > 0 ? entries[0].ts : Date.now(),
    entries,
  };
  fs.writeFileSync(logPath, JSON.stringify(data), 'utf-8');
}

function cleanOldLogs() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const files = fs.readdirSync(LOG_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(LOG_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > MAX_LOG_AGE_MS) {
        fs.unlinkSync(fp);
      }
    }
  } catch { /* ignore */ }
}

// ── 主程式 ────────────────────────────────────────
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'default';
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};

    const logPath = getLogPath(sessionId);
    const history = readLog(logPath);

    const currentEntry = {
      tool: toolName,
      args: toolInput,
      ts: Date.now(),
    };

    // 檢查所有模式（每條規則回傳 null 或警告字串）
    const warnings = [];
    for (const pat of PATTERNS) {
      const msg = pat.detect(currentEntry, history);
      if (msg) warnings.push(msg);
    }

    // 輸出警告
    if (warnings.length > 0) {
      process.stdout.write(warnings.join('\n'));
    }

    // 記錄當前呼叫
    history.push(currentEntry);
    // 只保留最近 50 筆
    if (history.length > 50) history.splice(0, history.length - 50);
    writeLog(logPath, history);

    // 定期清理舊 log
    if (Math.random() < 0.1) cleanOldLogs();

    process.exit(0);
  } catch (e) {
    process.exit(0); // hook 不能阻擋正常流程
  }
});
