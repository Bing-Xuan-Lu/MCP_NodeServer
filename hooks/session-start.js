#!/usr/bin/env node
/**
 * SessionStart Hook — 對話開場記憶載入
 * 1. 自動偵測當前專案對應的 memory 目錄
 * 2. 載入上次 session 摘要（7 天內）
 * 3. 顯示 MEMORY.md 摘要（前 40 行）
 * 4. 顯示 24h 內更新的記憶檔
 * 5. 提醒近期踩坑紀錄（3 天內）
 *
 * stdout 內容會被 Claude 看到（注入 context）
 * 靜默失敗：任何錯誤都不影響正常使用
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || process.env.USERPROFILE;
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const LEARNED_DIR = path.join(HOME, '.claude', 'skills', 'learned');
const MAX_AGE_DAYS = 7;

// === 根據 CWD 動態找對應的 project memory 目錄 ===
function findProjectMemoryDir() {
  const cwd = process.cwd().replace(/\\/g, '/');
  const parts = cwd.split('/').filter(Boolean);

  // 組出 Claude projects 目錄的 ID 格式
  // Windows: D:/Develop/MCP_NodeServer → d--Develop-MCP_NodeServer
  // 嘗試多種格式
  const candidates = [];

  if (parts.length >= 2) {
    const drive = parts[0].replace(':', '').toLowerCase();
    const rest = parts.slice(1).join('-');
    candidates.push(`${drive}--${rest}`);

    // 也嘗試只到第二層
    candidates.push(`${drive}--${parts[1]}`);
  }

  for (const id of candidates) {
    const memDir = path.join(PROJECTS_DIR, id, 'memory');
    if (fs.existsSync(memDir)) return memDir;
  }

  // Fallback：掃描所有專案目錄，找 CWD 最匹配的
  if (!fs.existsSync(PROJECTS_DIR)) return null;
  try {
    const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    const cwdLower = cwd.toLowerCase().replace(/[:\\]/g, '-').replace(/\//g, '-');
    const matched = projects.find(p => cwdLower.includes(p.toLowerCase().replace(/--/, '-')));
    if (matched) {
      const memDir = path.join(PROJECTS_DIR, matched, 'memory');
      if (fs.existsSync(memDir)) return memDir;
    }
  } catch (e) {}

  return null;
}

// === 找最近的 session 摘要 ===
function findLatestSession() {
  if (!fs.existsSync(SESSIONS_DIR)) return null;

  const now = Date.now();
  const maxAge = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('-session.md') || f.endsWith('-compact.md') || f.endsWith('-checkpoint.md'))
    .map(f => ({
      name: f,
      path: path.join(SESSIONS_DIR, f),
      mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs,
    }))
    .filter(f => (now - f.mtime) < maxAge)
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0] : null;
}

// === 讀 MEMORY.md 摘要（前 40 行）===
function loadMemorySummary(memDir) {
  if (!memDir) return null;
  const memFile = path.join(memDir, 'MEMORY.md');
  if (!fs.existsSync(memFile)) return null;

  const content = fs.readFileSync(memFile, 'utf-8').trim();
  const lines = content.split('\n').slice(0, 40);
  return lines.join('\n');
}

// === 找 24h 內更新的記憶檔 ===
function findRecentMemoryChanges(memDir) {
  if (!memDir || !fs.existsSync(memDir)) return [];

  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;

  return fs.readdirSync(memDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(memDir, f)).mtimeMs }))
    .filter(f => (now - f.mtime) < maxAge)
    .sort((a, b) => b.mtime - a.mtime)
    .map(f => f.name);
}

// === 找最近踩坑紀錄（3 天內）===
function findRecentPitfalls() {
  if (!fs.existsSync(LEARNED_DIR)) return null;

  const now = Date.now();
  const maxAge = 3 * 24 * 60 * 60 * 1000;

  const files = fs.readdirSync(LEARNED_DIR)
    .filter(f => f.startsWith('auto-pitfall-') && f.endsWith('.md'))
    .map(f => ({ name: f, path: path.join(LEARNED_DIR, f), mtime: fs.statSync(path.join(LEARNED_DIR, f)).mtimeMs }))
    .filter(f => (now - f.mtime) < maxAge)
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0] : null;
}

// === 主程式 ===
function main() {
  const output = [];

  try {
    const memDir = findProjectMemoryDir();

    // 1. 上次 session 摘要
    const latest = findLatestSession();
    if (latest) {
      const content = fs.readFileSync(latest.path, 'utf-8').trim();
      if (content && content.length >= 20) {
        const label = latest.name.replace(/-(session|compact|checkpoint)\.md$/, '');
        output.push(`[Session] 上次摘要（${label}）：\n${content}`);
      }
    } else {
      output.push('[Session] 沒有近期工作紀錄，全新開始！');
    }

    // 2. MEMORY.md 摘要
    const memorySummary = loadMemorySummary(memDir);
    if (memorySummary) {
      output.push(`\n[Memory] 專案記憶摘要：\n${memorySummary}`);
    }

    // 3. 24h 內更新的記憶檔
    const recentChanges = findRecentMemoryChanges(memDir);
    if (recentChanges.length > 0) {
      output.push(`\n[Memory] 24h 內更新：${recentChanges.join(', ')}`);
    }

    // 4. 近期踩坑
    const pitfall = findRecentPitfalls();
    if (pitfall) {
      const content = fs.readFileSync(pitfall.path, 'utf-8').trim();
      const brief = content.split('\n').slice(0, 15).join('\n');
      output.push(`\n[Learn] 近期踩坑紀錄：\n${brief}`);
    }

  } catch (err) {
    // 靜默失敗，不影響使用者
  }

  if (output.length > 0) {
    process.stdout.write(output.join('\n') + '\n');
  }
}

main();
