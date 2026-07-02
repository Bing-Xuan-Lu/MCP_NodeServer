#!/usr/bin/env node
/**
 * Stop Hook — Self-Admission Recorder（AI 自認犯錯 → 自動存教訓）
 *
 * 問題（使用者原話）：「每次都說我錯了我錯了，結果下次又發生。」
 *   AI 在對話中承認錯誤（「我搞錯了 / 言過其實 / 是我的疏失」）後，什麼都沒留下，
 *   換場 context 一清就重踩同一個坑。靠 AI 記得手動 /lesson 不可靠（它就是不記得才有這問題）。
 *
 * 機制：
 *   1. 回合結束掃 transcript 最後一則 assistant 純文字
 *   2. 命中「第一人稱自認犯錯」pattern（嚴格錨定「我 + 認錯」，排除「你錯了 / 假設語氣」）
 *   3. 自動 append 一筆到 ~/.claude/quality-lessons.jsonl（與 record-lesson.cjs 同 schema，auto:true 標記）
 *   4. session-start 開場浮現 pending 筆數；/retro lesson 逐條轉成長期 memory/hook
 *   5. 非阻擋（純捕捉，exit 0）；同 session 同一段承認（hash）不重複存
 *
 * 為何掛 Stop：認錯通常是回合結尾純文字、後面沒接 tool call，PreToolUse 抓不到。
 * 任何錯誤一律靜默 exit 0，絕不因 hook 異常卡住回合。
 */

import fs from 'fs';
import path from 'path';
import { HOME, CLAUDE_HOOK_DEBUG as DEBUG_MODE } from '../env.js';

const SINK = path.join(HOME, '.claude', 'quality-lessons.jsonl');
const STATE_DIR = path.join(HOME, '.claude', 'self-admission-state');

function writeStderrUtf8(s) {
  process.stderr.write(Buffer.from(s, 'utf8'));
}
function debug(msg) {
  if (DEBUG_MODE) writeStderrUtf8(`[self-admission-recorder] ${msg}\n`);
}

// ── 第一人稱自認犯錯 pattern（嚴格錨定「我」，避免抓到「你錯了 / code 算錯了」）──────
// 每條都要求主體是 AI 自己（我/自己），且是「已發生的認錯」而非假設語氣。
const ADMISSION_PATTERNS = [
  // 我（剛/剛才/之前/上一場/上個 session）… 搞錯/弄錯/寫錯/改錯/看錯/漏了/誤判/理解錯/會錯意
  /我(?:剛剛?|剛才|之前|先前|上一?場|上個?\s*session|一開始)?[^。\n]{0,8}?(?:搞錯|弄錯|寫錯|改錯|看錯|想錯|漏(?:了|掉|看|驗)|誤判|理解錯|會錯意|搞混|弄反|判斷錯)/,
  // 抓到（我）自己…（改）錯
  /抓到(?:我)?自己[^。\n]{0,6}?(?:改)?錯/,
  // 言過其實 / 誇大 / 我（太）武斷 / 我高估 / 過度樂觀
  /(?:言過其實|我(?:太)?武斷|我(?:高|低)估|過度樂觀|說得太滿|講得太滿|太早下結論)/,
  // 是我的（錯/疏失/問題/失誤/盲點/疏忽/鍋）
  /是我(?:的)?(?:錯|疏失|失誤|疏忽|盲點|盲區|問題|鍋)/,
  // 我（確實/的確）（沒/漏/忘/沒有）… — 承認遺漏
  /我(?:確實|的確|真的)(?:沒(?:有)?|漏|忘(?:了)?|忽略)/,
  // 我不該/不應該（就/直接/憑）… 假設/推導/宣稱 — 承認流程走偏
  /我不(?:該|應該)[^。\n]{0,12}?(?:就|直接|憑|假設|推導|推測|宣稱|跳過)/,
  // 我（之前的）驗證/測試（其實）有盲區/不算數/是形式化/沒真的測
  /我[^。\n]{0,10}?(?:驗證|測試|檢查)[^。\n]{0,8}?(?:有盲區|不算數|不能算|沒(?:有)?真的|只是形式|流於形式|沒測到)/,
  // 我搞錯方向 / 走偏了 / 繞遠路了（第一人稱檢討）
  /我[^。\n]{0,6}?(?:搞錯方向|走偏|繞(?:了)?遠路|繞路)/,
];

