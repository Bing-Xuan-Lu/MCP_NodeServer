#!/usr/bin/env node
/**
 * PreToolUse Hook — 單場 Token 預算斷路器（Token Budget Circuit Breaker）
 *
 * 緣由（實測 某專案 30 天 121 場、17,372 回合得到的結論）：
 *   - 燒 token 的主因不是「單筆工具回傳太肥」（實測單筆最大才 75KB，全部回傳加起來才十幾 MB）。
 *   - 真正的大頭是「回合數 × 每回合重讀固定 context」：每次 tool call 都把 ~50 萬 token 的
 *     固定開銷（CLAUDE.md + memory + 工具 schema + session-start 注入）重讀一遍。
 *     17,372 回合 × ~50 萬 ≈ 87 億 cacheRead，跟實際相符；cacheRead 量是 output 的百倍，主導總成本。
 *   - 所以「回合數」是 token 燃燒的單位；但「回合多」不等於「亂燒」。
 *
 * 關鍵教訓（為什麼不能純看次數）：
 *   實測最兇的一場 451 回合，其實是「有完成」的大任務（還原 DB + 建測資 + 改退款 + 逐筆驗 + 部署）。
 *   純用「次數 ≥ 250 就 BLOCK」會誤殺這種正當大任務。
 *   真正該擋的是「量大 **又在原地打轉**」——同一檔反覆改 8~11 次、重複同樣呼叫，動了卻沒進展。
 *
 * 對策：兩段式，且 BLOCK 需「量大」+「打轉」雙條件成立：
 *   - calls ≥ WARN（預設 150）→ 軟提醒「該收斂」，每 50 次提一次（放行）。
 *   - calls ≥ BLOCK（預設 250）：
 *       · 偵測到「打轉」（近窗同檔狂改 / 重複同呼叫 / 高量低檔案多樣性）→ 硬擋一次，點名是哪個檔在打轉。
 *       · 沒打轉（量大但在動不同檔、有進展）→ 只軟提醒「考慮分發 subagent / 回報進度」，放行，不誤殺。
 *   - 斷路器語意：硬擋跳脫一次後放行，飆到下個門檻（+150）再評估，不永久鎖死。
 *
 * 放行例外：TodoWrite 永遠放行（讓 Claude 能立刻收斂 / 重新規劃）。
 * 門檻覆寫：CLAUDE_TOKEN_BUDGET_WARN / CLAUDE_TOKEN_BUDGET_BLOCK（以 tool call 次數計）。
 * 任何錯誤一律靜默放行（exit 0）。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const WARN_AT = parseInt(process.env.CLAUDE_TOKEN_BUDGET_WARN || '150', 10);
const BLOCK_AT = parseInt(process.env.CLAUDE_TOKEN_BUDGET_BLOCK || '250', 10);
const WARN_EVERY = 50;          // 達 WARN 後每 N 次再提一次
const BLOCK_EVERY = 150;        // 跳脫後，再過 N 次重新評估一次
const CHURN_WINDOW = 60;        // 「近窗」看最近幾個 tool call 判斷有無打轉
const TAIL_LINES = 500;         // 解析 transcript 末段幾行（夠涵蓋 CHURN_WINDOW 個 call）
const DEBUG = process.env.CLAUDE_HOOK_DEBUG === '1';

const STATE_DIR = path.join(os.homedir(), '.claude', '.hook-state');
const EDIT_TOOLS = new Set(['Edit', 'Write', 'create_file', 'create_file_batch', 'apply_diff', 'apply_diff_batch', 'multi_file_inject']);

function debug(msg) { if (DEBUG) process.stderr.write(`[token-budget] ${msg}\n`); }
function allow() { process.exit(0); }

/**
 * 分析 transcript：
 *  - calls：整場 tool_use 次數（字串掃描，快）
 *  - outTokens：累計 output token（色彩用）
 *  - churn：近 CHURN_WINDOW 個 call 的「打轉」分析（解析末段行）
 */
