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

// ── 3. 複製 risk-tiers.json ──────────────────────────────
const riskSrc = path.join(__dirname, 'risk-tiers.json');
const riskDst = path.join(CLAUDE, 'risk-tiers.json');
if (fs.existsSync(riskSrc)) {
  fs.copyFileSync(riskSrc, riskDst);
  console.log(`  [config] OK: risk-tiers.json`);
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
    { hooks: [{ type: 'command', command: `node "${H}/user-prompt-guard.js"` }] }
  ],
};

let registered = 0;
for (const [event, config] of Object.entries(HOOK_REGISTRY)) {
  if (!settings.hooks[event]) {
    settings.hooks[event] = config;
    registered++;
    console.log(`  [settings] Registered: ${event}`);
  } else {
    console.log(`  [settings] Already exists (skip): ${event}`);
  }
}

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2), 'utf-8');

console.log('');
console.log(`Done. Copied ${copied} hooks, registered ${registered} new hook events.`);
