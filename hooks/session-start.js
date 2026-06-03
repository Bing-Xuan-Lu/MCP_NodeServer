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
import { execFileSync } from 'child_process';
import { HOME, MCP_ROOT as MCP_ROOT_FROM_ENV } from '../env.js';
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
  // Windows: D:/MCP_Server → d--MCP-Server（drive: + 路徑用 -- 開頭，路徑中 / 和 _ 轉成 -）
  // 嘗試多種格式
  const candidates = [];

  if (parts.length >= 2) {
    const drive = parts[0].replace(':', '').toLowerCase();
    const rest = parts.slice(1).join('-');
    candidates.push(`${drive}--${rest}`);

    // Claude 可能把底線轉成連字號（My_Project → My-Project）
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

// === 最近場次輕量索引（取代「倒一份 5 天前舊 compact」）===
// 走 session-recall-scan.js index 模式，回最近 N 場各一行：日期 + 主題 + 未完成 + 失敗數 + 熱檔。
// 給 Claude 一張「地圖」，真正相關那場的細節由 UserPromptSubmit 的 session-recall-on-prompt 在送指令時注入。
function loadRecentIndex(slug, n = 6) {
  const scan = path.join(HOME, '.claude', 'hooks', 'session-recall-scan.js');
  if (!slug || !fs.existsSync(scan)) return null;
  try {
    const out = execFileSync(process.execPath, [scan, 'index', slug, String(n)],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    const j = JSON.parse(out);
    if (!j.sessions || j.sessions.length === 0) return null;
    const lines = j.sessions.map((s) => {
      const date = (s.date || '').slice(0, 16).replace('T', ' ');
      const topic = (s.topic || '(無使用者輸入)').slice(0, 60);
      const tags = [];
      if (s.pendingTodos > 0) tags.push(`未完成 ${s.pendingTodos}`);
      if (s.failedCalls > 0) tags.push(`失敗 ${s.failedCalls}`);
      const hot = (s.topFiles && s.topFiles[0]) ? ` · ${s.topFiles[0].file}` : '';
      const tagStr = tags.length ? ` [${tags.join(' / ')}]` : '';
      return `  • ${date} \`${s.sessionId.slice(0, 8)}\`${tagStr}${hot}\n      ${topic}`;
    });
    return lines.join('\n');
  } catch { return null; }
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

// === MCP_Server root 偵測（給 preset 自動建議用） ===
function findMcpServerRoot() {
  // 1) 環境變數覆寫優先（MCP_SERVER_ROOT 或 env.js 匯出的 MCP_ROOT）
  if (process.env.MCP_SERVER_ROOT && fs.existsSync(process.env.MCP_SERVER_ROOT)) {
    return process.env.MCP_SERVER_ROOT;
  }
  if (MCP_ROOT_FROM_ENV && fs.existsSync(path.join(MCP_ROOT_FROM_ENV, '.mcp_sftp_presets.json'))) {
    return MCP_ROOT_FROM_ENV;
  }
  // 2) 常見 Windows 位置 fallback
  const candidates = [
    'D:/MCP_Server',
    'C:/MCP_Server',
    path.join(HOME, 'MCP_Server'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, '.mcp_sftp_presets.json'))) return c;
  }
  return null;
}

// === 依 cwd 推薦 DB / SFTP preset ===
function suggestPresets(cwd) {
  const root = findMcpServerRoot();
  if (!root) return null;

  let dbConnections = {};
  let sftpPresets = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'tools', '.mcp_db_config.json'), 'utf8'));
    dbConnections = cfg.connections || {};
  } catch {}
  try {
    sftpPresets = JSON.parse(fs.readFileSync(path.join(root, '.mcp_sftp_presets.json'), 'utf8'));
  } catch {}

  const cwdNorm = cwd.toLowerCase().replace(/\\/g, '/');
  const cwdBase = path.basename(cwdNorm); // 例 "myproject"

  // SFTP 用 local_base 精準比對
  let sftpHit = null;
  for (const [name, cfg] of Object.entries(sftpPresets)) {
    const lb = (cfg.local_base || '').toLowerCase().replace(/\\/g, '/');
    if (!lb) continue;
    if (cwdNorm === lb || cwdNorm.startsWith(lb + '/') || lb.endsWith('/' + cwdBase) || lb.endsWith(cwdBase)) {
      sftpHit = name;
      break;
    }
  }

  // DB 用 preset 名 vs cwd basename 模糊比對（去底線/連字號歧異）
  const baseSimple = cwdBase.replace(/[-_]/g, '');
  let dbHit = null;
  for (const name of Object.keys(dbConnections)) {
    const ns = name.toLowerCase().replace(/[-_]/g, '');
    if (baseSimple.includes(ns) || ns.includes(baseSimple)) {
      dbHit = name;
      break;
    }
  }

  if (!dbHit && !sftpHit) return null;
  return { db: dbHit, sftp: sftpHit };
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

  // 0.5 Preset 自動建議（依 cwd 推 DB/SFTP preset）
  try {
    const presets = suggestPresets(cwd);
    if (presets) {
      const lines = [];
      if (presets.db) lines.push(`  → set_database({ preset: "${presets.db}" })`);
      if (presets.sftp) lines.push(`  → sftp_connect({ preset: "${presets.sftp}" })`);
      output.push(
        `[Preset] 偵測到當前專案對應 preset，需要 DB / SFTP 時直接用 preset 載入（不必再列 host/user/password）：\n` +
        lines.join('\n')
      );
    }
  } catch (e) {}

  try {
    const memDir = findProjectMemoryDir();

    // 1. 最近場次索引（輕量地圖，取代倒一份 5 天前的舊 compact）
    //    真正「跟這次任務相關」那場的細節，由 session-recall-on-prompt（UserPromptSubmit）在你送出指令時按關鍵字注入。
    const slug = memDir ? path.basename(path.dirname(memDir)) : null;
    const recentIndex = slug ? loadRecentIndex(slug, 6) : null;
    if (recentIndex) {
      output.push(
        `[Recent Sessions] 本專案最近場次（地圖；相關那場的細節會在你下指令時自動帶出，或用 session_recall 查）：\n${recentIndex}`
      );
    } else {
      // 後援：索引拿不到時退回舊的單場摘要
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
    //    各 pattern 對應的「具體避免方式」— 讓 Claude 不只看到「最近被投訴 N 次」，還知道為什麼會被擋與怎麼閃避
    const PATTERN_TIPS = {
      verification_cheat_detect:
        '驗證捷徑被擋。避免：① 不准 mock window.confirm/open/fetch/print/alert/location 或 localStorage auth bypass；② browser_evaluate 不准直呼業務動詞（用 click 觸發 UI flow）；③ 不准空 catch / `except: pass` / `|| true` / PHP `@` 抑制錯誤；④ DML 後必須跑 SELECT 驗證才能宣告成功；⑤ 不准硬編 PASS/OK 或讓 mock 只回 true。',
      screenshot_wrong_path:
        'Playwright 截圖路徑錯。修法：browser_take_screenshot / browser_interact 的截圖一律存進 screenshot/ 目錄，不放專案根目錄。',
      exact_same_call:
        '完全相同 args 重複呼叫被擋（門檻 5 / browser_wait_for 9 / _harness 12）。修法：等不到 selector 就改策略不要再 wait；fetch 內容無變化先讀本地 cache；run_php_script 同檔 12 次表示測試發散，回頭看任務。',
      grep_php_symbol:
        'Grep 搜 PHP class/method 被擋。一律用 class_method_lookup / symbol_index / find_usages / trace_logic。Grep 留給變數名/字串/SQL 表名/註解。',
      grep_read_same_php_file:
        '同一 PHP 檔 Grep+Read 拼湊 3+ 次。直接 class_method_lookup 拿整段 method，或 symbol_index 列檔內結構。',
      bash_wrong_tool:
        '用 Bash 做 MCP 工具該做的事。DB → execute_sql、PHP → run_php_script、curl → send_http_request、SFTP/SSH → mcp 工具。',
      css_inspect_gate:
        '寫 CSS !important 或回報跑版前未跑 inspect。先 css_computed_winner / css_specificity_check / css_inspect 取證再改。',
      assumption_in_write:
        '寫入前的 AI input 含「我假設/應該是/猜測」等不確定語句。停下，先問使用者確認再動手。',
      ambiguous_ui_complaint:
        '使用者只給「跑版/壞了」+ 截圖就直接動工具。先反問 1 句確認層級（layout / trigger / data / interaction）再動手。',
      ui_verify_mismatch:
        '改完前端互動檔卻用 run_php_code echo/var_dump 驗證。改用 browser_interact 端到端，PHP 無法驗 Vue reactivity / 點擊。',
      git_first_for_dependencies:
        '查「誰用了 X / 砍 X 要改哪些」用了 git log/blame/show。依賴是當前狀態問題不是歷史問題；改用 find_usages / find_dependencies / Grep 字串。',
    };

    try {
      const complaintsPath = path.join(HOME, '.claude', 'hook-complaints.jsonl');
      if (fs.existsSync(complaintsPath)) {
        const lines = fs.readFileSync(complaintsPath, 'utf-8').trim().split('\n').filter(Boolean);
        const pending = lines.filter(l => {
          try { return JSON.parse(l).status === 'pending'; } catch { return false; }
        });
        if (pending.length > 0) {
          // pattern 分類統計（所有專案共用，給後面的具體建議用）
          const byPattern = {};
          pending.forEach(l => {
            try { const e = JSON.parse(l); byPattern[e.pattern] = (byPattern[e.pattern] || 0) + 1; } catch {}
          });

          const isMcpProject = cwd.toLowerCase().includes('mcp') && cwd.toLowerCase().includes('server');
          if (isMcpProject) {
            // MCP_Server：顯示詳情 + pattern 分類統計
            const breakdown = Object.entries(byPattern)
              .sort((a, b) => b[1] - a[1])
              .map(([p, n]) => `  ${String(n).padStart(3)} × ${p}`)
              .join('\n');
            const recent = pending.slice(-5).map(l => {
              const e = JSON.parse(l);
              return `  ${e.ts.slice(0, 16)} | ${e.project} | ${e.tool} | ${e.pattern}`;
            });
            output.push(
              `\n[Hook Complaints] 📢 有 ${pending.length} 筆未處理的 hook 投訴：\n` +
              breakdown +
              `\n  ── 最近 5 筆 ──\n` +
              recent.join('\n') +
              `\n  → 執行 /hook_complaints 查看詳情並處理`
            );
          } else {
            // 其他專案：簡短提醒
            output.push(
              `\n[Hook Complaints] 📢 有 ${pending.length} 筆 hook 投訴待處理。請到 MCP_Server 專案執行 /hook_complaints 審查。`
            );
          }

          // 5b. 跨專案通用：對近期高頻 pattern 給具體閃避建議（門檻 ≥3 次才提醒，避免噪音）
          const tipsToShow = Object.entries(byPattern)
            .filter(([p, n]) => n >= 3 && PATTERN_TIPS[p])
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4); // 最多 4 條
          if (tipsToShow.length > 0) {
            const tipLines = tipsToShow.map(([p, n]) =>
              `  • ${p} (${n}×) — ${PATTERN_TIPS[p]}`
            ).join('\n');
            output.push(
              `\n[Hook Tips] 🎯 近期高頻投訴的避免方式（這個 session 開始就請遵守）：\n` + tipLines
            );
          }
        }
      }
    } catch (e) {}

    // 6. 對話品質教訓（/lesson 暫存區）— 即時捕捉的繞遠路/幻覺/測試形式化，待 /retro lesson 轉成 memory
    //    跨專案共用：在 A 專案踩的坑（如 emulateMedia 污染）也該在 B 專案開場提醒，因為這是 AI 行為層教訓
    try {
      const lessonsPath = path.join(HOME, '.claude', 'quality-lessons.jsonl');
      if (fs.existsSync(lessonsPath)) {
        const pending = fs.readFileSync(lessonsPath, 'utf-8').trim().split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(e => e && e.status === 'pending');
        if (pending.length > 0) {
          const CAT_LABEL = { detour: '繞遠路', hallucination: '幻覺', 'test-theater': '測試形式化', 'memory-miss': '記憶失效', general: '其他' };
          const recent = pending.slice(-6).map(e =>
            `  • [${CAT_LABEL[e.category] || e.category}] ${(e.text || '').slice(0, 90)}（${(e.ts || '').slice(0, 10)} ${e.project}）`
          ).join('\n');
          output.push(
            `\n[Quality Lessons] 🧭 有 ${pending.length} 筆待轉化的對話品質教訓（/lesson 即時捕捉的繞遠路/幻覺）：\n` +
            recent +
            `\n  → 這些是「上次踩過的坑」，這個 session 請主動避開；有空到 MCP_Server 執行 /retro lesson 轉成長期 memory（轉完自動消去）。`
          );
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
