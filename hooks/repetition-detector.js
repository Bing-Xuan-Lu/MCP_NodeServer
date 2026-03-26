#!/usr/bin/env node
/**
 * PreToolUse Hook — Tool Choice & Repetition Guard（工具選擇 + 重複行為偵測）
 *
 * 兩層防線：
 * Layer 1 — Wrong Tool（首次即攔）：Bash 做了有專用工具的事，不需歷史紀錄
 * Layer 2 — Repetition（累計偵測）：同類操作重複時建議 batch 或策略調整
 *
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

// ── Bash 命令模式辨識 ─────────────────────────────
// warnOnFirst: true  = 有明確替代工具，第一次就該用對的（Layer 1: Wrong Tool）
// warnOnFirst: false = 偶爾用 Bash 合理，重複才需提醒（Layer 2: Repetition）
const BASH_PATTERNS = [
  {
    regex: /docker\s+exec\s+\S+\s+mysql/i,
    signature: 'bash:docker-mysql',
    hint: 'set_database + execute_sql / execute_sql_batch（MCP 工具，免重複 docker exec 開銷）',
    warnOnFirst: true,
  },
  {
    regex: /docker\s+exec\s+\S+\s+php\b/i,
    signature: 'bash:docker-php',
    hint: 'run_php_script / run_php_script_batch（MCP 工具）',
    warnOnFirst: true,
  },
  {
    regex: /docker\s+exec\s+\S+\s+python/i,
    signature: 'bash:docker-python',
    hint: 'run_python_script（MCP 工具）',
    warnOnFirst: true,
  },
  {
    regex: /\b(cat|head|tail)\s+/i,
    signature: 'bash:read-file',
    hint: 'Read 工具（內建，支援 offset/limit，不需 Bash）',
    warnOnFirst: true,
  },
  {
    regex: /\b(grep|rg|findstr)\s+/i,
    signature: 'bash:grep',
    hint: 'Grep 工具（內建，支援 regex + glob 過濾，不需 Bash）',
    warnOnFirst: true,
  },
  {
    regex: /\bfind\s+\S+\s+-/i,
    signature: 'bash:find',
    hint: 'Glob 工具（內建，模式匹配更快，不需 Bash）',
    warnOnFirst: true,
  },
  {
    regex: /\b(sed|awk)\s+/i,
    signature: 'bash:sed-awk',
    hint: 'Edit 工具（內建，精確替換 + 可 review，不需 Bash）',
    warnOnFirst: true,
  },
  {
    regex: /\bcurl\s+/i,
    signature: 'bash:curl',
    hint: 'send_http_request / send_http_requests_batch（MCP 工具，支援 cookie session）',
    warnOnFirst: false,
  },
  {
    regex: /\becho\s+.*[>]/i,
    signature: 'bash:write-file',
    hint: 'Write 工具（內建，支援 review，不需 Bash）',
    warnOnFirst: true,
  },
  {
    regex: /\bwget\s+/i,
    signature: 'bash:wget',
    hint: 'WebFetch（內建）或 send_http_request（MCP 工具，支援 cookie session）',
    warnOnFirst: false,
  },
  {
    regex: /\bwc\s+(-l\s+)?/i,
    signature: 'bash:wc',
    hint: 'Read 工具可直接看檔案內容，或 Grep(output_mode: "count") 計算匹配數',
    warnOnFirst: false,
  },
  {
    regex: /\bdiff\s+/i,
    signature: 'bash:diff',
    hint: 'git_diff（MCP 工具）或 remote_diff（Skill），結構化輸出更易讀',
    warnOnFirst: false,
  },
];

// ── 工具函式 ──────────────────────────────────────

// MCP 工具名稱去前綴
function shortName(toolName) {
  const match = toolName.match(/^mcp__[^_]+(?:__[^_]+)*__(.+)$/);
  return match ? match[1] : toolName;
}

/** 從 Bash 命令提取簽名（核心動作） */
function extractBashSignature(command) {
  if (!command) return null;
  for (const { regex, signature } of BASH_PATTERNS) {
    if (regex.test(command)) return signature;
  }
  return null;
}

/** 從 Bash 命令取得完整匹配結果 { signature, hint, warnOnFirst } */
function matchBashPattern(command) {
  if (!command) return null;
  for (const pat of BASH_PATTERNS) {
    if (pat.regex.test(command)) return pat;
  }
  return null;
}

/** 取得 entry 的分類 key（用於同類偵測） */
function getCategoryKey(entry) {
  const tool = shortName(entry.tool);

  // Bash 命令：用簽名分類
  if (tool === 'Bash' && entry.bashSig) {
    return entry.bashSig;
  }

  // 檔案工具：用副檔名分類
  const filePath = entry.args?.file_path || entry.args?.path || '';
  const ext = path.extname(filePath).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  if (isImage) return `${tool}:image`;
  if (ext) return `${tool}:${ext}`;

  return tool;
}

/** 查找 batch 建議 */
function lookupBatchHint(entry) {
  const tool = shortName(entry.tool);

  // Bash 命令：用專屬建議
  if (tool === 'Bash') {
    const cmd = entry.args?.command || '';
    const pat = matchBashPattern(cmd);
    return pat ? pat.hint : null;
  }

  // 其他工具：查 BATCH_HINTS
  const catKey = getCategoryKey(entry);
  if (BATCH_HINTS[catKey]) return BATCH_HINTS[catKey];
  if (BATCH_HINTS[tool]) return BATCH_HINTS[tool];
  return null;
}

