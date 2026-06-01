#!/usr/bin/env node
/**
 * record-lesson.cjs — 記錄一筆「對話品質教訓」到暫存 sink
 *
 * sink: ~/.claude/quality-lessons.jsonl（append-only，跨專案共用）
 * 由 /lesson skill 即時呼叫（發現繞遠路 / 幻覺 / 測試形式化的當下就存，不等 session 尾）。
 * session-start.js 開場浮現 pending 筆數；/retro lesson 模式逐條轉成 memory/hook 後標 done。
 *
 * 用法:
 *   node record-lesson.cjs <category> <text...>
 *   node record-lesson.cjs --list           列出 pending
 *   node record-lesson.cjs --done <ts>       標記某筆為 done（ts 為該筆的 ISO 時間）
 *
 * category 可給英文或中文，會 normalize：
 *   detour|繞遠路  hallucination|幻覺  test-theater|測試形式化  memory-miss|記憶失效  general|其他
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SINK = path.join(HOME, '.claude', 'quality-lessons.jsonl');

function readAll() {
  try {
    return fs.readFileSync(SINK, 'utf-8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function writeAll(entries) {
  fs.writeFileSync(SINK, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf-8');
}

const CAT_MAP = {
  'detour': 'detour', '繞遠路': 'detour', '繞路': 'detour', '彎路': 'detour', '走偏': 'detour',
  'hallucination': 'hallucination', '幻覺': 'hallucination', '幻想': 'hallucination', '亂講': 'hallucination',
  'test-theater': 'test-theater', '測試形式化': 'test-theater', '假驗證': 'test-theater', '驗證形式': 'test-theater',
  'memory-miss': 'memory-miss', 'memory失效': 'memory-miss', '記憶失效': 'memory-miss',
  'general': 'general', '其他': 'general',
};

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('用法: node record-lesson.cjs <category> <text...> | --list | --done <ts>');
  process.exit(1);
}

// --list
if (argv[0] === '--list') {
  const pending = readAll().filter(e => e.status === 'pending');
  if (pending.length === 0) { console.log('（無 pending 品質教訓）'); process.exit(0); }
  pending.forEach((e, i) => console.log(`${i + 1}. [${e.category}] ${e.text}  （${e.ts} ${e.project}）`));
  process.exit(0);
}

// --done <ts>
if (argv[0] === '--done') {
  const ts = argv[1];
  if (!ts) { console.error('--done 需要 ts 參數'); process.exit(1); }
  const all = readAll();
  let n = 0;
  for (const e of all) { if (e.ts === ts && e.status === 'pending') { e.status = 'done'; e.doneAt = new Date().toISOString(); n++; } }
  writeAll(all);
  console.log(`✅ 標記 ${n} 筆為 done（ts=${ts}）`);
  process.exit(0);
}

// 預設：append 一筆
let category = 'general';
let textParts = argv;
const firstKey = CAT_MAP[argv[0]] || CAT_MAP[argv[0].toLowerCase()];
if (firstKey) { category = firstKey; textParts = argv.slice(1); }
const text = textParts.join(' ').trim();
if (!text) { console.error('教訓內容不可為空'); process.exit(1); }

const cwd = process.cwd().replace(/\\/g, '/');
const project = cwd.split('/').filter(Boolean).pop() || 'unknown';
const entry = { ts: new Date().toISOString(), project, cwd, category, text: text.slice(0, 500), status: 'pending' };
fs.appendFileSync(SINK, JSON.stringify(entry) + '\n', 'utf-8');
console.log(`✅ 已記錄品質教訓 [${category}] → ${SINK}`);
console.log(`   ${text.slice(0, 120)}`);
