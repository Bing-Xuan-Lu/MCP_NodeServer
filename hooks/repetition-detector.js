#!/usr/bin/env node
/**
 * PreToolUse Hook — Tool Choice & Repetition Guard（工具選擇 + 重複行為偵測）
 *
 * 三層防線：
 * Layer 1 — Wrong Tool（首次即攔）：Bash 做了有專用工具的事，不需歷史紀錄
 * Layer 2 — Scatter Search（累計偵測）：Grep 散搜多檔案時強制注入記憶，提醒用 CODEMAPS / MCP 工具
 * Layer 3 — Repetition（累計偵測）：同類操作重複時建議 batch 或策略調整
 *
 * 非阻擋式：只輸出提醒，不取消操作（exit 0）。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

// ── 設定 ──────────────────────────────────────────
const HOME = process.env.HOME || process.env.USERPROFILE;
const LOG_DIR = path.join(os.tmpdir(), 'claude_tool_logs');
const COMPLAINTS_PATH = path.join(HOME, '.claude', 'hook-complaints.jsonl');
const MAX_LOG_AGE_MS = 2 * 60 * 60 * 1000; // 2 小時後自動清除
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.svg']);

// 環境變數配置
const DEBUG_MODE = process.env.CLAUDE_HOOK_DEBUG === '1';
const SLACK_WEBHOOK = process.env.CLAUDE_SLACK_WEBHOOK || '';
const NOTIFY_ON_BLOCK = process.env.CLAUDE_NOTIFY_ON_BLOCK === '1';

// 內網 IP 範圍（這些 host 的 sftp/ssh 操作跳過重複偵測）
const INTERNAL_IP_PATTERNS = [
  /^192\.168\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^127\./,
  /^localhost$/i,
];

// 需要判斷內網才放行的工具（非連線工具本身）
const NETWORK_TOOLS = new Set([
  'ssh_exec',
  'sftp_upload', 'sftp_download', 'sftp_list', 'sftp_delete',
  'sftp_upload_batch', 'sftp_download_batch', 'sftp_list_batch', 'sftp_delete_batch',
]);

/** 判斷 host 是否為內網 */
function isInternalHost(host) {
  if (!host) return false;
  return INTERNAL_IP_PATTERNS.some(re => re.test(host));
}

