#!/usr/bin/env node
/**
 * PreToolUse Hook — Tool Choice & Repetition Guard（工具選擇 + 重複行為偵測）
 *
 * 三層防線：
 * Layer 1 — Wrong Tool（首次即攔）：Bash 做了有專用工具的事，不需歷史紀錄
 * Layer 2 — Scatter Search（累計偵測）：Grep 散搜多檔案時強制注入記憶，提醒用 CODEMAPS / RAG / MCP 工具
 * Layer 3 — Repetition（累計偵測）：同類操作重複時建議 batch 或策略調整
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

/** 從 session log 讀取最近一次 sftp_connect 的 host */
function getSessionHost(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]._sftpHost) return history[i]._sftpHost;
  }
  return null;
}

// ── 記憶強制注入（Scatter Search 觸發時載入）──────

const HOME = process.env.HOME || process.env.USERPROFILE;
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

/** 組裝記憶注入文字（Scatter Search 觸發時呼叫） */
function buildMemoryInjection(grepCount) {
  const memDir = findProjectMemoryDir();
  const codemaps = detectCodemaps();
  const lines = [];

  lines.push(`\n[Memory Injection] 🧠 偵測到 Grep 散搜模式（已搜 ${grepCount} 個不同路徑），強制載入搜尋策略記憶：\n`);

  // 1. 注入搜尋策略記憶
  const searchStrategy = loadMemoryFile(memDir, 'feedback/general/feedback_search_strategy.md');
  if (searchStrategy) {
    // 只取 frontmatter 之後的內容
    const body = searchStrategy.replace(/^---[\s\S]*?---\s*/, '');
    lines.push('── feedback_search_strategy ──');
    lines.push(body);
    lines.push('');
  }

  // 2. 注入重複行為記憶
  const repetition = loadMemoryFile(memDir, 'feedback/general/feedback_repetition_awareness.md');
  if (repetition) {
    const body = repetition.replace(/^---[\s\S]*?---\s*/, '');
    lines.push('── feedback_repetition_awareness ──');
    lines.push(body);
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
  lines.push('  不確定位置 → rag_query（語意搜尋）或先讀 CODEMAPS');
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
    block: true,
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
    block: true,
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
    // Layer 2.5: Scatter Search — Grep 搜不同路徑 ≥ 2 次，強制注入記憶
    //   偵測「不確定功能在哪 → 到處 Grep」的低效模式
    //   觸發時讀取 memory 檔案內容直接注入 context，強制 Claude 想起 CODEMAPS / RAG / MCP 工具
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
             `  → rag_query：語意搜尋直接定位功能所在檔案\n` +
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

      // 7 次以上 → 阻擋
      if (count >= 7) {
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
      if (count < 3) return null;
      return {
        block: true,
        message: `[Repetition Detector] ❌ BLOCKED：完全相同的工具呼叫已達 ${count} 次。停下來重新評估策略。\n`,
      };
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
    const warnings = [];
    let shouldBlock = false;
    for (const pat of PATTERNS) {
      const result = pat.detect(currentEntry, history);
      if (result) {
        if (typeof result === 'object' && result.block) {
          shouldBlock = true;
          warnings.push(result.message);
        } else {
          warnings.push(result);
        }
      }
    }

    if (warnings.length > 0) {
      process.stdout.write(warnings.join('\n'));
    }

    // 被阻擋時不記錄（因為工具呼叫不會實際執行），直接 exit 2
    if (shouldBlock) {
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

    process.stderr.write(`[repetition-detector] pass: ${shortToolName}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[repetition-detector] pass (error ignored)\n`);
    process.exit(0);
  }
});