// 排除：假設語氣（如果我錯了 / 若有誤）、引用使用者的話、疑問句
const HYPOTHETICAL_RE = /(?:如果|若|假如|要是|萬一)[^。\n]{0,4}我[^。\n]{0,4}錯/;

function findAdmission(text) {
  if (HYPOTHETICAL_RE.test(text)) {
    // 只有假設語氣、沒有實際認錯 → 不記
    const stripped = text.replace(HYPOTHETICAL_RE, '');
    if (!ADMISSION_PATTERNS.some((re) => re.test(stripped))) return null;
  }
  for (const re of ADMISSION_PATTERNS) {
    const m = re.exec(text);
    if (m) return { index: m.index, matched: m[0] };
  }
  return null;
}

// 抽出認錯句附近的上下文（該句 + 前後補足），給 /retro lesson 用
function extractContext(text, index) {
  // 以句號/換行切句，取包含 index 的那一句 + 往前補一句（提供前因）
  const parts = text.split(/(?<=[。！\n])/);
  let acc = 0;
  let hitIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    acc += parts[i].length;
    if (acc > index) { hitIdx = i; break; }
  }
  if (hitIdx < 0) return text.slice(index, index + 200).trim();
  const from = Math.max(0, hitIdx - 1);
  return parts.slice(from, hitIdx + 1).join('').replace(/\s+/g, ' ').trim();
}

function readLastAssistantText(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = raw.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
          const c = obj.message.content;
          if (typeof c === 'string') return c;
          if (Array.isArray(c)) {
            return c.filter((x) => x?.type === 'text').map((x) => x.text || '').join('\n');
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* unreadable → 放行 */ }
  return '';
}

function quickHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

function loadSeen(sessionId) {
  try {
    const f = path.join(STATE_DIR, `${sessionId}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch { /* ignore */ }
  return { hashes: [] };
}
function saveSeen(sessionId, state) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, `${sessionId}.json`), JSON.stringify(state));
  } catch { /* ignore */ }
}

function projectFromCwd(cwd) {
  if (!cwd) return 'unknown';
  return cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'unknown';
}

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    if (data.stop_hook_active) return process.exit(0);

    const sessionId = data.session_id || 'default';
    const text = readLastAssistantText(data.transcript_path || '');
    if (!text.trim()) return process.exit(0);

    const hit = findAdmission(text);
    if (!hit) { debug('無自認犯錯 → 略過'); return process.exit(0); }

    const context = extractContext(text, hit.index).slice(0, 400);
    const state = loadSeen(sessionId);
    const h = quickHash(context);
    if (state.hashes.includes(h)) { debug('同段承認已記過 → 略過'); return process.exit(0); }

    const entry = {
      ts: new Date().toISOString(),
      project: projectFromCwd(data.cwd),
      cwd: (data.cwd || '').replace(/\\/g, '/'),
      category: 'self-error',
      text: context,
      status: 'pending',
      auto: true, // 標記為 hook 自動捕捉（非 /lesson 手動），供 /retro lesson 區分
    };
    fs.appendFileSync(SINK, JSON.stringify(entry) + '\n', 'utf-8');

    state.hashes.push(h);
    state.hashes = state.hashes.slice(-100);
    saveSeen(sessionId, state);

    debug(`已自動記錄自認犯錯：${context.slice(0, 60)}`);
    process.exit(0);
  } catch (e) {
    debug(`error (ignored): ${e.message}`);
    process.exit(0);
  }
});
