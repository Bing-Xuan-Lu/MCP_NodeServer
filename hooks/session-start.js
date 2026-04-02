#!/usr/bin/env node
/**
 * SessionStart Hook — 對話開場記憶載入 + RAG 狀態偵測
 * 1. 自動偵測當前專案對應的 memory 目錄
 * 2. 載入上次 session 摘要（7 天內）
 * 3. 顯示 MEMORY.md 摘要（前 40 行）
 * 4. 顯示 24h 內更新的記憶檔
 * 5. 提醒近期踩坑紀錄（3 天內）
 * 6. 偵測 ChromaDB + 當前專案 RAG 索引狀態
 *
 * stdout 內容會被 Claude 看到（注入 context）
 * 靜默失敗：任何錯誤都不影響正常使用
 */

import fs from 'fs';
import path from 'path';
import http from 'http';

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

    // Claude 可能把底線轉成連字號（PG_dbox3 → PG-dbox3）
    const restHyphen = rest.replace(/_/g, '-');
    if (restHyphen !== rest) candidates.push(`${drive}--${restHyphen}`);

    // 也嘗試只到第二層
    candidates.push(`${drive}--${parts[1]}`);
    const p1Hyphen = parts[1].replace(/_/g, '-');
    if (p1Hyphen !== parts[1]) candidates.push(`${drive}--${p1Hyphen}`);
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

// === RAG 狀態偵測（ChromaDB） ===
const CHROMA_URL = 'http://localhost:8010';
const CHROMA_TIMEOUT = 1500; // ms，避免拖慢啟動

/** 從 CWD 推算專案名稱（D:\Project\PG_dbox3 → PG_dbox3） */
function guessProjectName() {
  const cwd = process.cwd().replace(/\\/g, '/').replace(/\/$/, '');
  const parts = cwd.split('/').filter(Boolean);
  // 取最後一層目錄名作為專案名
  return parts[parts.length - 1] || null;
}

/** HTTP GET with timeout, returns Promise<string|null> */
function httpGet(url, timeout) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(chunks.join('')));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 偵測 ChromaDB 狀態 + 當前專案索引 */
async function checkRagStatus() {
  // 1. heartbeat
  const hb = await httpGet(`${CHROMA_URL}/api/v2/heartbeat`, CHROMA_TIMEOUT);
  if (!hb) return null; // ChromaDB not running

  // 2. list collections
  const raw = await httpGet(
    `${CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections`,
    CHROMA_TIMEOUT
  );
  if (!raw) return { online: true, collections: [], project: null };

  let collections;
  try { collections = JSON.parse(raw); } catch { return { online: true, collections: [], project: null }; }

  const projectName = guessProjectName();
  const collectionName = projectName ? `rag_${projectName}` : null;
  const matched = collectionName
    ? collections.find(c => c.name === collectionName)
    : null;

  return {
    online: true,
    collections: collections.map(c => c.name),
    project: projectName,
    hasIndex: !!matched,
    collectionName,
  };
}

