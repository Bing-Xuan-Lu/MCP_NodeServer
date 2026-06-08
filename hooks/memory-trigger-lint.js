#!/usr/bin/env node
/**
 * 記憶 triggers 健檢
 *
 * 掃 memory 目錄，分類每個 .md：
 *   - ok      ：triggers 可被 memory-auto-recall 正確解析（有 prompt_keywords / path_patterns / tools）
 *   - broken  ：有 `triggers:` 字串但解析不出可用維度（沉默失敗來源）
 *   - missing ：完全沒有 triggers（不會自動召回，但不算錯）
 *
 * 用法：
 *   node memory-trigger-lint.js [slug]      單一專案（省略 slug 由 cwd 推）
 *   node memory-trigger-lint.js --all       掃所有專案
 *   加 --json                               輸出機器可讀 JSON（給 session-start 用）
 *
 * 與 memory-auto-recall.js 共用同一套 frontmatter parser，判定口徑一致。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  return parseYamlBlock(m[1]);
}
function parseYamlBlock(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const result = {};
  const stack = [{ obj: result, indent: -1, key: null }];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const indent = line.match(/^ */)[0].length;
    const stripped = line.slice(indent);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (stripped.startsWith('- ')) {
      const val = parseScalar(stripped.slice(2).trim());
      const arrKey = stack[stack.length - 1].key;
      if (arrKey && Array.isArray(parent[arrKey])) parent[arrKey].push(val);
      i++; continue;
    }
    const kv = stripped.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1]; const rawVal = kv[2];
      if (rawVal === '' || rawVal === undefined) {
        const nextLine = lines.slice(i + 1).find(l => l.trim() && !l.trim().startsWith('#'));
        if (nextLine && nextLine.slice(nextLine.match(/^ */)[0].length).startsWith('- ')) {
          parent[key] = []; stack.push({ obj: parent, indent, key });
        } else {
          parent[key] = {}; stack.push({ obj: parent[key], indent, key: null });
        }
      } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        parent[key] = rawVal.slice(1, -1).split(',').map(s => parseScalar(s.trim())).filter(s => s !== '');
      } else parent[key] = parseScalar(rawVal);
      i++; continue;
    }
    i++;
  }
  return result;
}
function parseScalar(s) {
  if (s === '') return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s === 'true') return true; if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// 遞迴掃（跳過 reports / _private / dotdir），與 memory-auto-recall.js 的 walk 口徑一致
function lintDir(rootDir) {
  if (!fs.existsSync(rootDir)) return null;
  const res = { total: 0, ok: 0, missing: [], broken: [] };
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'reports' || e.name === '_private' || e.name.startsWith('.')) continue;
        walk(fp);
      } else if (e.isFile() && e.name.endsWith('.md') && e.name !== 'MEMORY.md') {
        res.total++;
        let txt = '';
        try { txt = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
        const rel = path.relative(rootDir, fp).replace(/\\/g, '/');
        const hasRaw = /(^|\n)\s*triggers\s*:/.test(txt);
        const fm = parseFrontmatter(txt);
        const t = fm && fm.triggers;
        const usable = !!(t && (
          (Array.isArray(t.prompt_keywords) && t.prompt_keywords.length) ||
          (Array.isArray(t.path_patterns) && t.path_patterns.length) ||
          (Array.isArray(t.tools) && t.tools.length)
        ));
        if (usable) res.ok++;
        else if (hasRaw) res.broken.push(rel);
        else res.missing.push(rel);
      }
    }
  }
  walk(rootDir);
  return res;
}

function slugFromCwd() {
  const cwd = process.cwd().replace(/\\/g, '/');
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const drive = parts[0].replace(':', '').toLowerCase();
  const cands = [
    `${drive}--${parts.slice(1).join('-')}`,
    `${drive}--${parts.slice(1).join('-').replace(/_/g, '-')}`,
    `${drive}--${parts[1]}`,
    `${drive}--${parts[1].replace(/_/g, '-')}`,
  ];
  for (const id of cands) if (fs.existsSync(path.join(PROJECTS_DIR, id, 'memory'))) return id;
  return null;
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const all = args.includes('--all');
const slugArg = args.find(a => !a.startsWith('--'));

function run(slug) {
  const memDir = path.join(PROJECTS_DIR, slug, 'memory');
  const r = lintDir(memDir);
  return r ? { project: slug, ...r } : null;
}

let results = [];
if (all) {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch {}
  results = dirs.map(run).filter(Boolean).filter(r => r.total > 0);
} else {
  const slug = slugArg || slugFromCwd();
  if (slug) { const r = run(slug); if (r) results = [r]; }
}

if (json) {
  process.stdout.write(JSON.stringify(all ? results : (results[0] || null)) + '\n');
} else {
  if (results.length === 0) { console.log('找不到任何專案 memory 目錄。'); process.exit(0); }
  for (const r of results.sort((a, b) => b.broken.length - a.broken.length)) {
    const flag = r.broken.length ? ' ⚠️' : '';
    console.log(`\n[${r.project}]${flag}  共 ${r.total}　ok ${r.ok}　broken ${r.broken.length}　missing ${r.missing.length}`);
    if (r.broken.length) console.log('  🔴 格式壞（hook 讀不到，沉默失敗）：\n' + r.broken.map(f => '    - ' + f).join('\n'));
    if (r.missing.length) console.log(`  ⚪ 無 triggers（不會自動召回）：${r.missing.length} 個` + (r.missing.length <= 20 ? '\n' + r.missing.map(f => '    - ' + f).join('\n') : ''));
  }
}
