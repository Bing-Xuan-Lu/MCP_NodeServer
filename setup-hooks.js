#!/usr/bin/env node
/**
 * setup-hooks.js — 自動將 MCP Hooks 部署到 ~/.claude/ 並更新 settings.json
 *
 * 由 setup.ps1 呼叫，也可單獨執行：node setup-hooks.js
 *
 * 做的事：
 * 1. 建立 ~/.claude/hooks/ 目錄
 * 2. 複製所有 hooks/*.js → ~/.claude/hooks/
 * 3. 複製 risk-tiers.json → ~/.claude/risk-tiers.json
 * 4. 在 settings.json 登記所有 hook 事件（不覆蓋已有設定）
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME      = process.env.USERPROFILE || process.env.HOME;
const CLAUDE    = path.join(HOME, '.claude');
const HOOKS_SRC = path.join(__dirname, 'hooks');
const HOOKS_DST = path.join(CLAUDE, 'hooks');
const SETTINGS  = path.join(CLAUDE, 'settings.json');

// ── 1. 建立目錄 ─────────────────────────────────────────
fs.mkdirSync(HOOKS_DST, { recursive: true });

// ── 2. 複製 hooks/*.js ───────────────────────────────────
const HOOK_FILES = [
  'session-start.js',
  'pre-compact.js',
  'write-guard.js',
  'llm-judge.js',
  'user-prompt-guard.js',
  'skill-router.js',
];

let copied = 0;
for (const f of HOOK_FILES) {
  const src = path.join(HOOKS_SRC, f);
  const dst = path.join(HOOKS_DST, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`  [hooks] OK: ${f}`);
    copied++;
  } else {
    console.log(`  [hooks] SKIP (not found): ${f}`);
  }
}

// ── 3. 複製 config JSON ──────────────────────────────────
const CONFIG_FILES = [
  { src: 'risk-tiers.json',    dst: path.join(CLAUDE, 'risk-tiers.json') },
  { src: path.join('hooks', 'skill-keywords.json'), dst: path.join(HOOKS_DST, 'skill-keywords.json') },
];
for (const { src, dst } of CONFIG_FILES) {
  const srcPath = path.join(__dirname, src);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, dst);
    console.log(`  [config] OK: ${path.basename(src)}`);
  }
}

// ── 4. 登記 hooks 到 settings.json ──────────────────────
let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf-8')); } catch (e) {}
if (!settings.hooks) settings.hooks = {};

// 用 forward slash 路徑（Git Bash / Node.js 皆相容）
const H = HOOKS_DST.replace(/\\/g, '/');

const HOOK_REGISTRY = {
  SessionStart: [
    { hooks: [{ type: 'command', command: `node "${H}/session-start.js"` }] }
  ],
  PreCompact: [
    { hooks: [{ type: 'command', command: `node "${H}/pre-compact.js"` }] }
  ],
  PreToolUse: [
    { matcher: 'Write|Edit', hooks: [{ type: 'command', command: `node "${H}/write-guard.js"` }] }
  ],
  PostToolUse: [
    { matcher: 'Write|Edit', hooks: [{ type: 'command', command: `node "${H}/llm-judge.js"` }] }
  ],
  UserPromptSubmit: [
    { hooks: [{ type: 'command', command: `node "${H}/user-prompt-guard.js"` }] },
    { hooks: [{ type: 'command', command: `node "${H}/skill-router.js"`, timeout: 5 }] },
  ],
};

let registered = 0;
for (const [event, entries] of Object.entries(HOOK_REGISTRY)) {
  if (!settings.hooks[event]) {
    settings.hooks[event] = entries;
    registered += entries.length;
    console.log(`  [settings] Registered: ${event} (${entries.length} hooks)`);
  } else {
    // 逐條比對 command，只補缺少的
    const existing = settings.hooks[event];
    const existingCmds = new Set(
      existing.flatMap(e => (e.hooks || []).map(h => h.command))
    );
    for (const entry of entries) {
      const cmd = entry.hooks?.[0]?.command;
      if (cmd && !existingCmds.has(cmd)) {
        existing.push(entry);
        registered++;
        console.log(`  [settings] Added to ${event}: ${path.basename(cmd)}`);
      } else {
        console.log(`  [settings] Already exists (skip): ${path.basename(cmd || event)}`);
      }
    }
  }
}

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2), 'utf-8');

console.log('');
console.log(`Done. Copied ${copied} hooks, registered ${registered} new hook events.`);
