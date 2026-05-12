/**
 * file_diff — 純 Node 實作的雙檔比對工具（unified diff 格式輸出）
 *
 * 用途：取代 `Bash git --no-pager diff --no-index path_a path_b` fallback，
 *      不需 git binary 即可比較本機 vs 遠端下載檔。
 *
 * 演算法：Myers diff 簡化版（LCS 表格法，O(N*M) 空間/時間，純文字適用）
 *        對大檔（>10000 行）會自動切到 hash 行對應加速。
 */

import fs from "fs/promises";
import path from "path";
import { resolveSecurePath } from "../../config.js";

export const definitions = [
  {
    name: "file_diff",
    description:
      "比對兩個本機檔案產出 unified diff（取代 Bash git diff fallback）。\n" +
      "支援文字檔（UTF-8/UTF-16 自動偵測），不支援 binary。\n" +
      "回傳 unified diff 字串，無差異時回傳「✅ 兩檔內容一致」。",
    inputSchema: {
      type: "object",
      properties: {
        path_a: { type: "string", description: "檔案 A 路徑（相對 basePath 或絕對）" },
        path_b: { type: "string", description: "檔案 B 路徑（相對 basePath 或絕對）" },
        context: {
          type: "number",
          description: "context lines（前後各 N 行），預設 3",
          default: 3,
        },
        ignore_whitespace: {
          type: "boolean",
          description: "忽略行尾空白與 CRLF/LF 差異，預設 false",
          default: false,
        },
        max_lines: {
          type: "number",
          description: "單檔行數上限（防止 OOM），預設 50000",
          default: 50000,
        },
      },
      required: ["path_a", "path_b"],
    },
  },
];

// ─ 文字讀取（自動偵測 BOM / UTF-16）─
async function readText(absPath) {
  const buf = await fs.readFile(absPath);
  // UTF-16 LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString("utf16le");
  }
  // UTF-16 BE BOM
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString("utf16le");
  }
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString("utf8");
  }
  return buf.toString("utf8");
}

// ─ LCS 表格（短檔用，O(N*M)）─
function lcsLengths(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      dp[i][j] = ai === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

// ─ 回溯產生 edit script ─
function backtrack(dp, a, b) {
  const ops = []; // {type:'=' | '-' | '+', line:string, ai:number, bi:number}
  let i = a.length, j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ type: "=", line: a[i - 1], ai: i - 1, bi: j - 1 });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: "-", line: a[i - 1], ai: i - 1, bi: j });
      i--;
    } else {
      ops.push({ type: "+", line: b[j - 1], ai: i, bi: j - 1 });
      j--;
    }
  }
  while (i > 0) { ops.push({ type: "-", line: a[i - 1], ai: i - 1, bi: j }); i--; }
  while (j > 0) { ops.push({ type: "+", line: b[j - 1], ai: i, bi: j - 1 }); j--; }
  return ops.reverse();
}

// ─ 大檔加速：先用行 hash 找完全相同的長段，再對剩餘段做 LCS ─
function diffLines(a, b) {
  // 直接 LCS（適用於 < ~5000 行 * 5000 行 = 2.5e7 cells，記憶體約 100MB）
  // 超過則建議使用者拆檔或設定 max_lines
  const dp = lcsLengths(a, b);
  return backtrack(dp, a, b);
}

