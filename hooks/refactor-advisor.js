#!/usr/bin/env node
/**
 * PreToolUse Hook — Refactor Advisor（PHP 程式碼品質偵測）
 *
 * 當 Claude 準備修改 PHP 檔案時，快速掃描目標檔案的結構品質：
 *   1. 檔案過大（行數門檻）
 *   2. 單一檔案函式/方法過多（SRP 違反）
 *   3. 單一函式/方法過長
 *   4. God Class（單一 class 方法過多）
 *   5. 深層巢狀（過度縮排）
 *   6. 混合職責（SQL + HTML 同檔）
 *   7. 散落的 inline SQL
 *   8. 單行重複硬編碼
 *   9. Inline CSS 過多
 *  10. Clean Code：單字母變數名
 *  11. Clean Code：函式參數過多
 *  12. Clean Code：魔術數字
 *  13. 雙狀態 SESSION 分支提醒（登入/未登入兩條 SQL 路徑同步維護）
 *
 * 偵測到問題時注入提醒，要求 Claude 先評估重構再動手修改。
 * 非阻擋式（exit 0），僅輸出建議。
 *
 * 排除：vendor/、node_modules/、packages/ 等第三方目錄
 *
 * 觸發：Edit | Write | apply_diff | apply_diff_batch
 */

import fs from 'fs';
import path from 'path';

// ── 設定 ──────────────────────────────────────────
const THRESHOLDS = {
  fileLines: 400,           // 檔案超過此行數觸發大檔案警告
  fileLinesHard: 800,       // 超過此行數 = 強烈建議重構
  maxFunctions: 15,         // 單檔函式/方法數上限（SRP）
  maxFunctionLength: 80,    // 單一函式/方法行數上限
  maxNestingDepth: 5,       // 最大巢狀深度
  maxClassMethods: 20,      // 單一 class 方法數上限（God Class）
  duplicateMinLines: 5,     // 重複區塊最小行數
  duplicateThreshold: 3,    // 相同區塊出現 N 次以上視為重複
};

// 排除的第三方 / 非專案目錄
const EXCLUDED_DIRS = [
  'vendor', 'node_modules', 'packages', 'libs', 'lib',
  '.git', 'bin', 'obj', 'cache', 'storage',
  'public/assets', 'public/vendor',
];

// ── 工具函式 ──────────────────────────────────────

/** 從 tool input 取得檔案路徑 */
function extractFilePath(toolName, toolInput) {
  if (!toolInput) return null;

  // Edit / Write
  if (toolInput.file_path) return toolInput.file_path;
  // apply_diff
  if (toolInput.path) return toolInput.path;
  // apply_diff_batch — 取所有 diff 的 path
  if (toolInput.diffs && Array.isArray(toolInput.diffs)) {
    return toolInput.diffs.map(d => d.path).filter(Boolean);
  }
  return null;
}

/** 判斷路徑是否在排除目錄中 */
function isExcluded(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return EXCLUDED_DIRS.some(dir => {
    const d = dir.toLowerCase();
    return normalized.includes('/' + d + '/') || normalized.includes('\\' + d + '\\');
  });
}

/** 判斷是否為 PHP 檔案 */
function isPHP(filePath) {
  return /\.php$/i.test(filePath);
}

/** 將 MCP basePath 相對路徑轉為絕對路徑（嘗試常見 basePath） */
function resolveToAbsolute(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  const basePaths = ['D:\\Project\\', 'D:/Project/'];
  for (const base of basePaths) {
    const full = path.join(base, filePath);
    if (fs.existsSync(full)) return full;
  }
  return filePath;
}

// ── 分析器 ──────────────────────────────────────

