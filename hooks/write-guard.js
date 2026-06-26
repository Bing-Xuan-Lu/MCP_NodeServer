#!/usr/bin/env node
/**
 * PreToolUse Hook — Write Guard（敏感檔案寫入警告 + 風險層級警告 + 批次限制 + Prompt Guard 連動）
 *
 * 依據 risk-tiers.json 分級輸出警告：
 *   HIGH  → 🔴 強警告（列出具體風險）
 *   MEDIUM → 🟡 提醒
 *   敏感模式 → ⚠️ 警告（.env / key / secret 等）
 *
 * 方案 A — Prompt Guard 連動：
 *   若 Prompt Guard 發出「請先詢問使用者」提醒，在使用者下一次發話前
 *   阻擋所有 Edit/Write（exit 2 = BLOCK）
 *
 * 方案 B — 批次編輯限制：
 *   單一 session 連續 Edit/Write 超過 BATCH_LIMIT 個不同檔案時，阻擋並要求確認
 *
 * 觸發條件：工具名稱為 Write 或 Edit 時
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { HOME, MCP_ROOT } from '../env.js';

// 把 MCP_ROOT 變成可比對的 regex 片段（吃掉路徑分隔符差異）
const MCP_ROOT_RE = new RegExp(
  MCP_ROOT.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '[\\\\/]'),
  'i'
);
const GLOBAL_RISK_TIERS = path.join(HOME, '.claude', 'risk-tiers.json');

// ── 方案 A+B 設定 ────────────────────────────────────────
const BATCH_LIMIT = 15; // 超過 N 個不同檔案 → 阻擋（一輪對話實務上會動 8-12 檔，5 太低）
const STATE_DIR = path.join(os.tmpdir(), 'claude-write-guard');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

// ── 診斷腳本豁免：_harness/ 下檔案 + 對話內已有 trace/diff 證據 ──
// 用途：當使用者已要求調查、Claude 已跑完 trace_excel_logic / analyze_csv / case_diff* 等
// 蒐證工具，後續寫 _harness/probe_*.php 應放行（不應被 Prompt Guard 連動擋）
const HARNESS_PATH_RE = /[\\/]_harness[\\/]|[\\/]\.harness[\\/]/i;
const EVIDENCE_TOOLS = [
  'trace_excel_logic', 'trace_gsheet_formula', 'gsheet_xlookup_trace',
  'analyze_csv', 'case_diff_full', 'case_diff_categorical',
  'execute_sql', 'execute_sql_batch',
  'gsheet_fetch_with_state', 'gsheet_fetch_formatted',
  'run_php_script', 'run_php_code',
  'symbol_index', 'find_usages', 'trace_logic', 'class_method_lookup',
  'js_symbol_lookup', 'js_find_usages', 'js_trace_logic',
];
const AUDIT_LOG = path.join(HOME, '.claude', 'logs', 'mcp_audit.log');
const EVIDENCE_WINDOW_MS = 30 * 60 * 1000; // 最近 30 分鐘

function hasRecentEvidence() {
  try {
    if (!fs.existsSync(AUDIT_LOG)) return null;
    // 讀末尾 64KB 即可（log append-only，最近紀錄在尾端）
    const stat = fs.statSync(AUDIT_LOG);
    const readBytes = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(AUDIT_LOG, 'r');
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
    fs.closeSync(fd);
    const text = buf.toString('utf-8');
    const cutoff = Date.now() - EVIDENCE_WINDOW_MS;
    // log 格式: [ISO] toolName | args | status
    for (const line of text.split('\n')) {
      const m = line.match(/^\[([^\]]+)\]\s+(\S+)\s+\|/);
      if (!m) continue;
      const ts = Date.parse(m[1]);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      if (EVIDENCE_TOOLS.includes(m[2])) {
        return { tool: m[2], at: m[1] };
      }
    }
  } catch (e) {}
  return null;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      const age = Date.now() - (raw.ts || 0);
      // 超過 30 分鐘自動重置（避免跨 session 殘留）
      if (age > 30 * 60 * 1000) return freshState();
      // promptGuardActive 短 TTL：超過 2 分鐘自動解除（避免 stuck state）
      if (raw.promptGuardActive && age > 2 * 60 * 1000) {
        raw.promptGuardActive = false;
      }
      return raw;
    }
  } catch (e) {}
  return freshState();
}

function freshState() {
  return { ts: Date.now(), files: [], promptGuardActive: false, batchAcked: false };
}

function saveState(state) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    state.ts = Date.now();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {}
}

// 注意：user-prompt-guard.js 透過直接讀寫 STATE_FILE 來設定
// promptGuardActive 和重置 batch，不透過 import 本檔。

// ── 載入風險分級設定 ──────────────────────────────────────
function loadRiskTiers() {
  // 1. CWD 本地 override
  const localPath = path.join(process.cwd(), 'risk-tiers.json');
  if (fs.existsSync(localPath)) {
    try { return JSON.parse(fs.readFileSync(localPath, 'utf-8')); } catch (e) {}
  }
  // 2. 全域預設
  if (fs.existsSync(GLOBAL_RISK_TIERS)) {
    try { return JSON.parse(fs.readFileSync(GLOBAL_RISK_TIERS, 'utf-8')); } catch (e) {}
  }
  return { high: [], medium: [] };
}

function matchTier(filePath, patterns) {
  if (!patterns?.length) return false;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return patterns.some(pattern => {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) return normalized.endsWith(p.slice(1));
    if (p.endsWith('/'))    return normalized.includes('/' + p.slice(0, -1) + '/') || normalized.includes('/' + p);
    return normalized.includes(p);
  });
}

// ── 敏感檔案模式（不分層級，直接警告）────────────────────
const PROTECTED_PATTERNS = [
  { pattern: /\.env$/, reason: '可能含有 API Key 或密碼，推送到 GitHub 會外洩' },
  { pattern: /credentials/i, reason: '檔名含 credentials，可能儲存帳號憑證' },
  { pattern: /\.secret/i, reason: '檔名含 secret，可能含有敏感資料' },
  { pattern: /password/i, reason: '檔名含 password' },
  { pattern: /private[_\-.]key/i, reason: '可能是私鑰檔案' },
  { pattern: /id_rsa$|id_ed25519$/i, reason: 'SSH 私鑰檔案' },
];

const WARN_PATTERNS = [
  { pattern: /^README\.md$/i, msg: '是否真的需要建立 README.md？' },
  { pattern: /^CHANGELOG\.md$/i, msg: '是否真的需要建立 CHANGELOG.md？' },
];

const CACHE_BUST_EXTENSIONS = ['.js', '.css'];

// 允許的路徑（不警告）
const ALLOWED_PATH_PATTERNS = [
  /\.claude\/commands\//i,
  /\.claude\/hooks\//i,
  MCP_ROOT_RE,
];

// ── Prompt Injection 偵測（HTML / PHP 模板）────────────────
const INJECTION_PATTERNS = [
  /ignore previous instructions/i,
  /ignore all instructions/i,
  /you are now/i,
  /<\|im_start\|>/i,
  /\[INST\]/i,
];
const INJECTION_EXTENSIONS = ['.html', '.htm', '.php', '.twig', '.blade.php'];

function checkPromptInjection(filePath, content) {
  if (!content) return null;
  const ext = path.extname(filePath).toLowerCase();
  if (!INJECTION_EXTENSIONS.some(e => filePath.toLowerCase().endsWith(e))) return null;
  const found = INJECTION_PATTERNS.find(p => p.test(content));
  return found ? `疑似 Prompt Injection 語句（pattern: ${found}）` : null;
}

// ─────────────────────────────────────────────────────────
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const filePath = (data.tool_input?.file_path || '').replace(/\\/g, '/');
    const filename = path.basename(filePath);
    const normalizedPath = filePath.toLowerCase();

    const isAllowed = ALLOWED_PATH_PATTERNS.some(p => p.test(normalizedPath));
    if (isAllowed) { process.exit(0); }

    // ── Meta-dev 自我豁免 ─────────────────────────────────
    // 寫入目標位於 MCP_Server 自身（改 hook / Skill / 工具本身）時：
    //   - 跳過 Prompt Guard 連動阻擋
    //   - 跳過批次編輯上限
    // 仍保留風險警告、敏感檔案警告、Prompt Injection 偵測（這些是純資訊性提醒）。
    // 理由：本 hook 是用來保護下游客戶專案的，meta-dev MCP 本身時這些 BLOCK 反成阻礙。
    const isMetaDev = MCP_ROOT_RE.test(filePath);

    const tiers = loadRiskTiers();
    const isHigh   = matchTier(filePath, tiers.high);
    const isMedium = !isHigh && matchTier(filePath, tiers.medium);

    // ── 風險層級警告 ─────────────────────────────────────
    if (isHigh) {
      process.stdout.write(
        `[Write Guard] 🔴 高風險路徑：${filename}\n` +
        `  ▸ 此路徑屬於 HIGH 風險層級（DB / 設定 / 遷移）\n` +
        `  ▸ 請確認：沒有 hardcode 憑證、SQL 無 injection 風險、migration 已可回溯\n`
      );
    } else if (isMedium) {
      process.stdout.write(
        `[Write Guard] 🟡 中風險路徑：${filename}\n` +
        `  ▸ 此路徑屬於 MEDIUM 風險層級（Model / Controller / API）\n` +
        `  ▸ 請確認：輸入驗證完整、API 介面相容性未被破壞\n`
      );
    }

    // ── 敏感檔案警告 ─────────────────────────────────────
    for (const { pattern, reason } of PROTECTED_PATTERNS) {
      if (pattern.test(filename)) {
        process.stdout.write(`[Write Guard] ⚠️  正在寫入 ${filename} — ${reason}\n`);
      }
    }

    // ── 不必要檔案提醒 ───────────────────────────────────
    for (const { pattern, msg } of WARN_PATTERNS) {
      if (pattern.test(filename)) {
        process.stdout.write(`[Write Guard] 💡 ${msg}\n`);
      }
    }

    // ── JS/CSS 修改 → 提醒 bump version ─────────────────
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    if (CACHE_BUST_EXTENSIONS.includes(ext)) {
      process.stdout.write(
        `[Write Guard] 💡 ${filename} modified — remember to bump ?v= in the PHP/HTML file that references it (browser cache)\n`
      );
    }

    // ── Prompt Injection 偵測 ────────────────────────────
    const content = data.tool_input?.new_string || data.tool_input?.content || '';
    const injectionWarning = checkPromptInjection(filePath, content);
    if (injectionWarning) {
      process.stdout.write(`[Write Guard] 🚨 ${injectionWarning} — 請確認此內容是否安全\n`);
    }

    // ── 方案 A：Prompt Guard 連動阻擋 ───────────────────
    // 例外：背景 sub-agent 寫檔不受 promptGuardActive 影響
    //   理由：Prompt Guard 是保護「使用者—主 Claude」對齊；sub-agent 由主 Claude 派遣時已附完整任務 prompt，
    //   不該被使用者層級的 guard 連帶擋住（過去出包：兩個 background agent 收完整 5 段 prompt 仍被擋）。
    const isSubAgent = !!(data.parent_tool_use_id || data.parentToolUseId);
    const state = loadState();

    // 例外：_harness/ 診斷腳本 + 最近 30 分鐘有 trace/diff/CSV 等蒐證工具紀錄
    //   理由：使用者已下達調查指令，Claude 已跑完蒐證鏈（trace_excel_logic / analyze_csv / case_diff*），
    //   後續寫 _harness/probe_*.php 屬於「驗證假設」的合理下一步，不該被 Prompt Guard 連帶擋
    //   過去出包：trace 完公式 + 7 筆 local 訂單對照都有了，仍因 Prompt Guard 餘溫擋寫 probe.php
    let harnessExempt = null;
    if (state.promptGuardActive && !isSubAgent && HARNESS_PATH_RE.test(filePath)) {
      const evidence = hasRecentEvidence();
      if (evidence) {
        harnessExempt = evidence;
        process.stdout.write(
          `[Write Guard] 🔓 _harness/ 診斷腳本豁免 — 偵測到最近蒐證紀錄：` +
          `${evidence.tool} @ ${evidence.at}\n` +
          `  → Prompt Guard 仍 active 但本檔放行（已具備分析證據鏈）\n`
        );
      }
    }

    // 例外：文件/筆記類寫入（.md/.txt 等非程式碼）不受 promptGuardActive 阻擋。
    // promptGuard 防的是「需求不明就冷寫 code」；寫分析/說明/筆記文件是釐清需求的一部分，不該擋。
    const isDocFile = /\.(md|markdown|mdx|txt|rst|adoc)$/i.test(filePath);

    if (state.promptGuardActive && !isSubAgent && !harnessExempt && !isMetaDev && !isDocFile) {
      const reasonLine = state.promptGuardReason
        ? `  判斷依據：${state.promptGuardReason}\n`
        : '';
      const msg =
        `[Write Guard] ❌ 所有寫入工具（Edit / Write / apply_diff / create_file / multi_file_inject）同步被擋。\n` +
        `  原因：Prompt Guard 偵測到任務描述不完整，避免 Claude 在資訊不全時動手寫程式。\n` +
        reasonLine +
        `  → 唯一正解：先用「純文字」回覆使用者確認需求方向，等使用者明確回應後再修改。\n` +
        `  → 不要繞道嘗試其他寫入工具（apply_diff / create_file 等）— 它們同樣被擋。\n` +
        `  → 此擋線同 session 內 prompt 處理完後自動解除（約 2 分鐘 TTL）。\n`;
      // exit 2 時 Claude Code 讀的是 stderr；同步寫 stdout 讓使用者也看得到
      process.stderr.write(msg);
      process.stdout.write(msg);
      process.exit(2);
    }

    // 印 Meta-dev 豁免訊息（若實際豁免了某個會 BLOCK 的條件）
    if (isMetaDev && state.promptGuardActive && !isSubAgent && !harnessExempt) {
      process.stdout.write(
        '[Write Guard] 🔓 MCP_Server meta-dev 豁免 — Prompt Guard active 但本檔放行（改 hook/Skill/工具本身）\n'
      );
    }

    // ── 方案 B：批次編輯限制 ────────────────────────────
    const normalizedFile = filePath.toLowerCase();
    if (!state.files.includes(normalizedFile)) {
      state.files.push(normalizedFile);
    }
    if (state.files.length > BATCH_LIMIT && !state.batchAcked && !isMetaDev) {
      // 擋第一次 → 標記 batchAcked，下次放行（警告已送達使用者）
      state.batchAcked = true;
      saveState(state);
      const msg =
        `[Write Guard] ❌ BLOCKED：已連續修改 ${state.files.length} 個不同檔案（上限 ${BATCH_LIMIT}）。\n` +
        `  → 請先暫停，向使用者確認是否要繼續批次修改。\n` +
        `  → 已自動 ack；若使用者確認繼續，下一次修改會放行。否則請停下。\n`;
      process.stderr.write(msg);
      process.stdout.write(msg);
      process.exit(2);
    }
    saveState(state);

    process.exit(0);
  } catch (e) {
    process.stderr.write(`[write-guard] error: ${e.message}\n`);
    process.exit(0);
  }
});
