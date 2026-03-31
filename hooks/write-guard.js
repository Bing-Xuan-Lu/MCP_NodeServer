#!/usr/bin/env node
/**
 * PreToolUse Hook — Write Guard（敏感檔案寫入警告）
 *
 * 在 Claude 寫入敏感檔案前發出警告訊息。
 * 非阻擋式：只輸出提醒，不取消操作（exit 0）。
 *
 * 觸發條件：工具名稱為 Write 或 Edit 時
 */

import path from 'path';

// 敏感檔案模式（發出警告但不阻擋）
const PROTECTED_PATTERNS = [
  { pattern: /\.env$/, reason: '可能含有 API Key 或密碼，推送到 GitHub 會外洩' },
  { pattern: /credentials/i, reason: '檔名含 credentials，可能儲存帳號憑證' },
  { pattern: /\.secret/i, reason: '檔名含 secret，可能含有敏感資料' },
  { pattern: /password/i, reason: '檔名含 password' },
  { pattern: /private[_\-.]key/i, reason: '可能是私鑰檔案' },
  { pattern: /id_rsa$|id_ed25519$/i, reason: 'SSH 私鑰檔案' },
];

// 不必要的檔案（提醒但不阻擋）
const WARN_PATTERNS = [
  { pattern: /^README\.md$/i, msg: '是否真的需要建立 README.md？' },
  { pattern: /^CHANGELOG\.md$/i, msg: '是否真的需要建立 CHANGELOG.md？' },
];

// JS/CSS 檔案修改 → 提醒 bump version（避免瀏覽器快取舊版）
const CACHE_BUST_EXTENSIONS = ['.js', '.css'];

// 允許的路徑（不警告）
const ALLOWED_PATH_PATTERNS = [
  /\.claude\/commands\//i,
  /\.claude\/hooks\//i,
  /MCP_NodeServer\//i,
];

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

    // 敏感檔案警告
    for (const { pattern, reason } of PROTECTED_PATTERNS) {
      if (pattern.test(filename)) {
        process.stdout.write(`[Write Guard] ⚠️ 正在寫入 ${filename} — ${reason}\n`);
      }
    }

    // 不必要檔案提醒
    for (const { pattern, msg } of WARN_PATTERNS) {
      if (pattern.test(filename)) {
        process.stdout.write(`[Write Guard] 💡 ${msg}\n`);
      }
    }

    // JS/CSS 修改 → 提醒 bump version
    const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
    if (CACHE_BUST_EXTENSIONS.includes(ext)) {
      process.stdout.write(
        `[Write Guard] 💡 ${filename} modified — remember to bump ?v= in the PHP/HTML file that references it (browser cache)\n`
      );
    }

    process.exit(0); // 允許繼續
  } catch (e) {
    process.exit(0);
  }
});