/** 檢查 git 未 commit 的檔案數 */
function checkUncommittedFiles() {
  try {
    const status = execSync('git status --porcelain 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const files = status.trim().split('\n').filter(l => l.length > 0);
    return files.length;
  } catch {
    return 0;
  }
}

/** 粗略估算 input token 數 (字數 / 4) */
function estimateInputTokens(args) {
  if (!args) return 0;
  const str = JSON.stringify(args);
  return Math.ceil(str.length / 4);
}

/** 估算 tool call 的總 token 消耗 */
function estimateToolTokens(tool, args) {
  const shortTool = shortName(tool);
  const inputTokens = estimateInputTokens(args);

  // 根據 tool 類型估算 output token
  const outputEstimates = {
    'Bash': 500,           // Bash 輸出通常較大
    'Read': 1000,          // Read 檔案內容
    'Grep': 400,           // Grep 結果
    'send_http_request': 600,
    'execute_sql': 500,
    'browser_interact': 1200,  // 包含截圖等
  };

  const estimated = outputEstimates[shortTool] || 300;
  return inputTokens + estimated;
}

/** 識別低效操作並計算可節省的 token */
function identifyTokenWaste(entry, history) {
  const tool = shortName(entry.tool);
  const args = entry.args || {};

  // 同檔案連讀多次
  if (tool === 'Read') {
    const filePath = args.file_path || '';
    const sameFileReads = history.filter(h =>
      shortName(h.tool) === 'Read' &&
      (h.args?.file_path || '') === filePath
    ).length + 1;

    if (sameFileReads >= 2) {
      const wastedTokens = estimateToolTokens(entry.tool, args) * (sameFileReads - 1);
      return {
        issue: `重複讀同檔案 ${sameFileReads} 次`,
        wasted: wastedTokens,
        suggestion: '用 Read 的 offset/limit 一次讀完，或改用 read_files_batch',
      };
    }
  }

  // Bash 逐行讀檔
  if (tool === 'Bash') {
    const cmd = args.command || '';
    if (/^\s*(cat|head|tail|grep|wc)\s+/i.test(cmd)) {
      const wastedTokens = estimateToolTokens(entry.tool, args) * 2;
      return {
        issue: 'Bash 做了內建工具的事',
        wasted: wastedTokens,
        suggestion: '用 Read / Grep 工具替代（省 token）',
      };
    }
  }

  return null;
}

/** Slack 通知（異步，不阻擋 hook） */
function notifySlack(message, isBlocked = false) {
  if (!SLACK_WEBHOOK || (!isBlocked && !NOTIFY_ON_BLOCK)) return;

  const payload = {
    text: isBlocked ? '🛑 Claude Code Block' : '⚠️ Claude Code Warning',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: message,
        },
      },
    ],
  };

  // 非阻擋執行，防止 hook 超時
  setTimeout(() => {
    try {
      execSync(`curl -X POST -H 'Content-type: application/json' --data '${JSON.stringify(payload).replace(/'/g, "'\\\\''")}' ${SLACK_WEBHOOK}`, {
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      // 忽略 Slack 通知失敗
    }
  }, 0);
}

/** 寫入投訴紀錄（讓其他專案的 session 可向 MCP_Server 反映 hook 太嚴格） */
function fileComplaint(toolName, patternId, message) {
  try {
    const cwd = process.cwd().replace(/\\/g, '/');
    const project = cwd.split('/').filter(Boolean).pop() || 'unknown';
    const entry = {
      ts: new Date().toISOString(),
      project,
      cwd,
      tool: toolName,
      pattern: patternId,
      message: message.replace(/\n/g, ' ').slice(0, 300),
      status: 'pending',
    };
    fs.appendFileSync(COMPLAINTS_PATH, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // 投訴寫入失敗不影響 hook 執行
  }
}

/** Debug 日誌輸出 */
function debugLog(message) {
  if (DEBUG_MODE) {
    process.stderr.write(`[hook-debug] ${message}\n`);
  }
}

/** 記憶注入內容智能截斷（只取前 500 字） */
function smartTruncateMemory(content, maxChars = 500) {
  if (content.length <= maxChars) return content;
  const truncated = content.substring(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  return lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated;
}

/** 生成自動修復建議（Bash sed → Edit 工具） */
function generateAutoFixSuggestion(entry) {
  const tool = shortName(entry.tool);
  if (tool !== 'Bash') return null;

  const cmd = entry.args?.command || '';

  // 偵測常見 sed 模式：sed 's/old/new/' file 或 sed -i 's/old/new/' file
  const sedMatch = cmd.match(/sed\s+(?:-i\s+)?['"]s\/([^/]+)\/([^/]*)\/['"].*(['"])(\S+)(['"])?/);
  if (sedMatch) {
    const oldStr = sedMatch[1];
    const newStr = sedMatch[2];
    const filePath = sedMatch[4];

    return {
      issue: 'Bash sed 修改檔案',
      suggestion: `改用 Edit 工具（更安全、可 review）：\n` +
                  `  Edit(file_path="${filePath}", old_string="${oldStr}", new_string="${newStr}")`,
    };
  }

  // 偵測 awk 模式
  if (cmd.match(/awk\s+/i)) {
    return {
      issue: 'Bash awk 文字處理',
      suggestion: '改用 Read 工具讀檔，用 JavaScript 在 browser_evaluate 或 Run Python 處理（更可控）',
    };
  }

  return null;
}

/** 新增自動修復建議的 Pattern */
const AUTO_FIX_PATTERN = {
  id: 'auto_fix_suggestion',
  detect: (entry, history) => {
    const suggestion = generateAutoFixSuggestion(entry);
    if (!suggestion) return null;

    return `[Auto-Fix Suggestion] ✨ 偵測到可自動化的操作：${suggestion.issue}\n` +
           `  💡 建議：${suggestion.suggestion}\n`;
  },
};

/** 從 session log 讀取最近一次 sftp_connect 的 host */
function getSessionHost(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]._sftpHost) return history[i]._sftpHost;
  }
  return null;
}

// ── 記憶強制注入（Scatter Search 觸發時載入）──────

const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

/** 從 CWD 推算專案的 memory 目錄 */
function findProjectMemoryDir() {
  const cwd = process.cwd().replace(/\\/g, '/');
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const drive = parts[0].replace(':', '').toLowerCase();
  const candidates = [
    `${drive}--${parts.slice(1).join('-')}`,
    `${drive}--${parts.slice(1).join('-').replace(/_/g, '-')}`,
    `${drive}--${parts[1]}`,
    `${drive}--${parts[1].replace(/_/g, '-')}`,
  ];

  for (const id of candidates) {
    const memDir = path.join(PROJECTS_DIR, id, 'memory');
    if (fs.existsSync(memDir)) return memDir;
  }
  return null;
}

/** 讀取指定記憶檔（相對於 memory 目錄），回傳內容或 null */
function loadMemoryFile(memDir, relPath) {
  if (!memDir) return null;
  const fp = path.join(memDir, relPath);
  try { return fs.readFileSync(fp, 'utf-8').trim(); } catch { return null; }
}

/** 偵測當前專案是否有 CODEMAPS */
function detectCodemaps() {
  const cwd = process.cwd().replace(/\\/g, '/');
  const candidates = [
    path.join(cwd, 'docs', 'CODEMAPS'),
    path.join(cwd, '.reports', 'codemaps'),
  ];
  for (const d of candidates) {
    if (fs.existsSync(d)) {
      try {
        const files = fs.readdirSync(d).filter(f => f.endsWith('.md'));
        if (files.length > 0) return { dir: d, files };
      } catch { /* ignore */ }
    }
  }
  return null;
}

/** 組裝記憶注入文字（Scatter Search 觸發時呼叫），智能截斷以節省 token */
function buildMemoryInjection(grepCount) {
  const memDir = findProjectMemoryDir();
  const codemaps = detectCodemaps();
  const lines = [];

  lines.push(`\n[Memory Injection] 🧠 偵測到 Grep 散搜模式（已搜 ${grepCount} 個不同路徑），強制載入搜尋策略記憶：\n`);

  // 1. 注入搜尋策略記憶（截斷）
  const searchStrategy = loadMemoryFile(memDir, 'feedback/general/feedback_search_strategy.md');
  if (searchStrategy) {
    const body = searchStrategy.replace(/^---[\s\S]*?---\s*/, '');
    const truncated = smartTruncateMemory(body, 400);
    lines.push('── feedback_search_strategy ──');
    lines.push(truncated);
    if (truncated.length < body.length) lines.push('（已截斷，詳細見記憶檔）');
    lines.push('');
  }

  // 2. 注入重複行為記憶（截斷）
  const repetition = loadMemoryFile(memDir, 'feedback/general/feedback_repetition_awareness.md');
  if (repetition) {
    const body = repetition.replace(/^---[\s\S]*?---\s*/, '');
    const truncated = smartTruncateMemory(body, 300);
    lines.push('── feedback_repetition_awareness ──');
    lines.push(truncated);
    if (truncated.length < body.length) lines.push('（已截斷，詳細見記憶檔）');
    lines.push('');
  }

  // 3. CODEMAPS 提醒
  if (codemaps) {
    lines.push(`── CODEMAPS 可用 ──`);
    lines.push(`此專案有 ${codemaps.files.length} 份 Codemap：${codemaps.files.join(', ')}`);
    lines.push(`📂 路徑：${codemaps.dir}`);
    lines.push(`⚡ 你必須先讀 Codemap 查函式行號，再用 Read(offset, limit) 精準讀取。`);
    lines.push(`   禁止繼續 Grep 掃描多個檔案。`);
    lines.push('');
  }

  // 4. MCP 工具提醒
  lines.push('── MCP 工具優先規則 ──');
  lines.push('  找函式碼 → class_method_lookup（一次到位，禁止 Grep→Read 兩步）');
  lines.push('  不確定位置 → find_usages（AST 精確搜尋）或先讀 CODEMAPS');
  lines.push('  知道函式名 → Grep OK，但不要散搜多個檔案');
  lines.push('  3+ 檔案 → 查 _batch 版本工具');
  lines.push('');
  lines.push('🛑 請立即停止散搜，改用上述高效工具。如果以上工具都不適用，先向使用者確認位置。');

  return lines.join('\n');
}

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
// block: true        = 直接阻擋（exit 2），強制使用 MCP 工具，不給機會
const BASH_PATTERNS = [
  {
    regex: /docker\s+exec\s+\S+\s+mysql/i,
    signature: 'bash:docker-mysql',
    hint: 'set_database + execute_sql / execute_sql_batch（MCP 工具，免重複 docker exec 開銷）',
    warnOnFirst: true,
    block: true,
  },
  {
    regex: /docker\s+exec\s+\S+\s+php\b/i,
    signature: 'bash:docker-php',
    hint: 'run_php_script / run_php_script_batch（MCP 工具）',
    warnOnFirst: true,
    block: false,
  },
  {
    regex: /docker\s+exec\s+\S+\s+python/i,
    signature: 'bash:docker-python',
    hint: 'run_python_script（MCP 工具）',
    warnOnFirst: true,
    block: true,
  },
  {
    regex: /\bmysql\s+(-[ueph]\s*\S+\s+)*.*(-e|--execute)/i,
    signature: 'bash:direct-mysql',
    hint: 'set_database + execute_sql / execute_sql_batch（MCP 工具）',
    warnOnFirst: true,
    block: false,
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
    regex: /git\s+(reset|checkout|clean)\s+--hard/i,
    signature: 'bash:git-destructive',
    hint: '禁用危險操作：可能丟失未 commit 的改動。請先用 git diff / git status 確認狀態，或改用 git restore --staged（安全取消暫存）。',
    warnOnFirst: true,
    block: true,
  },
  {
    regex: /git\s+push\s+--force/i,
    signature: 'bash:git-force-push',
    hint: '禁用 force push：可能覆蓋遠端歷史。除非確定遠端沒人用此分支，應改用 git push --force-with-lease（更安全）。',
    warnOnFirst: true,
    block: true,
  },
  {
    regex: /rm\s+-rf\s+/i,
    signature: 'bash:rm-recursive',
    hint: '禁用 rm -rf：易誤刪。改用 git clean -fd（只刪 untracked），或手動驗證後再刪。',
    warnOnFirst: true,
    block: true,
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

  // Bash 命令：有簽名用簽名，沒有則用命令前 80 字元分類（不同命令不互相累積）
  if (tool === 'Bash') {
    if (entry.bashSig) return entry.bashSig;
    const cmd = (entry.args?.command || '').trim().slice(0, 80);
    return cmd ? `Bash:${cmd}` : 'Bash';
  }

  // ToolSearch：不同工具/query 算不同類
  if (tool === 'ToolSearch') {
    const query = entry.args?.query || '';
    return `ToolSearch:${query}`;
  }

  // Playwright navigate：不同 URL 算不同類
  if (tool === 'mcp__project-migration-assistant-pro__browser_interact') {
    const actions = entry.args?.actions || [];
    const navActions = actions.filter(a => a.type === 'navigate');
    if (navActions.length > 0) {
      const urls = navActions.map(a => a.url).join('|');
      return `browser_navigate:${urls}`;
    }
  }

  // Read：同檔不同 offset/limit 算不同類（檔名 + offset 組合）
  if (tool === 'Read' || tool === 'read_file') {
    const filePath = entry.args?.file_path || entry.args?.path || '';
    const offset = entry.args?.offset || 0;
    const limit = entry.args?.limit || 'full';
    return `${tool}:${filePath}:${offset}:${limit}`;
  }

  // Grep：path + pattern 組合算不同類（不同搜尋目標不是重複）
  if (tool === 'Grep') {
    const grepPath = entry.args?.path || 'cwd';
    const pattern = entry.args?.pattern || '';
    return `Grep:${grepPath}:${pattern}`;
  }

  // Edit：file_path + old_string 前 80 字組合算不同類
  if (tool === 'Edit') {
    const filePath = entry.args?.file_path || '';
    const oldStr = (entry.args?.old_string || '').slice(0, 80);
    return `Edit:${filePath}:${oldStr}`;
  }

  // HTTP request：URL + method 組合算不同類（不同 endpoint 不是重複）
  if (tool === 'send_http_request') {
    const url = entry.args?.url || '';
    const method = entry.args?.method || 'GET';
    return `send_http_request:${method}:${url}`;
  }

  // browser_evaluate / browser_run_code：function 前 100 字算不同類
  if (tool === 'browser_evaluate' || tool === 'browser_run_code') {
    const fn = (entry.args?.function || entry.args?.code || '').slice(0, 100);
    return `${tool}:${fn}`;
  }

  // image_diff：不同圖片對算不同類（批次比對不是重複）
  if (tool === 'image_diff') {
    const a = entry.args?.image_a || '';
    const b = entry.args?.image_b || '';
    return `image_diff:${a}:${b}`;
  }

  // dom_compare：不同 URL 對算不同類
  if (tool === 'dom_compare') {
    const a = entry.args?.url_a || '';
    const b = entry.args?.url_b || '';
    return `dom_compare:${a}:${b}`;
  }

  // Playwright browser 操作：tool + ref/url 組合
  if (tool.startsWith('browser_')) {
    const ref = entry.args?.ref || entry.args?.url || '';
    return `${tool}:${ref}`;
  }

  // 其他檔案工具：用副檔名分類
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
    // Layer 1: Wrong Tool — 有明確替代工具卻用 Bash
    //   block: true  → exit 2 阻擋，工具呼叫被拒絕（docker exec mysql/php/python）
    //   block: false → exit 0 警告，允許但提醒（cat/grep/find/sed 等）
    id: 'bash_wrong_tool',
    detect: (entry, _history) => {
      if (shortName(entry.tool) !== 'Bash') return null;
      const cmd = entry.args?.command || '';
      const pat = matchBashPattern(cmd);
      if (!pat || !pat.warnOnFirst) return null;

      if (pat.block) {
        return {
          block: true,
          message: `[Wrong Tool] ❌ BLOCKED：Bash 執行「${pat.signature}」被阻擋。\n` +
                   `  → 必須改用：${pat.hint}\n` +
                   `  → 此類操作已被強制禁止使用 Bash，請改用 MCP 工具。\n`,
        };
      }

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
    // Layer 2.4: Grep PHP Symbol — Grep 搜尋 PHP class/method 時提醒用 AST 工具
    id: 'grep_php_symbol',
    detect: (entry, _history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Grep') return null;

      const pattern = entry.args?.pattern || '';
      const filePath = entry.args?.path || '';
      const glob = entry.args?.glob || '';

      // 偵測搜尋 PHP class/method 的 pattern
      const isPhpContext = /\.php/i.test(glob) || /\.php/i.test(filePath) ||
        /admin|model|controller|cls\b/i.test(filePath);
      if (!isPhpContext) return null;

      // 搜尋 class 名稱、method 呼叫、extends/implements
      const isSymbolSearch = /(::|->|extends|implements|new\s+|class\s+|function\s+)/i.test(pattern) ||
        /^[A-Z][a-zA-Z]+$/.test(pattern); // PascalCase = likely class name
      if (!isSymbolSearch) return null;

      return `[PHP Symbol] 💡 偵測到用 Grep 搜尋 PHP class/method「${pattern.substring(0, 40)}」。\n` +
             `  PHP 關係型查詢請改用 MCP AST 工具（精確、零 token）：\n` +
             `  → find_usages：找「誰呼叫了這個 method」「哪裡用到這個 class」\n` +
             `  → find_hierarchy：找繼承鏈（extends / implements）\n` +
             `  → class_method_lookup：直接取得 method 原始碼\n` +
             `  Grep 只適合搜「變數名」「字串常數」等純文字定位。\n`;
    },
  },
  {
    // Layer 2.5: Scatter Search — Grep 搜不同路徑 ≥ 2 次，強制注入記憶
    //   偵測「不確定功能在哪 → 到處 Grep」的低效模式
    //   觸發時讀取 memory 檔案內容直接注入 context，強制 Claude 想起 CODEMAPS / MCP 工具
    id: 'grep_scatter_search',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Grep') return null;

      // 統計歷史中 Grep 過的不同路徑/pattern
      const grepEntries = history.filter(h => shortName(h.tool) === 'Grep');
      const currentPath = entry.args?.path || entry.args?.pattern || '';
      const uniquePaths = new Set(grepEntries.map(h => h.args?.path || h.args?.pattern || ''));
      uniquePaths.add(currentPath);

      // 不同路徑 ≥ 3 → 散搜模式確認
      if (uniquePaths.size < 3) return null;

      // 檢查是否已注入過完整記憶（用 history 裡的標記判斷）
      const alreadyInjected = history.some(h => h._memoryInjected);
      if (alreadyInjected) {
        // 已注入過完整記憶，只給簡短提醒
        return `[Scatter Search] ⚠️ Grep 已散搜 ${uniquePaths.size} 個不同路徑。記憶已載入，請遵守搜尋策略。\n`;
      }

      // 首次觸發：注入完整記憶（在 entry 標記，會被寫入 log）
      entry._memoryInjected = true;
      return buildMemoryInjection(uniquePaths.size);
    },
  },
  {
    // Layer 2.6: Grep→Read Alternation — 交替 Grep/Read 搜尋模式偵測
    //   偵測「Grep 找到 → Read 看內容 → 又 Grep 另一個」的追蹤模式
    id: 'grep_read_alternation',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Grep' && tool !== 'Read') return null;

      // 取最近 8 筆，看 Grep↔Read 交替次數
      const recent = history.slice(-8).map(h => shortName(h.tool));
      recent.push(tool);

      let alternations = 0;
      for (let i = 1; i < recent.length; i++) {
        const prev = recent[i - 1];
        const curr = recent[i];
        if ((prev === 'Grep' && curr === 'Read') || (prev === 'Read' && curr === 'Grep')) {
          alternations++;
        }
      }

      if (alternations < 3) return null;

      return `[Scatter Search] ⚠️ 偵測到 Grep↔Read 交替搜尋模式（${alternations} 次切換）。\n` +
             `  這是低效的「順藤摸瓜」模式，請改用：\n` +
             `  → class_method_lookup：PHP 函式一次到位取得原始碼\n` +
             `  → find_usages：AST 精確搜尋 class/method 引用位置\n` +
             `  → CODEMAPS：查函式行號後 Read(offset, limit) 精準讀取\n`;
    },
  },
  {
    // Layer 3: Same Category Repeat — 同類操作 3 次才警告，7 次阻擋
    //   排除 Read→Edit 必要流程（Edit 前的 Read 不計入重複）
    id: 'same_category_repeat',
    detect: (entry, history) => {
      // 跳過已被 bash_pattern_repeat 處理的
      if (entry.bashSig) return null;

      const catKey = getCategoryKey(entry);
      const tool = shortName(entry.tool);

      // 排除 Read→Edit 必要流程：如果當前是 Edit，最後一個 Read 是同檔且 offset/limit 一致，則不計
      if ((tool === 'Edit' || tool === 'write') && entry.args?.file_path) {
        const lastRead = history.slice(-1)[0];
        if (lastRead && (shortName(lastRead.tool) === 'Read' || shortName(lastRead.tool) === 'read_file')) {
          if (lastRead.args?.file_path === entry.args?.file_path) {
            // Edit 前有同檔 Read，不計重複
            return null;
          }
        }
      }

      const sameCategory = history.filter(h => getCategoryKey(h) === catKey);
      const count = sameCategory.length + 1;

      // 低於 3 次不提醒
      if (count < 3) return null;

      const batchHint = lookupBatchHint(entry);
      const displayName = shortName(entry.tool);

      // 10 次以上 → 阻擋
      if (count >= 10) {
        const lines = [`[Repetition Detector] ❌ BLOCKED：${displayName} 同類操作已達 ${count} 次，強制暫停。`];
        if (batchHint) {
          lines.push(`  → 必須改用 batch 工具：${batchHint}`);
        }
        lines.push('  → 停下來重新評估策略，不要繼續重複同類操作。');
        return { block: true, message: lines.join('\n') + '\n' };
      }

      // 3-6 次 → 警告（但最早只在第 3 次觸發）
      if (count >= 3) {
        const lines = [`[Repetition Detector] ⚠️ ${displayName} 同類操作已執行 ${count} 次（7 次將被阻擋）。請暫停思考：`];
        if (batchHint) {
          lines.push(`  - 建議改用 batch 工具：${batchHint}`);
        } else {
          lines.push('  - 是否有更高效的批次做法？');
        }
        lines.push('  - 當前策略本身是否需要調整？');
        return lines.join('\n') + '\n';
      }

      return null;
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
      if (count < 5) return null;
      return {
        block: true,
        message: `[Repetition Detector] ❌ BLOCKED：完全相同的工具呼叫已達 ${count} 次。停下來重新評估策略。\n`,
      };
    },
  },
  {
    // Layer 4: Post-Tool-Use 提前檢測 — 在執行 Edit/Write 後累積超過 15+ 未 commit 檔案
    id: 'uncommitted_accumulation',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Edit' && tool !== 'Write') return null;

      // 只在最近有 Edit/Write 且累積超過 15 個檔案時檢查
      const recentEdits = history.slice(-20).filter(h => {
        const t = shortName(h.tool);
        return t === 'Edit' || t === 'Write';
      });
      if (recentEdits.length < 5) return null;

      const uncommittedCount = checkUncommittedFiles();
      if (uncommittedCount >= 15) {
        return `[Post-Tool-Use] ℹ️ 已修改 ${uncommittedCount} 個檔案未 commit。若預期這次改動是原子性的，建議稍後執行 git commit。\n`;
      }
      return null;
    },
  },
  {
    // Layer 5: 成本追蹤 — 識別低效操作並估算 token 浪費
    id: 'token_waste_detection',
    detect: (entry, history) => {
      const waste = identifyTokenWaste(entry, history);
      if (!waste) return null;

      const lines = [
        `[Token Accounting] 💰 偵測到低效操作：${waste.issue}`,
        `  估計浪費 ~${waste.wasted} tokens`,
        `  💡 建議：${waste.suggestion}`,
      ];
      return lines.join('\n') + '\n';
    },
  },
  AUTO_FIX_PATTERN,
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
const hookStartTime = Date.now();

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'default';
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};

    const shortToolName = shortName(toolName);
    const logPath = getLogPath(sessionId);
    const history = readLog(logPath);

    // sftp_connect：記錄 host 到 session log，然後放行
    if (shortToolName === 'sftp_connect') {
      const host = toolInput.host || '';
      const entry = { tool: toolName, _sftpHost: host, ts: Date.now() };
      history.push(entry);
      if (history.length > 50) history.splice(0, history.length - 50);
      writeLog(logPath, history);
      process.stderr.write(`[repetition-detector] pass: sftp_connect → ${host}\n`);
      process.exit(0);
    }

    // sftp/ssh 操作：內網放行，外網照常偵測
    if (NETWORK_TOOLS.has(shortToolName)) {
      const host = getSessionHost(history);
      if (isInternalHost(host)) {
        // 內網 → 直接放行，不偵測也不記錄
        process.stderr.write(`[repetition-detector] pass: ${shortToolName} (internal: ${host})\n`);
        process.exit(0);
      }
      // 外網 → 繼續走正常偵測流程
    }

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
    debugLog(`PreToolUse: tool=${shortToolName}, args keys=${Object.keys(toolInput || {}).join(',')}`);
    const warnings = [];
    let shouldBlock = false;
    let blockMessage = '';
    let blockPatternId = '';

    for (const pat of PATTERNS) {
      const result = pat.detect(currentEntry, history);
      if (result) {
        debugLog(`Pattern matched: ${pat.id}`);
        if (typeof result === 'object' && result.block) {
          shouldBlock = true;
          blockMessage = result.message;
          blockPatternId = pat.id;
          warnings.push(result.message);
        } else {
          warnings.push(result);
        }
      }
    }

    if (warnings.length > 0) {
      process.stdout.write(warnings.join('\n'));
    }

    // 被阻擋時：寫投訴 → Slack 通知 → exit 2
    if (shouldBlock) {
      process.stderr.write(`[repetition-detector] BLOCKED: ${shortToolName} — ${blockMessage}\n`);
      fileComplaint(shortToolName, blockPatternId, blockMessage);
      // 在 stdout 追加投訴提示，讓被擋的 session 知道已記錄
      process.stdout.write('\n📢 此阻擋已自動記錄到投訴系統。若認為不合理，請告知使用者到 MCP_Server 專案執行 /hook_complaints 審查。\n');
      notifySlack(blockMessage, true);
      process.exit(2);
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
    // 持久化記憶注入標記（跨 process 保留）
    if (currentEntry._memoryInjected) {
      storedEntry._memoryInjected = true;
    }

    history.push(storedEntry);
    if (history.length > 50) history.splice(0, history.length - 50);
    writeLog(logPath, history);

    if (Math.random() < 0.1) cleanOldLogs();

    // Hook 效能監控
    const hookMs = Date.now() - hookStartTime;
    if (hookMs > 100) {
      process.stderr.write(`[repetition-detector] slow: ${shortToolName} took ${hookMs}ms\n`);
    } else {
      debugLog(`Hook completed in ${hookMs}ms`);
    }

    process.stderr.write(`[repetition-detector] pass: ${shortToolName}\n`);
    process.exit(0);
  } catch (e) {
    const hookMs = Date.now() - hookStartTime;
    process.stderr.write(`[repetition-detector] error (ignored, took ${hookMs}ms): ${e.message}\n`);
    process.exit(0);
  }
});