function analyze(transcriptPath) {
  const empty = { calls: 0, outTokens: 0, churn: null };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return empty;
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); } catch { return empty; }

  const calls = (raw.match(/"type":\s*"tool_use"/g) || []).length;
  let outTokens = 0;
  const mt = raw.match(/"output_tokens":\s*(\d+)/g);
  if (mt) for (const x of mt) outTokens += parseInt(x.replace(/\D/g, ''), 10) || 0;

  // ── 近窗打轉分析：只解析末段，蒐集最近 CHURN_WINDOW 個 tool_use ──
  const lines = raw.split(/\r?\n/);
  const tail = lines.slice(-TAIL_LINES);
  const seq = []; // { tool, file, hash }
  for (const line of tail) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (b && b.type === 'tool_use') {
          const tool = (b.name || '').replace(/^mcp__.*?__/, '');
          const inp = b.input || {};
          const file = inp.file_path || inp.path || (inp.target && inp.target.path) || '';
          const hash = tool + ':' + JSON.stringify(inp).slice(0, 160);
          seq.push({ tool, file, hash });
        }
      }
    }
  }
  const win = seq.slice(-CHURN_WINDOW);
  const editByFile = {};
  const byHash = {};
  let editCount = 0;
  for (const e of win) {
    byHash[e.hash] = (byHash[e.hash] || 0) + 1;
    if (EDIT_TOOLS.has(e.tool) && e.file) {
      editByFile[e.file] = (editByFile[e.file] || 0) + 1;
      editCount++;
    }
  }
  let maxFileEdits = 0, maxFileName = '';
  for (const [f, n] of Object.entries(editByFile)) if (n > maxFileEdits) { maxFileEdits = n; maxFileName = f; }
  let maxRepeat = 0, maxRepeatTool = '';
  for (const [h, n] of Object.entries(byHash)) if (n > maxRepeat) { maxRepeat = n; maxRepeatTool = h.split(':')[0]; }
  const distinctEditFiles = Object.keys(editByFile).length;

  // 打轉判定（任一成立）：
  //  ① 近窗同一檔被改 ≥ 5 次（d74b4ed3 的 update.php ×11 型）
  //  ② 近窗重複幾乎相同的呼叫 ≥ 4 次（無腦重試）
  //  ③ 近窗編輯量大（≥15）但只集中在 ≤3 個檔（高量低多樣＝原地磨）
  const churnSignal =
    maxFileEdits >= 5 ||
    maxRepeat >= 4 ||
    (editCount >= 15 && distinctEditFiles > 0 && distinctEditFiles <= 3);

  const churn = { churnSignal, maxFileEdits, maxFileName, maxRepeat, maxRepeatTool, editCount, distinctEditFiles };
  return { calls, outTokens, churn };
}