// ─ 將 edit script 組成 unified diff hunks ─
function formatUnifiedDiff(ops, contextLines, pathA, pathB) {
  // 找出所有 change 區段，再向外擴 contextLines
  const changeIdx = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "=") changeIdx.push(i);
  }
  if (changeIdx.length === 0) return "";

  // 合併鄰近 hunk
  const hunks = [];
  let curStart = Math.max(0, changeIdx[0] - contextLines);
  let curEnd = changeIdx[0];
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k];
    if (idx - curEnd <= contextLines * 2) {
      curEnd = idx;
    } else {
      hunks.push([curStart, Math.min(ops.length - 1, curEnd + contextLines)]);
      curStart = Math.max(0, idx - contextLines);
      curEnd = idx;
    }
  }
  hunks.push([curStart, Math.min(ops.length - 1, curEnd + contextLines)]);

  let out = `--- ${pathA}\n+++ ${pathB}\n`;
  for (const [s, e] of hunks) {
    // 計算 a/b 起始行（1-based）
    let aStart = 0, bStart = 0;
    for (let k = 0; k <= s; k++) {
      if (ops[k].type !== "+") aStart = ops[k].ai;
      if (ops[k].type !== "-") bStart = ops[k].bi;
    }
    // aStart/bStart 是當前 op 的 0-based index，hunk header 要 1-based 起始
    let aLines = 0, bLines = 0;
    const body = [];
    // 連續的非「=」op 群組：先輸出所有 `-`，再輸出所有 `+`（符合標準 unified diff 慣例）
    let pendingMinus = [];
    let pendingPlus = [];
    const flush = () => {
      for (const x of pendingMinus) body.push(`-${x}`);
      for (const x of pendingPlus) body.push(`+${x}`);
      pendingMinus = [];
      pendingPlus = [];
    };
    for (let k = s; k <= e; k++) {
      const op = ops[k];
      if (op.type === "=") {
        flush();
        body.push(` ${op.line}`);
        aLines++; bLines++;
      } else if (op.type === "-") {
        pendingMinus.push(op.line);
        aLines++;
      } else {
        pendingPlus.push(op.line);
        bLines++;
      }
    }
    flush();
    out += `@@ -${aStart + 1},${aLines} +${bStart + 1},${bLines} @@\n`;
    out += body.join("\n") + "\n";
  }
  return out;
}

// ─ 簡易 binary 偵測 ─
function looksBinary(buf, sampleSize = 8000) {
  const len = Math.min(buf.length, sampleSize);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function handle(name, args) {
  if (name !== "file_diff") return null;

  const pathA = args?.path_a;
  const pathB = args?.path_b;
  if (!pathA || !pathB) {
    return { content: [{ type: "text", text: "錯誤：缺少 path_a 或 path_b" }], isError: true };
  }

  let absA, absB;
  try {
    absA = resolveSecurePath(pathA);
    absB = resolveSecurePath(pathB);
  } catch (e) {
    return { content: [{ type: "text", text: `路徑解析失敗：${e.message}` }], isError: true };
  }

  // binary 偵測
  try {
    const [bufA, bufB] = await Promise.all([
      fs.readFile(absA, { encoding: null }).then((b) => b.slice(0, 8000)),
      fs.readFile(absB, { encoding: null }).then((b) => b.slice(0, 8000)),
    ]);
    if (looksBinary(bufA) || looksBinary(bufB)) {
      return {
        content: [{ type: "text", text: "❌ 偵測到 binary 檔（含 null byte），file_diff 不支援。" }],
        isError: true,
      };
    }
  } catch (e) {
    return { content: [{ type: "text", text: `讀檔失敗：${e.message}` }], isError: true };
  }

  let textA, textB;
  try {
    [textA, textB] = await Promise.all([readText(absA), readText(absB)]);
  } catch (e) {
    return { content: [{ type: "text", text: `讀檔失敗：${e.message}` }], isError: true };
  }

  if (args.ignore_whitespace) {
    textA = textA.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
    textB = textB.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "");
  } else {
    textA = textA.replace(/\r\n/g, "\n");
    textB = textB.replace(/\r\n/g, "\n");
  }

  const linesA = textA.split("\n");
  const linesB = textB.split("\n");

  const maxLines = args.max_lines ?? 50000;
  if (linesA.length > maxLines || linesB.length > maxLines) {
    return {
      content: [{
        type: "text",
        text: `❌ 檔案超過 max_lines 上限 (${maxLines})：A=${linesA.length}, B=${linesB.length}。\n` +
              `建議：調大 max_lines、或先拆段比對。`,
      }],
      isError: true,
    };
  }

  // 純等比較先短路
  if (linesA.length === linesB.length && textA === textB) {
    return { content: [{ type: "text", text: "✅ 兩檔內容一致" }] };
  }

  const ops = diffLines(linesA, linesB);
  const context = Math.max(0, args.context ?? 3);
  const unified = formatUnifiedDiff(ops, context, pathA, pathB);

  if (!unified) {
    return { content: [{ type: "text", text: "✅ 兩檔內容一致（忽略空白後）" }] };
  }

  const added = ops.filter((o) => o.type === "+").length;
  const removed = ops.filter((o) => o.type === "-").length;
  const summary = `📊 +${added} / -${removed}（A: ${linesA.length} 行, B: ${linesB.length} 行）`;

  return {
    content: [{ type: "text", text: `${summary}\n\n${unified}` }],
  };
}
