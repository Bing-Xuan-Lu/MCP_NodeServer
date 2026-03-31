#!/usr/bin/env node
/**
 * PreToolUse Hook — Write Guard（敏感檔案寫入警告 + 風險層級警告）
 *
 * 依據 risk-tiers.json 分級輸出警告：
 *   HIGH  → 🔴 強警告（列出具體風險）
 *   MEDIUM → 🟡 提醒
 *   敏感模式 → ⚠️ 警告（.env / key / secret 等）
 *
 * 非阻擋式：只輸出提醒，不取消操作（exit 0）。
 * 觸發條件：工具名稱為 Write 或 Edit 時
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || process.env.USERPROFILE;
const GLOBAL_RISK_TIERS = path.join(HOME, '.claude', 'risk-tiers.json');

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

    process.exit(0);
  } catch (e) {
    process.exit(0);
  }
});
