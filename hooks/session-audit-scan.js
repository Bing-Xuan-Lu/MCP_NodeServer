// session-audit-scan.js — 由 /session_audit 呼叫，避免 bash 引號地獄
// usage: node hooks/session-audit-scan.js <slug> <days>
// 註：專案 package.json 為 "type":"module"，故用 ESM import（勿改回 require）
import fs from 'fs';
import path from 'path';
import os from 'os';

const slug = process.argv[2];
const days = +(process.argv[3] || 7);
if (!slug) { console.error('usage: node session_audit_run.js <slug> <days>'); process.exit(1); }

const dir = path.join(os.homedir(), '.claude', 'projects', slug);
if (!fs.existsSync(dir)) { console.error(`Slug not found: ${dir}`); process.exit(1); }

const cutoff = Date.now() - days * 86400000;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
  .map(f => ({f, p: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs}))
  .filter(x => x.m >= cutoff)
  .sort((a, b) => b.m - a.m);

const stats = {
  sessions: files.length,
  tools: {},
  filesModified: {},
  userPrompts: [],
  tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
  hookComplaints: 0,
  hookComplaintTypes: {},
  exactRepeats: {},
  totalErrors: 0,
  sessionDates: [],
  filesBySession: {}, // 算「跨幾場 session 改同檔」
};

for (const { f, p, m } of files) {
  const sid = f.replace('.jsonl', '').slice(0, 8);
  stats.sessionDates.push({ sid, date: new Date(m).toISOString().slice(0, 16) });
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
  const lines = text.split('\n').filter(Boolean);
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }

    if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
      for (const c of o.message.content) {
        if (c.type === 'text' && c.text && !c.text.startsWith('<') && c.text.length < 500) {
          stats.userPrompts.push({ sid, text: c.text.slice(0, 200) });
        }
        if (c.type === 'tool_result' && c.is_error) stats.totalErrors++;
      }
    }

    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const c of o.message.content) {
        if (c.type === 'tool_use') {
          const t = c.name;
          stats.tools[t] = (stats.tools[t] || 0) + 1;
          const hash = t + ':' + JSON.stringify(c.input || {}).slice(0, 200);
          stats.exactRepeats[hash] = (stats.exactRepeats[hash] || 0) + 1;
          const bare = t.replace(/^mcp__.*?__/, '');
          if (['Edit', 'Write', 'create_file', 'apply_diff', 'apply_diff_batch', 'multi_file_inject'].includes(bare)) {
            const fp = (c.input && (c.input.file_path || c.input.path)) || null;
            if (fp) {
              stats.filesModified[fp] = (stats.filesModified[fp] || 0) + 1;
              stats.filesBySession[fp] = stats.filesBySession[fp] || new Set();
              stats.filesBySession[fp].add(sid);
            }
          }
        }
      }
      if (o.message.usage) {
        stats.tokenUsage.input += o.message.usage.input_tokens || 0;
        stats.tokenUsage.output += o.message.usage.output_tokens || 0;
        stats.tokenUsage.cacheRead += o.message.usage.cache_read_input_tokens || 0;
        stats.tokenUsage.cacheCreate += o.message.usage.cache_creation_input_tokens || 0;
      }
    }

  }
}

// ── Hook 投訴：直接讀權威來源 ~/.claude/hook-complaints.jsonl ──
// （比解析 transcript 文字準確：transcript 內的投訴摘要會跨 session 重複計數，
//   且文字 regex 易漏抓非 *_detect/*_guard 命名的規則，如 exact_same_call / bash_wrong_tool）
// slug → project 對應：complaint.project 為 cwd 最後一段（如 my_project），
// 與 slug 尾段（如 ...-my-project）相同但分隔符不同，故兩邊正規化為純 [a-z0-9] 後比對。
const complaintsPath = path.join(os.homedir(), '.claude', 'hook-complaints.jsonl');
const normSlug = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
const hookComplaintStatuses = {};
try {
  const clines = fs.readFileSync(complaintsPath, 'utf8').split('\n').filter(Boolean);
  for (const line of clines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e.ts || new Date(e.ts).getTime() < cutoff) continue;
    const normProj = (e.project || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normProj || !normSlug.endsWith(normProj)) continue;
    stats.hookComplaints++;
    const pat = e.pattern || 'unknown';
    stats.hookComplaintTypes[pat] = (stats.hookComplaintTypes[pat] || 0) + 1;
    const st = e.status || 'unknown';
    hookComplaintStatuses[st] = (hookComplaintStatuses[st] || 0) + 1;
  }
} catch { /* 無投訴 log 視為 0 */ }

const topTools = Object.entries(stats.tools).sort((a, b) => b[1] - a[1]).slice(0, 15);
const topFiles = Object.entries(stats.filesModified).sort((a, b) => b[1] - a[1]).slice(0, 15)
  .map(([f, n]) => ({ file: f, edits: n, crossSessions: (stats.filesBySession[f] || new Set()).size }));
const topRepeats = Object.entries(stats.exactRepeats).filter(([_, n]) => n >= 5).sort((a, b) => b[1] - a[1]).slice(0, 15);
const totalToolCalls = Object.values(stats.tools).reduce((s, n) => s + n, 0);

console.log(JSON.stringify({
  slug,
  days,
  sessions: stats.sessions,
  sessionDates: stats.sessionDates.slice(0, 30),
  totalToolCalls,
  topTools: topTools.map(([t, n]) => ({ tool: t, count: n, pct: ((n / totalToolCalls) * 100).toFixed(1) + '%' })),
  topFiles,
  topRepeats: topRepeats.map(([h, n]) => ({ argsHash: h.slice(0, 160), count: n })),
  tokenUsage: stats.tokenUsage,
  cacheHitRate: (stats.tokenUsage.cacheRead / (stats.tokenUsage.input + stats.tokenUsage.cacheRead || 1) * 100).toFixed(1) + '%',
  totalErrors: stats.totalErrors,
  errorRate: ((stats.totalErrors / totalToolCalls) * 100).toFixed(2) + '%',
  hookComplaints: stats.hookComplaints,
  hookComplaintTypes: stats.hookComplaintTypes,
  hookComplaintStatuses,
  userPromptCount: stats.userPrompts.length,
  promptSample: stats.userPrompts.slice(-60).map(p => p.text),
}, null, 2));