function sidFromPath(p) {
  try { return path.basename(p).replace(/\.jsonl$/, '').slice(0, 12) || 'unknown'; }
  catch { return 'unknown'; }
}
function readState(sid) {
  try {
    const f = path.join(STATE_DIR, `tb-${sid}.json`);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch { /* ignore */ }
  return { warnMilestone: 0, blockMilestone: 0 };
}
function writeState(sid, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, `tb-${sid}.json`), JSON.stringify(state));
  } catch { /* ignore */ }
}
function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}
function baseName(p) { try { return p.split(/[\\/]/).pop() || p; } catch { return p; } }

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const toolName = data.tool_name || '';
    const transcriptPath = data.transcript_path || '';

    // TodoWrite 永遠放行：讓 Claude 能立刻收斂 / 重新規劃
    if (toolName === 'TodoWrite') return allow();

    const { calls, outTokens, churn } = analyze(transcriptPath);
    debug(`calls=${calls} out=${outTokens} churn=${churn ? churn.churnSignal : '?'} (maxFileEdits=${churn?.maxFileEdits} maxRepeat=${churn?.maxRepeat})`);
    if (calls < WARN_AT) return allow();

    const sid = sidFromPath(transcriptPath);
    const state = readState(sid);
    const tokenNote = outTokens > 0 ? ` · 累計約 ${fmtTokens(outTokens)} output token` : '';

    // ── BLOCK 區：calls ≥ BLOCK_AT ──
    if (calls >= BLOCK_AT) {
      const isChurn = !!(churn && churn.churnSignal);

      // 沒打轉：量大但有進展（在動不同檔）→ 只軟提醒，不誤殺正當大任務
      if (!isChurn) {
        const nextSoft = state.warnMilestone < BLOCK_AT ? BLOCK_AT : state.warnMilestone + WARN_EVERY;
        if (calls >= nextSoft) {
          state.warnMilestone = nextSoft;
          writeState(sid, state);
          process.stdout.write(
            `⚠️ [Token 預算] 本場已 ${calls} 次 tool call${tokenNote}，量很大但你在動不同檔、沒在原地打轉（放行）。\n` +
            `  → 若有可獨立的子任務，考慮分發 subagent（Agent 工具）降低主線 context；否則向使用者回報目前進度與還需幾步。`
          );
        }
        return allow();
      }

      // 有打轉 + 量大 → 硬擋一次（斷路器跳脫）
      const nextBlock = state.blockMilestone === 0 ? BLOCK_AT : state.blockMilestone + BLOCK_EVERY;
      if (calls >= nextBlock) {
        state.blockMilestone = nextBlock;
        state.warnMilestone = Math.max(state.warnMilestone, calls);
        writeState(sid, state);

        const evid = [];
        if (churn.maxFileEdits >= 5) evid.push(`近 ${CHURN_WINDOW} 回合內把「${baseName(churn.maxFileName)}」改了 ${churn.maxFileEdits} 次`);
        if (churn.maxRepeat >= 4) evid.push(`重複幾乎相同的 ${churn.maxRepeatTool} 呼叫 ${churn.maxRepeat} 次`);
        if (churn.editCount >= 15 && churn.distinctEditFiles <= 3) evid.push(`${churn.editCount} 次編輯只集中在 ${churn.distinctEditFiles} 個檔`);

        const msg =
          `🛑 [Token 預算斷路器] BLOCKED：本場 ${calls} 次 tool call${tokenNote}，而且**在原地打轉**：\n` +
          `    ${evid.map((e) => '· ' + e).join('\n    ')}\n\n` +
          `  「改了又改同一個檔」「重複同樣呼叫」= 動了卻沒進展，這正是 bug 修不完 + token 空燒的型態。\n` +
          `  → 停下來換層次，別再硬磨：\n` +
          `     ① 先查根因：是不是改錯層（前端顯示 vs 後端計算雙源頭）？用 class_method_lookup / trace_logic / execute_sql 看資料來源。\n` +
          `     ② 先 session_search 查「以前是不是處理過這個檔/這個錯」，避免重踩。\n` +
          `     ③ 真要繼續，用 TodoWrite 把「卡點 + 下一個假設」寫下來，一次只驗一個假設。\n\n` +
          `  → 斷路器跳脫一次：本則擋下後即放行；若仍打轉飆到 ${nextBlock + BLOCK_EVERY} 次會再跳。\n` +
          `  → 若你確認這是正當必要的反覆（如逐筆驗證），向使用者說明後再繼續。`;
        process.stdout.write(msg);
        process.stderr.write(`[token-budget] BLOCK(churn) at ${calls} calls (milestone ${nextBlock})\n`);
        process.exit(2);
      }
      return allow();
    }

    // ── WARN 區：WARN_AT ~ BLOCK_AT 之間，每 WARN_EVERY 提一次 ──
    const nextWarn = state.warnMilestone < WARN_AT ? WARN_AT : state.warnMilestone + WARN_EVERY;
    if (calls >= nextWarn) {
      state.warnMilestone = nextWarn;
      writeState(sid, state);
      const churnHint = churn && churn.churnSignal && churn.maxFileEdits >= 5
        ? `（注意：你最近一直在改「${baseName(churn.maxFileName)}」${churn.maxFileEdits} 次，像在打轉）`
        : '';
      process.stdout.write(
        `⚠️ [Token 預算] 本場已 ${calls} 次 tool call${tokenNote}（${BLOCK_AT} 次+打轉會硬擋）${churnHint}。\n` +
        `  該收斂了：確認剩下哪些「真的必要」的步驟，發散支線先停。需要的話用 TodoWrite 列剩餘項。`
      );
    }
    return allow();
  } catch (e) {
    debug(`error (ignored): ${e.message}`);
    process.exit(0);
  }
});
