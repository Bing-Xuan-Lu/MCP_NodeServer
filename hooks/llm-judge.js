#!/usr/bin/env node
/**
 * PostToolUse Hook — LLM Judge（自我審查觸發器）
 *
 * 在 Claude 完成 Write/Edit 後，依據風險層級注入自我審查提示：
 *   HIGH   → 完整安全 + 架構審查清單
 *   MEDIUM → 邏輯 + 相容性審查
 *   PHP 非測試檔 → 提醒「事故→測試」習慣
 *   PHP 檔案    → docker php -l 語法驗證（靜默失敗不阻斷）
 *   JS/CSS 檔案 → 提醒 bump version（write-guard 未攔截時補一層）
 *
 * 輸入（stdin JSON）：
 *   { session_id, tool_name, tool_input: { file_path, ... }, tool_response: {...} }
 *
 * stdout 內容會被 Claude 看到（注入 context）
 * 靜默失敗：任何錯誤都不影響正常使用
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { HOME } from '../env.js';
const GLOBAL_RISK_TIERS = path.join(HOME, '.claude', 'risk-tiers.json');

function loadRiskTiers() {
  const localPath = path.join(process.cwd(), 'risk-tiers.json');
  if (fs.existsSync(localPath)) {
    try { return JSON.parse(fs.readFileSync(localPath, 'utf-8')); } catch (e) {}
  }
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

function isTestFile(filePath) {
  const n = filePath.toLowerCase();
  return n.includes('test') || n.includes('spec') || n.includes('_test.') || n.includes('.test.');
}

// 將主機路徑轉為 dev-php84 容器內路徑（D:\Project → /var/www/html）
function toContainerPath(hostPath) {
  const normalized = hostPath.replace(/\\/g, '/');
  const m = normalized.match(/^[dD]:\/Project\/(.+)$/);
  return m ? `/var/www/html/${m[1]}` : null;
}

function runPhpLint(filePath) {
  const containerPath = toContainerPath(filePath);
  if (!containerPath) return null; // 非 D:\Project 下，跳過
  try {
    const result = execSync(
      `docker exec dev-php84 php -l "${containerPath}" 2>&1`,
      { timeout: 8000, encoding: 'utf-8' }
    );
    return { ok: result.includes('No syntax errors'), output: result.trim() };
  } catch (e) {
    // exec 非零離開 → e.stdout 有 php -l 訊息
    const out = (e.stdout || e.message || '').trim();
    return { ok: false, output: out };
  }
}

// 從不同工具的 tool_input 萃取所有受影響的檔案路徑
function extractAffectedFiles(toolName, toolInput) {
  if (!toolInput) return [];
  const files = [];
  // Write / Edit
  if (toolInput.file_path) files.push(toolInput.file_path);
  // apply_diff (MCP: path)
  if (toolInput.path && typeof toolInput.path === 'string') files.push(toolInput.path);
  // apply_diff_batch (MCP: diffs[].path)
  if (Array.isArray(toolInput.diffs)) {
    for (const d of toolInput.diffs) if (d?.path) files.push(d.path);
  }
  // create_file_batch (MCP: files[].path)
  if (Array.isArray(toolInput.files)) {
    for (const f of toolInput.files) if (f?.path) files.push(f.path);
  }
  return [...new Set(files)];
}

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || '';
    const affected = extractAffectedFiles(toolName, data.tool_input);
    const filePath = data.tool_input?.file_path || affected[0] || '';
    if (!filePath) { process.exit(0); }

    const tiers = loadRiskTiers();
    const isHigh   = matchTier(filePath, tiers.high);
    const isMedium = !isHigh && matchTier(filePath, tiers.medium);
    const ext      = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath);

    const messages = [];

    if (isHigh) {
      messages.push(
        `[LLM Judge] 🔴 高風險檔案已修改：${basename}\n` +
        `請立即自我審查以下項目（不需回覆，內部確認即可）：\n` +
        `  □ 有沒有 hardcode 密碼、API Key 或憑證？\n` +
        `  □ SQL 查詢有沒有 injection 風險（未使用 prepared statement）？\n` +
        `  □ DB migration / schema 變更是否可回溯（有 down 方法 / 備份計畫）？\n` +
        `  □ 這個變更是否影響其他模組（side effect）？\n` +
        `  □ 是否需要更新文件或設定範本（.env.example）？`
      );
    } else if (isMedium) {
      messages.push(
        `[LLM Judge] 🟡 中風險檔案已修改：${basename}\n` +
        `請確認：\n` +
        `  □ 輸入驗證是否完整（型別、長度、格式）？\n` +
        `  □ API 介面是否向後相容（既有呼叫方不受影響）？\n` +
        `  □ 是否需要寫或更新測試案例？`
      );
    }

    // PHP 非測試檔 → 「事故→測試」提醒 + docker php -l 語法驗證（批次涵蓋所有受影響 .php）
    const phpFiles = affected.filter(p => p.toLowerCase().endsWith('.php') && !isTestFile(p));
    if (ext === '.php' && !isTestFile(filePath) && !isHigh) {
      messages.push(
        `[LLM Judge] 💡 ${basename} 已修改 — 若此改動修復了 bug，記得同步新增測試案例（事故→測試習慣）`
      );
    }
    let phpLintFailed = false;
    let phpLintErrorMsg = '';
    if (phpFiles.length > 0) {
      const lintResults = phpFiles.map(p => ({ p, r: runPhpLint(p) })).filter(x => x.r !== null);
      const failed = lintResults.filter(x => !x.r.ok);
      const passed = lintResults.filter(x => x.r.ok);
      if (failed.length > 0) {
        phpLintFailed = true;
        phpLintErrorMsg =
          `[PHP Lint Gate] ❌ BLOCKED：PHP 語法錯誤（${failed.length}/${lintResults.length} 檔）：\n` +
          failed.map(x => {
            const lines = x.r.output.split('\n').filter(l => l.trim());
            const errLine = lines.find(l => /Parse error|syntax error/i.test(l)) || lines.slice(-1)[0] || '';
            return `  • ${path.basename(x.p)}: ${errLine.trim()}`;
          }).join('\n') +
          `\n⚠️ 壞檔已寫入磁碟，禁止繼續其他操作（特別是 sftp_upload）。\n` +
          `→ 立即修復語法錯誤後再進行下一步，否則上傳到測試機會直接 500。\n` +
          `→ 常見坑：逗號 regex 誤切函式參數列、孤兒 } / endif / $var、apply_diff 多 block 邊界錯誤。\n`;
        messages.push(phpLintErrorMsg);
      } else if (passed.length > 0) {
        messages.push(`[LLM Judge] ✅ PHP 語法驗證通過（${passed.length} 檔）`);
      }
    }

    // JS / CSS 修改 → 提醒 bump version
    if (['.js', '.css'].includes(ext) && !isTestFile(filePath)) {
      messages.push(
        `[LLM Judge] 🔢 ${basename} 已修改 — 記得確認是否需要 bump version（避免瀏覽器 cache 舊版）`
      );
    }

    if (messages.length > 0) {
      // PHP lint 失敗 → 寫到 stderr + exit 2 阻擋後續操作（PostToolUse 規約）
      if (phpLintFailed) {
        process.stderr.write(messages.join('\n\n') + '\n');
        process.exit(2);
      }
      process.stdout.write(messages.join('\n\n') + '\n');
    }

    process.exit(0);
  } catch (e) {
    process.stderr.write(`[llm-judge] error: ${e.message}\n`);
    process.exit(0);
  }
});
