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
import { HOME } from '../env.js';
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const LEARNED_DIR = path.join(HOME, '.claude', 'skills', 'learned');
const PENDING_DIR = path.join(HOME, '.claude', 'skills', 'pending-review');
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

// === MCP heartbeat 偵測（已知會寫 heartbeat 的 server） ===
const KNOWN_MCP_SERVERS = ['project-migration-assistant-pro'];
const MCP_BEAT_FRESH_MS = 20000;   // heartbeat 視為新鮮的閾值
const MCP_WAIT_MAX_MS = 5000;      // 最多等多久讓 MCP 寫 heartbeat
const MCP_WAIT_STEP_MS = 500;

async function checkMcpAlive(cwd) {
  // 讀 cwd 的 .mcp.json，找出該專案註冊的 server
  let configured = [];
  try {
    const mcpJsonPath = path.join(cwd, '.mcp.json');
    if (fs.existsSync(mcpJsonPath)) {
      const cfg = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      configured = Object.keys(cfg.mcpServers || {});
    }
  } catch (e) {}

  // 只檢查我們已知會寫 heartbeat 的 server（避免對 Playwright 等誤報）
  const toCheck = configured.filter(s => KNOWN_MCP_SERVERS.includes(s));
  if (toCheck.length === 0) return null;

  const aliveDir = path.join(HOME, '.claude', '.mcp-alive');
  const deadline = Date.now() + MCP_WAIT_MAX_MS;
  const dead = [];

  for (const name of toCheck) {
    const beatFile = path.join(aliveDir, `${name}.json`);
    let alive = false;
    while (Date.now() < deadline) {
      try {
        const st = fs.statSync(beatFile);
        if ((Date.now() - st.mtimeMs) < MCP_BEAT_FRESH_MS) { alive = true; break; }
      } catch (e) {}
      await new Promise(r => setTimeout(r, MCP_WAIT_STEP_MS));
    }
    if (!alive) {
      let lastSeen = null;
      try { lastSeen = fs.statSync(beatFile).mtimeMs; } catch (e) {}
      dead.push({ name, lastSeen });
    }
  }
  return dead.length > 0 ? dead : null;
}

