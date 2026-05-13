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
import {
  HOME,
  CLAUDE_HOOK_DEBUG as DEBUG_MODE,
  CLAUDE_SLACK_WEBHOOK as SLACK_WEBHOOK,
  CLAUDE_NOTIFY_ON_BLOCK as NOTIFY_ON_BLOCK,
  CLAUDE_TOKEN_FEEDBACK as TOKEN_FEEDBACK_MODE,
  CLAUDE_SUMMARY_INTERVAL as PASSIVE_SUMMARY_INTERVAL,
} from '../env.js';

// ── 設定 ──────────────────────────────────────────
const LOG_DIR = path.join(os.tmpdir(), 'claude_tool_logs');
const COMPLAINTS_PATH = path.join(HOME, '.claude', 'hook-complaints.jsonl');
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

/** 識別低效操作並計算可節省的 token（回傳陣列，可能一次偵測到多個問題） */
function identifyTokenWaste(entry, history) {
  const tool = shortName(entry.tool);
  const args = entry.args || {};
  const issues = [];

  // ── W1: 同檔案連讀多次 ──
  if (tool === 'Read' || tool === 'read_file') {
    const filePath = args.file_path || args.path || '';
    const sameFileReads = history.filter(h => {
      const t = shortName(h.tool);
      return (t === 'Read' || t === 'read_file') &&
        (h.args?.file_path || h.args?.path || '') === filePath;
    }).length + 1;

    if (sameFileReads >= 2) {
      const isPhp = /\.php$/i.test(filePath);
      const phpHint = isPhp
        ? '；.php 檔請改用 class_method_lookup(class, method) 直接抓 method 原始碼，免分段'
        : '';
      issues.push({
        id: 'W1_duplicate_read',
        issue: `重複讀同檔案 ${sameFileReads} 次：${path.basename(filePath)}`,
        wasted: estimateToolTokens(entry.tool, args) * (sameFileReads - 1),
        suggestion: `一次用 Read(offset, limit) 讀完需要的區段，或用 Grep 定位行號再精準讀${phpHint}`,
      });
    }
  }

  // ── W9: 同檔多次小 limit 分段讀（碎片化讀取） ──
  //   觸發：同 file_path 在最近 N 步內被 Read ≥4 次，且每次 limit ≤60
  //   常見壞模式：明明 Read 預設可讀 2000 行，卻刻意 limit:30~60 反覆切片讀
  if (tool === 'Read' || tool === 'read_file') {
    const filePath = args.file_path || args.path || '';
    if (filePath && (args.limit ?? 9999) <= 60) {
      const recentSmallReads = history.slice(-15).filter(h => {
        const t = shortName(h.tool);
        if (t !== 'Read' && t !== 'read_file') return false;
        if ((h.args?.file_path || h.args?.path || '') !== filePath) return false;
        return (h.args?.limit ?? 9999) <= 60;
      });
      const totalSmallReads = recentSmallReads.length + 1;
      if (totalSmallReads >= 4) {
        issues.push({
          id: 'W9_fragmented_small_reads',
          issue: `同檔 ${path.basename(filePath)} 已用小 limit (≤60) Read ${totalSmallReads} 次，碎片化讀取`,
          wasted: totalSmallReads * 150,
          suggestion: 'Read 預設可讀 2000 行，一次讀完省去多次 round-trip；或先 Grep 定位行號再精準讀',
        });
      }
    }
  }

  // ── W2: Read 大檔案未用 offset/limit ──
  if (tool === 'Read' || tool === 'read_file') {
    const hasOffset = args.offset != null;
    const hasLimit = args.limit != null;
    if (!hasOffset && !hasLimit) {
      // 檢查歷史中是否有對同檔案的 Grep 結果（代表知道位置但仍整檔讀取）
      const filePath = args.file_path || args.path || '';
      const hadGrep = history.some(h =>
        shortName(h.tool) === 'Grep' &&
        (h.args?.path || '').includes(path.basename(filePath))
      );
      if (hadGrep) {
        issues.push({
          id: 'W2_read_without_offset',
          issue: `已 Grep 定位過卻整檔 Read：${path.basename(filePath)}`,
          wasted: 800, // 估算：整檔 vs 精準讀的差距
          suggestion: '已知行號就用 Read(offset, limit) 精準讀取，省掉不需要的上下文',
        });
      }
    }
  }

  // ── W3: Bash 做了內建工具的事（與 L1 互補，L1 是即時警告，這裡是 token 計算） ──
  if (tool === 'Bash') {
    const cmd = args.command || '';
    if (/^\s*(cat|head|tail|grep|wc)\s+/i.test(cmd)) {
      issues.push({
        id: 'W3_bash_builtin',
        issue: 'Bash 做了內建工具的事',
        wasted: estimateToolTokens(entry.tool, args) * 2,
        suggestion: '用 Read / Grep 工具替代（省 token、輸出結構化）',
      });
    }
  }

  // ── W4: Agent 重複搜尋相似目標 ──
  if (tool === 'Agent') {
    const prompt = (args.prompt || '').slice(0, 200).toLowerCase();
    const recentAgents = history.filter(h => shortName(h.tool) === 'Agent');
    for (const prev of recentAgents) {
      const prevPrompt = (prev.args?.prompt || '').slice(0, 200).toLowerCase();
      if (prevPrompt && prompt && stringSimilarity(prompt, prevPrompt) > 0.6) {
        issues.push({
          id: 'W4_agent_similar_search',
          issue: '多次派遣 Agent 做相似搜尋任務',
          wasted: 3000, // Agent 開銷大
          suggestion: '合併搜尋需求到一次 Agent 呼叫，或用 Grep/Glob 直接定位',
        });
        break;
      }
    }
  }

  // ── W5: Grep 結果太大（head_limit 未設 + 無 glob 過濾） ──
  if (tool === 'Grep') {
    const hasGlob = !!args.glob;
    const hasType = !!args.type;
    const hasLimit = args.head_limit != null;
    const hasPath = !!args.path;
    // 沒有任何過濾條件 = 全目錄暴搜
    if (!hasGlob && !hasType && !hasLimit && !hasPath) {
      issues.push({
        id: 'W5_grep_unscoped',
        issue: 'Grep 無任何過濾（無 glob、type、path、head_limit）',
        wasted: 600,
        suggestion: '加 glob/type 縮小範圍，或設 head_limit 限制輸出量',
      });
    }
  }

  // ── W6: 連續 ToolSearch 相同工具 ──
  if (tool === 'ToolSearch') {
    const query = args.query || '';
    const recentTS = history.filter(h => shortName(h.tool) === 'ToolSearch');
    const dupCount = recentTS.filter(h => (h.args?.query || '') === query).length;
    if (dupCount >= 1) {
      issues.push({
        id: 'W6_duplicate_toolsearch',
        issue: `重複 ToolSearch 同一 query: "${query.slice(0, 40)}"`,
        wasted: 400,
        suggestion: 'ToolSearch 結果在整個對話中都有效，不需重複查詢',
      });
    }
  }

  // ── W7: 多個單檔 MCP 工具可用 batch 替代 ──
  if (BATCH_HINTS[tool]) {
    const recentSame = history.slice(-10).filter(h => shortName(h.tool) === tool).length;
    if (recentSame >= 2) {
      issues.push({
        id: 'W7_batch_available',
        issue: `連續 ${recentSame + 1} 次 ${tool}，有 batch 版可用`,
        wasted: recentSame * 200, // 每次 round-trip 開銷
        suggestion: `改用 ${BATCH_HINTS[tool]} 一次處理`,
      });
    }
  }

  // ── W8: browser_interact 頻繁截圖（連續 screenshot action） ──
  if (tool === 'browser_interact') {
    const actions = args.actions || [];
    const hasScreenshot = actions.some(a => a.type === 'screenshot');
    if (hasScreenshot) {
      const recentScreenshots = history.slice(-6).filter(h => {
        if (shortName(h.tool) !== 'browser_interact') return false;
        return (h.args?.actions || []).some(a => a.type === 'screenshot');
      }).length;
      if (recentScreenshots >= 3) {
        issues.push({
          id: 'W8_frequent_screenshot',
          issue: `近期 ${recentScreenshots + 1} 次截圖操作`,
          wasted: recentScreenshots * 1200,
          suggestion: '截圖消耗大量 token（圖片 base64），合併操作後再截一次確認',
        });
      }
    }
  }

  return issues.length > 0 ? issues : null;
}

