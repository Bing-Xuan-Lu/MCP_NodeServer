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
  //   註：offset 多段（不限小 limit）的碎讀由獨立 Layer 5.1 read_fragment_detection 偵測（門檻 3 段/3 offset），此處不重複。
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
 * 返回 [{ts, text, hasImage}, ...]，最新在前
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
          let hasImage = false;
          if (typeof c === 'string') text = c;
          else if (Array.isArray(c)) {
            text = c.filter(x => x?.type === 'text').map(x => x.text || '').join('\n');
            hasImage = c.some(x => x?.type === 'image' || x?.type === 'image_url');
          }
          if (text.trim() || hasImage) {
            out.push({ ts: Date.parse(obj.timestamp || '') || 0, text, hasImage });
          }
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
    // docker cp：已有對應 MCP 工具 docker_cp（tools/deploy/docker_ops.js），
    //   有安全防護 basePath 白名單 + container 名 + container_path regex 檢查，比裸 Bash 安全。
    regex: /^\s*docker\s+cp\b/i,
    signature: 'bash:docker-cp',
    hint: 'docker_cp（MCP 工具，自動處理 basePath 白名單 + 命令注入防護）',
    warnOnFirst: true,
    block: false,
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
    // docker exec <容器> php → BLOCK（PHP 執行一律走 MCP 工具）。
    //   regex 用 lazy token 吃掉中間的 docker flag（-i / -it / -u user / -w path），
    //   並要求 php 為獨立命令 token（php(?=\s|$)）避免誤判 `cat php.ini`。
    regex: /docker\s+exec\s+(?:\S+\s+)*?php(?=\s|$)/i,
    // 框架 / 互動 / 探測類 CLI（MCP php 工具無法等價替代）放行：
    //   -l(lint)/-r(inline)/腳本檔執行 → MCP 有對應，照擋；artisan/console/vendor-bin/-v/-i/-a/-m/-S → 放行
    skipIfMatch: /\bphp\s+(?:-(?:a|v|i|m|S)\b|--(?:version|interactive|ini)\b|artisan\b|composer\b|bin\/console\b|vendor\/bin\/|\S*\.phar\b)/i,
    signature: 'bash:docker-php',
    hint: 'PHP 執行請用 MCP 工具：語法檢查 run_php_code({lint:true})／跑 inline run_php_code／跑腳本檔 run_php_script（遠端容器加 remote:true,container）。\n  框架/探測 CLI（artisan / bin/console / vendor/bin / -v / -i / -a / -S）已自動放行；真有 MCP 無法替代的場景，命令尾加 # mcp-fallback: <原因>。',
    warnOnFirst: true,
    block: true,
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
    hint: 'PHP 符號定位請用 AST 工具：class_method_lookup / find_usages / symbol_index / trace_logic。\n  找「誰引用某 class / 有沒有死碼」用 find_usages / find_dead_symbols（別用 grep new X / X::）。\n  純文字搜尋請用 Grep 工具帶 glob="*.php"。\n  禁 Bash grep .php — 規避 PHP symbol hook 偵測。',
    warnOnFirst: true,
    block: false,
  },
  {
    // Bash grep 對 PHP 專案目錄（cls / model / controller / service / repository / trait）→ BLOCK
    regex: /\b(grep|rg|findstr)\b[^|]*\b(cls|model|controller|service|repository|trait)s?\b/i,
    signature: 'bash:grep-php-dir',
    hint: 'PHP 目錄符號查詢請用 AST 工具：class_method_lookup / find_usages / symbol_index。\n  找 class 引用 / 死碼掃描用 find_usages / find_dead_symbols。',
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
    hint: '禁用 rm -rf：易誤刪。\n  → 刪 git「已追蹤」檔：用 git rm <path>（保留刪除紀錄、可還原）。\n  → 刪「未追蹤」檔（build 產物、暫存）：用 git clean -fd。\n  → 非 git 目錄或暫存路徑：手動驗證後再刪，或用 cleanup_path 工具（白名單 tmp 路徑）。',
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

// 剝除「字串承載」命令的 payload，避免把訊息內容裡的關鍵字當成實際執行命令。
//   只處理 git commit 訊息（-m / --message / heredoc）與 echo/printf 的引號字串——
//   這些情境裡的 `docker exec php` 等字樣是「文字資料」而非執行意圖（曾踩坑：commit
//   訊息描述提到 docker exec php 被 L1 docker-php 規則誤擋）。
//   不碰 docker/grep 等真正執行類命令的引號（那是執行意圖，需保留偵測）；
//   鏈接如 `git commit -m "x" && docker exec php y` 仍保留後段供偵測。
function stripMessagePayloads(command) {
  let s = command;
  // heredoc 主體：<<'EOF' ... \nEOF （含 git commit -m "$(cat <<'EOF' ... EOF )"）
  s = s.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\b/gm, ' HEREDOC ');
  if (/\bgit\s+commit\b/i.test(command)) {
    s = s.replace(/-m\s+(["'])[\s\S]*?\1/gi, ' -m MSG ');              // -m "訊息"
    s = s.replace(/--message(?:=|\s+)(["'])[\s\S]*?\1/gi, ' --message MSG ');
    s = s.replace(/\$\(cat[\s\S]*?\)/gi, ' MSG ');                      // 殘留的 $(cat ...)
  }
  if (/^\s*(?:echo|printf)\b/i.test(command)) {
    s = s.replace(/(["'])[\s\S]*?\1/g, ' STR ');                        // echo/printf 的引號字串
  }
  return s;
}

/** 從 Bash 命令提取簽名（核心動作） */
function extractBashSignature(command) {
  if (!command) return null;
  const probe = stripMessagePayloads(command);
  for (const { regex, signature } of BASH_PATTERNS) {
    if (regex.test(probe)) return signature;
  }
  return null;
}

/** 從 Bash 命令取得完整匹配結果 { signature, hint, warnOnFirst } */
function matchBashPattern(command) {
  if (!command) return null;
  const probe = stripMessagePayloads(command);
  for (const pat of BASH_PATTERNS) {
    if (pat.regex.test(probe)) {
      // 若 pattern 帶 skipIfMatch：命令符合時視為合法用途，放行（用於 mysql DDL/SHOW/EXPLAIN 等 meta query）
      if (pat.skipIfMatch && pat.skipIfMatch.test(probe)) return null;
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
    // Layer 1.7: ssh_exec → docker exec mysql/php/python — BLOCK
    //   ssh_exec 透過 SSH 到遠端再下 docker exec 是 Bash docker exec 的繞道路徑。
    //   修法：execute_sql({ connection_type:"docker_exec", preset:... }) /
    //         run_php_script({ container:... }) / run_python_script
    id: 'ssh_exec_docker_exec',
    detect: (entry, _history) => {
      const t = shortName(entry.tool);
      if (t !== 'ssh_exec') return null;
      const cmd = entry.args?.command || '';
      // fallback override：尾端 `# mcp-fallback: <reason>` 放行（會被 L1.6 計數）
      if (MCP_FALLBACK_RE.test(cmd)) {
        process.stderr.write(`[ssh_exec_docker_exec] allow: mcp-fallback comment\n`);
        return null;
      }
      let target = null;
      let hint = null;
      // 例外：DDL / meta query 放行（與 BASH_PATTERNS docker-mysql 同政策）
      const ddlSkip = /-e\s+["']?\s*(SHOW|EXPLAIN|DESCRIBE|DESC|CREATE|ALTER|DROP|USE|SET|RESET|FLUSH|ANALYZE|OPTIMIZE|CHECK|REPAIR)\b/i;
      if (/docker\s+exec\s+\S+\s+mysql/i.test(cmd)) {
        if (ddlSkip.test(cmd)) return null;
        target = 'mysql';
        hint = 'set_database({ connection_type:"docker_exec", container, ... }) + execute_sql / execute_sql_batch';
      } else if (/docker\s+exec\s+\S+\s+php\b/i.test(cmd)) {
        target = 'php';
        hint = '遠端容器 → run_php_code({ remote:true, container, code }) 或 run_php_script({ remote:true, container, path })（先 sftp_connect，自動走 SSH→docker exec）；本機容器 → run_php_script / run_php_code（帶 container）';
      } else if (/docker\s+exec\s+\S+\s+python/i.test(cmd)) {
        target = 'python';
        hint = 'run_python_script（python_runner 容器）';
      }
      if (!target) return null;
      return {
        block: true,
        message: `[L1.7 ssh_exec docker exec] ❌ BLOCKED（target=${target}）\n` +
                 `  → ssh_exec 走 SSH 過去再下 docker exec，等同 Bash docker exec 的繞道路徑。\n` +
                 `  → 請改用：${hint}\n` +
                 `  → 真有理由必須這樣下，在命令尾加 \`# mcp-fallback: <reason>\` 放行（會留審計紀錄）。\n`,
      };
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

      // 明確 JS scope（*.js/.ts/.vue glob、type 或 .js 路徑）→ 交給 grep_js_symbol，PHP 層讓位（避免給 PHP 建議卻是 JS）
      if (/\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte)\b/i.test(glob) ||
          /\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte)$/i.test(filePath) ||
          ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte'].includes(entry.args?.type)) {
        return null;
      }

      // 偵測搜尋 PHP class/method 的 pattern
      // 放寬 PHP context：路徑含 .php、常見 PHP 目錄名、或專案目錄（project/src/app）
      const isPhpContext = /\.php/i.test(glob) || /\.php/i.test(filePath) ||
        /admin|model|controller|cls\b|service|repository|src\b|app\b|project/i.test(filePath);
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

      // 鬆散 path-based PHP context (如 admin/, model/, project/) 但 pattern 無 PHP 結構符號
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
          /admin|model|controller|cls\b|service|repository|src\b|app\b|project/i.test(hPath);
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
    // Layer 2.4f: Grep JS Symbol — Grep 搜 JS/TS/Vue 的 function/class/method 定義時提醒改 AST 工具
    //   JS 符號（CLAUDE.md）應走 js_symbol_lookup / js_find_usages，Grep 散搜 obj.method / function 名常跑十幾輪。
    //   與 PHP 層互補：明確 PHP scope 交給 grep_php_symbol；這層管「明確 JS scope」與「無 scope 但 pattern 是 JS 定義風格」。
    //   警告級（不 BLOCK），對齊「JS/CSS hook 未強制 block」的既有立場。
    id: 'grep_js_symbol',
    detect: (entry, _history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Grep') return null;
      const pattern = entry.args?.pattern || '';
      const filePath = entry.args?.path || '';
      const glob = entry.args?.glob || '';
      const type = entry.args?.type || '';
      if (!pattern) return null;

      // 純文字搜尋特徵 → 放行（alternation / 中文 / kebab / HTML 屬性 / 含檔名副檔名）
      const isTextLike =
        /\|/.test(pattern) || /[一-鿿]/.test(pattern) ||
        /[a-z0-9]-[a-z0-9]/i.test(pattern) ||
        /\b(?:class|id|data-|aria-|style|href|src|name|type|value)\s*=/i.test(pattern) ||
        /\.(?:php|js|mjs|cjs|ts|tsx|jsx|vue|css|scss|less|html?|json|xlsx?|csv|md|py|sql|png|jpe?g|svg|txt|xml)\b/i.test(pattern);
      if (isTextLike) return null;

      // 明確 PHP scope → 交給 grep_php_symbol，這層不重複噴
      if (/\.php\b/i.test(glob) || /\.php\b/i.test(filePath) || type === 'php') return null;

      const JS_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte)\b/i;
      const JS_TYPES = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte']);
      const isJsScope = JS_EXT.test(glob) || JS_EXT.test(filePath) || JS_TYPES.has(type) || /[\\/]js[\\/]/i.test(filePath);

      // JS 符號「定義」pattern（function/class/賦值）— 不分 scope 都算（含 whole-repo 無 scope，如 `function showError`）
      const DEF_PATS = [
        { re: /\bfunction\s+\*?\s*[A-Za-z_$][\w$]*/, hint: 'function 名' },
        { re: /\bclass\s+[A-Za-z_$][\w$]*/, hint: 'class 名' },
        { re: /[A-Za-z_$][\w$]*\s*[:=]\s*(?:async\s+)?function\b/, hint: 'x = function' },
        { re: /[A-Za-z_$][\w$]*\s*=\s*\([^)]*\)\s*=>/, hint: 'arrow 賦值' },
      ];
      let hit = DEF_PATS.find((s) => s.re.test(pattern));
      // obj.method 點記號：較鬆，只在明確 JS scope 時才算（避免 file.php / CSS 點選擇器誤殺）
      if (!hit && isJsScope && /^_?[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(pattern.trim())) {
        hit = { hint: 'obj.method 點記號' };
      }
      if (!hit) return null;

      return `[JS Symbol] ⚠️ Grep 找 JS 符號（${hit.hint}）「${pattern.substring(0, 50)}」→ 建議改 AST 工具更省 token：\n` +
             `  → js_symbol_lookup（定義+原始碼，支援 obj.method 點記號）/ js_find_usages（精確找呼叫點）/ js_symbol_index\n` +
             `  Grep 適合搜純文字（變數名、字串、CSS class）。若目標其實是 PHP，改用 class_method_lookup / find_usages。\n`;
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
        /admin|model|controller|cls\b|service|repository|src\b|app\b|project|trait/i.test(filePath);
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
    // Layer 2.4e: Grep 找 class 引用 / 死碼 → 建議 find_usages / find_dead_symbols
    //   觸發：Grep（PHP context）pattern 形如 `new ClassName` / `ClassName::` / `extends X` / `implements X`
    //   這類「誰實例化/繼承這個 class」「這 class 還有沒有人用」是 find_usages / find_dead_symbols 的本職；
    //   Grep 散搜易被字串常數、檔尾 demo 行（如 `new Crypter()` 範例）誤導成「有人用」。
    id: 'grep_find_class_refs',
    detect: (entry, _history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Grep') return null;

      const pattern = entry.args?.pattern || '';
      const filePath = entry.args?.path || '';
      const glob = entry.args?.glob || '';
      const type = entry.args?.type || '';

      // 明確非 PHP 副檔名 → 放行（前端/其他語言走 js_find_usages 等，不在此層處理）
      const NON_PHP_EXTS = /\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte|css|scss|sass|less|html?|htm|json|md|py|go|rs|rb|java)\b/i;
      const NON_PHP_TYPES = new Set(['js','mjs','cjs','ts','tsx','jsx','vue','svelte','css','scss','sass','less','html','htm','json','md','py','go','rust','ruby','java']);
      if (NON_PHP_EXTS.test(glob) || NON_PHP_TYPES.has(type)) return null;

      const isPhpContext =
        /\.php/i.test(glob) || /\.php/i.test(filePath) || type === 'php' ||
        /admin|model|controller|cls\b|service|repository|src\b|app\b|project|trait/i.test(filePath);
      if (!isPhpContext) return null;

      // 「找 class 引用」的 pattern：new X / X:: / extends X / implements X
      const REF_HUNT = /(\bnew\s+[A-Za-z_]\w*|\b[A-Z]\w*\s*::|\bextends\s+[A-Za-z_]\w*|\bimplements\s+[A-Za-z_]\w*)/;
      if (!REF_HUNT.test(pattern)) return null;

      return `[PHP Symbol] ⚠️ 用 Grep 找「誰引用這個 class（new / :: / extends / implements）」→ 改用 AST 工具，免被字串常數/檔尾 demo 行誤導成「有人用」：\n` +
             `  → find_usages({ project, class_name })：精確列出所有 new / 靜態呼叫 / 繼承 / 實作位置\n` +
             `  → find_dead_symbols({ project })：一次掃出整包「零引用」死碼候選，取代逐一 grep 反查\n`;
    },
  },
  {
    // Layer 2.4d: php_text_search 全專案散搜守門
    //   同 session 內第 2 次 php_text_search 無 scope 且未 force_full_scan → BLOCK
    //   首次散搜由工具內 FULL_SCAN_THRESHOLD 守（>1500 .php 檔擋下），
    //   這層補的是「跨次重複全掃」的攔截，避免每次都掃 13000 檔再喊燒 token。
    id: 'php_text_search_no_scope',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'php_text_search') return null;

      const args = entry.args || {};
      const hasScope = Array.isArray(args.scope) && args.scope.length > 0;
      if (hasScope) return null;
      if (args.force_full_scan === true) return null;

      // 統計歷史中同 session 的 php_text_search 無 scope 呼叫
      const prevNoScope = history.filter(h => {
        if (shortName(h.tool) !== 'php_text_search') return false;
        const a = h.args || {};
        if (Array.isArray(a.scope) && a.scope.length > 0) return false;
        if (a.force_full_scan === true) return false;
        return true;
      });

      if (prevNoScope.length === 0) return null; // 首次交給工具內 threshold 守

      const pattern = (args.pattern || '').slice(0, 60);
      return {
        block: true,
        message:
          `[php_text_search] ❌ BLOCKED：本 session 已第 ${prevNoScope.length + 1} 次 php_text_search 無 scope 全專案散搜。\n` +
          `  pattern="${pattern}"\n` +
          `  全掃命中率通常極低、燒 token。請改用：\n` +
          `    (A) 補 scope: ["adminControl/xxx", "cls/model"] 縮小範圍\n` +
          `    (B) 若搜 DB 欄位名 → set_database + execute_sql 查 INFORMATION_SCHEMA\n` +
          `    (C) 真要全掃 → force_full_scan: true 並說明理由\n`,
      };
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
    // Layer 2.10c: Layout Suspect JS Edit
    //   使用者剛回報 popup / 跑版 / 錯位 / 樣式問題（cssInspectRequired flag 啟動），
    //   但 Claude 下一個 Edit/Write 動的是 .js / .vue / .ts 而不是 .css —
    //   提醒「確定不是 CSS 問題嗎？」（純警告，不擋）。
    //   過去案例：使用者抱怨 popup 跑版，prompt-guard 已提醒先 inspect CSS，
    //   但 Claude 仍直接動 JS handler，繞了一圈才回去查 CSS。
    id: 'layout_suspect_js_edit',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      const writeTools = new Set(['Edit', 'Write', 'apply_diff', 'create_file', 'apply_diff_batch', 'multi_file_inject']);
      if (!writeTools.has(tool)) return null;

      const filePath = (entry.args?.file_path || entry.args?.path || '').replace(/\\/g, '/').toLowerCase();
      // JS / Vue / TS 家族（不含 .css）
      if (!/\.(jsx?|tsx?|vue|mjs|cjs|svelte)$/.test(filePath)) return null;

      // 讀 write-guard 共享 state
      let cssInspectRequired = false;
      let lastPrompt = '';
      try {
        const wgFile = path.join(os.tmpdir(), 'claude-write-guard', 'state.json');
        if (fs.existsSync(wgFile)) {
          const wg = JSON.parse(fs.readFileSync(wgFile, 'utf-8'));
          if (Date.now() - (wg.ts || 0) < 30 * 60 * 1000) {
            cssInspectRequired = !!wg.cssInspectRequired;
            lastPrompt = (wg.lastPrompt || '').toLowerCase();
          }
        }
      } catch {}

      if (!cssInspectRequired) return null;

      // 已在本 session 跑過 inspect 工具 → 代表 Claude 真的查過 CSS 才決定改 JS，放行
      const INSPECT_TOOLS = new Set([
        'css_computed_winner', 'css_specificity_check', 'css_inspect',
        'mcp__project-migration-assistant-pro__css_computed_winner',
        'mcp__project-migration-assistant-pro__css_specificity_check',
        'mcp__project-migration-assistant-pro__css_inspect',
      ]);
      if (history.some(h => INSPECT_TOOLS.has(h.tool) || INSPECT_TOOLS.has(shortName(h.tool)))) return null;

      // 使用者最近 prompt 已明確表示「就是 JS 問題 / 不是 CSS」→ 放行
      if (/不是.{0,4}css|不是.{0,4}樣式|是.{0,4}(?:js|邏輯|事件|功能)|跟.{0,4}css.{0,4}無關|popup.{0,4}沒(?:跳|彈|觸發|顯示)/i.test(lastPrompt)) {
        return null;
      }

      const fname = filePath.split('/').pop();
      return (
        `[Layout Suspect] ⚠️ 使用者剛回報「排版 / 跑版 / popup 樣式 / 錯位」相關問題，但你現在要動的是 ${fname}（JS/Vue/TS）。\n` +
        `  → 確定不是 CSS 問題嗎？popup 跑版 / 元素錯位 / 樣式蓋不掉 9 成是 CSS specificity / @media / z-index / position 衝突，不是 JS 邏輯。\n` +
        `  → 建議先查 CSS 拿事實再決定改哪：\n` +
        `    ▸ mcp__css_computed_winner(url, selector, property) — 看哪條規則贏\n` +
        `    ▸ mcp__css_specificity_check(url, selector) — 列出所有命中規則\n` +
        `    ▸ mcp__css_inspect(url, selector) — 取 computed style + 來源行號\n` +
        `  → 若已確認是 JS 邏輯問題（popup 沒觸發 / 事件綁錯 / 資料沒回填），請向使用者明說「我確認不是 CSS」後再繼續改 JS。\n`
      );
    },
  },
  {
    // Layer 2.11: Playwright emulateMedia 殘留污染（screen media 漏進 page.pdf）
    //   page.emulateMedia({media:'screen'}) 在 Playwright MCP 同一個 page 上會「持久化」，
    //   之後每一次 page.pdf() 都改用螢幕 CSS 渲染 → 列印按鈕跑進 PDF、版面臨界值全是假數據。
    //   page.pdf() 預期跑在 print media；要量列印版面前必須先 emulateMedia({media:'print'})。
    //   前車之鑑（列印版面測試）：screen 殘留讓 page.pdf 量到假臨界值，反覆調 PAGE_MM
    //     空轉約 40 輪，重設 print media 後真實臨界值一次就對。
    //   ① 單次呼叫內：同段 code 先設 screen、後 page.pdf、中間沒 reset 回 print。
    //   ② 跨呼叫殘留：先前某次 browser_run_code/evaluate 設了 screen 從未 reset，本次又 page.pdf。
    //   警告不擋（exit 0）。
    id: 'playwright_media_leak',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      const BROWSER_CODE = new Set(['browser_run_code', 'browser_evaluate']);
      const SCRIPT_TOOLS = new Set(['run_python_script', 'run_php_code', 'run_php_script']);
      const isBrowserCode = BROWSER_CODE.has(tool);
      if (!isBrowserCode && !SCRIPT_TOOLS.has(tool)) return null;

      const codeOf = (e) => {
        const a = e.args || {};
        return [a.code, a.function, a.script, a.command]
          .filter(s => typeof s === 'string').join('\n');
      };
      const code = codeOf(entry);
      if (!code) return null;

      const SRC_SCREEN = /emulate_?media\s*\([^)]*\bmedia\b\s*[:=]\s*['"]screen['"]/i;
      const SRC_PRINT  = /emulate_?media\s*\([^)]*\bmedia\b\s*[:=]\s*['"]print['"]/i;
      // reset → 視為等同 print（pdf 預設 media 就是 print，所以是安全的）
      const SRC_RESET  = /emulate_?media\s*\(\s*(\)|\{\s*\}|\{\s*media\s*[:=]\s*(null|None)\s*\})/i;
      const RE_PDF     = /\.pdf\s*\(/i;

      // 本次 code 沒有 page.pdf → 不在本層管轄（截圖污染另論，聚焦最致命的 pdf）
      if (!RE_PDF.test(code)) return null;
      const pdfIdx = code.search(RE_PDF);

      // 在 text 的 [0, limit) 區間內，找「最後」一次 media 設定，回傳 'screen'|'print'|null
      const lastMediaBefore = (text, limit) => {
        let state = null, pos = -1;
        const scan = (src, label) => {
          const r = new RegExp(src.source, 'gi'); let m;
          while ((m = r.exec(text)) !== null) {
            if (m.index < limit && m.index > pos) { pos = m.index; state = label; }
          }
        };
        scan(SRC_SCREEN, 'screen');
        scan(SRC_PRINT, 'print');
        scan(SRC_RESET, 'print');
        return state;
      };

      const buildMsg = (kind) => (
        `[Playwright Media Leak] ⚠️ 偵測到 page.pdf() 但 emulateMedia 目前狀態是 'screen'（${kind}）。\n` +
        `  → page.pdf() 預期跑在 print media；screen 殘留會讓 PDF 用螢幕樣式渲染（列印鈕跑進 PDF、版面臨界值全是假數據）。\n` +
        `  → 修法：產 PDF 前先 await page.emulateMedia({ media: 'print' })；截圖才切回 'screen'。量列印版面務必確認當下是 print media。\n` +
        `  → 前車之鑑：列印版面測試曾因 screen 殘留量到假臨界值，反覆調參數空轉數十輪，重設 print 後一次就對。\n`
      );

      // ① 單次呼叫內：pdf 之前最後設定的是 screen
      const inCall = lastMediaBefore(code, pdfIdx);
      if (inCall === 'screen') return buildMsg('同段 code 先設了 screen、未 reset 就 page.pdf');
      if (inCall === 'print') return null; // 同段已明確 reset / 設 print，安全

      // ② 跨呼叫殘留：僅 MCP 同一 browser page 適用（run_python_script 每次新 process 不殘留）
      if (isBrowserCode) {
        for (let i = history.length - 1; i >= 0; i--) {
          const h = history[i];
          if (!BROWSER_CODE.has(shortName(h.tool))) continue;
          const hCode = codeOf(h);
          if (!hCode) continue;
          const hState = lastMediaBefore(hCode, hCode.length);
          if (hState === 'screen') return buildMsg('先前某次 browser code 設了 screen 從未 reset 回 print');
          if (hState === 'print') break; // 已 reset，安全
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

      // 同 session 已 ack：跑過 /css_legacy_override skill、或 lastPrompt 帶確認字樣
      // 為了減少 UX friction：除了原本長 ack phrase 外，也接受「短確認」（如 OK / 好 / 動手 / 繼續）
      // — 因為使用者通常在看過 Claude 報的 3-check checklist 後才會短確認，再要求打全文太囉嗦
      let acked = false;
      try {
        const wgFile = path.join(os.tmpdir(), 'claude-write-guard', 'state.json');
        if (fs.existsSync(wgFile)) {
          const wg = JSON.parse(fs.readFileSync(wgFile, 'utf-8'));
          const lpRaw = (wg.lastPrompt || '').trim();
          const lp = lpRaw.toLowerCase();
          // 長 ack phrase（任何位置出現都算）
          if (/\/css_legacy_override|legacy.*已查|已跑.*legacy|確認.*覆寫|skip.*legacy/.test(lp)) acked = true;
          // 短 ack（整個 prompt 就是這幾個字才算，避免長訊息裡剛好出現 ok 被誤判）
          // 允許最多 12 個字元的短回覆，含常見肯定詞
          if (
            lpRaw.length <= 12 &&
            /^(ok|okay|好|好的|好喔|可以|可以動手|做|做吧|動手|上|繼續|go|do it|沒問題|yes|對|對的|嗯)[\s。！!.]*$/i.test(lpRaw)
          ) {
            acked = true;
          }
          if (wg.cssLegacyAcked && (Date.now() - (wg.ts || 0) < 30 * 60 * 1000)) acked = true;
        }
      } catch {}

      // 只接受顯式 ack（跑過 /css_legacy_override skill 或 prompt 帶確認字樣）
      // 不再「重 retry 自動放行」— 那是 escape hatch，會讓 Claude 不檢查直接重試導致 gate 形同虛設
      if (acked) return null;

      const fname = filePath.split('/').pop();
      return (
        `[CSS Legacy Gate] ⚠️ 寫入頁面層 CSS（${fname}）— 若這次改動含 display/position/layout 反制 legacy，建議先檢查：\n` +
        `  □ Specificity ≥ legacy 且 legacy 無 !important\n` +
        `  □ @media 全斷點覆蓋（1024 / 768 / 480 / hover）\n` +
        `  □ 排版位置使用者已確認 OK\n` +
        `  推薦：/css_legacy_override {CSS檔} {選擇器} 自動產對照表\n` +
        `  純色/字體/動畫/間距微調可忽略本訊息。\n`
      );
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
    // Layer 2.75: Status Value Audit — 修改業務狀態值前提醒先 audit 全專案 filter
    //   觸發：Edit/Write/apply_diff/create_file 內容含
    //         `'status' => 'XXX'` 或 `"status" => "XXX"` PHP 陣列 syntax，新值為純大寫
    //         或 SQL `INSERT INTO ... status ... VALUES` / `UPDATE ... SET status =`
    //   行為：純警告（不擋），提醒先 Glob list.php + Grep status= 列完整 filter
    //   原因：新增業務狀態值容易撞既有 tab filter（list.php WHERE status IN (...)），
    //         先 audit 再改才不會出現「新值落在沒對應 tab 的狀態」
    id: 'status_value_audit',
    detect: (entry, _history) => {
      const tool = shortName(entry.tool);
      const WRITE_TOOLS = new Set(['Edit', 'Write', 'apply_diff', 'apply_diff_batch', 'create_file', 'create_file_batch']);
      if (!WRITE_TOOLS.has(tool)) return null;

      const filePath = entry.args?.file_path || entry.args?.path || '';
      // 只在 PHP / SQL 檔案範圍偵測，避免誤殺 JS/Vue 的 status: 'loading' 等 UI 狀態
      if (filePath && !/\.(php|sql|inc)$/i.test(filePath) && !/items/.test(JSON.stringify(entry.args || {}))) {
        // batch 工具沒有單一 file_path，落到內容檢查
      }

      // 收集所有可能含修改內容的字串欄位
      const fields = [
        entry.args?.new_string,
        entry.args?.content,
        entry.args?.new_content,
        entry.args?.diff,
      ].filter((v) => typeof v === 'string');
      if (entry.args?.items && Array.isArray(entry.args.items)) {
        for (const it of entry.args.items) {
          if (typeof it?.content === 'string') fields.push(it.content);
          if (typeof it?.new_string === 'string') fields.push(it.new_string);
          if (typeof it?.diff === 'string') fields.push(it.diff);
        }
      }
      if (fields.length === 0) return null;
      const haystack = fields.join('\n');

      // Pattern 1：PHP 陣列 'status' => 'UPPERCASE_VALUE'
      const phpArrayRe = /['"]status['"]\s*=>\s*['"]([A-Z][A-Z0-9_]{1,30})['"]/;
      // Pattern 2：SQL INSERT / UPDATE 帶 status 欄位
      const sqlInsertRe = /INSERT\s+INTO\s+\w+[^;]*\bstatus\b/i;
      const sqlUpdateRe = /UPDATE\s+\w+\s+SET\s+[^;]*\bstatus\s*=/i;

      const phpMatch = haystack.match(phpArrayRe);
      const sqlMatch = sqlInsertRe.test(haystack) || sqlUpdateRe.test(haystack);
      if (!phpMatch && !sqlMatch) return null;

      const valueHint = phpMatch ? `偵測到值「${phpMatch[1]}」` : '偵測到 SQL 對 status 欄位的寫入';
      return `[L2.75 Status Audit] ⚠️ 你正在修改業務狀態值（${valueHint}）。\n` +
             `  → 動手前請先 audit：\n` +
             `     1. Glob "**/list.php" 列出所有列表頁\n` +
             `     2. Grep "status\\s*=" 在 list.php / model 範圍，列出既有 tab filter 完整值表\n` +
             `     3. 確認新值是否該歸到既有 tab、或要新增 tab\n` +
             `  → 漏掉這步常見後果：新狀態值的訂單在所有 tab 都看不到、或落到錯誤 tab\n` +
             `  → 純提醒不阻擋；確認 audit 過就繼續寫。\n`;
    },
  },
  {
    // Layer 2.76: Status Value Thrashing — 同檔同狀態值反覆 Edit ≥3 次 → BLOCK
    //   觸發：同檔案內，相同 status / payment_chk 值出現在 ≥3 次 Edit 的 new_string
    //   行為：BLOCK，要求停下做全 audit 再選方向
    //   原因：反覆改同一狀態值代表「方向錯」（漏 audit、撞 filter、邊改邊試），
    //         不是「改錯字」這種正常修改；強制停下避免無限調整
    id: 'status_value_thrashing',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      const WRITE_TOOLS = new Set(['Edit', 'apply_diff']);
      if (!WRITE_TOOLS.has(tool)) return null;

      const filePath = entry.args?.file_path || entry.args?.path || '';
      if (!filePath) return null;

      // 從當前 entry 抽出 status / payment_chk 值（PHP 陣列 syntax）
      const VALUE_RE = /['"](?:status|payment_chk)['"]\s*=>\s*['"]([A-Z][A-Z0-9_]{1,30})['"]/g;
      const cur = entry.args?.new_string || entry.args?.diff || '';
      if (typeof cur !== 'string') return null;
      const curValues = new Set();
      let m;
      while ((m = VALUE_RE.exec(cur)) !== null) curValues.add(m[1]);
      if (curValues.size === 0) return null;

      // 掃 history 同檔同 value 的次數
      for (const targetValue of curValues) {
        let count = 1; // 含當前
        for (const h of history) {
          const ht = shortName(h.tool);
          if (!WRITE_TOOLS.has(ht)) continue;
          const hPath = h.args?.file_path || h.args?.path || '';
          if (hPath !== filePath) continue;
          const hNew = h.args?.new_string || h.args?.diff || '';
          if (typeof hNew !== 'string') continue;
          const re = new RegExp(`['"](?:status|payment_chk)['"]\\s*=>\\s*['"]${targetValue}['"]`);
          if (re.test(hNew)) count++;
        }
        if (count >= 3) {
          return {
            block: true,
            message: `[L2.76 Status Thrashing] ❌ BLOCKED：同檔同狀態值反覆修改 ${count} 次。\n` +
                     `  檔案：${filePath}\n` +
                     `  反覆值：${targetValue}（status / payment_chk）\n` +
                     `  → 反覆改同一狀態值代表「方向錯」（漏 audit / 撞 filter / 邊改邊試）。\n` +
                     `  → 請停下來，先做全 audit：\n` +
                     `     1. Glob "**/list.php" + Grep "${targetValue}" 列出所有引用點\n` +
                     `     2. 確認該值在每個 tab filter 的歸屬\n` +
                     `     3. 把方案攤給使用者選，不要再硬改\n`,
          };
        }
      }
      return null;
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
    // Layer 2.82c: gspread 讀公式結果前若無近期寫入動作，警示可能用過期 state 下結論
    // 觸發：run_python_script 跑 gspread fetch 公式結果，且近 30 分鐘無 batch_update / update_values
    // 用途：計算對齊類任務避免「fetch 了但 fetch 時 source 狀態對應的是別的 case」
    id: 'gspread_stale_state',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'run_python_script') return null;
      const code = entry.args?.code || entry.args?.script_content || '';
      const scriptPath = entry.args?.script_path || '';

      // 取 script 內容（直接 code 或從路徑讀）
      let src = code;
      if (!src && scriptPath) {
        try {
          const p = scriptPath.replace(/\\/g, '/');
          src = fs.readFileSync(p, 'utf-8').slice(0, 16384);
        } catch {}
      }
      if (!src) return null;

      // 必含 gspread + FORMULA / UNFORMATTED_VALUE 之一
      const hasGspread = /\bgspread\b/.test(src) || /\bopen_by_key\(|\bworksheet\(/.test(src);
      const readsFormula = /value_render_option\s*=\s*['"]?(FORMULA|UNFORMATTED_VALUE)/i.test(src);
      if (!hasGspread || !readsFormula) return null;

      // 已 ack 過 → 跳過（同 session 一次）
      const ackPath = path.join(LOG_DIR, 'gspread_stale_state_ack.flag');
      try { if (fs.existsSync(ackPath)) return null; } catch {}

      // 看 history 近 30 分鐘有沒有「寫 Sheet」動作（同樣是 run_python_script，但 code 含 update / batch_update / update_values / append_row）
      const THIRTY_MIN = 30 * 60 * 1000;
      const now = Date.now();
      const sawWrite = history.some(h => {
        if ((now - (h.ts || 0)) > THIRTY_MIN) return false;
        if (shortName(h.tool) !== 'run_python_script') return false;
        const hcode = h.args?.code || h.args?.script_content || '';
        let hsrc = hcode;
        if (!hsrc && h.args?.script_path) {
          try { hsrc = fs.readFileSync(h.args.script_path.replace(/\\/g, '/'), 'utf-8').slice(0, 16384); } catch {}
        }
        if (!hsrc) return false;
        return /\.update\s*\(|\.batch_update\s*\(|\.update_values\s*\(|\.update_cell\s*\(|\.update_acell\s*\(|\.append_row\s*\(|values_update/.test(hsrc);
      });
      if (sawWrite) return null;

      // 落 ack 避免反覆擾人
      try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(ackPath, String(now)); } catch {}

      return `[gspread Stale State] ⚠️ 即將讀 Sheet 公式結果（FORMULA / UNFORMATTED_VALUE），但近 30 分鐘無寫入 Sheet 的動作。\n` +
             `  → 公式結果反映「Sheet 目前的輸入狀態」，若 web 輸入欄（如 A3/B3/C3/D3/F3/H3/I9/J3 等業務輸入）對應的是別的 case，\n` +
             `    這次 fetch 出來的值對「當前 case」是過期狀態。\n` +
             `  → 建議先：(1) 寫入當前 case 的輸入值 → (2) sleep 2-3 秒等 Sheet 重算 → (3) 再 fetch。\n` +
             `  → 若 fetch 的不是 input-sensitive 的 cells（如 lookup table 本體、常數）可忽略此提醒。\n` +
             `  → 同 session 此提醒只出現一次。\n`;
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
    // L3b: Consecutive Batch Eligible — 同一個 batch-eligible 工具連續 ≥4 次（不分子類別）就主動提示
    //   背景：same_category_repeat 對 execute_sql 是依 SQL 類型+表名分桶，
    //         4 個不同表的 SELECT 不會觸發，但其實全都可以塞進 execute_sql_batch 一次跑。
    //   觸發條件：最近 N 次 tool call 中，連續 ≥4 次都是同一個 batch-eligible 工具（含 _batch 版互通）。
    //   單次警告：同 session 同工具的 batch 提示只發一次，避免每多一次又跳一次。
    id: 'consecutive_batch_eligible',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (!BATCH_HINTS[tool]) return null;

      // 數「最近連續」幾次：從尾端往回掃，遇到非同工具就停
      let consecutive = 1; // 含本次
      for (let i = history.length - 1; i >= 0; i--) {
        if (shortName(history[i].tool) === tool) {
          consecutive++;
        } else {
          break;
        }
      }
      if (consecutive < 4) return null;

      // 同 session 同工具只警告一次（用 history 中是否已有過此提示作粗略判斷）
      // 註：以 session 狀態檔記錄更乾淨；此處用「連續次數 == 4 才提」作 dedupe
      if (consecutive !== 4) return null;

      const batchTool = BATCH_HINTS[tool];
      return (
        `[Repetition Detector] 📦 BATCH 提示：${tool} 已連續呼叫 ${consecutive} 次。\n` +
        `  → 改用「${batchTool}」一次處理多筆，每次 round-trip 省 ~200 tokens。\n` +
        `  → 跨 4 場 session retro 證實：execute_sql 連用 57+ 次都單發，是最常被忽略的 batch 機會。\n` +
        `  （同 session 同工具僅提一次；繼續單發不再警告。）\n`
      );
    },
  },
  {
    // L3c: GSheet Per-Cell Pull — 逐組/逐格拉 GSheet 而非批次對帳（token 燒點）
    //   背景：逐項對帳（PHP vs GSheet baseline）時，容易一組一組 fetch_with_state / get_values，
    //         甚至 fetch_with_state 回空又補一次 get_values（雙叫）。14 組 ×2 = 28 次、每次回傳整片，
    //         輕鬆堆到 40K+。token 斷路器數「呼叫次數」不數 token，這種高 token/次的燒法會滑過去；
    //         L3b 要求「連續同一支工具」，交替叫也不觸發。故補這個「GSheet 讀取家族」窗口偵測。
    //   觸發：最近 12 步內 GSheet 讀取家族累計 ≥5 次 → 提示改批次（一次多 range / PHP 端批次比對出表）。
    //   單次警告（== 5 時提一次）。
    id: 'gsheet_per_cell_pull',
    detect: (entry, history) => {
      const GS_READ = new Set(['gsheet_fetch_with_state', 'gsheet_get_values', 'gsheet_fetch_formatted']);
      const tool = shortName(entry.tool);
      if (!GS_READ.has(tool)) return null;

      const recent = history.slice(-12).map((h) => shortName(h.tool));
      const count = recent.filter((t) => GS_READ.has(t)).length + 1; // 含本次
      if (count < 5) return null;
      if (count !== 5) return null; // 只在剛達 5 次時提一次，去重

      // 偵測「fetch_with_state 回空又補 get_values」的雙叫節奏（相鄰兩步一支 fetch 一支 get）
      const last2 = recent.slice(-2);
      const doubleCall =
        (last2.includes('gsheet_fetch_with_state') && last2.includes('gsheet_get_values'));

      return (
        `[Repetition Detector] 💸 BATCH 提示：你已逐組拉 GSheet ${count} 次（token 燒點）。\n` +
        (doubleCall
          ? `  → 偵測到「fetch_with_state 回空 → 補 get_values」雙叫節奏；這台不穩就直接用 gsheet_get_values / gsheet_set_values 一套到底，別再雙叫。\n`
          : '') +
        `  → gsheet_get_values 一次可帶「多個 range」，把整批格併成一次呼叫，別一組一組拉。\n` +
        `  → 逐項對帳的正解：測試機 PHP 算好 N 項 → 一支腳本批次比對 → 出一張 PASS/FAIL 表（全程 3~4 次呼叫），不要一格一格灌 GSheet 還自己心算。\n` +
        `  → 無印刷的組別，印刷版三格必然全不適用，抽樣「有印刷 + 無法承製」各 2 組即可驗證邏輯，不必 14 組全灌。\n` +
        `  （同 session 僅提一次；繼續逐組拉不再警告，但 token 會持續累積。）\n`
      );
    },
  },
  {
    // L2.84b: Consecutive Same-URL Navigate — 連續導航同一 URL ≥3 次即警告（早於 exact_same_call 9 次門檻）
    //   背景：page audit / wait_for 後常會反射性重 navigate 同一頁，但頁面狀態沒清掉重來等於白燒。
    //   觸發：最近 N 次 tool call 連續都是同一 URL 的 browser_navigate（不分哪個 playwright instance）。
    //   單次警告（連續 == 3 時提一次），避免每多一次又跳一次。
    id: 'consecutive_same_url_navigate',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'browser_navigate') return null;
      const currentUrl = entry.args?.url || '';
      if (!currentUrl) return null;

      let consecutive = 1;
      for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (shortName(h.tool) !== 'browser_navigate') break;
        if ((h.args?.url || '') !== currentUrl) break;
        consecutive++;
      }
      if (consecutive !== 3) return null; // 只在第 3 次連續同 URL 時提，去重

      return (
        `[Repetition Detector] 🔁 連續 navigate 同一 URL ${consecutive} 次：${currentUrl.slice(0, 100)}\n` +
        `  → 頁面通常不會因為再 navigate 一次就好。建議：\n` +
        `    1. 先 browser_close 重設 session，再 navigate（解 stale state）\n` +
        `    2. 或檢查 selector 是否真的存在（用 browser_snapshot 看實際 DOM）\n` +
        `    3. 或檢查 callback 是否真的有跑（用 send_http_request 打 endpoint 看 raw 200 body）\n` +
        `  （第 ${consecutive} 次同 URL 提示；達 9 次會被 exact_same_call 硬擋。）\n`
      );
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

      // 動態門檻：
      //   - browser_wait_for / browser_navigate：UI 測試常反覆 wait / re-navigate → 9
      //   - run_php_script 跑 harness/diff/verify 類腳本：本來就需要反覆執行確認修改成效 → 12
      //     (路徑含 `_harness/` 或檔名含 diff/verify/audit 字樣)
      //   - 其他：5
      const tool = shortName(entry.tool);
      const phpScriptPath = tool === 'run_php_script' ? (entry.args?.path || '') : '';
      const isHarnessScript =
        phpScriptPath &&
        (/[\\/]_harness[\\/]/.test(phpScriptPath) ||
          /(?:^|[\\/])([^\\/]*?)(diff|verify|audit)[^\\/]*\.php$/i.test(phpScriptPath));

      let threshold = 5;
      if (tool === 'browser_wait_for' || tool === 'browser_navigate') threshold = 9;
      else if (isHarnessScript) threshold = 12;

      if (count < threshold) return null;
      const extraHint = (tool === 'browser_wait_for')
        ? '\n  → wait_for 持續失敗多半是前置條件沒成立：檢查 callback 是否真的有跑（先打 endpoint 看 raw body）、selector 是否仍存在、頁面是否被 navigate 走。'
        : (tool === 'browser_navigate')
        ? '\n  → 連續 navigate 同一 URL 通常代表頁面狀態不對：先 browser_close 重設 session，或檢查網址是否真的有變。'
        : isHarnessScript
        ? '\n  → harness/diff 類腳本已跑 12 次且 args 完全相同：建議檢視是不是只在等 cache / 沒換 case，或改帶不同 args 讓本 hook 視為新呼叫。'
        : '';
      return {
        block: true,
        message: `[Repetition Detector] ❌ BLOCKED：完全相同的工具呼叫已達 ${count} 次（門檻 ${threshold}）。停下來重新評估策略。${extraHint}\n`,
      };
    },
  },
  {
    // Layer 4: Post-Tool-Use 未 commit 累積提醒 — 已依使用者要求停用（不再提示 commit）
    id: 'uncommitted_accumulation',
    detect: () => null,
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
            .filter(d => d.isDirectory() && /^(screenshot|_harness)/i.test(d.name))
            .map(d => d.name);
          return dirs.length > 0 ? dirs : ['screenshot', 'screenshots', '_harness'];
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

      // 例外：背景 sub-agent 寫檔不受 promptGuardActive 影響（與 write-guard.js 同步）
      if (entry.parent_tool_use_id || entry.parentToolUseId) return null;

      // 例外：文件/筆記類寫入（.md/.txt 等非程式碼）不受 promptGuardActive 阻擋。
      // promptGuard 的本意是防「需求不明就冷寫 code」；寫分析/說明/筆記文件本來就是釐清需求的一部分，不該擋。
      const wPath = entry.args?.path || entry.args?.file_path || '';
      if (/\.(md|markdown|mdx|txt|rst|adoc)$/i.test(String(wPath))) return null;

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

        const reasonLine = raw.promptGuardReason
          ? `  判斷依據：${raw.promptGuardReason}\n`
          : '';
        return {
          block: true,
          message: `[Prompt Guard] ❌ BLOCKED：${tool} 暫時被擋（Prompt Guard 偵測到任務描述不完整）。\n` +
                   reasonLine +
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
    // Layer 2.87: Git-First Dependency Lookup — 使用者問當前依賴時，Claude 先翻 git history 是錯方向
    //   依賴是「當前 code 狀態」問題，不是「歷史」問題；應先 grep / class_method_lookup / find_usages / find_dependencies
    //   觸發：Bash 跑 git log/blame/show/grep + 最近使用者訊息含「誰用 / 誰依賴 / 哪裡會掛 / 砍/刪除/移除 + 要改/影響」
    //   行為：warn（不擋），同 user-turn 提示一次後 ack 避免反覆
    id: 'git_first_for_dependencies',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (tool !== 'Bash' && tool !== 'PowerShell') return null;
      const cmd = entry.args?.command || '';
      // 偵測「翻歷史找依賴」類型的 git 指令
      if (!/\bgit\s+(log|blame|show|grep)\b/i.test(cmd)) return null;
      // 純 git log / git show <commit> 查 commit 本身內容是合理的，這裡只擋「找 X 在 code 中被誰用」
      // 簡化判定：使用者訊息是判斷依據，不過度看 cmd 結構

      const recentMsgs = readRecentUserMessages(3);
      const DEP_RE = /(誰(用|依賴|呼叫|引用)|哪(裡|些).*?(掛|用|依賴|引用|改|受影響)|砍.*?(改|影響|要|哪)|刪除.*?(改|影響|要|哪)|移除.*?(改|影響|要|哪)|哪些(檔案|頁面|module|模組|地方).*?(用|依賴|引用)|find\s+(usages|dependencies|references)|who\s+(uses|depends))/i;
      const triggered = recentMsgs.some(m => DEP_RE.test(m.text || ''));
      if (!triggered) return null;

      // 同 user-turn 已提示過 → 跳過
      const lastUserTs = recentMsgs[0]?.ts || 0;
      const alreadyWarned = history.some(h =>
        h._gitFirstDepWarned && (h.ts || 0) >= lastUserTs
      );
      if (alreadyWarned) return null;

      entry._gitFirstDepWarned = true;
      return `[Git-First Dep] ⚠️ 偵測到「找當前依賴」類問題，但你準備跑 \`${cmd.slice(0, 60).replace(/\n/g, ' ')}\`。\n` +
             `  → 依賴是「當前 code 狀態」問題，不是「歷史」問題。git log/blame 只能看誰「曾經」改過，看不到現在誰真的依賴。\n` +
             `  → 先用以下工具掃當前 code：\n` +
             `    ▸ find_usages({ symbol: "..." }) — AST 精確找誰呼叫此符號\n` +
             `    ▸ find_dependencies({ class_name: "..." }) — 找 class/method 依賴鏈\n` +
             `    ▸ Grep（純文字搜尋 SQL 表名 / 字串常數）+ glob 縮範圍\n` +
             `  → git 只該在「想知道某段 code 為什麼這樣寫」時用，不是找依賴的工具。\n`;
    },
  },
  {
    // Layer 2.88: Ambiguous UI Complaint — 使用者貼模糊抱怨 + 截圖，Claude 沒先反問就動手
    //   UI 問題有 4 層：layout（位置/樣式）/ trigger（不該出現）/ data（顯示錯）/ interaction（操作沒反應）
    //   截圖只證明「現象出現」，不證明使用者在意的層級。先反問 1 句省 6+ 輪繞遠路。
    //   觸發：使用者最近訊息含「跑版/壞了/不對/有問題/怪/錯了」+ 附圖 + Claude 動手工具（非反問）
    //   行為：warn（不擋），同 user-turn ack 後不再提示
    id: 'ambiguous_ui_complaint',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      // 動手類工具（會直接開始 trace / 改 code），AskUserQuestion / 純文字回答不算
      const ACTION_TOOLS = new Set([
        'Bash', 'PowerShell', 'Read', 'Grep', 'Glob', 'Edit', 'Write',
        'apply_diff', 'apply_diff_batch', 'create_file', 'create_file_batch',
        'read_file', 'list_files', 'list_files_batch',
        'browser_interact', 'browser_navigate', 'browser_click', 'browser_evaluate',
        'browser_snapshot', 'browser_take_screenshot', 'page_audit', 'css_inspect',
        'class_method_lookup', 'find_usages', 'symbol_index', 'trace_logic',
        'php_text_search', 'send_http_request', 'execute_sql',
      ]);
      if (!ACTION_TOOLS.has(tool)) return null;

      const recentMsgs = readRecentUserMessages(2);
      if (recentMsgs.length === 0) return null;
      const latest = recentMsgs[0];
      if (!latest.hasImage) return null;

      // 模糊 UI 抱怨關鍵字（不含具體層級線索的詞）
      const AMBIGUOUS_RE = /(跑版|破版|壞了|壞掉|不對勁?|不對|有問題|怪怪的?|錯了|不正常|歪掉|歪了|跑掉|看起來|這樣)/;
      // 排除已具體指明層級的詞（layout/trigger/data/interaction）
      const SPECIFIC_RE = /(顏色|字型|字體|背景|邊框|間距|對齊|位置歪|尺寸|大小不對|疊在一起|沒出現|出不來|跳兩次|重複跳|沒反應|點不到|按不到|送不出去|金額.*?錯|數字.*?錯|資料.*?錯|顯示.*?空白|顯示.*?錯)/;
      if (!AMBIGUOUS_RE.test(latest.text || '')) return null;
      if (SPECIFIC_RE.test(latest.text || '')) return null;

      // 同 user-turn 已提示過 → 跳過
      const lastUserTs = latest.ts || 0;
      const alreadyWarned = history.some(h =>
        h._ambiguousUiWarned && (h.ts || 0) >= lastUserTs
      );
      if (alreadyWarned) return null;

      entry._ambiguousUiWarned = true;
      return `[Ambiguous UI] ⚠️ 偵測到模糊 UI 抱怨 + 附圖，你準備直接用 ${tool} 動手。\n` +
             `  → 截圖只證明「現象出現」，不證明使用者在意的層級。先反問 1 句省繞路。\n` +
             `  → UI 問題的 4 個層級（修法完全不同）：\n` +
             `    (A) layout — 位置/樣式跑版（改 CSS）\n` +
             `    (B) trigger — 不該出現卻出現 / 該出現沒出現（找觸發源）\n` +
             `    (C) data — 顯示資料錯誤（追資料來源）\n` +
             `    (D) interaction — 操作沒反應或反應錯（追事件 + AJAX gate）\n` +
             `  → 建議：先用一句話問使用者在意哪一層，再開動手工具。/bug_trace 步驟 0「分層確認」即為此設計。\n`;
    },
  },
  {
    // Layer 2.88b: Causal Bug Layer Gate — 因果型 bug 抱怨（「為什麼…還是壞」），動手「改」前強制先分層 + 查資料來源
    //   根因（跨 某專案 10 場 retro）：因果抱怨直接進「改 CSS/前端」治標模式，跳過「這是哪一層 + 資料來源查證」
    //   → 同類 bug 反覆犯、修了又犯。把 bug_trace 步驟 0 升級為 hook 級硬擋（只擋「寫入」，不擋調查）。
    //   行為：causal 抱怨後、尚未做任何根因調查就要寫入 → BLOCK；做過調查工具 / 問過使用者 / 已擋過一次 → 放行。
    id: 'causal_bug_layer_gate',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      const WRITE_TOOLS = new Set([
        'Edit', 'Write', 'apply_diff', 'apply_diff_batch',
        'create_file', 'create_file_batch', 'multi_file_inject',
      ]);
      if (!WRITE_TOOLS.has(tool)) return null;

      // 排除「非 code 寫入」：寫 memory / 文件(.md/.txt) 不可能「治標蓋現象」，gate 不該擋。
      //   收集本次寫入的目標路徑；若全部是 memory 目錄或純文件檔 → 放行。
      const a = entry.args || {};
      const targetPaths = [];
      for (const k of ["file_path", "path"]) if (typeof a[k] === "string") targetPaths.push(a[k]);
      if (a.target && typeof a.target.path === "string") targetPaths.push(a.target.path);
      for (const arrKey of ["files", "diffs", "items", "inserts"]) {
        if (Array.isArray(a[arrKey])) for (const it of a[arrKey]) {
          if (typeof it === "string") targetPaths.push(it);
          else if (it && typeof it.path === "string") targetPaths.push(it.path);
          else if (it && typeof it.file_path === "string") targetPaths.push(it.file_path);
        }
      }
      const isDocOrMemory = (p) =>
        /[\\/]memory[\\/]/i.test(p) || /\.claude[\\/]projects[\\/]/i.test(p) || /\.(md|markdown|txt)$/i.test(p);
      if (targetPaths.length > 0 && targetPaths.every(isDocOrMemory)) return null;

      const msgs = readRecentUserMessages(1);
      if (msgs.length === 0) return null;
      const latest = msgs[0];
      const text = latest.text || '';
      const lastUserTs = latest.ts || 0;

      // 因果型 bug 抱怨：「為什麼…還是/沒/又」「明明…怎麼被」「後台設定…還能報價」「還是沒對齊/沒展開」
      const CAUSAL_BUG_RE = /((為什麼|為何|怎麼會?|明明)[\s\S]{0,40}(還是|還在|還能|沒|不對|不該|被轉|被改|又|卻))|((還是|依然|仍然)[\s\S]{0,16}(沒|不對|錯|壞|空白|出不來|沒出現|沒展開|對不上|一樣))|((後台|設定)[\s\S]{0,30}(可以|還能|竟然|居然)[\s\S]{0,12}(報價|顯示|出貨|完成|送出))/;
      if (!CAUSAL_BUG_RE.test(text)) return null;

      // 自使用者抱怨後，是否已做「根因調查」或「反問使用者」→ 放行
      const INVESTIGATION = new Set([
        'find_usages', 'find_dependencies', 'class_method_lookup', 'trace_logic',
        'php_text_search', 'symbol_index', 'execute_sql', 'execute_sql_batch',
        'get_db_schema', 'send_http_request', 'css_computed_winner',
        'css_specificity_check', 'css_inspect', 'js_find_usages', 'js_trace_logic',
        'js_symbol_lookup', 'js_symbol_index', 'css_class_lookup', 'css_find_usages',
        'AskUserQuestion',
      ]);
      const investigatedSince = history.some(h =>
        (h.ts || 0) >= lastUserTs && INVESTIGATION.has(shortName(h.tool))
      );
      if (investigatedSince) return null;

      // 已擋過一次仍要寫 → 放行（避免硬卡死），保留審計
      const blockedBefore = history.some(h => h._causalGateBlocked && (h.ts || 0) >= lastUserTs);
      if (blockedBefore) return null;

      entry._causalGateBlocked = true;
      return {
        block: true,
        message: `[L2.88b Causal Bug Gate] ❌ 偵測到因果型 bug 抱怨（「為什麼…還是/沒/又…」），你準備直接用 ${tool} 改 code，但還沒做根因調查。\n` +
                 `  → 這類「修了又犯／治標不治本」是這個專案 bug 修不乾淨的主因。動手改前先做兩件事：\n` +
                 `    ① 講清楚這是哪一層：layout(版面) / trigger(觸發) / data(資料顯示) / backend(後端根因)。\n` +
                 `    ② 查「資料來源」佐證：execute_sql 看 DB 實際值 / find_usages / class_method_lookup / trace_logic 找輸出與寫入處。\n` +
                 `  → 直接改 CSS 或前端顯示，常只蓋掉現象、根因還在，下次同類再犯。\n` +
                 `  → 做完任一根因調查工具（或先用 AskUserQuestion 問使用者層級）後，同一動作即放行。`,
      };
    },
  },
  {
    // Layer 2.90: write_needs_investigation — 寫 code 前本回合須先有查證動作（讀檔/查DB/查符號/trace/打API），否則視為憑猜冷寫 → BLOCK
    id: 'write_needs_investigation',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      const WRITE_TOOLS = new Set([
        'Edit', 'Write', 'apply_diff', 'apply_diff_batch',
        'create_file', 'create_file_batch', 'multi_file_inject',
      ]);
      if (!WRITE_TOOLS.has(tool)) return null;

      // 收集目標路徑
      const a = entry.args || {};
      const targetPaths = [];
      for (const k of ['file_path', 'path']) if (typeof a[k] === 'string') targetPaths.push(a[k]);
      if (a.target && typeof a.target.path === 'string') targetPaths.push(a.target.path);
      for (const arrKey of ['files', 'diffs', 'items', 'inserts']) {
        if (Array.isArray(a[arrKey])) for (const it of a[arrKey]) {
          if (typeof it === 'string') targetPaths.push(it);
          else if (it && typeof it.path === 'string') targetPaths.push(it.path);
          else if (it && typeof it.file_path === 'string') targetPaths.push(it.file_path);
        }
      }
      if (targetPaths.length === 0) return null;

      // 只管 code 檔；文件/記憶/設定資料/暫存放行
      const isNonCode = (p) =>
        /[\\/]memory[\\/]/i.test(p) || /\.claude[\\/]projects[\\/]/i.test(p) ||
        /\.(md|markdown|txt|json|yml|yaml|env|lock|csv|ini|conf|xml)$/i.test(p);
      const codeTargets = targetPaths.filter(p => !isNonCode(p) &&
        /\.(php|js|jsx|ts|tsx|mjs|cjs|vue|css|scss|sass|less|py|sql|html?|phtml)$/i.test(p));
      if (codeTargets.length === 0) return null;

      // 已明示「來源已核實」旁路 → 放行（留審計）
      const writtenText = [
        a.new_string || '', a.content || '', a.description || '', a.comment || '',
        ...(Array.isArray(a.diffs) ? a.diffs.map(d => (d && (d.replace || d.content)) || '') : []),
      ].join('\n');
      if (/source[-\s]?(verified|traced)|已(?:查證|核實|對照|對齊)\s*(?:來源|sheet|excel|db|code|資料)|mcp-fallback/i.test(writtenText)) return null;

      // 自使用者上一則訊息後，是否做過任一「查證/調查」動作 → 放行
      const INVESTIGATION = new Set([
        'Read', 'read_file', 'read_files_batch', 'read_pdf_file', 'read_word_file', 'read_excel',
        'class_method_lookup', 'symbol_index', 'find_usages', 'find_dependencies', 'find_hierarchy',
        'trace_logic', 'php_text_search',
        'js_symbol_lookup', 'js_symbol_index', 'js_find_usages', 'js_trace_logic',
        'css_class_lookup', 'css_find_usages', 'css_inspect', 'css_computed_winner', 'css_specificity_check',
        'Grep', 'Glob',
        'execute_sql', 'execute_sql_batch', 'get_db_schema', 'get_db_schema_batch', 'schema_diff',
        'trace_gsheet_formula', 'gsheet_xlookup_trace', 'gsheet_fetch_with_state',
        'gsheet_get_values', 'gsheet_fetch_formatted', 'gsheet_get_metadata',
        'trace_excel_logic', 'get_excel_values_batch', 'simulate_excel_change', 'csv_recompute_audit',
        'send_http_request', 'send_http_requests_batch', 'run_php_script', 'run_php_code',
        'browser_interact', 'page_audit', 'AskUserQuestion',
      ]);
      const msgs = readRecentUserMessages(1);
      const lastUserTs = msgs.length ? (msgs[0].ts || 0) : 0;
      const investigated = history.some(h =>
        (h.ts || 0) >= lastUserTs && INVESTIGATION.has(shortName(h.tool))
      );
      if (investigated) return null;

      const hit = path.basename(codeTargets[0]);
      return {
        block: true,
        message: `[L2.90 Write-Needs-Investigation] ❌ 你要寫 code（${hit}），但自使用者上一則訊息後完全沒做過任何查證/調查動作，等於憑記憶冷寫（用猜的）。\n` +
                 `  → 規則：寫任何 code 前先查證它依據的真相源——讀既有檔 / 查 DB / 查符號·依賴 / 查試算表公式 / 打 API 看真實行為。\n` +
                 `  → 「用猜的」蓋出來的 code 是 bug 永遠清不完的根源。做過任一查證動作後同一寫入即放行。\n` +
                 `  → 若此寫入確實無需查證（純樣板/全新獨立檔），在內容或 description 註明「source-verified: <原因>」放行（留審計）。`,
      };
    },
  },
  {
    // Layer 2.89: assumption_in_write — Write/Edit 前 AI input 含假設語句 → BLOCK（不確定先問/查證，不可假設後直接寫）
    id: 'assumption_in_write',
    detect: (entry, history) => {
      const tool = shortName(entry.tool);
      if (!['Write', 'Edit', 'apply_diff', 'create_file'].includes(tool)) return null;

      // 從 entry 取 AI 說明文字（tool_use input 的 description / comment 欄，以及 new_string / content 前幾行）
      const desc = [
        entry.args?.description || '',
        entry.args?.comment || '',
        (entry.args?.new_string || '').slice(0, 300),
        (entry.args?.content || '').slice(0, 300),
      ].join(' ');

      // 假設語句 pattern（中英文）
      const ASSUMPTION_PATTERNS = [
        /我(?:假設|猜測?|推測|猜想|認為應該|覺得應該)/,
        /應該(?:是|為|會|都|就是)(?!.*確認|.*驗證|.*測試)/,
        /(?:猜|估計|大概|可能)(?:是|為|會)/,
        /(?:暫時|先)(?:假設|當作|視為|認為)/,
        /(?:根據|依照).*(?:推測|猜測|猜想)/,
        /(?:i\s+)?assum(?:e|ing|ption)/i,
        /(?:i\s+)?guess(?:ing)?/i,
        /(?:probably|likely|i\s+think)\s+(?:it\s+)?(?:is|should|would)/i,
        /(?:不確定|不清楚|不知道).*(?:先|就|暫時)(?:這樣|如此|照著)/,
      ];

      const hit = ASSUMPTION_PATTERNS.find(p => p.test(desc));
      if (!hit) return null;

      const preview = desc.replace(/\s+/g, ' ').slice(0, 80);

      // 旁路：目標為文件/記憶、或已明示核實 → 不擋
      const a = entry.args || {};
      const tp = [a.file_path, a.path].filter(s => typeof s === 'string');
      const isDocOrMem = (p) => /[\\/]memory[\\/]/i.test(p) || /\.claude[\\/]projects[\\/]/i.test(p) || /\.(md|markdown|txt)$/i.test(p);
      if (tp.length > 0 && tp.every(isDocOrMem)) return null;
      if (/已(?:確認|驗證|核實)|confirmed|verified|mcp-fallback/i.test(desc)) return null;

      return {
        block: true,
        message: `[Assumption Guard] ❌ 偵測到 AI 在 ${tool} 前帶著假設語句就要動手寫 code。\n` +
                 `  → 片段：「${preview}…」\n` +
                 `  → 規則 1（思考優先）：不確定時先問或查證，不要假設後直接寫。「用猜的」蓋出來的 code 就是 bug 清不完的根源。\n` +
                 `  → 先做其一再寫：① AskUserQuestion 問清楚；② 查證來源（execute_sql / class_method_lookup / trace_* / 讀 Sheet/Excel）；③ 確定無誤後把假設語句拿掉再寫。`,
      };
    },
  },
  {
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
      parent_tool_use_id: data.parent_tool_use_id || data.parentToolUseId || null,
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