// === 主程式 ===
async function main() {
  const output = [];
  const cwd = process.cwd().replace(/\\/g, '/');

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

    // 5. RAG 狀態偵測
    const rag = await checkRagStatus();
    if (rag) {
      if (rag.hasIndex) {
        output.push(
          `\n[RAG] ${rag.collectionName} 已索引，語意搜尋可用。` +
          `\n⚠️ 搜尋規則（必須遵守）：` +
          `\n  - 不確定功能在哪個檔案 → 必須先用 rag_query，禁止直接 Glob+Grep+Read 掃描` +
          `\n  - PHP class/method → 用 class_method_lookup 一次到位，禁止 Grep→Read 兩步` +
          `\n  - 知道確切函式名/變數名 → 用 Grep` +
          `\n  - rag_query 回傳的 chunk 已包含程式碼片段，通常不需要再 Read 整個檔案` +
          `\n  - 只有在需要看 chunk 周圍的完整上下文時，才用 Read(offset, limit) 讀取該區段`
        );
      } else if (rag.online && rag.project) {
        output.push(`\n[RAG] ChromaDB 在線但此專案未索引。大型專案建議先執行 rag_index { project: "${rag.project}" } 建立索引，可大幅節省後續搜尋 token。`);
      }
    }

    // 6. Hook 投訴偵測（所有專案都提醒，MCP_Server 顯示詳情）
    try {
      const complaintsPath = path.join(HOME, '.claude', 'hook-complaints.jsonl');
      if (fs.existsSync(complaintsPath)) {
        const lines = fs.readFileSync(complaintsPath, 'utf-8').trim().split('\n').filter(Boolean);
        const pending = lines.filter(l => {
          try { return JSON.parse(l).status === 'pending'; } catch { return false; }
        });
        if (pending.length > 0) {
          const isMcpProject = cwd.toLowerCase().includes('mcp') && cwd.toLowerCase().includes('server');
          if (isMcpProject) {
            // MCP_Server：顯示詳情
            const recent = pending.slice(-5).map(l => {
              const e = JSON.parse(l);
              return `  ${e.ts.slice(0, 16)} | ${e.project} | ${e.tool} | ${e.pattern}`;
            });
            output.push(
              `\n[Hook Complaints] 📢 有 ${pending.length} 筆未處理的 hook 投訴：\n` +
              recent.join('\n') +
              `\n  → 執行 /hook_complaints 查看詳情並處理`
            );
          } else {
            // 其他專案：簡短提醒
            output.push(
              `\n[Hook Complaints] 📢 有 ${pending.length} 筆 hook 投訴待處理。請到 MCP_Server 專案執行 /hook_complaints 審查。`
            );
          }
        }
      }
    } catch (e) {}

    // 7. 文件老化偵測 — CLAUDE.md > 30 天未更新
    try {
      const claudeMdPath = path.join(cwd, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) {
        const ageDays = Math.floor((Date.now() - fs.statSync(claudeMdPath).mtimeMs) / (24 * 60 * 60 * 1000));
        if (ageDays > 30) {
          output.push(`\n[Guard] ⚠️ CLAUDE.md 已 ${ageDays} 天未更新，建議執行 /revise-claude-md 確認內容仍符合現況`);
        }
      }
    } catch (e) {}

    // 8. risk-tiers 提示 — 專案目錄沒有本地 risk-tiers.json
    try {
      const localRisk = path.join(cwd, 'risk-tiers.json');
      const globalRisk = path.join(HOME, '.claude', 'risk-tiers.json');
      if (!fs.existsSync(localRisk) && fs.existsSync(globalRisk)) {
        // 靜默 — 全域設定存在就夠了，不打擾使用者
      } else if (!fs.existsSync(localRisk) && !fs.existsSync(globalRisk)) {
        output.push(`\n[Guard] 💡 尚未設定 risk-tiers.json，write-guard 與 llm-judge 將以無分級模式運行。建議建立 ~/.claude/risk-tiers.json`);
      }
    } catch (e) {}

    // 9. Codemap 偵測 — 有 codemap 才能高效除錯
    const codemapCandidates = [
      path.join(cwd, 'docs', 'CODEMAPS'),
      path.join(cwd, '.reports', 'codemaps'),
    ];
    const codemapDir = codemapCandidates.find(d => fs.existsSync(d));
    if (codemapDir) {
      const cmFiles = fs.readdirSync(codemapDir).filter(f => f.endsWith('.md'));
      if (cmFiles.length > 0) {
        const oldest = Math.min(...cmFiles.map(f => fs.statSync(path.join(codemapDir, f)).mtimeMs));
        const ageDays = Math.floor((Date.now() - oldest) / (24 * 60 * 60 * 1000));
        const staleWarning = ageDays > 7 ? ` ⚠️ 最舊 ${ageDays} 天前更新，建議跑 /update_codemaps` : '';
        output.push(
          `\n[Codemap] ${path.relative(cwd, codemapDir)}/ 有 ${cmFiles.length} 份（${cmFiles.join(', ')}）${staleWarning}`
        );
      }
    }

  } catch (err) {
    process.stderr.write(`[session-start] error: ${err.message}\n`);
  }

  if (output.length > 0) {
    process.stdout.write(output.join('\n') + '\n');
  }
}

main();
