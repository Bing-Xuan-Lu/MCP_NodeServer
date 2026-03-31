#!/usr/bin/env node
/**
 * PostToolUse Hook — LLM Judge（自我審查觸發器）
 *
 * 在 Claude 完成 Write/Edit 後，依據風險層級注入自我審查提示：
 *   HIGH   → 完整安全 + 架構審查清單
 *   MEDIUM → 邏輯 + 相容性審查
 *   PHP 非測試檔 → 提醒「事故→測試」習慣
 *
 * 輸入（stdin JSON）：
 *   { session_id, tool_name, tool_input: { file_path, ... }, tool_response: {...} }
 *
 * stdout 內容會被 Claude 看到（注入 context）
 * 靜默失敗：任何錯誤都不影響正常使用
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || process.env.USERPROFILE;
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

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const filePath = data.tool_input?.file_path || '';
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

    // PHP 非測試檔 → 「事故→測試」提醒
    if (ext === '.php' && !isTestFile(filePath) && !isHigh) {
      messages.push(
        `[LLM Judge] 💡 ${basename} 已修改 — 若此改動修復了 bug，記得同步新增測試案例（事故→測試習慣）`
      );
    }

    if (messages.length > 0) {
      process.stdout.write(messages.join('\n\n') + '\n');
    }

    process.exit(0);
  } catch (e) {
    process.exit(0);
  }
});