// ── 偵測規則 ──────────────────────────────────────

const PATTERNS = [
  {
    // Layer 1: Wrong Tool — 有明確替代工具卻用 Bash，第一次就提醒（跨 session 有效）
    id: 'bash_wrong_tool',
    detect: (entry, _history) => {
      if (shortName(entry.tool) !== 'Bash') return null;
      const cmd = entry.args?.command || '';
      const pat = matchBashPattern(cmd);
      if (!pat || !pat.warnOnFirst) return null;

      return `[Wrong Tool] ⚠️ 偵測到 Bash 執行「${pat.signature}」，但有專用工具可用。\n` +
             `  → 建議改用：${pat.hint}\n` +
             `  → 專用工具省 token、支援 batch、輸出結構化，請優先使用。\n`;
    },
  },
  {
    // Layer 2: Bash Repetition — warnOnFirst=false 的模式，重複時才提醒
    id: 'bash_pattern_repeat',
    detect: (entry, history) => {
      if (!entry.bashSig) return null;
      // warnOnFirst 的已被 Layer 1 處理，這裡只管 warnOnFirst=false
      const cmd = entry.args?.command || '';
      const pat = matchBashPattern(cmd);
      if (pat?.warnOnFirst) return null;

      const count = history.filter(h => h.bashSig === entry.bashSig).length + 1;
      if (count < 2) return null;

      const lines = [
        `[Repetition Detector] ⚠️ Bash 命令模式「${entry.bashSig}」已出現 ${count} 次。`,
      ];
      if (pat?.hint) {
        lines.push(`  → 建議改用：${pat.hint}`);
      }
      if (count >= 3) {
        lines.push('  → 請停下來重新評估策略，不要繼續用 Bash 做同類操作。');
      }
      return lines.join('\n') + '\n';
    },
  },
  {
    id: 'same_category_repeat',
    detect: (entry, history) => {
      // 跳過已被 bash_pattern_repeat 處理的
      if (entry.bashSig) return null;

      const catKey = getCategoryKey(entry);
      const count = history.filter(h => getCategoryKey(h) === catKey).length + 1;
      if (count < 3) return null;

      const batchHint = lookupBatchHint(entry);
      const displayName = shortName(entry.tool);
      const lines = [`[Repetition Detector] ⚠️ ${displayName} 同類操作已執行 ${count} 次。請暫停思考：`];
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
      const tool = entry.tool;
      const count = history.filter(h => h.tool === tool).length + 1;
      if (count < 6) return null;
      // 如果已被更精準的規則捕捉就不重複提醒
      if (entry.bashSig) return null;
      const catKey = getCategoryKey(entry);
      const catCount = history.filter(h => getCategoryKey(h) === catKey).length + 1;
      if (catCount >= 3) return null;

      return `[Repetition Detector] 🔁 工具 ${shortName(tool)} 本次對話已呼叫 ${count} 次。是否該檢視整體策略？\n`;
    },
  },
  {
    id: 'exact_same_call',
    detect: (entry, history) => {
      const entryStr = JSON.stringify({ tool: entry.tool, args: entry.args });
      const count = history.filter(h =>
        JSON.stringify({ tool: h.tool, args: h.args }) === entryStr
      ).length + 1;
      if (count < 3) return null;
      return '[Repetition Detector] ❌ 完全相同的工具呼叫已執行 ' + count + ' 次，結果不會改變。請停下來重新思考策略。\n';
    },
  },
];

// ── Log 管理 ──────────────────────────────────────

function getLogPath(sessionId) {
  return path.join(LOG_DIR, `${sessionId || 'default'}.json`);
}

function readLog(logPath) {
  try {
    const raw = fs.readFileSync(logPath, 'utf-8');
    const data = JSON.parse(raw);
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

    // 建立當前 entry，Bash 命令額外提取簽名
    const bashCommand = toolName === 'Bash' ? (toolInput.command || '') : '';
    const bashSig = toolName === 'Bash' ? extractBashSignature(bashCommand) : null;

    const currentEntry = {
      tool: toolName,
      args: toolInput,
      bashSig,
      ts: Date.now(),
    };

    // 檢查所有模式
    const warnings = [];
    for (const pat of PATTERNS) {
      const msg = pat.detect(currentEntry, history);
      if (msg) warnings.push(msg);
    }

    if (warnings.length > 0) {
      process.stdout.write(warnings.join('\n'));
    }

    // 記錄當前呼叫（精簡存儲：Bash 只存簽名和前 100 字元命令）
    const storedEntry = {
      tool: toolName,
      args: toolName === 'Bash'
        ? { command: bashCommand.slice(0, 100) }
        : toolInput,
      bashSig,
      ts: Date.now(),
    };

    history.push(storedEntry);
    if (history.length > 50) history.splice(0, history.length - 50);
    writeLog(logPath, history);

    if (Math.random() < 0.1) cleanOldLogs();

    process.exit(0);
  } catch (e) {
    process.exit(0);
  }
});