// === 主程式 ===
async function main() {
  const output = [];
  const cwd = process.cwd().replace(/\\/g, '/');

  // 0. MCP 連線偵測（在所有其他輸出之前，最顯眼）
  try {
    const dead = await checkMcpAlive(cwd);
    if (dead) {
      const lines = dead.map(d => {
        if (d.lastSeen) {
          const ageMin = Math.floor((Date.now() - d.lastSeen) / 60000);
          return `  - ${d.name}（最後 heartbeat 在 ${ageMin} 分鐘前）`;
        }
        return `  - ${d.name}（從未啟動成功）`;
      }).join('\n');
      output.push(
        `[MCP ⚠️] 偵測到 MCP server 未運行：\n${lines}\n` +
        `  → 對應的 MCP 工具會失敗。請檢查 Claude Code 啟動訊息或重啟。`
      );
    }
  } catch (e) {}

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

    // 5. Hook 投訴偵測（所有專案都提醒，MCP_Server 顯示詳情）
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

    // 9. Skill 待評估提醒（pending-review）
    try {
      if (fs.existsSync(PENDING_DIR)) {
        const pendingFiles = fs.readdirSync(PENDING_DIR)
          .filter(f => f.endsWith('.json'))
          .map(f => ({ name: f, path: path.join(PENDING_DIR, f), mtime: fs.statSync(path.join(PENDING_DIR, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);

        if (pendingFiles.length > 0) {
          // 合併所有待評估的 Skill（去重）
          const allSkills = new Set();
          for (const pf of pendingFiles) {
            try {
              const record = JSON.parse(fs.readFileSync(pf.path, 'utf-8'));
              (record.skills || []).forEach(s => allSkills.add(s));
            } catch (e) {}
          }

          if (allSkills.size > 0) {
            const skillList = [...allSkills].map(s => `/${s}`).join(', ');
            output.push(
              `\n[Skill Review] 上次 session 使用了以下 Skill：${skillList}\n` +
              `請在本次對話中評估這些 Skill 的執行品質，若有改進空間請直接 patch 對應的 MD 檔（Skills/commands/ 下）。\n` +
              `評估完成後刪除 ${PENDING_DIR} 下的 .json 檔即可。`
            );
          }
        }
      }
    } catch (e) {}

    // 9b. MCP 工具優先順序速查（每次 session 都注入）
    output.push(
      `\n[MCP Tools] 工具優先順序（違反 L1/L2.4c 會 BLOCK）：\n` +
      `  DB 操作    → execute_sql / get_db_schema（禁 Bash docker exec mysql）\n` +
      `  PHP 執行   → run_php_script / run_php_code（禁 Bash docker exec php）\n` +
      `  PHP 符號   → class_method_lookup / symbol_index / find_usages（禁 Grep PHP 結構語法）\n` +
      `  檔案讀寫   → Read / Edit / Glob / Grep（禁 cat/head/tail/find via Bash）\n` +
      `  HTTP 請求  → send_http_request（禁 curl via Bash）\n` +
      `  SFTP/SSH   → sftp_upload / ssh_exec MCP 工具`
    );

    // 10. PHP AST 工具速查（只在偵測到 PHP 專案時注入）
    try {
      const isPhpProject = (() => {
        if (fs.existsSync(path.join(cwd, 'composer.json'))) return true;
        try {
          const top = fs.readdirSync(cwd, { withFileTypes: true });
          if (top.some(e => e.isFile() && e.name.endsWith('.php'))) return true;
          const phpDirs = ['cls', 'model', 'controller', 'service', 'trait', 'app', 'src'];
          return top.some(e => e.isDirectory() && phpDirs.includes(e.name.toLowerCase()));
        } catch { return false; }
      })();
      if (isPhpProject) {
        output.push(
          `\n[PHP] 定位 class/method 用 AST 工具（class_method_lookup / find_usages / symbol_index / find_hierarchy / trace_logic），Grep 只搜變數/字串/註解。違反會 BLOCK。`
        );
      }
    } catch (e) {}

    // 11. Codemap 偵測 — 有 codemap 才能高效除錯
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

    // 12. Stale Snapshot 偵測 — 當前專案根目錄的 Playwright a11y snapshot YAML
    //     只掃 cwd 根目錄（不遞迴），列前 10 + 總數 + 一鍵清理指令
    try {
      const entries = fs.readdirSync(cwd, { withFileTypes: true });
      const stale = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!/\.ya?ml$/i.test(e.name)) continue;
        const fp = path.join(cwd, e.name);
        try {
          const head = fs.readFileSync(fp, 'utf-8').slice(0, 2048);
          if (/\[ref=e\d+\]/.test(head)) {
            stale.push({ name: e.name, mtime: fs.statSync(fp).mtimeMs });
          }
        } catch {}
      }
      if (stale.length > 0) {
        stale.sort((a, b) => b.mtime - a.mtime);
        const list = stale.slice(0, 10).map(f => `  - ${f.name}`).join('\n');
        const more = stale.length > 10 ? `\n  ...還有 ${stale.length - 10} 個` : '';
        const names = stale.map(f => `"${f.name}"`).join(' ');
        output.push(
          `\n[Cleanup] 🧹 偵測到 ${stale.length} 個 stale Playwright snapshot YAML（專案根目錄）：\n` +
          list + more +
          `\n  → 一鍵清理：cleanup_path({ paths: [${stale.slice(0, 10).map(f => `"${f.name}"`).join(', ')}${stale.length > 10 ? ', ...' : ''}] })\n` +
          `  → 或 PowerShell：Remove-Item ${names}\n` +
          `  → 這些是你之前自動產生的 stale 檔，請主動清理而不是留給使用者。`
        );
      }
    } catch (e) {}

  } catch (err) {
    process.stderr.write(`[session-start] error: ${err.message}\n`);
  }

  if (output.length > 0) {
    process.stdout.write(output.join('\n') + '\n');
  }
}

main();
