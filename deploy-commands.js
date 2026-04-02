#!/usr/bin/env node
/**
 * deploy-commands.js
 * 白名單部署：Skills/enabled-skills.txt 控制哪些 Skill 被部署。
 * - 在 Skills/commands/ 遞迴搜尋白名單中的檔名
 * - 清除目標目錄中不在白名單的 .md 檔（stale 清理）
 * - 同時部署到 ~/.claude/commands/ 和 ~/.gemini/skills/
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const HOME       = process.env.USERPROFILE || process.env.HOME;
const CLAUDE_DIR = path.join(HOME, '.claude', 'commands');
const GEMINI_DIR = path.join(HOME, '.gemini', 'skills');
const WHITELIST  = path.join(__dirname, 'Skills', 'enabled-skills.txt');
const SKILLS_SRC = path.join(__dirname, 'Skills', 'commands');

// 確保目標目錄存在
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
fs.mkdirSync(GEMINI_DIR, { recursive: true });

// 讀白名單
if (!fs.existsSync(WHITELIST)) {
  console.error('ERROR: Skills/enabled-skills.txt not found.');
  process.exit(1);
}
const enabled = fs.readFileSync(WHITELIST, 'utf-8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));

if (enabled.length === 0) {
  console.log('WARNING: enabled-skills.txt is empty. No skills will be deployed.');
  process.exit(0);
}

// 遞迴掃描 Skills/commands/ 建立 filename → fullpath 索引
function scanSkills(dir, index = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳過 _* 開頭的私有目錄
      if (!entry.name.startsWith('_')) scanSkills(fullPath, index);
    } else if (entry.name.endsWith('.md') &&
               !entry.name.startsWith('_') &&
               !entry.name.endsWith('_internal.md') &&
               !entry.name.endsWith('_steps.md')) {
      index[entry.name] = fullPath;
    }
  }
  return index;
}
const sourceIndex = scanSkills(SKILLS_SRC);

// Stale 清理
let stale = 0;
for (const dir of [CLAUDE_DIR, GEMINI_DIR]) {
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    if (!enabled.includes(f)) {
      fs.rmSync(path.join(dir, f));
      if (dir === CLAUDE_DIR) { console.log(`  removed stale: ${f}`); stale++; }
    }
  }
}

// 部署
let deployed = 0, missing = 0;
for (const name of enabled) {
  const src = sourceIndex[name];
  if (!src) {
    console.log(`  WARNING: ${name} not found in Skills/commands/`);
    missing++;
    continue;
  }
  fs.copyFileSync(src, path.join(CLAUDE_DIR, name));
  fs.copyFileSync(src, path.join(GEMINI_DIR, name));
  console.log(`  deployed ${name}`);
  deployed++;
}

console.log('');
console.log(`Done! ${deployed} deployed, ${stale} stale removed, ${missing} not found.`);
console.log(`  Claude: ${CLAUDE_DIR}`);
console.log(`  Gemini: ${GEMINI_DIR}`);
console.log(`  Whitelist: Skills/enabled-skills.txt`);