function analyzePhpFile(filePath) {
  const absolutePath = resolveToAbsolute(filePath);

  let content;
  try {
    content = fs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const smells = [];

  // ── 1. 檔案大小 ──
  if (totalLines > THRESHOLDS.fileLinesHard) {
    smells.push({
      severity: 'high',
      type: 'file_too_large',
      message: '\u6A94\u6848 ' + totalLines + ' \u884C\uFF08\u56B4\u91CD\u8D85\u6A19\uFF0C\u9580\u6ABB ' + THRESHOLDS.fileLinesHard + '\uFF09\uFF0C\u5F37\u70C8\u5EFA\u8B70\u62C6\u5206',
    });
  } else if (totalLines > THRESHOLDS.fileLines) {
    smells.push({
      severity: 'medium',
      type: 'file_large',
      message: '\u6A94\u6848 ' + totalLines + ' \u884C\uFF08\u8D85\u904E ' + THRESHOLDS.fileLines + ' \u884C\u9580\u6ABB\uFF09\uFF0C\u8003\u616E\u62C6\u5206\u8077\u8CAC',
    });
  }

  // ── 2. 函式/方法計數 + 長度分析 ──
  const funcPattern = /^\s*(?:public\s+|protected\s+|private\s+|static\s+)*function\s+(\w+)\s*\(/;
  const classPattern = /^\s*(?:abstract\s+|final\s+)*class\s+(\w+)/;

  const functions = [];
  const classes = [];
  let currentFunc = null;
  let braceDepth = 0;
  let funcBraceStart = 0;
  let currentClass = null;
  let classBraceDepth = 0;
  let classBraceStart = 0;
  let maxNesting = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const classMatch = line.match(classPattern);
    if (classMatch && !currentClass) {
      currentClass = { name: classMatch[1], startLine: i + 1, methodCount: 0 };
      classBraceDepth = 0;
      classBraceStart = -1;
    }

    const funcMatch = line.match(funcPattern);
    if (funcMatch) {
      currentFunc = { name: funcMatch[1], startLine: i + 1, endLine: null, length: 0 };
      braceDepth = 0;
      funcBraceStart = -1;
      if (currentClass) currentClass.methodCount++;
    }

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (currentFunc) {
      if (funcBraceStart === -1 && opens > 0) funcBraceStart = i;
      braceDepth += opens - closes;

      if (braceDepth > maxNesting) maxNesting = braceDepth;

      if (funcBraceStart !== -1 && braceDepth <= 0) {
        currentFunc.endLine = i + 1;
        currentFunc.length = currentFunc.endLine - currentFunc.startLine + 1;
        functions.push(currentFunc);
        currentFunc = null;
      }
    }

    if (currentClass) {
      if (classBraceStart === -1 && opens > 0) classBraceStart = i;
      classBraceDepth += opens - closes;

      if (classBraceStart !== -1 && classBraceDepth <= 0) {
        classes.push(currentClass);
        currentClass = null;
      }
    }
  }

  if (currentFunc) {
    currentFunc.endLine = lines.length;
    currentFunc.length = currentFunc.endLine - currentFunc.startLine + 1;
    functions.push(currentFunc);
  }
  if (currentClass) classes.push(currentClass);

  // 函式數量過多（SRP）
  if (functions.length > THRESHOLDS.maxFunctions) {
    smells.push({
      severity: 'high',
      type: 'srp_violation',
      message: '\u55AE\u6A94 ' + functions.length + ' \u500B\u51FD\u5F0F/\u65B9\u6CD5\uFF08\u4E0A\u9650 ' + THRESHOLDS.maxFunctions + '\uFF09\uFF0C\u9055\u53CD\u55AE\u4E00\u8077\u8CAC\u539F\u5247\uFF0C\u61C9\u62C6\u5206\u70BA\u591A\u500B class \u6216 include',
    });
  }

  // 過長的函式
  const longFuncs = functions.filter(f => f.length > THRESHOLDS.maxFunctionLength);
  if (longFuncs.length > 0) {
    const details = longFuncs
      .sort((a, b) => b.length - a.length)
      .slice(0, 5)
      .map(f => f.name + '() ' + f.length + '\u884C (L' + f.startLine + ')')
      .join(', ');
    smells.push({
      severity: 'medium',
      type: 'long_function',
      message: '\u904E\u9577\u51FD\u5F0F\uFF1A' + details + '\uFF08\u4E0A\u9650 ' + THRESHOLDS.maxFunctionLength + ' \u884C\uFF09\uFF0C\u61C9\u62BD\u51FA\u5B50\u51FD\u5F0F',
    });
  }

  // ── 3. God Class ──
  const godClasses = classes.filter(c => c.methodCount > THRESHOLDS.maxClassMethods);
  if (godClasses.length > 0) {
    const details = godClasses.map(c => c.name + '(' + c.methodCount + ' \u65B9\u6CD5)').join(', ');
    smells.push({
      severity: 'high',
      type: 'god_class',
      message: 'God Class\uFF1A' + details + '\uFF08\u4E0A\u9650 ' + THRESHOLDS.maxClassMethods + ' \u65B9\u6CD5\uFF09\uFF0C\u61C9\u4F9D\u8077\u8CAC\u62C6\u5206',
    });
  }

  // ── 4. 深層巢狀 ──
  if (maxNesting > THRESHOLDS.maxNestingDepth) {
    smells.push({
      severity: 'medium',
      type: 'deep_nesting',
      message: '\u6700\u6DF1\u5DE2\u72C0 ' + maxNesting + ' \u5C64\uFF08\u4E0A\u9650 ' + THRESHOLDS.maxNestingDepth + '\uFF09\uFF0C\u7528 early return / guard clause \u964D\u4F4E\u8907\u96DC\u5EA6',
    });
  }

  // ── 5. 混合職責（SQL + HTML 同檔）──
  const hasSQL = /\b(SELECT|INSERT|UPDATE|DELETE)\s+.*(FROM|INTO|SET)\b/i.test(content);
  const hasHTML = /<\s*(html|div|table|form|input|button|span|td|tr|th)\b/i.test(content);
  const hasDirectEcho = /echo\s+['"]<\s*(div|table|form|tr|td|p|h[1-6])\b/i.test(content);

  if (hasSQL && (hasHTML || hasDirectEcho)) {
    smells.push({
      severity: 'high',
      type: 'mixed_concerns',
      message: 'SQL \u67E5\u8A62\u8207 HTML \u8F38\u51FA\u6DF7\u5728\u540C\u4E00\u6A94\u6848\uFF0C\u9055\u53CD MVC \u5206\u96E2\u539F\u5247\uFF0C\u61C9\u62C6\u5206\u70BA Model + View',
    });
  }

  // ── 6. 重複程式碼偵測（連續行 hash 比對）──
  const duplicates = findDuplicateBlocks(lines);
  if (duplicates.length > 0) {
    const totalDupGroups = duplicates.length;
    const totalDupOccurrences = duplicates.reduce((sum, d) => sum + d.count, 0);
    const details = duplicates
      .slice(0, 3)
      .map(d => {
        const locs = d.locations.slice(0, 3).map(l => 'L' + l).join(',');
        const more = d.locations.length > 3 ? '...\u5171' + d.locations.length + '\u8655' : '';
        return locs + more + '\uFF08' + d.count + '\u6B21, ' + d.size + '\u884C\uFF09';
      })
      .join(', ');
    smells.push({
      severity: 'medium',
      type: 'duplicate_code',
      message: '\u767C\u73FE ' + totalDupGroups + ' \u7D44\u91CD\u8907\u7A0B\u5F0F\u78BC\uFF08\u5171 ' + totalDupOccurrences + ' \u6B21\u51FA\u73FE\uFF09\uFF1A' + details + '\uFF0C\u61C9\u62BD\u51FA\u5171\u7528\u51FD\u5F0F\u6216 include',
    });
  }

  // ── 7. 散落的 inline SQL（沒有 class/function 包裝）──
  if (hasSQL && classes.length === 0 && functions.length <= 2) {
    smells.push({
      severity: 'medium',
      type: 'inline_sql',
      message: 'SQL \u6563\u843D\u5728\u9802\u5C64\u7A0B\u5F0F\u78BC\u4E2D\uFF0C\u6C92\u6709\u5C01\u88DD\u6210 function/class\uFF0C\u96E3\u4EE5\u7DAD\u8B77\u8207\u91CD\u7528',
    });
  }

  // ── 8. 單行重複 pattern 偵測（硬編碼散布）──
  const lineFreq = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '{' || trimmed === '}' || trimmed === '<?php' || trimmed === '?>'
        || /^\/\//.test(trimmed) || /^\/?\*/.test(trimmed) || trimmed.length < 10) continue;
    lineFreq.set(trimmed, (lineFreq.get(trimmed) || 0) + 1);
  }
  const hardcoded = [...lineFreq.entries()]
    .filter(([, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (hardcoded.length > 0) {
    const details = hardcoded
      .map(([line, count]) => {
        const preview = line.slice(0, 50) + (line.length > 50 ? '...' : '');
        return '"' + preview + '" x' + count;
      })
      .join(', ');
    smells.push({
      severity: 'medium',
      type: 'hardcoded_repeat',
      message: '\u5927\u91CF\u91CD\u8907\u786C\u7DE8\u78BC\u884C\uFF1A' + details + '\uFF0C\u61C9\u6539\u7528\u8FF4\u5708\u6216\u9663\u5217\u9A45\u52D5\u6A21\u677F',
    });
  }

  // ── 9. Inline CSS 過多（應抽出為獨立 .css 檔）──
  const styleTagMatch = content.match(/<style[\s\S]*?<\/style>/gi) || [];
  const inlineStyleLines = styleTagMatch.reduce((sum, block) => sum + block.split('\n').length, 0);
  const inlineAttrStyles = (content.match(/style\s*=\s*["'][^"']{20,}/g) || []).length;
  if (inlineStyleLines > 30 || inlineAttrStyles > 10) {
    const parts = [];
    if (inlineStyleLines > 0) parts.push('<style> \u5340\u584A\u5171 ' + inlineStyleLines + ' \u884C');
    if (inlineAttrStyles > 0) parts.push(inlineAttrStyles + ' \u500B inline style \u5C6C\u6027');
    smells.push({
      severity: 'medium',
      type: 'inline_css',
      message: parts.join(', ') + '\uFF0CCSS \u61C9\u62BD\u51FA\u70BA\u7368\u7ACB .css \u6A94\u518D include\uFF08\u5C24\u5176\u5217\u5370\u9801\u9762\u5171\u7528\u6A23\u5F0F\uFF09',
    });
  }

  // ── 10. Clean Code：單字母變數名（排除迴圈的 $i/$j/$k）──
  const shortVarPattern = /\$([a-z])\b/g;
  const loopVars = new Set(['i', 'j', 'k', 'n', 'e']);
  const shortVars = new Map();
  let varMatch;
  while ((varMatch = shortVarPattern.exec(content)) !== null) {
    const v = varMatch[1];
    if (!loopVars.has(v)) {
      shortVars.set(v, (shortVars.get(v) || 0) + 1);
    }
  }
  const badVars = [...shortVars.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
  if (badVars.length > 0) {
    const details = badVars.map(function(pair) { return '$' + pair[0] + ' x' + pair[1]; }).join(', ');
    smells.push({
      severity: 'medium',
      type: 'short_var_names',
      message: 'Clean Code: ' + details + ' \u2014 \u8B8A\u6578\u540D\u61C9\u6709\u610F\u7FA9\uFF08$a \u2192 $amount\uFF09',
    });
  }

  // ── 11. Clean Code：函式參數過多（>4 個）──
  const longParamFuncs = [];
  const paramPattern = /function\s+(\w+)\s*\(([^)]*)\)/g;
  let paramMatch;
  while ((paramMatch = paramPattern.exec(content)) !== null) {
    const fname = paramMatch[1];
    const params = paramMatch[2].trim();
    if (!params) continue;
    const paramCount = params.split(',').length;
    if (paramCount > 4) {
      longParamFuncs.push(fname + '(' + paramCount + ')');
    }
  }
  if (longParamFuncs.length > 0) {
    smells.push({
      severity: 'medium',
      type: 'too_many_params',
      message: 'Clean Code: \u53C3\u6578\u904E\u591A\u7684\u51FD\u5F0F\uFF1A' + longParamFuncs.slice(0, 5).join(', ') + ' \u2014 \u8D85\u904E 4 \u500B\u53C3\u6578\u61C9\u7528\u7269\u4EF6/\u9663\u5217\u5C01\u88DD',
    });
  }

  // ── 12. Clean Code：魔術數字（裸數字常數散落在邏輯中）──
  const magicPattern = /(?:===?|!==?|[<>]=?|[+\-*\/])\s*(\d{2,})\b/g;
  const magicNums = new Map();
  let magicMatch;
  while ((magicMatch = magicPattern.exec(content)) !== null) {
    const num = magicMatch[1];
    if (['10', '100', '1000'].includes(num)) continue;
    magicNums.set(num, (magicNums.get(num) || 0) + 1);
  }
  const frequentMagic = [...magicNums.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
  if (frequentMagic.length > 0) {
    const details = frequentMagic.slice(0, 5).map(function(pair) { return pair[0] + ' x' + pair[1]; }).join(', ');
    smells.push({
      severity: 'medium',
      type: 'magic_numbers',
      message: 'Clean Code: \u9B54\u8853\u6578\u5B57 ' + details + ' \u2014 \u61C9\u62BD\u51FA\u70BA\u5E38\u6578\uFF08const STATUS_ACTIVE = 1\uFF09',
    });
  }

  // ── 13. 雙狀態 SESSION 分支：含登入/未登入分支的 method，提醒兩路徑都要測 ──
  // 路徑與 session pattern 可由環境變數覆寫（不寫死 cls/model）：
  //   CLAUDE_DUAL_STATE_PATH_REGEX   — 限定觸發路徑（預設：所有 .php）
  //   CLAUDE_DUAL_STATE_SESSION_RE   — session 偵測 regex（預設：isset(\$_SESSION...）
  const pathRe = process.env.CLAUDE_DUAL_STATE_PATH_REGEX;
  const passPath = !pathRe || new RegExp(pathRe, 'i').test(filePath.replace(/\\/g, '/'));
  if (passPath) {
    const sessionReSrc = process.env.CLAUDE_DUAL_STATE_SESSION_RE
      || 'if\\s*\\(\\s*!?\\s*isset\\s*\\(\\s*\\$_SESSION';
    const sessionRe = new RegExp(sessionReSrc, 'gi');
    const dualHits = [];
    for (const fn of functions) {
      const body = lines.slice(fn.startLine - 1, fn.endLine).join('\n');
      sessionRe.lastIndex = 0;
      if (sessionRe.test(body) && /\belse\b/.test(body)) {
        dualHits.push(fn.name + '() L' + fn.startLine);
      }
    }
    if (dualHits.length > 0) {
      smells.push({
        severity: 'medium',
        type: 'dual_state_session_branch',
        message: '雙狀態 SESSION 分支：' + dualHits.slice(0, 5).join(', ')
          + ' — 修改 SQL 時請同步登入 / 未登入兩條路徑，並測試兩種狀態',
      });
    }
  }

  return { filePath, totalLines, functions: functions.length, classes: classes.length, smells };
}

/** 簡易重複區塊偵測：將連續 N 行 normalize 後做 hash，找出重複 */
function findDuplicateBlocks(lines) {
  const blockSize = THRESHOLDS.duplicateMinLines;
  const hashMap = new Map();

  for (let i = 0; i <= lines.length - blockSize; i++) {
    if (lines[i].trim() === '') continue;

    const block = lines.slice(i, i + blockSize)
      .map(l => l.trim())
      .join('\n');

    if (block.replace(/\/\/.*|\/\*[\s\S]*?\*\/|\s+/g, '').length < 20) continue;

    const hash = simpleHash(block);
    if (!hashMap.has(hash)) {
      hashMap.set(hash, []);
    }
    hashMap.get(hash).push(i + 1);
  }

  const duplicates = [];
  for (const [, positions] of hashMap) {
    const filtered = [positions[0]];
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] - positions[i - 1] >= blockSize) {
        filtered.push(positions[i]);
      }
    }

    if (filtered.length >= THRESHOLDS.duplicateThreshold) {
      duplicates.push({
        locations: filtered,
        count: filtered.length,
        size: blockSize,
      });
    }
  }

  return duplicates.sort((a, b) => b.count - a.count).slice(0, 5);
}

/** 簡易字串 hash（FNV-1a 變體） */
function simpleHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

// ── 輸出格式化 ──────────────────────────────────

function formatSmells(analysis) {
  if (!analysis || analysis.smells.length === 0) return null;

  const { filePath, totalLines, functions, classes, smells } = analysis;
  const fileName = path.basename(filePath);

  const highSmells = smells.filter(s => s.severity === 'high');
  const mediumSmells = smells.filter(s => s.severity === 'medium');

  const icon = highSmells.length > 0 ? '\uD83D\uDD34' : '\uD83D\uDFE1';
  const urgency = highSmells.length > 0
    ? '\u6B64\u6A94\u6848\u6709\u56B4\u91CD\u7684\u7D50\u69CB\u554F\u984C\uFF0C\u5F37\u70C8\u5EFA\u8B70\u5148\u91CD\u69CB\u518D\u4FEE\u6539'
    : '\u6B64\u6A94\u6848\u6709\u6539\u5584\u7A7A\u9593\uFF0C\u4FEE\u6539\u6642\u9806\u624B\u91CD\u69CB';

  let output = '[Refactor Advisor] ' + icon + ' ' + fileName + '\uFF08' + totalLines + '\u884C, ' + functions + '\u51FD\u5F0F, ' + classes + '\u985E\u5225\uFF09\n';
  output += '  \u25B8 ' + urgency + '\n';

  for (const smell of [...highSmells, ...mediumSmells]) {
    const sIcon = smell.severity === 'high' ? '\uD83D\uDD34' : '\uD83D\uDFE1';
    output += '  ' + sIcon + ' ' + smell.message + '\n';
  }

  output += '\n';
  output += '  \uD83D\uDCCB \u4FEE\u6539\u524D\u8ACB\u5148\u56DE\u7B54\uFF1A\n';
  output += '  (1) \u9019\u6BB5\u908F\u8F2F\u662F\u5426\u61C9\u8A72\u62C6\u5206\u6210\u7368\u7ACB\u6A94\u6848\u6216 class\uFF1F\n';
  output += '  (2) \u6709\u6C92\u6709\u91CD\u8907\u7684\u7A0B\u5F0F\u78BC\u53EF\u4EE5\u62BD\u51FA\u5171\u7528\u51FD\u5F0F\uFF1F\n';
  output += '  (3) \u5982\u679C\u8981\u91CD\u69CB\uFF0C\u4F60\u7684\u65B9\u6848\u662F\u4EC0\u9EBC\uFF1F\n';
  output += '  \u2192 \u78BA\u8A8D\u4E0D\u9700\u8981\u91CD\u69CB\u624D\u7E7C\u7E8C\u4FEE\u6539\u3002\u82E5\u9700\u91CD\u69CB\uFF0C\u5148\u5411\u4F7F\u7528\u8005\u63D0\u51FA\u65B9\u6848\u3002\n';

  return output;
}

// ── 主程式 ──────────────────────────────────────

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};

    const paths = extractFilePath(toolName, toolInput);
    if (!paths) { process.exit(0); return; }

    const fileList = Array.isArray(paths) ? paths : [paths];

    const outputs = [];

    for (const filePath of fileList) {
      if (!filePath) continue;
      if (!isPHP(filePath)) continue;
      if (isExcluded(filePath)) continue;

      const analysis = analyzePhpFile(filePath);
      const output = formatSmells(analysis);
      if (output) outputs.push(output);
    }

    if (outputs.length > 0) {
      process.stdout.write(outputs.join('\n'));
    }

    process.exit(0);
  } catch (e) {
    process.stderr.write('[refactor-advisor] error: ' + e.message + '\n');
    process.exit(0);
  }
});
