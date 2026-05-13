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
import { HOME } from '../env.js';
const GLOBAL_RISK_TIERS = path.join(HOME, '.claude', 'risk-tiers.json');

// ── 方案 A+B 設定 ────────────────────────────────────────
const BATCH_LIMIT = 15; // 超過 N 個不同檔案 → 阻擋（一輪對話實務上會動 8-12 檔，5 太低）
const STATE_DIR = path.join(os.tmpdir(), 'claude-write-guard');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

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
  /MCP_NodeServer\//i,
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
    const state = loadState();
    if (state.promptGuardActive) {
      const msg =
        `[Write Guard] ❌ 所有寫入工具（Edit / Write / apply_diff / create_file / multi_file_inject）同步被擋。\n` +
        `  原因：Prompt Guard 偵測到任務描述不完整，避免 Claude 在資訊不全時動手寫程式。\n` +
        `  → 唯一正解：先用「純文字」回覆使用者確認需求方向，等使用者明確回應後再修改。\n` +
        `  → 不要繞道嘗試其他寫入工具（apply_diff / create_file 等）— 它們同樣被擋。\n` +
        `  → 此擋線同 session 內 prompt 處理完後自動解除（約 2 分鐘 TTL）。\n`;
      // exit 2 時 Claude Code 讀的是 stderr；同步寫 stdout 讓使用者也看得到
      process.stderr.write(msg);
      process.stdout.write(msg);
      process.exit(2);
    }

    // ── 方案 B：批次編輯限制 ────────────────────────────
    const normalizedFile = filePath.toLowerCase();
    if (!state.files.includes(normalizedFile)) {
      state.files.push(normalizedFile);
    }
    if (state.files.length > BATCH_LIMIT && !state.batchAcked) {
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