/** 簡易字串相似度（Jaccard on bigrams），用於 Agent prompt 比對 */
function stringSimilarity(a, b) {
  const bigrams = s => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const bg of setA) if (setB.has(bg)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

/** 計算 session 累計 token 浪費摘要（被動模式用） */
function buildTokenSummary(history) {
  const allWastes = [];
  let totalWasted = 0;

  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    const prevHistory = history.slice(0, i);
    const wastes = identifyTokenWaste(entry, prevHistory);
    if (wastes) {
      for (const w of wastes) {
        totalWasted += w.wasted;
        // 累計每種問題的次數
        const existing = allWastes.find(x => x.id === w.id);
        if (existing) {
          existing.count++;
          existing.totalWasted += w.wasted;
        } else {
          allWastes.push({ id: w.id, issue: w.issue, suggestion: w.suggestion, count: 1, totalWasted: w.wasted });
        }
      }
    }
  }

  if (allWastes.length === 0) return null;

  // 按浪費量排序
  allWastes.sort((a, b) => b.totalWasted - a.totalWasted);

  const lines = [
    `\n[Token Summary] 📊 本次對話效率報告（${history.length} 次工具呼叫）：`,
    `  累計可節省 ~${totalWasted} tokens`,
    '',
  ];

  for (const w of allWastes.slice(0, 5)) {
    lines.push(`  • ${w.issue}（${w.count} 次，~${w.totalWasted} tokens）`);
    lines.push(`    💡 ${w.suggestion}`);
  }

  lines.push('');
  return lines.join('\n');
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

/**
 * 讀取最近 N 則使用者訊息（從 transcript JSONL 倒著讀，效能 OK）
 * 返回 [{ts, text}, ...]，最新在前
 */
let _CURRENT_TRANSCRIPT_PATH = '';
function readRecentUserMessages(limit = 5) {
  if (!_CURRENT_TRANSCRIPT_PATH) return [];
  try {
    const raw = fs.readFileSync(_CURRENT_TRANSCRIPT_PATH, 'utf-8');
    const lines = raw.trim().split(/\r?\n/);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'user' && obj.message?.role === 'user') {
          const c = obj.message.content;
          let text = '';
          if (typeof c === 'string') text = c;
          else if (Array.isArray(c)) {
            text = c.filter(x => x?.type === 'text').map(x => x.text || '').join('\n');
          }
          if (text.trim()) out.push({ ts: Date.parse(obj.timestamp || '') || 0, text });
        }
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
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
  lines.push('  追邏輯流程 → trace_logic（解析 if/switch 分支 + 遞迴展開子呼叫）');
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
//
// Fallback override：命令內含 `# mcp-fallback: <reason>` 即放行（不 block、不警告）
// 用於 MCP 工具真的不適用的場景（如下載二進位、環境探測），保留審計軌跡
const MCP_FALLBACK_RE = /#\s*mcp-fallback\s*:/i;

// Block 例外白名單：命中即降為純警告（不 block）
// 用於明確合法的 Bash 用途，避免誤傷
const BASH_BLOCK_ALLOWLIST = [
  /--version\b/,                                  // 版本探測
  /\s-h\b|\s--help\b/,                            // help
  /github\.com\/[^\s]+\/releases\//i,             // GitHub releases 下載
  /ghcr\.io\//i,                                  // 容器 registry
  /\blocalhost[:\/]/i,                            // 本機探測
  /\b127\.0\.0\.1[:\/]/,                          // 本機探測
];

// rm -rf 安全白名單：限定明確 tmp / drift 暫存路徑（搭配 cleanup_path 工具的同等規則）
const RM_TMP_WHITELIST = [
  /\brm\s+-r?f?\s+["']?[dD]:[/\\]tmp[/\\]/,
  /\brm\s+-r?f?\s+["']?[cC]:[/\\]Users[/\\][^/\\]+[/\\]AppData[/\\]Local[/\\]Temp[/\\]/,
  /\brm\s+-r?f?\s+["']?\/tmp\//,
  /\brm\s+-r?f?\s+[^\s]*[/\\]_tmp_remote[/\\]/i,
  /\brm\s+-r?f?\s+[^\s]*[/\\]_drift[/\\]/i,
  /\brm\s+-r?f?\s+[^\s]*[/\\]\.tmp[/\\]/i,
];

function isBashAllowed(command) {
  if (!command) return false;
  if (MCP_FALLBACK_RE.test(command)) return true;
  if (RM_TMP_WHITELIST.some(re => re.test(command))) return true;
  return BASH_BLOCK_ALLOWLIST.some(re => re.test(command));
}

const BASH_PATTERNS = [
  {
    // docker cp：檔案傳輸，無對應 MCP 工具（與 docker exec 不同），不警告也不擋
    // silent=true：L1/L2 不輸出訊息，僅取 bashSig 供 L3 同類去重
    regex: /^\s*docker\s+cp\b/i,
    signature: 'bash:docker-cp',
    hint: '',
    warnOnFirst: false,
    block: false,
    silent: true,
  },
  {
    regex: /docker\s+exec\s+\S+\s+mysql/i,
    // -e "SHOW / EXPLAIN / DESCRIBE / DESC / CREATE VIEW|TABLE|... / ALTER / DROP / USE / SET / RESET / FLUSH / ANALYZE / OPTIMIZE / CHECK / REPAIR" 等 DDL/meta query 放行
    // 原因：execute_sql 對 SHOW CREATE VIEW / FULL COLUMNS / TABLE STATUS 等 meta 輸出常截斷不全，DDL 場景 docker exec mysql -e 是合理替代
    skipIfMatch: /-e\s+["']?\s*(SHOW|EXPLAIN|DESCRIBE|DESC|CREATE|ALTER|DROP|USE|SET|RESET|FLUSH|ANALYZE|OPTIMIZE|CHECK|REPAIR)\b/i,
    signature: 'bash:docker-mysql',
    hint: 'set_database + execute_sql / execute_sql_batch（MCP 工具，免重複 docker exec 開銷）',
    warnOnFirst: true,
    block: false,
  },
  {
    regex: /docker\s+exec\s+\S+\s+php\b/i,
    signature: 'bash:docker-php',
    hint: 'run_php_script / run_php_script_batch / run_php_code（MCP 工具）',
    warnOnFirst: true,
    block: false,
  },
  {
    regex: /docker\s+exec\s+\S+\s+python/i,
    signature: 'bash:docker-python',
    hint: 'run_python_script（MCP 工具）',
    warnOnFirst: true,
    block: false,
  },
  {
    regex: /\bmysql\s+(-[ueph]\s*\S+\s+)*.*(-e|--execute)/i,
    skipIfMatch: /(-e|--execute)\s+["']?\s*(SHOW|EXPLAIN|DESCRIBE|DESC|CREATE|ALTER|DROP|USE|SET|RESET|FLUSH|ANALYZE|OPTIMIZE|CHECK|REPAIR)\b/i,
    signature: 'bash:direct-mysql',
    hint: 'set_database + execute_sql / execute_sql_batch（MCP 工具）',
    warnOnFirst: true,
    block: false,
  },
  {
    // Bash grep 對 .php 檔 → BLOCK（規避 L2.4/L2.4b/L2.4c PHP symbol 偵測的常見手法）
    // 必須放在 bash:read-file 之前，否則 `grep ... | head` 會先命中 head pattern
    regex: /\b(grep|rg|findstr)\b.*\.php\b/i,
    signature: 'bash:grep-php',
    hint: 'PHP 符號定位請用 AST 工具：class_method_lookup / find_usages / symbol_index / trace_logic。\n  純文字搜尋請用 Grep 工具帶 glob="*.php"。\n  禁 Bash grep .php — 規避 PHP symbol hook 偵測。',
    warnOnFirst: true,
    block: false,
  },
  {
    // Bash grep 對 PHP 專案目錄（cls / model / controller / service / repository / trait）→ BLOCK
    regex: /\b(grep|rg|findstr)\b[^|]*\b(cls|model|controller|service|repository|trait)s?\b/i,
    signature: 'bash:grep-php-dir',
    hint: 'PHP 目錄符號查詢請用 AST 工具：class_method_lookup / find_usages / symbol_index。',
    warnOnFirst: true,
    block: false,
  },
  {
    // rg --type php → BLOCK（同等於指定 PHP 檔，但無 .php 字面）
    regex: /\brg\b[^|]*--type\s+php\b/i,
    signature: 'bash:rg-type-php',
    hint: '改用 AST 工具或 Grep 工具 type="php"。',
    warnOnFirst: true,
    block: false,
  },
  {
    // Node 自寫 file-read-and-grep → BLOCK（規避 PHP symbol 偵測的繞道路徑）
    regex: /\bnode\b[^|]*-e\b[^|]*\b(readFile(Sync)?|fs\.read)[^|]*\.php\b/i,
    signature: 'bash:node-grep-php',
    hint: 'PHP 符號用 AST 工具：class_method_lookup / find_usages / symbol_index。禁用 node 自寫 grep 繞道。',
    warnOnFirst: true,
    block: false,
  },
  {
    // awk / sed 對 .php 檔 → BLOCK
    regex: /\b(awk|sed)\b[^|]*\.php\b/i,
    signature: 'bash:awk-sed-php',
    hint: 'PHP 處理請用 AST 工具（讀取）+ apply_diff（修改），不要 awk/sed。',
    warnOnFirst: true,
    block: false,
  },
  {
    // PowerShell Select-String 對 .php → BLOCK
    // 雙向：Select-String 後接 .php，或 .php 透過 pipe 餵給 Select-String
    regex: /\bSelect-String\b.*\.php\b|\.php\b.*\bSelect-String\b/i,
    signature: 'bash:powershell-grep-php',
    hint: 'PHP 符號用 AST 工具，不要透過 PowerShell Select-String 規避。',
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
    regex: /\bfind\s+(\S+\s+)?-(name|type|iname|path|maxdepth|mindepth)\b/i,
    signature: 'bash:find',
    hint: 'Glob 工具（內建，模式匹配更快，不需 Bash）',
    warnOnFirst: true,
  },
  {
    // ls / dir：列目錄一律改用 list_files / Glob
    // 排除 `ls -la | grep ...` 這類少見但合理的組合（已被 grep pattern 攔下，不重複擋）
    regex: /^\s*(ls|dir)\b(?!\s+\|)/i,
    signature: 'bash:ls',
    hint: 'list_files / list_files_batch（MCP 工具，結構化輸出含大小/日期）或 Glob（內建模式匹配）',
    warnOnFirst: true,
    block: false,
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
    warnOnFirst: true,
    block: false,
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
    warnOnFirst: true,
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
    if (pat.regex.test(command)) {
      // 若 pattern 帶 skipIfMatch：命令符合時視為合法用途，放行（用於 mysql DDL/SHOW/EXPLAIN 等 meta query）
      if (pat.skipIfMatch && pat.skipIfMatch.test(command)) return null;
      return pat;
    }
  }
  return null;
}

/**
 * 從 grep PHP 命令解析符號，產出具體 AST 工具呼叫建議。
 * 例：grep -rn "OrderModel::add" cls/ → 建議 class_method_lookup({class:"OrderModel", method:"add"})
 */
function buildPhpAstSuggestions(command) {
  if (!command) return null;
  // 抽取 grep/rg/findstr 的搜尋字串（雙引號、單引號、或裸字）
  const m = command.match(/\b(?:grep|rg|findstr)\b\s+(?:[-]\S+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (!m) return null;
  const pattern = (m[1] || m[2] || m[3] || '').trim();
  if (!pattern) return null;

  const lines = ['  → 具體 AST 工具呼叫：'];

  // ClassName::method 或 ClassName->method
  const cm = pattern.match(/([A-Z][A-Za-z0-9_]+)\s*(?:::|->)\s*([a-z_][A-Za-z0-9_]*)/);
  if (cm) {
    lines.push(`     class_method_lookup({ class_name: "${cm[1]}", method_name: "${cm[2]}" })`);
    lines.push(`     find_usages({ symbol: "${cm[1]}::${cm[2]}" })`);
    return lines.join('\n');
  }

  // function name(
  const fn = pattern.match(/function\s+([a-z_][A-Za-z0-9_]*)/i);
  if (fn) {
    lines.push(`     symbol_index({ path: "<dir>" })  // 找出 function ${fn[1]} 所在檔`);
    lines.push(`     find_usages({ symbol: "${fn[1]}" })`);
    return lines.join('\n');
  }

  // class XXX
  const cls = pattern.match(/class\s+([A-Z][A-Za-z0-9_]*)/);
  if (cls) {
    lines.push(`     find_hierarchy({ class_name: "${cls[1]}" })`);
    lines.push(`     symbol_index({ path: "<file_or_dir>" })`);
    return lines.join('\n');
  }

  // 純 identifier（可能是 method/function/symbol 名）
  if (/^[a-zA-Z_][A-Za-z0-9_]*$/.test(pattern)) {
    lines.push(`     find_usages({ symbol: "${pattern}" })`);
    lines.push(`     symbol_index({ path: "<dir>" })  // 確認 ${pattern} 是 class/method/function`);
    return lines.join('\n');
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

  // ssh_exec：依命令前 80 字元分類（不同指令不互相累積，避免診斷型連發誤擋）
  if (tool === 'ssh_exec') {
    const cmd = (entry.args?.command || '').trim().slice(0, 80);
    return cmd ? `ssh_exec:${cmd}` : 'ssh_exec';
  }

  // run_php_code：依程式碼前 80 字元分類（不同 snippet 不視為重複）
  if (tool === 'run_php_code') {
    const code = (entry.args?.code || '').trim().slice(0, 80);
    return code ? `run_php_code:${code}` : 'run_php_code';
  }

  // execute_sql：依 SQL 語句類型（SELECT/UPDATE/INSERT/DELETE）+ 表名分類
  //   不同操作目的不應累積為「重複」（如查詢→驗證→更新是正常流程）
  if (tool === 'execute_sql') {
    const sql = (entry.args?.sql || entry.args?.query || '').trim().toUpperCase();
    const typeMatch = sql.match(/^(SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|SHOW|DESCRIBE|EXPLAIN)/);
    const sqlType = typeMatch ? typeMatch[1] : 'OTHER';
    // 嘗試提取主要表名
    const tableMatch = sql.match(/(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+[`"]?(\w+)[`"]?/i);
    const table = tableMatch ? tableMatch[1].toLowerCase() : '';
    return `execute_sql:${sqlType}:${table}`;
  }

  // apply_diff：path + search 前 80 字組合算不同類（不同檔案/不同修改不累積）
  if (tool === 'apply_diff') {
    const filePath = entry.args?.path || '';
    const search = (entry.args?.search || '').slice(0, 80);
    return `apply_diff:${filePath}:${search}`;
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

  // browser_take_screenshot：同 URL 不同 filename 視為不同類（多 popup 驗證場景）
  if (tool === 'browser_take_screenshot') {
    const ref = entry.args?.ref || entry.args?.url || '';
    const filename = entry.args?.filename || '';
    return `${tool}:${ref}:${filename}`;
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
      // 同時涵蓋 Bash 與 PowerShell — PowerShell 工具是常見的繞道路徑
      const t = shortName(entry.tool);
      if (t !== 'Bash' && t !== 'PowerShell') return null;
      const cmd = entry.args?.command || '';
      const pat = matchBashPattern(cmd);
      if (!pat || !pat.warnOnFirst || pat.silent) return null;

      // Fallback override / 白名單：放行
      if (isBashAllowed(cmd)) {
        const reason = MCP_FALLBACK_RE.test(cmd) ? 'mcp-fallback 註解' : '白名單命中';
        process.stderr.write(`[bash_wrong_tool] allow (${pat.signature}): ${reason}\n`);
        return null;
      }

      if (pat.block) {
        const suggestion = (pat.signature === 'bash:grep-php' || pat.signature === 'bash:grep-php-dir')
          ? buildPhpAstSuggestions(cmd)
          : null;
        return {
          block: true,
          message: `[L1 Wrong Tool] ❌ BLOCKED (sig=${pat.signature})\n` +
                   `  → 請改用 MCP 工具：${pat.hint}\n` +
                   (suggestion ? suggestion + '\n' : '') +
                   `  → 此類 Bash 操作已強制禁止。若真有理由必須用 Bash，` +
                   `在命令尾加 \`# mcp-fallback: <reason>\` 即可放行（會留審計紀錄）。\n`,
        };
      }

      return `[L1 Wrong Tool] ⚠️ Bash 執行「${pat.signature}」有專用工具可用。\n` +
             `  → 建議改用：${pat.hint}\n` +
             `  → 專用工具省 token、支援 batch、輸出結構化。\n`;
    },
  },
  {
    // Layer 1.5: Ghost Tool — 偵測文字內容中提到已刪除 / 已改名的工具名稱（共通黑名單）
    // 黑名單檔：~/.claude/hooks/ghost-tools.json（hot-reload，每次觸發重讀）
    id: 'ghost_tool_reference',
    detect: (entry, _history) => {
      const SCAN_TOOLS = new Set(['Edit', 'Write', 'apply_diff', 'create_file', 'agent_coord']);
      const tool = shortName(entry.tool);
      if (!SCAN_TOOLS.has(tool)) return null;

      // agent_coord 只掃 post 動作的 message
      if (tool === 'agent_coord' && entry.args?.action !== 'post') return null;

      let ghostMap;
      try {
        const ghostPath = path.join(HOME, '.claude', 'hooks', 'ghost-tools.json');
        ghostMap = JSON.parse(fs.readFileSync(ghostPath, 'utf-8'));
      } catch {
        return null;
      }

      const fields = [
        entry.args?.new_string,
        entry.args?.content,
        entry.args?.message,
        entry.args?.search,
        entry.args?.replace,
        entry.args?.old_string,
      ].filter(v => typeof v === 'string');
      if (fields.length === 0) return null;
      const haystack = fields.join('\n');

      const hits = [];
      for (const [ghost, hint] of Object.entries(ghostMap)) {
        if (ghost.startsWith('_')) continue;
        const re = new RegExp(`\\b${ghost.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`);
        if (re.test(haystack)) hits.push({ ghost, hint });
      }
      if (hits.length === 0) return null;

      const lines = [`[Ghost Tool] \u26A0\uFE0F \u5075\u6E2C\u5230\u5F15\u7528\u4E86\u5DF2\u522A\u9664 / \u5DF2\u6539\u540D\u7684\u5DE5\u5177\uFF1A`];
      for (const { ghost, hint } of hits) {
        lines.push(`  - \`${ghost}\` \u2192 ${hint}`);
      }
      lines.push(`  \u2192 \u8ACB\u6838\u5C0D\u5F8C\u4FEE\u6B63\uFF0C\u5225\u8B93\u5E7B\u89BA\u5BEB\u9032\u6A94\u6848/\u8A0A\u606F\u3002`);
      return lines.join('\n') + '\n';
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
      if (pat?.warnOnFirst || pat?.silent) return null;

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
    //   第 1 次：💡 軟提醒
    //   第 2+ 次跨不同路徑：⚠️ 強警告 + 記憶注入
    id: 'grep_php_symbol',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Grep') return null;

      const pattern = entry.args?.pattern || '';
      const filePath = entry.args?.path || '';
      const glob = entry.args?.glob || '';

      // 偵測搜尋 PHP class/method 的 pattern
      // 放寬 PHP context：路徑含 .php、常見 PHP 目錄名、或專案目錄（dbox/project/src/app）
      const isPhpContext = /\.php/i.test(glob) || /\.php/i.test(filePath) ||
        /admin|model|controller|cls\b|service|repository|src\b|app\b|project|dbox/i.test(filePath);
      if (!isPhpContext) return null;

      // ── 高信心 PHP symbol 偵測（嚴格）──
      // 過去版本對 alternation 中任一子項 looks-like-symbol 就 BLOCK，
      // 導致 `tooltip|信用卡|payment_id|p_question` 這種 HTML/JS/字串混搜被誤殺。
      // 新規則：alternation / 含中文 / kebab-case / HTML 屬性語法 → 一律視為純文字搜尋，不擋。
      // 只在「pattern 含明確 PHP 結構符號」或「pattern 為單一 PHP 命名 token」時才判為 symbol search。
      const looksLikeSymbol = (s) =>
        /^[A-Z][a-zA-Z0-9]+$/.test(s) ||           // PascalCase: OrderModel
        /^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(s) ||     // camelCase method: grantBonus
        /^[a-z]+(?:_[a-z0-9]+){1,}$/.test(s);      // snake_case: grant_bonus（2+ 段）
      const hasSymbolOperator = (p) =>
        /(::|->\w|extends\s|implements\s|new\s+[A-Z]|class\s+[A-Z]|function\s+\w)/i.test(p);

      const detectSymbolSearch = (p) => {
        if (!p) return false;
        // 含 PHP 結構符號（->method、::, extends, function xxx, class Foo）→ 一律算 symbol
        if (hasSymbolOperator(p)) return true;
        // alternation / 中文 / kebab / HTML 屬性 → 純文字搜尋，不算 symbol
        const isTextLike =
          /\|/.test(p) ||
          /[一-鿿]/.test(p) ||
          /[a-z0-9]-[a-z0-9]/i.test(p) ||
          /\b(?:class|id|data-|aria-|style|href|src|name|type|value)\s*=/i.test(p);
        if (isTextLike) return false;
        // 純單一 token + 符合 PHP 命名 → 算 symbol
        return looksLikeSymbol(p.trim());
      };

      if (!detectSymbolSearch(pattern)) return null;

      // 升級為 BLOCK：當 Grep 明確指定 PHP scope + symbol pattern → 第 1 次就擋
      // 「明確 PHP scope」三種情況：
      //   1. glob 含 .php（如 *.php）
      //   2. type=php
      //   3. path 是單一 .php 檔（如 cls/model/foo.class.php）— 比 glob 更明確
      const explicitPhpScope =
        /\*?\.php\b/i.test(glob) ||
        entry.args?.type === 'php' ||
        /\.php$/i.test(filePath);

      // SQL 欄位名搜尋白名單：純 snake_case 詞 + 無 PHP 結構符號 + 無 CamelCase
      // 合法用途：找「哪些 PHP 檔的 SQL 字串有用到此欄位」— 屬純文字搜尋
      const isPureSnakeCaseField = (p) => {
        const alts = p.split('|').map(s => s.trim()).filter(Boolean);
        if (alts.length === 0) return false;
        const phpStructural = /(::|->|\bfunction\b|\bclass\b|\bextends\b|\bimplements\b|\bnew\s)/i;
        if (phpStructural.test(p)) return false;
        return alts.every(a =>
          /^[a-z][a-z0-9_]*$/.test(a) &&
          !/^[A-Z]/.test(a) &&
          !/[a-z][A-Z]/.test(a)
        );
      };

      // 純 snake_case 欄位名（如 payment_id, complete_dt）→ SQL 欄位搜尋場景，放行
      if (isPureSnakeCaseField(pattern)) return null;

      if (explicitPhpScope) {
        return `[PHP Symbol] ⚠️ Grep PHP scope+symbol「${pattern.substring(0, 50)}」→ 建議改 class_method_lookup / find_usages / symbol_index（更省 token）。Grep 適合搜純文字。\n`;
      }

      // 鬆散 path-based PHP context (如 dbox/, admin/, project/) 但 pattern 無 PHP 結構符號
      // → 無法區分是 PHP method 還是同名 JS 變數（如 showBonusUI / getMemberBonus），
      //   一律放行避免誤殺純 JS 開發。要 BLOCK 必須 pattern 內有 `::` / `->` / `function ` / `class ` 等明確證據。
      if (!hasSymbolOperator(pattern)) return null;

      // 累計：統計歷史中同樣是 PHP symbol search 的 Grep，跨不同路徑
      const prevSymbolGreps = history.filter(h => {
        if (shortName(h.tool) !== 'Grep') return false;
        const hp = h.args?.pattern || '';
        const hPath = h.args?.path || '';
        const hGlob = h.args?.glob || '';
        const hPhp = /\.php/i.test(hGlob) || /\.php/i.test(hPath) ||
          /admin|model|controller|cls\b|service|repository|src\b|app\b|project|dbox/i.test(hPath);
        return hPhp && detectSymbolSearch(hp);
      });
      const uniquePaths = new Set(prevSymbolGreps.map(h => h.args?.path || 'cwd'));
      uniquePaths.add(filePath || 'cwd');
      const count = prevSymbolGreps.length + 1;

      // 鬆散 PHP context + pattern 含 PHP 結構符號 → 警告
      return `[PHP Symbol] ⚠️ Grep PHP symbol「${pattern.substring(0, 50)}」→ 建議改 MCP AST 工具更省 token：\n` +
             `  → class_method_lookup / find_usages / trace_logic / find_hierarchy\n` +
             `  Grep 適合搜純文字（變數名、字串常數、SQL 欄位名）。\n`;
    },
  },
  {
    // Layer 2.4c: Grep PHP Structural Pattern — 高信心 PHP 結構語法 → 直接 BLOCK
    //   只針對後端 PHP 程式：glob/path 必須含 .php 或常見 PHP 目錄
    //   只擋明確的「結構語法」：function xxx / class xxx / extends / implements / ->method( / ::method(
    //   純文字搜尋（變數名、字串、註解）不會誤觸
    id: 'grep_php_structural_block',
    detect: (entry, _history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Grep') return null;

      const pattern = entry.args?.pattern || '';
      const filePath = entry.args?.path || '';
      const glob = entry.args?.glob || '';
      const type = entry.args?.type || '';

      // 排除：glob/type 明確指定非 PHP 副檔名 → 一律放行（前端/其他語言不誤擋）
      const NON_PHP_EXTS = /\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte|css|scss|sass|less|html?|htm|json|md|mdx|py|go|rs|rb|java|kt|swift|c|cpp|cs|sh|yaml|yml|xml|toml)\b/i;
      const NON_PHP_TYPES = new Set(['js','mjs','cjs','ts','tsx','jsx','vue','svelte','css','scss','sass','less','html','htm','json','md','py','go','rust','ruby','java','kotlin','swift','c','cpp','csharp','shell','yaml','xml','toml']);
      if (NON_PHP_EXTS.test(glob) || NON_PHP_TYPES.has(type)) return null;

      // 必須是 PHP 後端程式 context
      const isPhpContext =
        /\.php/i.test(glob) || /\.php/i.test(filePath) || type === 'php' ||
        /admin|model|controller|cls\b|service|repository|src\b|app\b|project|dbox|trait/i.test(filePath);
      if (!isPhpContext) return null;

      // 高信心 PHP 結構 pattern — 只保留 PHP 獨有語法，避免誤擋 .php 內的 inline JS
      // 移除 function/class/extends/implements/new — 這些 JS/TS/Vue 也用
      // 注意：user 傳入的 pattern 是 regex 字串，括號可能是 \( 或 (
      const STRUCTURAL = [
        { re: /->\s*\w+\s*\\?\(/,             hint: '->method(' },
        { re: /::\s*\w+\s*\\?\(/,             hint: '::method(' },
        { re: /\babstract\s+(public|protected|private|function)/i, hint: 'abstract method' },
        { re: /\b(public|protected|private)\s+(static\s+)?function\s+\w+/i, hint: 'visibility + function' },
      ];
      const hit = STRUCTURAL.find(s => s.re.test(pattern));
      if (!hit) return null;

      return `[PHP Symbol] ⚠️ Grep PHP 結構語法「${hit.hint}」→ 建議改 class_method_lookup / find_usages / symbol_index 更省 token。要搜純文字請去掉結構符號（如 \`->foo(\` → \`foo\`）。\n`;
    },
  },
  {
    // Layer 2.4b: Grep+Read on Same PHP File — 同一 PHP 檔反覆 Grep+Read 拼湊 method
    //   觸發：對同一 .php / Trait / Class 檔在最近 8 步內累計 Grep+Read ≥ 3 次
    //   建議改用 class_method_lookup 一次拿完整 method
    id: 'grep_read_same_php_file',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Grep' && tool !== 'Read' && tool !== 'read_file') return null;

      // 取當前操作的目標 PHP 檔
      const currentFile = entry.args?.path || entry.args?.file_path || '';
      if (!/\.php$/i.test(currentFile)) return null;

      // 最近 8 步內，對同一檔的 Grep + Read 操作
      const recent = history.slice(-8);
      const sameFileOps = recent.filter(h => {
        const t = shortName(h.tool);
        if (t !== 'Grep' && t !== 'Read' && t !== 'read_file') return false;
        const f = h.args?.path || h.args?.file_path || '';
        return f === currentFile;
      });
      const count = sameFileOps.length + 1;
      if (count < 3) return null;

      // 必須包含至少 1 次 Grep 和 1 次 Read（純 Read 多段不算這個模式）
      const allOps = [...sameFileOps, entry];
      const hasGrep = allOps.some(h => shortName(h.tool) === 'Grep');
      const hasRead = allOps.some(h => ['Read', 'read_file'].includes(shortName(h.tool)));
      if (!hasGrep || !hasRead) return null;

      const fileName = currentFile.split(/[\\/]/).pop();
      return `[PHP Symbol] ⚠️ 對同一 PHP 檔 ${fileName} 已 Grep+Read ${count} 次拼湊邏輯。\n` +
             `  🛑 停止這個模式 — 改用 MCP AST 工具一次拿完整資訊：\n` +
             `  → class_method_lookup(class_name, method_name)：直接取得整個 method 原始碼\n` +
             `  → trace_logic：追蹤完整控制流（含子呼叫展開）\n` +
             `  → find_usages：找呼叫關係\n` +
             `  CLAUDE.md 規定：定位 PHP 符號一律走 AST，禁 Grep+Read 暴力拼湊。\n`;
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
    // Layer 2.10: CSS Inspect Gate — .css 寫入前必須先用 inspect 工具確認 specificity，
    // 第一次 !important 就 BLOCK；trouble 詞觸發 cssInspectRequired 時連 .css Edit 都要先 inspect
    id: 'css_inspect_gate',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      const writeTools = new Set(['Edit', 'Write', 'apply_diff', 'create_file']);
      if (!writeTools.has(tool)) return null;

      const filePath = (entry.args?.file_path || entry.args?.path || '').toLowerCase();
      const isCss = filePath.endsWith('.css') || filePath.endsWith('.scss') || filePath.endsWith('.less');
      if (!isCss) return null;

      const countImportant = (s) => {
        if (!s || typeof s !== 'string') return 0;
        const m = s.match(/!important/gi);
        return m ? m.length : 0;
      };

      // 偵測 inspect 工具是否已在本 session 執行過
      const INSPECT_TOOLS = new Set([
        'css_computed_winner', 'css_specificity_check', 'css_inspect',
        'mcp__project-migration-assistant-pro__css_computed_winner',
        'mcp__project-migration-assistant-pro__css_specificity_check',
        'mcp__project-migration-assistant-pro__css_inspect',
      ]);
      const hasInspected = history.some(h => INSPECT_TOOLS.has(h.tool) || INSPECT_TOOLS.has(shortName(h.tool)));

      // 讀 write-guard 共享 state（含 cssInspectRequired flag）
      let cssInspectRequired = false;
      try {
        const wgFile = path.join(os.tmpdir(), 'claude-write-guard', 'state.json');
        if (fs.existsSync(wgFile)) {
          const wg = JSON.parse(fs.readFileSync(wgFile, 'utf-8'));
          if (Date.now() - (wg.ts || 0) < 30 * 60 * 1000) cssInspectRequired = !!wg.cssInspectRequired;
        }
      } catch {}

      // 計算本次新增的 !important
      const newStr = entry.args?.new_string || entry.args?.content || '';
      const oldStr = entry.args?.old_string || '';
      const diff = entry.args?.diff || '';
      const diffAdded = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');
      const currDelta = Math.max(0, countImportant(newStr) + countImportant(diffAdded) - countImportant(oldStr));

      const fname = filePath.split(/[\\/]/).pop();

      // ── 防線 1：寫入新 !important 但未 inspect → BLOCK ──
      if (currDelta > 0 && !hasInspected) {
        return {
          block: true,
          message:
            `[CSS Inspect Gate] ❌ BLOCKED：嘗試寫入 ${currDelta} 個 !important 到 ${fname}，但本 session 尚未執行 inspect 工具。\n` +
            `  原因：!important 是反模式，通常代表 specificity 沒查清楚就硬蓋。第一次寫就要證明真的需要。\n` +
            `  必要前置（擇一）：\n` +
            `    ▸ mcp__css_computed_winner(url, selector, property) — 看哪條規則贏\n` +
            `    ▸ mcp__css_specificity_check(url, selector) — 列出所有命中規則 + specificity\n` +
            `    ▸ mcp__css_inspect(url, selector) — 取 computed style + 來源檔行號\n` +
            `  替代修法（多數情況更乾淨）：\n` +
            `    A. 改源頭規則（inspect 找到贏家後直接改它）\n` +
            `    B. 獨立命名空間 .v3-xxx / .ui-2-xxx 隔離（避開全域繼承）\n` +
            `    C. 提高自身選擇器 specificity（多包一層父 class）\n`,
        };
      }

      // ── 防線 2：trouble flag 啟動 → 任何 .css 寫入都要先 inspect ──
      if (cssInspectRequired && !hasInspected) {
        return {
          block: true,
          message:
            `[CSS Inspect Gate] ❌ BLOCKED：使用者剛回報「排版/跑版/樣式問題」，但尚未執行 inspect 工具。\n` +
            `  原因：直接改 ${fname} 是猜測修法，過去常導致 !important 反覆疊加而跑版更嚴重。\n` +
            `  必須先做（擇一）：\n` +
            `    ▸ mcp__css_computed_winner(url, selector, property) — 找出真正贏的規則\n` +
            `    ▸ mcp__css_specificity_check(url, selector) — 看 specificity 衝突\n` +
            `    ▸ mcp__browser_interact 內 evaluate 跑 getComputedStyle\n` +
            `  → inspect 完拿到事實後，cssInspectRequired flag 自動解除，可正常 Edit。\n`,
        };
      }

      // ── 防線 1b：累計使用提醒（即使有 inspect 也還是要警告濫用）──
      if (currDelta > 0 && hasInspected) {
        let total = currDelta;
        for (const h of history) {
          const ht = shortName(h.tool);
          if (!writeTools.has(ht)) continue;
          const hp = (h.args?.file_path || h.args?.path || '').toLowerCase();
          if (!hp.endsWith('.css') && !hp.endsWith('.scss') && !hp.endsWith('.less')) continue;
          const hNew = countImportant(h.args?.new_string || h.args?.content || '');
          const hOld = countImportant(h.args?.old_string || '');
          const hDiff = h.args?.diff || '';
          const hDiffAdd = hDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');
          total += Math.max(0, hNew + countImportant(hDiffAdd) - hOld);
        }
        if (total >= 10) {
          return `[CSS Overuse] ⚠️ 累計 ${total} 個 !important（本次 +${currDelta}）。\n` +
                 `  → 已 inspect 過代表你看過 specificity 了，但還是堆這麼多代表該換策略：\n` +
                 `  → 建議改用獨立命名空間 class（.v3-xxx）整段隔離，而非繼續疊 !important。\n`;
        }
      }

      return null;
    },
  },
  {
    // Layer 2.10b: CSS Legacy Skill Gate
    //   寫入 css/v3/**/*.css、page/**/*.css，或 screen.prefixer / legacy global CSS 鄰近檔時，
    //   第一次 BLOCK 提示「先跑 /css_legacy_override」（避免桌機改完破手機）；同 session 已提示過則放行。
    //   ack 機制：使用者可發 prompt 含 "/css_legacy_override" 或 "確認" 字樣，或本 session 跑過 css_legacy_override skill 即放行。
    id: 'css_legacy_skill_gate',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      const writeTools = new Set(['Edit', 'Write', 'apply_diff', 'create_file', 'apply_diff_batch']);
      if (!writeTools.has(tool)) return null;

      const filePath = (entry.args?.file_path || entry.args?.path || '').replace(/\\/g, '/').toLowerCase();
      if (!/\.(css|scss|less)$/.test(filePath)) return null;

      // 觸發路徑：頁面層 CSS（v3/page、page/v3、{module}/page、{module}/v3）
      const isPageLayerCss = /(\/(v3|page)\/|\/page\/v\d+\/|\/[^/]+\/(page|v3)\/)/.test(filePath);
      if (!isPageLayerCss) return null;

      // 同 session 已 ack：history 出現過 css_legacy_override skill 命令、或 lastPrompt 含確認字樣
      let acked = false;
      try {
        const wgFile = path.join(os.tmpdir(), 'claude-write-guard', 'state.json');
        if (fs.existsSync(wgFile)) {
          const wg = JSON.parse(fs.readFileSync(wgFile, 'utf-8'));
          const lp = (wg.lastPrompt || '').toLowerCase();
          if (/\/css_legacy_override|legacy.*已查|已跑.*legacy|確認.*覆寫|skip.*legacy/.test(lp)) acked = true;
          if (wg.cssLegacyAcked && (Date.now() - (wg.ts || 0) < 30 * 60 * 1000)) acked = true;
        }
      } catch {}

      // 檢查 history：本 session 是否已被本 hook 攔過（自動 ack 機制：第二次放行）
      const prevBlocked = history.some(h => h._cssLegacyGateBlocked);
      if (prevBlocked || acked) return null;

      // 標記本次 entry 已被攔（給後續 entry 做 prevBlocked 判斷用）
      entry._cssLegacyGateBlocked = true;

      const fname = filePath.split('/').pop();
      return {
        block: true,
        message:
          `[CSS Legacy Gate] ❌ BLOCKED：嘗試寫入頁面層 CSS（${fname}），但本 session 尚未跑過 /css_legacy_override。\n` +
          `  原因：頁面層 CSS 通常是用來覆寫 legacy 全域 CSS（screen.prefixer.css 等）的 !important，\n` +
          `        如果只蓋桌機規則沒處理 @media (max-width: 768px) / 480px / hover，常導致：\n` +
          `        ▸ 桌機驗收 OK、手機 popup 跑版\n` +
          `        ▸ active state 失效、hover 變色錯誤\n` +
          `  必要前置：\n` +
          `    ▸ /css_legacy_override {目標CSS檔} {選擇器} — 自動掃 legacy 所有 @media 出現點，產出對照表 + 反制建議\n` +
          `  快速通過（若確定不需要反制）：\n` +
          `    ▸ 直接重發指令 — 本 hook 已記錄第一次攔截，第二次嘗試會自動放行\n` +
          `    ▸ 或在 prompt 內提到「已查 legacy / 確認覆寫 / /css_legacy_override」字樣\n`,
      };
    },
  },
  {
    // Layer 2.7: Edit Batch Replace — 多檔做相同字串替換時提醒用批次腳本
    id: 'edit_batch_replace',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Edit') return null;

      const oldStr = (entry.args?.old_string || '').trim();
      const newStr = (entry.args?.new_string || '').trim();
      if (!oldStr && !newStr) return null;

      // 找歷史中 old_string 或 new_string 相同的 Edit，但不同檔案
      // （token rename 類型：每檔 context 不同但替換目標相同也要算）
      const currentFile = entry.args?.file_path || '';
      const sameReplace = history.filter(h => {
        if (shortName(h.tool) !== 'Edit') return false;
        const hOld = (h.args?.old_string || '').trim();
        const hNew = (h.args?.new_string || '').trim();
        const hFile = h.args?.file_path || '';
        if (hFile === currentFile) return false;
        const oldMatch = oldStr && hOld === oldStr;
        const newMatch = newStr && hNew === newStr;
        return oldMatch || newMatch;
      });

      const count = sameReplace.length + 1; // 含本次
      if (count < 3) return null;

      const files = [...new Set([...sameReplace.map(h => h.args?.file_path), currentFile])];
      const preview = oldStr.length > 60 ? oldStr.slice(0, 60) + '…' : oldStr;

      // 放寬：不阻擋，只強度遞增提醒（避免擋實際批次注入工作如 sidebar 條件顯示）
      if (count >= 5) {
        return `[Batch Replace] ⚠️⚠️ 跨檔相同替換已 ${count} 次（${files.length} 檔）。\n` +
               `  → 替換內容：「${preview}」\n` +
               `  → 強烈建議改用 sed / node / multi_file_inject 一次掃完，省 tool call。\n`;
      }

      return `[Batch Replace] ⚠️ 偵測到跨檔相同替換（${files.length} 檔，${count} 次）。\n` +
             `  → 替換內容：「${preview}」\n` +
             `  → 建議改用 sed/node 腳本一次掃完所有檔案。\n`;
    },
  },
  {
    // Layer 2.8: Same File Edit — 同一檔案連續多次 Edit/apply_diff，提醒用 batch 或考慮重構
    id: 'same_file_edit',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      const editTools = new Set(['Edit', 'apply_diff']);
      if (!editTools.has(tool)) return null;

      const filePath = (entry.args?.file_path || entry.args?.path || '').replace(/\\/g, '/').toLowerCase();
      if (!filePath) return null;

      const sameFileEdits = history.filter(h => {
        const ht = shortName(h.tool);
        if (!editTools.has(ht)) return false;
        const hp = (h.args?.file_path || h.args?.path || '').replace(/\\/g, '/').toLowerCase();
        return hp === filePath;
      });
      const count = sameFileEdits.length + 1;

      // 區分「同區塊反覆修改」vs「不同區塊各修一次」
      // 用 old_string/search 前 80 字元作為 block key
      const getBlockKey = (h) => {
        const s = (h.args?.old_string || h.args?.search || '').trim().slice(0, 80);
        return s || `L${h.args?.offset || 0}`;
      };
      const blockKeys = new Set(sameFileEdits.map(getBlockKey));
      blockKeys.add(getBlockKey(entry));
      const uniqueBlocks = blockKeys.size;
      const isMultiBlock = uniqueBlocks === count; // 每次都改不同地方

      // apply_diff 本身已支援單次多 blocks，重複呼叫等同浪費；門檻較 Edit 嚴格
      // Edit 是逐處修改，多區塊分散修改較合理，閾值加倍
      // 放寬：移除 BLOCK，純警告分級（避免擋實際多區塊修改工作）
      const isApplyDiff = tool === 'apply_diff';
      const warn1At = isApplyDiff ? 5 : (isMultiBlock ? 8 : 5);
      const warn2At = isApplyDiff ? 10 : (isMultiBlock ? 18 : 10);

      // 早期 hint：multi-block 第 3 次時輕量提示改用 apply_diff_batch
      if (isMultiBlock && count === 3 && tool === 'Edit') {
        const fname = filePath.split('/').pop();
        return `[Same File Edit] \u{1F4A1} ${fname} \u5DF2\u7528 Edit \u6539\u4E86 3 \u500B\u4E0D\u540C\u533A\u584A\uFF0C\u5EFA\u8B70\u5269\u9918\u4FEE\u6539\u6539\u7528 apply_diff_batch \u4E00\u6B21\u9001\u5B8C\uFF08\u7701 token \u4E26\u907F\u514D\u5F8C\u7E8C\u89F8\u767C L2.8 \u963B\u64CB\uFF09\u3002\n`;
      }

      if (count >= warn2At) {
        const fname = filePath.split('/').pop();
        return `[Same File Edit] ⚠️⚠️ ${fname} 已${isApplyDiff ? ' apply_diff' : '修改'} ${count} 次，請考慮：\n` +
               `  → 是否該重構這個檔案？\n` +
               `  → 跨檔相同替換→ apply_diff_batch；同字串多處→ Edit replace_all=true。\n`;
      }

      if (count >= warn1At) {
        const fname = filePath.split('/').pop();
        const modeNote = isMultiBlock ? `（${uniqueBlocks} 個不同区塊）` : '';
        return `[Same File Edit] ⚠️ ${fname} 已${isApplyDiff ? ' apply_diff' : '修改'} ${count} 次${modeNote}。\n` +
               `  → 跨檔相同替換→ apply_diff_batch；同字串多處→ Edit replace_all=true。\n`;
      }

      return null;
    },
  },
  {
    // Layer 2.81: Confirm Requirements — 同檔 30 分鐘內 Edit ≥3 次 + 使用者訊息含
    // 「不對 / 又 / 為什麼 / 不是 / 又錯」→ 強制先確認需求，避免「猜需求→改→被退→再猜」死循環
    id: 'confirm_requirements_loop',
    detect: (entry, _history) => {
      const tool = shortName(entry.tool);
      const editTools = new Set(['Edit', 'apply_diff', 'Write', 'create_file']);
      if (!editTools.has(tool)) return null;

      const filePath = (entry.args?.file_path || entry.args?.path || '').replace(/\\/g, '/').toLowerCase();
      if (!filePath) return null;

      // 條件 A：同檔 30 分鐘內 Edit ≥3 次（含本次）
      const THIRTY_MIN = 30 * 60 * 1000;
      const now = Date.now();
      const recentSameFile = _history.filter(h => {
        if (!editTools.has(shortName(h.tool))) return false;
        const hp = (h.args?.file_path || h.args?.path || '').replace(/\\/g, '/').toLowerCase();
        if (hp !== filePath) return false;
        return (now - (h.ts || 0)) <= THIRTY_MIN;
      });
      const editCount = recentSameFile.length + 1;
      if (editCount < 3) return null;

      // 條件 B：最近 3 則使用者訊息有「不對/又/為什麼/不是/又錯/還是錯」
      const TRIGGER_RE = /(不對|不是這樣|為什麼|又|還是錯|又錯|不要|錯了)/;
      const recentMsgs = readRecentUserMessages(3);
      const triggered = recentMsgs.some(m => TRIGGER_RE.test(m.text));
      if (!triggered) return null;

      const fname = filePath.split('/').pop();
      return `[Confirm Requirements] ⚠️ ${fname} 30 分鐘內已 Edit ${editCount} 次，且最近使用者訊息含「不對/又/為什麼」等糾正詞。\n` +
             `  → 可能在「猜需求 → 改 → 被退 → 再猜」循環。\n` +
             `  → 建議先用 1-3 句話總結目前理解的需求，等使用者確認後再繼續修改。\n`;
    },
  },
  {
    // Layer 2.84: UI Click No Progress — 同 selector 連續 click ≥3 次，疑似 callback 沒執行
    // 真實案例：點刪除按鈕沒反應，反覆 click() / dispatchEvent() / 直呼 method 全沒效，
    // 根因是後端 fatal 噴 HTML，jQuery dataType:'json' success 靜默不執行——應先 fetch raw body。
    id: 'ui_click_no_progress',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      // 涵蓋兩個 playwright server (default / default2) 與 MCP browser_interact
      if (tool !== 'browser_interact' && tool !== 'browser_click') return null;

      const extractClickSelectors = (h) => {
        const ht = shortName(h.tool);
        if (ht === 'browser_click') {
          return [h.args?.element || h.args?.ref || h.args?.selector || ''];
        }
        if (ht === 'browser_interact') {
          const actions = h.args?.actions || [];
          return actions
            .filter(a => a.type === 'click' || a.type === 'evaluate' && /\.click\(\)|dispatchEvent.*click/i.test(a.code || ''))
            .map(a => a.selector || a.ref || a.code?.match(/['"]([#.][\w-]+)['"]/)?.[1] || '');
        }
        return [];
      };

      const currentSelectors = extractClickSelectors(entry).filter(Boolean);
      if (currentSelectors.length === 0) return null;

      // 比對最近 8 步內同 selector 的 click 次數
      const recentClicks = [];
      for (const h of history.slice(-8)) {
        for (const sel of extractClickSelectors(h).filter(Boolean)) {
          recentClicks.push(sel);
        }
      }

      const hits = currentSelectors.filter(sel =>
        recentClicks.filter(s => s === sel).length >= 2  // 過去已有 2 次 + 本次 = 3 次
      );
      if (hits.length === 0) return null;

      // 加分訊號：最近 8 步內是否有 send_http_request 或 fetch raw body 動作
      const hasFetchedRaw = history.slice(-8).some(h => {
        const ht = shortName(h.tool);
        if (ht === 'send_http_request') return true;
        if (ht === 'browser_interact') {
          const actions = h.args?.actions || [];
          return actions.some(a => a.type === 'evaluate' && /fetch\(.*\)\.text\(\)/i.test(a.code || ''));
        }
        return false;
      });

      if (hasFetchedRaw) return null;  // 已驗過 raw body，可能是真前端問題，不再警示

      return `[UI Click No Progress] ⚠️ 偵測到對 ${hits.join(', ')} 已連續 click ≥3 次（最近 8 步內）。\n` +
             `  → 反覆 click 沒進展常代表 callback 根本沒執行，不是「綁定問題」。\n` +
             `  → 最常見根因：後端 fatal/warning 噴 HTML，jQuery dataType:'json' success 靜默不跑。\n` +
             `  → 必做下一步：用 send_http_request 直接打該按鈕觸發的 endpoint，看 raw 200 body：\n` +
             `      ▸ body 開頭 \`{\` / \`[\` → 合法 JSON，問題在前端\n` +
             `      ▸ body 開頭 \`<\` 或含 \`<b>Fatal error</b>\` / \`Warning:\` → 後端壞了，禁止再改前端\n` +
             `  → 跳過此驗證會繞遠路（可參考 /bug_trace 步驟 2.5 AJAX gate）。\n`;
    },
  },
  {
    // Layer 2.83: UI Verify Mismatch — 改完前端互動 (Vue / popup / 事件綁定) 後用 run_php_code 充當驗證
    // run_php_code 只能驗資料層，無法驗 Vue reactivity / DOM 渲染 / v-if 條件分支 / 點擊事件
    // 警示 (非阻擋)：提醒改用 Playwright 端到端跑使用者操作流程
    id: 'ui_verify_mismatch',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'run_php_code') return null;

      // 條件 A：最近 30 個 step 內有改過前端互動相關檔案
      const editTools = new Set(['Edit', 'Write', 'apply_diff', 'create_file', 'multi_file_inject']);
      const VUE_DIRECTIVES = /v-(?:for|if|else|show|model|on|bind)\b|@click|@change|@submit|:class=|:style=|vm\.|Vue\.|new Vue\(|readyCart|removeReadyCart|addReadyCart/;

      // 整檔掃描快取（同 step 內同檔避免重複讀）
      const fileScanCache = new Map();
      const scanFileForVue = (absPath) => {
        if (fileScanCache.has(absPath)) return fileScanCache.get(absPath);
        let hit = false;
        try {
          const stat = fs.statSync(absPath);
          if (stat.size <= 512 * 1024) {
            const content = fs.readFileSync(absPath, 'utf-8');
            hit = VUE_DIRECTIVES.test(content);
          }
        } catch {}
        fileScanCache.set(absPath, hit);
        return hit;
      };

      const recentUiEdit = history.slice(-30).some(h => {
        if (!editTools.has(shortName(h.tool))) return false;
        const fp = (h.args?.file_path || h.args?.path || '').replace(/\\/g, '/');
        const fpLower = fp.toLowerCase();
        if (/\.(vue|jsx|tsx)$/.test(fpLower)) return true;
        if (/\.js$/.test(fpLower) && !/\/(node_modules|vendor|migrations)\//.test(fpLower)) return true;
        if (/\.php$/.test(fpLower)) {
          // 先看本次 diff/new_string（快路徑）
          const blob = (h.args?.new_string || h.args?.content || h.args?.diff || '');
          if (VUE_DIRECTIVES.test(blob)) return true;
          // fallback：掃整檔（涵蓋「改後端方法但同檔上方有 Vue 模板」死角）
          if (fp) {
            const abs = path.isAbsolute(fp) ? fp : path.resolve(process.cwd(), fp);
            if (scanFileForVue(abs)) return true;
          }
        }
        return false;
      });
      if (!recentUiEdit) return null;

      // 條件 B：run_php_code 內容看起來像「驗證/測試」用途
      const code = entry.args?.code || '';
      const looksLikeTest = /(echo|var_dump|print_r|var_export|json_encode)\s*\(/.test(code) ||
                            /assert|測試|驗證|check|verify|斷言/i.test(code) ||
                            /->build\(|->render\(|->get(?:Data|Result|Output)/.test(code);
      if (!looksLikeTest) return null;

      // 條件 C：read write-guard state，若使用者最近 prompt 含 UI 互動關鍵字，加重提醒
      let uiContext = false;
      try {
        const wgFile = path.join(os.tmpdir(), 'claude-write-guard', 'state.json');
        if (fs.existsSync(wgFile)) {
          const wg = JSON.parse(fs.readFileSync(wgFile, 'utf-8'));
          if (Date.now() - (wg.ts || 0) < 30 * 60 * 1000) {
            const lastPrompt = (wg.lastPrompt || '').toString();
            uiContext = /vue|popup|彈窗|reactivity|渲染|畫面|看不到|顯示|點擊|綁定|v-for|v-if|@click/i.test(lastPrompt);
          }
        }
      } catch {}

      const heavy = uiContext ? '⚠️⚠️ ' : '⚠️ ';
      return `[UI Verify Mismatch] ${heavy}偵測到剛改過前端互動相關檔案，正用 run_php_code 跑驗證。\n` +
             `  → run_php_code 只能驗「資料層輸出」，無法驗 Vue reactivity / DOM 渲染 / v-if 分支 / 點擊事件 / popup 開啟狀態。\n` +
             `  → 餵 fake session 給 builder 看 output 通過 ≠ 使用者畫面正常。\n` +
             `  → 正確驗法：browser_interact 端到端跑使用者操作流程（登入 → 觸發互動 → 抓 DOM 斷言）。\n` +
             `  → 若這次只是純資料層 trace（非驗證修復），可忽略此提醒。\n`;
    },
  },
  {
    // Layer 2.82: SFTP Local Test Gate — sftp_upload PHP/CSS/JS 前若 30 分鐘內無 localhost 訪問記錄，提醒先 local 測過
    // 警示而非阻擋（檔案↔URL 對應追蹤難度高，誤報率不低）
    id: 'sftp_local_test_gate',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'sftp_upload' && tool !== 'sftp_upload_batch') return null;

      const items = tool === 'sftp_upload_batch'
        ? (entry.args?.items || [])
        : [entry.args || {}];

      const codeFiles = items
        .map(it => (it.local_path || '').replace(/\\/g, '/'))
        .filter(p => /\.(php|css|js)$/i.test(p));
      if (codeFiles.length === 0) return null;

      // 排除明顯不需要 local 測試的檔案（include / class / config / migration）
      const skipPattern = /\/(include|inc|classes?|config|migrations?|sql|vendor|node_modules)\//i;
      const testableFiles = codeFiles.filter(p => !skipPattern.test(p));
      if (testableFiles.length === 0) return null;

      // 檢查最近 30 分鐘內是否有 browser_navigate 到 localhost / 127.0.0.1 / 區網 IP
      const THIRTY_MIN = 30 * 60 * 1000;
      const now = Date.now();
      const localPattern = /(localhost|127\.0\.0\.1|192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\.)/i;

      const recentLocalNav = history.some(h => {
        if ((now - (h.ts || 0)) > THIRTY_MIN) return false;
        const ht = shortName(h.tool);
        if (ht !== 'browser_interact' && ht !== 'browser_navigate') return false;
        const actions = h.args?.actions || [];
        const urls = ht === 'browser_navigate'
          ? [h.args?.url || '']
          : actions.filter(a => a.type === 'navigate').map(a => a.url || '');
        return urls.some(u => localPattern.test(u));
      });

      if (recentLocalNav) return null;

      const fnames = testableFiles.map(p => p.split('/').pop()).slice(0, 3).join(', ');
      const more = testableFiles.length > 3 ? ` 等 ${testableFiles.length} 個` : '';
      return `[SFTP Local Test Gate] ⚠️ ${fnames}${more} 即將 sftp_upload，但最近 30 分鐘內未偵測到 localhost / 區網訪問記錄。\n` +
             `  → 確定先在 local 測過了嗎？跳過 local 直接上測試機常導致來回部署。\n` +
             `  → 若是 include/class/config 類檔案不需直接訪問，可忽略此提醒。\n`;
    },
  },
  {
    // Layer 2.82b: SFTP Force Without Diff — sftp_upload(_batch) 帶 force=true 但近 10 分鐘內無 file_diff / git_diff / sftp_download，提醒先 diff
    // 警示而非阻擋；同 session 觸發後 ack（避免反覆擾人）
    id: 'sftp_force_no_diff',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'sftp_upload' && tool !== 'sftp_upload_batch') return null;
      if (entry.args?.force !== true) return null;

      // 已 ack 過就不再提醒（同 session 一次）
      const ackPath = path.join(LOG_DIR, 'sftp_force_ack.flag');
      try { if (fs.existsSync(ackPath)) return null; } catch {}

      // 收集本次 upload 的 local_path 集合
      const items = tool === 'sftp_upload_batch'
        ? (entry.args?.items || [])
        : [entry.args || {}];
      const targets = items.map(it => (it?.local_path || '').replace(/\\/g, '/').toLowerCase()).filter(Boolean);
      if (targets.length === 0) return null;

      const TEN_MIN = 10 * 60 * 1000;
      const now = Date.now();
      const diffTools = new Set(['file_diff', 'git_diff', 'sftp_download', 'sftp_download_batch']);
      const sawDiff = history.some(h => {
        if ((now - (h.ts || 0)) > TEN_MIN) return false;
        if (!diffTools.has(shortName(h.tool))) return false;
        // 任一 diff 動作都算（不嚴格綁定 local_path，避免誤判）
        return true;
      });
      if (sawDiff) return null;

      // 立刻 ack，下次 force 上傳直接放行
      try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(ackPath, String(now)); } catch {}

      const sample = targets.slice(0, 3).map(p => p.split('/').pop()).join(', ');
      const more = targets.length > 3 ? ` 等 ${targets.length} 個` : '';
      return `[SFTP Force Guard] ⚠️ 即將 force 覆蓋遠端：${sample}${more}\n` +
             `  → 近 10 分鐘內未跑過 file_diff / git_diff / sftp_download，無法確認遠端是否有他人改動。\n` +
             `  → 建議先：sftp_download 拉遠端版本 + file_diff 對比，或 git_diff 確認本機改動範圍。\n` +
             `  → 若已確認可覆蓋（或 sftp.js 內建 force 比對已足夠），此提醒不再重複。\n`;
    },
  },
  {
    // Layer 2.85: Bulk Text Replace — 同一檔案多個不同 search 替換，提示改用 run_php_code preg_replace
    id: 'bulk_text_replace',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      const editTools = new Set(['Edit', 'apply_diff']);
      if (!editTools.has(tool)) return null;

      const filePath = (entry.args?.file_path || entry.args?.path || '').replace(/\\/g, '/').toLowerCase();
      if (!filePath) return null;

      const currSearch = ((entry.args?.old_string || entry.args?.search) || '').trim();
      if (!currSearch) return null;

      const sameFile = history.filter(h => {
        if (!editTools.has(shortName(h.tool))) return false;
        const hp = (h.args?.file_path || h.args?.path || '').replace(/\\/g, '/').toLowerCase();
        return hp === filePath;
      });

      const searches = new Set();
      for (const h of sameFile) {
        const s = ((h.args?.old_string || h.args?.search) || '').trim();
        if (s) searches.add(s);
      }
      searches.add(currSearch);

      if (searches.size < 5) return null;

      const fname = filePath.split('/').pop();
      return `[Bulk Replace] ⚠️ 對 ${fname} 已累計 ${searches.size} 個不同文字替換。\n` +
             `  → 考慮改用 run_php_code 跑 preg_replace / str_replace 一次改完（省 tool call 來回）。\n` +
             `  → 若替換是結構化的且需跨檔，用 apply_diff_batch 合併送出。\n`;
    },
  },
  {
    // Layer 5.1: Read Fragment — 同一檔案多次不同 offset 碎讀，或 20 次內 Read 過多
    id: 'read_fragment_detection',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Read' && tool !== 'read_file') return null;

      const filePath = (entry.args?.file_path || entry.args?.path || '').replace(/\\/g, '/').toLowerCase();

      // 條件 A：同檔 ≥3 次不同 offset
      if (filePath) {
        const sameFileReads = history.filter(h => {
          const t = shortName(h.tool);
          if (t !== 'Read' && t !== 'read_file') return false;
          const hp = (h.args?.file_path || h.args?.path || '').replace(/\\/g, '/').toLowerCase();
          return hp === filePath;
        });

        const offsets = new Set();
        for (const h of sameFileReads) {
          offsets.add(String(h.args?.offset ?? 0));
        }
        offsets.add(String(entry.args?.offset ?? 0));

        const count = sameFileReads.length + 1;
        if (count >= 3 && offsets.size >= 3) {
          const fname = filePath.split('/').pop();
          return `[Read Fragment] ⚠️ 對 ${fname} 已碎讀 ${count} 次（${offsets.size} 個不同 offset）。\n` +
                 `  → 改用 Grep 定位關鍵字後再 Read 精準段落，或用 run_php_code / class_method_lookup 批次取。\n` +
                 `  → Read 預設可讀 2000 行，若檔案 ≤2000 行應一次讀完。\n`;
        }
      }

      // 條件 B：最近 20 次 tool call 中 Read ≥15
      const recent = history.slice(-19);
      const readCount = recent.filter(h => {
        const t = shortName(h.tool);
        return t === 'Read' || t === 'read_file';
      }).length + 1;
      if (readCount >= 15) {
        return `[Read Fragment] ⚠️ 最近 20 次呼叫中有 ${readCount} 次 Read。\n` +
               `  → 是否過度依賴讀檔？改用 Grep/class_method_lookup/symbol_index 可大幅省 token。\n`;
      }

      return null;
    },
  },
  {
    // Layer 2.9: PHP DB Cursor Trap — 寫入 PHP 時偵測 while($x = $db->getNext()) 外層對同一 $db 做 execute/execNext
    //   錯誤範例：while ($row = $db->getNext()) { $db->execute("..."); ... }
    //   這會讓內層 query 覆蓋外層 cursor，導致外層迴圈只跑一次或行為異常。
    id: 'php_db_cursor_trap',
    detect: (entry) => {
      const tool = shortName(entry.tool);
      const writeTools = new Set(['Edit', 'write', 'create_file', 'apply_diff']);
      if (!writeTools.has(tool)) return null;

      const filePath = entry.args?.file_path || entry.args?.path || '';
      if (!/\.php$/i.test(filePath)) return null;

      // 蒐集所有可能包含程式碼的字串欄位
      const fields = [
        entry.args?.new_string, entry.args?.content, entry.args?.code,
        entry.args?.diff, entry.args?.replace, entry.args?.search,
      ];
      const code = fields.filter(s => typeof s === 'string').join('\n');
      if (!code) return null;

      // while ($var = $db->getNext()) { ... $db->execute( / $db->execNext( ... }
      // 用 [\s\S]*? 跨行，限制外層 block 體內
      const re = /while\s*\(\s*\$(\w+)\s*=\s*\$(\w+)\s*->\s*getNext\s*\(\s*\)\s*\)\s*\{([\s\S]*?)\}/g;
      let m;
      while ((m = re.exec(code)) !== null) {
        const dbVar = m[2];
        const body = m[3];
        const innerRe = new RegExp(`\\$${dbVar}\\s*->\\s*(execute|execNext)\\s*\\(`);
        if (innerRe.test(body)) {
          return {
            block: true,
            message: `[DB Cursor Trap] \u274C BLOCKED\uFF1A\u5075\u6E2C\u5230 while (\\$x = \\$${dbVar}->getNext()) \u5916\u5C64\u8FF4\u5708\u5167\u53C8\u5C0D\u540C\u4E00\u500B \\$${dbVar} \u505A\u65B0 query\u3002\n` +
                     `  \u2192 \u5916\u5C64 cursor \u6703\u88AB\u5167\u5C64 query \u8986\u84CB\uFF0C\u8FF4\u5708\u53EA\u6703\u8DD1\u4E00\u6B21\u6216\u884C\u70BA\u7570\u5E38\u3002\n` +
                     `  \u2192 \u4FEE\u6B63\u65B9\u5F0F\uFF1A\u5148\u7528\u5916\u5C64 while \u628A\u7D50\u679C\u6536\u9032 array\uFF0C\u8FF4\u5708\u7D50\u675F\u5F8C\u518D foreach \u8A72 array \u505A\u5167\u5C64 query\u3002\n` +
                     `  \u2192 \u6216\u6539\u7528\u7368\u7ACB DB handle\uFF08\u5982 \\$db2\uFF09\u505A\u5167\u5C64 query\u3002\n`,
          };
        }
      }
      return null;
    },
  },
  {
    // Layer 2.95: DB Schema Change Smoke Test Reminder
    //   偵測 execute_sql/execute_sql_batch 內含 DROP COLUMN/DROP VIEW/ALTER TABLE，
    //   注入煙霧測試清單提醒（列表頁 / detail / add / 前台 ajax 四類必測）。
    id: 'db_schema_change_reminder',
    detect: (entry) => {
      const tool = shortName(entry.tool);
      if (tool !== 'execute_sql' && tool !== 'execute_sql_batch') return null;

      const collectSql = () => {
        const parts = [];
        if (typeof entry.args?.sql === 'string') parts.push(entry.args.sql);
        if (typeof entry.args?.query === 'string') parts.push(entry.args.query);
        if (Array.isArray(entry.args?.queries)) {
          for (const q of entry.args.queries) {
            if (typeof q === 'string') parts.push(q);
            else if (q?.sql) parts.push(q.sql);
          }
        }
        return parts.join('\n');
      };
      const sql = collectSql();
      if (!sql) return null;

      const ddlRe = /\b(DROP\s+(COLUMN|VIEW|TABLE|INDEX)|ALTER\s+TABLE|RENAME\s+COLUMN|CREATE\s+OR\s+REPLACE\s+VIEW)\b/i;
      if (!ddlRe.test(sql)) return null;

      const m = sql.match(ddlRe);
      return `[DB Schema] ⚠️ 偵測到 DDL 變更（${m[0]}）。本輪結束前請完成煙霧測試四類：\n` +
             `  1. 後台 list.php（各分類/狀態）\n` +
             `  2. 後台 update.php?id=N（實體 detail 頁）\n` +
             `  3. 後台 add.php（如有）\n` +
             `  4. 前台 ajax endpoint（curl / Playwright）\n` +
             `  → 踩坑紀錄：只測 list 不測 detail 漏過 SQL 殘留欄位引用，會在使用者點進去時炸 500。\n`;
    },
  },
  {
    // Layer 3: Same Category Repeat — 同類操作 3 次才警告，7 次阻擋
    //   排除 Read→Edit 必要流程（Edit 前的 Read 不計入重複）
    id: 'same_category_repeat',
    detect: (entry, history) => {
      // 跳過已被 bash_pattern_repeat 處理的
      if (entry.bashSig) return null;

      // 白名單：PHP AST 查詢工具本質上就是批量連續呼叫，不計入重複
      const L3_WHITELIST = new Set([
        'class_method_lookup', 'find_usages', 'find_hierarchy',
        'find_dependencies', 'symbol_index', 'trace_logic',
      ]);
      if (L3_WHITELIST.has(shortName(entry.tool))) return null;

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
        const lines = [`[Repetition Detector] ⚠️⚠️ ${displayName} 同類操作已達 ${count} 次，強烈建議暫停評估。`];
        if (batchHint) {
          lines.push(`  → 改用 batch 工具：${batchHint}`);
        }
        lines.push('  → 重新評估策略，避免繼續燒 token。');
        return lines.join('\n') + '\n';
      }

      // 3-6 次 → 警告
      if (count >= 3) {
        const lines = [`[Repetition Detector] ⚠️ ${displayName} 同類操作已執行 ${count} 次。請暫停思考：`];
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
      // sftp_upload / sftp_upload_batch：把本機檔案 mtime 納入比對 key
      // 迭代 debug 時同一路徑反覆 upload 但檔案內容已變，不該算重複
      const fingerprint = (h) => {
        const tool = shortName(h.tool);
        if (tool === 'sftp_upload' || tool === 'sftp_upload_batch') {
          const items = tool === 'sftp_upload_batch'
            ? (h.args?.items || [])
            : [h.args || {}];
          const mtimes = items.map(it => {
            const p = it.local_path;
            if (!p) return '';
            try {
              const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
              return `${p}@${fs.statSync(abs).mtimeMs}`;
            } catch { return `${p}@?`; }
          });
          return JSON.stringify({ tool: h.tool, args: h.args, _mtimes: mtimes });
        }
        return JSON.stringify({ tool: h.tool, args: h.args });
      };
      const entryStr = fingerprint(entry);
      const count = history.filter(h => fingerprint(h) === entryStr).length + 1;

      // UI 測試常在同一頁反覆 wait / re-navigate，門檻提高到 9
      // browser_wait_for 額外接受 text/textGone 不同視為不同呼叫（已由 fingerprint args 區分）
      const tool = shortName(entry.tool);
      const threshold = (tool === 'browser_wait_for' || tool === 'browser_navigate') ? 9 : 5;

      if (count < threshold) return null;
      const extraHint = (tool === 'browser_wait_for')
        ? '\n  → wait_for 持續失敗多半是前置條件沒成立：檢查 callback 是否真的有跑（先打 endpoint 看 raw body）、selector 是否仍存在、頁面是否被 navigate 走。'
        : (tool === 'browser_navigate')
        ? '\n  → 連續 navigate 同一 URL 通常代表頁面狀態不對：先 browser_close 重設 session，或檢查網址是否真的有變。'
        : '';
      return {
        block: true,
        message: `[Repetition Detector] ❌ BLOCKED：完全相同的工具呼叫已達 ${count} 次（門檻 ${threshold}）。停下來重新評估策略。${extraHint}\n`,
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
    //   active 模式：每次偵測到立即提醒（適合小 context）
    //   passive 模式：累計記錄，每 PASSIVE_SUMMARY_INTERVAL 次輸出摘要（適合 Pro Max 1M）
    id: 'token_waste_detection',
    detect: (entry, history) => {
      const wastes = identifyTokenWaste(entry, history);

      if (TOKEN_FEEDBACK_MODE === 'active') {
        // ── 主動模式：逐次即時回饋 ──
        if (!wastes) return null;
        const lines = [];
        for (const w of wastes) {
          lines.push(`[Token Accounting] 💰 ${w.issue}`);
          lines.push(`  浪費 ~${w.wasted} tokens → ${w.suggestion}`);
        }
        return lines.join('\n') + '\n';
      }

      // ── 被動模式：累計，定期輸出摘要 ──
      const callCount = history.length + 1;
      if (callCount % PASSIVE_SUMMARY_INTERVAL !== 0) return null;

      const summary = buildTokenSummary([...history, entry]);
      return summary;
    },
  },
  {
    // Layer 1.5: Screenshot Path — 截圖未指定截圖子資料夾就 block
    // 動態偵測專案目錄下實際存在的 screenshot* 資料夾名稱
    id: 'screenshot_wrong_path',
    detect: (entry, _history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'browser_take_screenshot' && tool !== 'browser_interact') return null;

      // 從 filename 提取所有截圖路徑
      const filenames = [];
      if (tool === 'browser_take_screenshot') {
        if (entry.args?.filename) filenames.push(entry.args.filename);
      } else if (tool === 'browser_interact') {
        for (const action of (entry.args?.actions || [])) {
          if (action.type === 'screenshot' && action.filename) filenames.push(action.filename);
        }
      }
      if (filenames.length === 0) return null;

      // 從 filename 的絕對路徑推斷專案目錄（D:\Project\XXX\ 或相對路徑用 cwd）
      // 也嘗試 MCP basePath
      const findScreenshotDirs = (filename) => {
        let projectDir = null;

        // 絕對路徑：取到專案目錄層級
        const absMatch = filename.replace(/\\/g, '/').match(/^([A-Z]:\/[^/]+\/[^/]+)\//i);
        if (absMatch) {
          projectDir = absMatch[1];
        }

        // 相對路徑：從第一段取專案名，嘗試 basePath 拼接
        if (!projectDir) {
          const firstSeg = filename.replace(/\\/g, '/').split('/')[0];
          const tryPaths = ['D:/Project/' + firstSeg, process.cwd()];
          for (const p of tryPaths) {
            try { if (fs.statSync(p).isDirectory()) { projectDir = p; break; } } catch {}
          }
        }

        if (!projectDir) return ['screenshot', 'screenshots'];

        try {
          const dirs = fs.readdirSync(projectDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && /^screenshot/i.test(d.name))
            .map(d => d.name);
          return dirs.length > 0 ? dirs : ['screenshot', 'screenshots'];
        } catch {
          return ['screenshot', 'screenshots'];
        }
      };

      for (const filename of filenames) {
        const screenshotDirs = findScreenshotDirs(filename);
        const escaped = screenshotDirs.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const pattern = new RegExp(`(^|[\\/\\\\])(${escaped.join('|')})/`, 'i');
        const hint = screenshotDirs.join('/ \u6216 ') + '/';

        // 正規化路徑後檢查
        const normalized = filename.replace(/\\/g, '/');
        if (!pattern.test(normalized)) {
          return {
            block: true,
            message: `[Wrong Path] \u274C BLOCKED\uFF1A\u622A\u5716\u8DEF\u5F91\u5FC5\u9808\u5728\u622A\u5716\u5B50\u8CC7\u6599\u593E\u3002\n` +
                     `  \u2192 \u6536\u5230\u7684 filename: "${filename}"\n` +
                     `  \u2192 \u8ACB\u6539\u70BA\uFF1A${screenshotDirs[0]}/your-filename.png\n` +
                     `  \u2192 \u5C08\u6848\u4E2D\u53EF\u7528\u7684\u622A\u5716\u8CC7\u6599\u593E\uFF1A${hint}\n` +
                     `  \u2192 \u622A\u5716\u662F\u66AB\u5B58\u7269\uFF0C\u4E0D\u53EF\u6C61\u67D3\u5C08\u6848\u6839\u76EE\u9304\u3002\n`,
          };
        }
      }

      return null;
    },
  },
  {
    // Layer 1.5b: Prompt Guard 擴及 MCP 寫入工具
    //   write-guard 只 hook 內建 Edit/Write，繞用 mcp__*__apply_diff / create_file / multi_file_inject 即可逃過。
    //   此層讀取同一份 claude-write-guard/state.json，對 MCP 寫入工具套同樣的 promptGuardActive 阻擋。
    //   也偵測 css_legacy_skill_gate（Layer 2.10b）所需的 file_path 路徑。
    id: 'prompt_guard_mcp_write',
    detect: (entry, _history) => {
      const tool = shortName(entry.tool);
      const MCP_WRITE_TOOLS = new Set([
        'apply_diff', 'apply_diff_batch',
        'create_file', 'create_file_batch',
        'multi_file_inject',
      ]);
      if (!MCP_WRITE_TOOLS.has(tool)) return null;

      try {
        const wgStateFile = path.join(os.tmpdir(), 'claude-write-guard', 'state.json');
        if (!fs.existsSync(wgStateFile)) return null;
        const raw = JSON.parse(fs.readFileSync(wgStateFile, 'utf-8'));
        const age = Date.now() - (raw.ts || 0);
        // 同 user-prompt-guard 的 2 分鐘 TTL，超過自動失效
        if (!raw.promptGuardActive || age > 2 * 60 * 1000) return null;

        // Implicit ack：guard 啟動後若已有任何 MCP 寫入工具呼叫進入 history（代表前一輪已通過或使用者已具體指示），
        // 5 分鐘時間窗內後續同類寫入自動放行，避免每改一次都要使用者重打「OK」。
        if (Array.isArray(_history) && _history.length > 0) {
          const FIVE_MIN = 5 * 60 * 1000;
          const now = Date.now();
          const recentWrite = _history.some(h => {
            const hts = h.ts || h.timestamp || 0;
            if (hts <= (raw.ts || 0)) return false;          // 必須晚於 guard 啟動時間
            if (now - hts > FIVE_MIN) return false;          // 5 分鐘窗
            return MCP_WRITE_TOOLS.has(shortName(h.tool));
          });
          if (recentWrite) return null;
        }

        return {
          block: true,
          message: `[Prompt Guard] ❌ BLOCKED：${tool} 暫時被擋（Prompt Guard 偵測到任務描述不完整）。\n` +
                   `  → write-guard 已擋下 Edit/Write，MCP 寫入工具同樣受限，避免繞道。\n` +
                   `  → 請先用純文字回覆使用者確認需求後再寫入。\n` +
                   `  → 確認方式：使用者明確回覆「OK / 確認 / 繼續 / A / 1」等即可解除。\n`,
        };
      } catch (e) {
        return null;
      }
    },
  },
  {
    // Layer 1.55: Snapshot Path — Playwright accessibility snapshot YAML 不可落專案根目錄
    // 偵測：Write/create_file/apply_diff 寫入 .yml/.yaml，內容含 `[ref=e` (Playwright a11y tree 特徵)
    //       且路徑不在 .playwright-mcp/ 或 screenshot*/ 子目錄下 → BLOCK
    id: 'snapshot_wrong_path',
    detect: (entry, _history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Write' && tool !== 'create_file' && tool !== 'apply_diff') return null;

      const filePath = entry.args?.file_path || entry.args?.path || entry.args?.filename;
      if (!filePath) return null;
      if (!/\.ya?ml$/i.test(filePath)) return null;

      const content = entry.args?.content || entry.args?.new_content || entry.args?.diff || '';
      if (typeof content !== 'string') return null;
      // Playwright a11y snapshot 特徵：含 `[ref=eNNN]` 形式的元素 ref
      if (!/\[ref=e\d+\]/.test(content)) return null;

      const normalized = filePath.replace(/\\/g, '/');
      // 允許落地的子目錄：.playwright-mcp/、screenshot*/、tmp/、_tmp_*/
      if (/(^|\/)(\.playwright-mcp|screenshots?|tmp|_tmp_[^/]+)\//i.test(normalized)) return null;

      return {
        block: true,
        message: `[Wrong Path] ❌ BLOCKED：Playwright snapshot YAML 不可落專案根目錄。\n` +
                 `  → 收到的 file_path: "${filePath}"\n` +
                 `  → 請改為：.playwright-mcp/your-snapshot.yml 或 screenshot/your-snapshot.yml\n` +
                 `  → snapshot 是暫存物（stale fast），不可污染專案根目錄。\n` +
                 `  → 若需長期保留請明確命名並放至 docs/ 或 reports/。\n`,
      };
    },
  },
  AUTO_FIX_PATTERN,
  {
    // Layer 7: Workload Reminder — 工作量高時提醒分發任務給其他 Agent
    //   追蹤 session 中 tool call 總數 + 工具多樣性，超過閾值時非阻擋提醒
    //   只提醒一次（用 _workloadReminded flag 防重複）
    id: 'workload_reminder',
    detect: (entry, history) => {
      // 已提醒過就不再觸發
      if (history.some(h => h._workloadReminded)) return null;

      const totalCalls = history.length + 1;

      // 閾值：至少 30 次 tool call
      if (totalCalls < 30) return null;

      // 計算最近 15 次呼叫的工具多樣性（不同 shortName 的數量）
      const recent = history.slice(-15);
      recent.push(entry);
      const uniqueTools = new Set(recent.map(h => shortName(h.tool)));

      // 多樣性閾值：4+ 種不同工具（表示多線並行工作）
      if (uniqueTools.size < 4) return null;

      // 計算待辦密度：最近 15 次中 Edit/Write 的比例（高 = 正在大量修改）
      const editCount = recent.filter(h => {
        const t = shortName(h.tool);
        return t === 'Edit' || t === 'Write' || t === 'create_file' || t === 'apply_diff';
      }).length;
      const editRatio = editCount / recent.length;

      // 至少有 20% 是修改操作才算真正在「做事」（排除純查詢 session）
      if (editRatio < 0.2) return null;

      // 標記已提醒（會被寫入 log，跨 process 持久化）
      entry._workloadReminded = true;

      const lines = [
        `\n[Workload Reminder] 📋 本次對話已執行 ${totalCalls} 次工具呼叫，涉及 ${uniqueTools.size} 類工具，修改比例 ${Math.round(editRatio * 100)}%。`,
        '  目前工作量較高，請考慮：',
        '  1. 用 Agent 工具分發獨立子任務給其他 agent（平行處理更快）',
        '  2. 用 agent_coord(action: "suggest_dispatch") 分析待辦清單，自動建議分派方案',
        '  3. 若待辦項目超過 5 個，強烈建議拆分而非全部自己做',
        '',
      ];

      return lines.join('\n');
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
const hookStartTime = Date.now();

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id || 'default';
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};
    _CURRENT_TRANSCRIPT_PATH = data.transcript_path || '';

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
    // 持久化標記（跨 process 保留）
    if (currentEntry._memoryInjected) {
      storedEntry._memoryInjected = true;
    }
    if (currentEntry._workloadReminded) {
      storedEntry._workloadReminded = true;
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
