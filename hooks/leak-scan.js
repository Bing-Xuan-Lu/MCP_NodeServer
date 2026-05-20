#!/usr/bin/env node
/**
 * Leak Scan — 給 /git_commit 與 write-guard 共用的客戶外洩掃描
 *
 * 用法：
 *   node hooks/leak-scan.js [staged|head|files <path...>] [--force] [--skip]
 *     staged  — 掃 git diff --cached（預設，commit 前用）
 *     head    — 掃 git diff HEAD（包含未 stage 變更）
 *     files   — 掃指定檔案內容（給 PreToolUse hook 用）
 *     --force — 強制掃描，忽略 remote 判定
 *     --skip  — 強制跳過
 *
 * 自動跳過條件（任一成立即跳過）：
 *   1. 當前 cwd 不是 git repo
 *   2. 沒有任何 remote（純本機 repo）
 *   3. 所有 remote 都不在 blocklist.public_remote_hosts 內（純內部 git）
 *
 * 輸出（stdout 第一行為狀態）：
 *   CLEAN              — exit 0
 *   NO_BLOCKLIST       — exit 0（找不到 blocklist，印警告）
 *   SKIP_NOT_GIT       — exit 0（不是 git repo）
 *   SKIP_NO_REMOTE     — exit 0（無 remote）
 *   SKIP_INTERNAL_GIT  — exit 0（remote 全為內部 host），第 2 行 JSON 列出 remotes
 *   LEAK_DETECTED      — exit 2，後接 JSON 命中清單
 *
 * blocklist 來源（依優先序）：
 *   1. ~/.claude/leak-blocklist.json
 *   2. {cwd}/.leak-blocklist.json
 *
 * 環境變數：LEAK_SCAN_FORCE=1 / LEAK_SCAN_SKIP=1
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

function loadBlocklist() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'leak-blocklist.json'),
    path.join(process.cwd(), '.leak-blocklist.json'),
  ];
  for (const p of candidates) {
    try { return { data: JSON.parse(fs.readFileSync(p, 'utf8')), source: p }; }
    catch {}
  }
  return null;
}

function buildExemptMatchers(exemptPaths) {
  return (exemptPaths || []).map(s => {
    // 視為「路徑包含此字串即豁免」(literal substring, 不是 regex)
    return s.toLowerCase();
  });
}

function isExempt(file, exemptList) {
  if (!file) return false;
  const lower = file.toLowerCase();
  return exemptList.some(e => lower.includes(e));
}

function buildTerms(bl) {
  return [
    ...(bl.client_names || []),
    ...(bl.proprietary_terms || []),
    ...(bl.client_paths || []),
    ...(bl.client_domains || []),
  ].filter(Boolean);
}

function findHits(text, file, terms, exemptList) {
  if (isExempt(file, exemptList)) return [];
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    for (const t of terms) {
      if (lower.includes(t.toLowerCase())) {
        hits.push({ file, line: i + 1, term: t, snippet: line.slice(0, 200) });
        break; // 同行多命中只記第一個
      }
    }
  }
  return hits;
}

function scanGitDiff(diffMode) {
  const cmd = diffMode === 'head' ? 'git diff HEAD --unified=0' : 'git diff --cached --unified=0';
  let diff;
  try { diff = execSync(cmd, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }); }
  catch (e) {
    console.error(`git diff failed: ${e.message}`);
    process.exit(0); // 不 fail commit（可能不在 git repo）
  }
  const bl = loadBlocklist();
  if (!bl) { console.log('NO_BLOCKLIST'); return; }
  const terms = buildTerms(bl.data);
  const exempt = buildExemptMatchers(bl.data.exempt_paths);

  const hits = [];
  let currentFile = null;
  for (const line of diff.split('\n')) {
    const m = line.match(/^\+\+\+ b\/(.+)/);
    if (m) { currentFile = m[1]; continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (isExempt(currentFile, exempt)) continue;
    const lower = line.toLowerCase();
    for (const t of terms) {
      if (lower.includes(t.toLowerCase())) {
        hits.push({ file: currentFile, term: t, snippet: line.slice(0, 200) });
        break;
      }
    }
  }
  if (hits.length === 0) { console.log('CLEAN'); return; }
  console.log('LEAK_DETECTED');
  console.log(JSON.stringify({ blocklist_source: bl.source, hits: hits.slice(0, 50), total_hits: hits.length }, null, 2));
  process.exit(2);
}

function checkRemoteHost(bl) {
  // returns: { skip: bool, reason: string, remotes?: [...] }
  // 不是 git repo
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe' });
  } catch {
    return { skip: true, reason: 'SKIP_NOT_GIT' };
  }
  // 取所有 remote URL
  let raw;
  try { raw = execSync('git remote -v', { encoding: 'utf8' }); }
  catch { return { skip: true, reason: 'SKIP_NO_REMOTE' }; }

  const urls = [...new Set(
    raw.split('\n')
      .map(l => l.match(/^\S+\s+(\S+)\s+\(/))
      .filter(Boolean)
      .map(m => m[1])
  )];
  if (urls.length === 0) return { skip: true, reason: 'SKIP_NO_REMOTE' };

  const publicHosts = (bl?.data?.public_remote_hosts) || ['github.com', 'gitlab.com', 'bitbucket.org'];
  const isPublic = u => publicHosts.some(h => u.toLowerCase().includes(h.toLowerCase()));
  const anyPublic = urls.some(isPublic);
  if (!anyPublic) {
    return { skip: true, reason: 'SKIP_INTERNAL_GIT', remotes: urls };
  }
  return { skip: false, reason: 'PUBLIC_REMOTE', remotes: urls.filter(isPublic) };
}

function scanFiles(files) {
  const bl = loadBlocklist();
  if (!bl) { console.log('NO_BLOCKLIST'); return; }
  const terms = buildTerms(bl.data);
  const exempt = buildExemptMatchers(bl.data.exempt_paths);
  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); }
    catch { continue; }
    hits.push(...findHits(text, f, terms, exempt));
  }
  if (hits.length === 0) { console.log('CLEAN'); return; }
  console.log('LEAK_DETECTED');
  console.log(JSON.stringify({ blocklist_source: bl.source, hits: hits.slice(0, 50), total_hits: hits.length }, null, 2));
  process.exit(2);
}

const args = process.argv.slice(2);
const mode = (args[0] && !args[0].startsWith('--')) ? args.shift() : 'staged';
const flagForce = args.includes('--force') || process.env.LEAK_SCAN_FORCE === '1';
const flagSkip = args.includes('--skip') || process.env.LEAK_SCAN_SKIP === '1';

if (flagSkip) { console.log('SKIP_FORCED'); process.exit(0); }

// 對 git-based 掃描（staged/head）才做 remote 判定；files 模式跳過判定（檔案級檢查不綁 repo 狀態）
if ((mode === 'staged' || mode === 'head') && !flagForce) {
  const bl = loadBlocklist();
  const r = checkRemoteHost(bl);
  if (r.skip) {
    console.log(r.reason);
    if (r.remotes) console.log(JSON.stringify({ remotes: r.remotes }, null, 2));
    process.exit(0);
  }
}

const remainingArgs = args.filter(a => !a.startsWith('--'));
if (mode === 'staged' || mode === 'head') {
  scanGitDiff(mode);
} else if (mode === 'files') {
  scanFiles(remainingArgs);
} else {
  console.error(`Unknown mode: ${mode}. Use staged | head | files <path...>`);
  process.exit(1);
}
