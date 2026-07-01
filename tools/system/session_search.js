// session_search.js — 跨 session 歷史對話搜尋與回顧（MCP 工具版）
//
// 為什麼存在：121 場對話的 JSONL 早就躺在 ~/.claude/projects/<slug>/ 下，
// 但過去只有 /session_recall、/session_audit 兩個「要手動開」的 skill。
// 包成 MCP 工具後，Claude 卡關當下可即時呼叫「以前是不是試過這個檔/這個錯」，
// 斷掉「換場重踩同個坑」的迴圈（這正是某報價系統修一個月的主因）。
//
// 設計：直接 spawn 現成的 ~/.claude/hooks/session-recall-scan.js（search/recall/list 三模式），
// 重用已測過的解析邏輯、零漂移。本模組只做「參數整理 + slug 模糊解析 + 輸出格式化」。

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { validateArgs } from "../_shared/utils.js";

const SCAN_SCRIPT = path.join(os.homedir(), ".claude", "hooks", "session-recall-scan.js");
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "session_search",
    description:
      "跨 session 全文搜尋過往對話歷史（~/.claude/projects/<slug>/*.jsonl）。" +
      "用途：卡關 / 反覆改同檔 / 同錯重現時，即時查「以前是不是處理過這個檔、這個錯、這個功能、結論是什麼」，" +
      "避免換場重踩同個坑。搜使用者輸入與 assistant 回覆文字（含檔名、錯誤訊息、功能關鍵字）。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "搜尋關鍵字（檔名如 MyService.php、錯誤訊息片段、功能名稱皆可，大小寫不敏感）",
        },
        days: {
          type: "integer",
          description: "往回搜幾天（預設 30，上限 180）",
          default: 30,
        },
        project: {
          type: "string",
          description: "（選用）只看某專案：slug 模糊關鍵字（如 myproject），省略＝跨所有專案",
        },
      },
      required: ["keyword"],
    },
  },
  {
    name: "session_recall",
    description:
      "回顧某一場過往對話：做了什麼、做完沒、卡在哪、動過哪些檔、跑過哪些 SQL/PHP、最後結論。" +
      "用途：接手未完成工作、查「上一場做到哪」、確認某功能上次改到什麼程度。唯讀，不改任何檔案。",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "專案 slug 模糊關鍵字（如 myproject）；省略＝依當前 cwd 推不出時需指定",
        },
        selector: {
          type: "string",
          description:
            "挑哪一場：prev（上一場，預設，排除當前對話）/ latest（含當前）/ 數字 N（往前第 N 場，1=最近）/ YYYY-MM-DD / session-id 前綴",
          default: "prev",
        },
      },
    },
  },
  {
    name: "session_changed_files",
    description:
      "跨 session 反查：某專案近 N 天內，哪些程式檔被動過、各自來自哪幾場 session。" +
      "用途：多場對話四散改了很多檔，要一次盤點「這些變更分別是哪場做的」，或搭配 git_status 一口氣部署。" +
      "只統計 Edit/Write/apply_diff/create_file 等檔案寫入工具，唯讀不改任何檔。",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "專案 slug 模糊關鍵字（如 myproject）；省略＝依當前 cwd 反推",
        },
        days: {
          type: "integer",
          description: "往回盤點幾天（預設 14，上限 90）",
          default: 14,
        },
      },
    },
  },
];

// ============================================
// 內部工具函式
// ============================================

/** 列出 ~/.claude/projects 下所有 slug 目錄 */
function listSlugs() {
  try {
    return fs
      .readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** 模糊解析 project 關鍵字 → slug；回 { slug } / { candidates } / { none } */
function resolveSlug(project) {
  const slugs = listSlugs();
  if (slugs.length === 0) return { none: true };
  if (!project) {
    // 依 cwd 反推：D:\Project\{Folder} → d--Project-{Folder}
    const cwd = process.cwd().replace(/\\/g, "/");
    const m = cwd.match(/\/([^/]+)\/?$/);
    const folder = m ? m[1] : "";
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hit = slugs.find((s) => norm(s).endsWith(norm(folder)) && folder);
    if (hit) return { slug: hit };
    return { candidates: slugs.slice(0, 30) };
  }
  const kw = project.toLowerCase();
  const matches = slugs.filter((s) => s.toLowerCase().includes(kw));
  if (matches.length === 1) return { slug: matches[0] };
  if (matches.length === 0) return { candidates: slugs.slice(0, 30) };
  return { candidates: matches };
}

/** spawn scan 腳本，回傳解析後的 JSON */
function runScan(args) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SCAN_SCRIPT)) {
      resolve({ error: `scan 腳本不存在：${SCAN_SCRIPT}` });
      return;
    }
    execFile(
      process.execPath,
      [SCAN_SCRIPT, ...args],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({ error: String(err.message || err) });
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ error: "scan 輸出非 JSON", raw: String(stdout).slice(0, 500) });
        }
      }
    );
  });
}

/** slug 尾段（去掉 d--Project- 前綴）當顯示用短名 */
function shortSlug(slug) {
  return slug.replace(/^[a-z]--?[Pp]roject-?/, "").replace(/^d--/, "") || slug;
}

// ============================================
// 輸出格式化
// ============================================

function formatSearch(res, projectFilter) {
  if (res.error) return `❌ 搜尋失敗：${res.error}`;
  let matches = res.matches || [];
  // project 後過濾（scan search 是跨全專案；這裡按 slug 關鍵字篩）
  if (projectFilter) {
    const kw = projectFilter.toLowerCase();
    matches = matches.filter((m) => m.slug.toLowerCase().includes(kw));
  }
  if (matches.length === 0) {
    return `🔍 「${res.keyword}」近 ${res.days} 天無相符對話${projectFilter ? `（專案含「${projectFilter}」）` : ""}。\n→ 可能是新問題，或換個關鍵字（檔名 / 錯誤片段 / 功能名）再搜。`;
  }
  const lines = [
    `🔍 「${res.keyword}」近 ${res.days} 天找到 ${matches.length} 場相關對話${projectFilter ? `（已篩專案「${projectFilter}」）` : "（跨專案）"}：`,
    "",
  ];
  matches.slice(0, 20).forEach((m, i) => {
    const d = (m.date || "").slice(0, 16).replace("T", " ");
    lines.push(`${i + 1}. [${shortSlug(m.slug)}] ${d} · 命中 ${m.hits} 次 · \`${m.sessionId.slice(0, 8)}\``);
    if (m.snippet) lines.push(`   ↳ ${m.snippet}`);
  });
  lines.push("");
  lines.push(`💡 要看某場完整經過：session_recall(project=\"${shortSlug(matches[0].slug)}\", selector=\"${matches[0].sessionId.slice(0, 8)}\")`);
  return lines.join("\n");
}

function formatRecall(res) {
  if (res.error) return `❌ 回顧失敗：${res.error}`;
  const L = [];
  L.push(`📖 回顧：[${shortSlug(res.slug)}] ${res.sessionId.slice(0, 8)} · ${(res.date || "").slice(0, 16).replace("T", " ")}`);
  L.push("");

  // 最重要的交接訊號：這場結束在一個等使用者回答的抉擇。
  // 放最前面，逼接手者先讀完整最後訊息，別照可能已作廢的 TODO 直接動手。
  if (res.pendingDecision) {
    L.push(`⚠️ 這場結束在一個【等你回答的抉擇】，並未做完就停。`);
    L.push(`   → 下面「未完成 TODO」很可能是中途計畫、已被最後訊息推翻。`);
    L.push(`   → 接手前務必先讀本頁最底的【上一場最後訊息（完整）】，以那則為準。`);
    L.push("");
  }

  if (res.userRequests && res.userRequests.length) {
    L.push(`【使用者要求】（共 ${res.userRequestTotal} 則，列前 ${Math.min(res.userRequests.length, 8)}）`);
    res.userRequests.slice(0, 8).forEach((r) => L.push(`  • ${r}`));
    L.push("");
  }

  if (res.lastTodos && res.lastTodos.length) {
    const pending = res.lastTodos.filter((t) => t.status !== "completed");
    const done = res.lastTodos.filter((t) => t.status === "completed");
    if (pending.length) {
      L.push(res.pendingDecision
        ? `【未完成 / 卡住】⚠️ 這批可能是中途計畫、已被最後訊息推翻，僅供參考（以文末完整最後訊息為準）`
        : `【未完成 / 卡住】← 下一場接手點`);
      pending.forEach((t) => L.push(`  ☐ ${t.content}${t.status ? ` (${t.status})` : ""}`));
      L.push("");
    }
    if (done.length) {
      L.push(`【已完成】`);
      done.forEach((t) => L.push(`  ☑ ${t.content}`));
      L.push("");
    }
  }

  if (res.filesModified && res.filesModified.length) {
    L.push(`【動過的檔】Top ${Math.min(res.filesModified.length, 12)}`);
    res.filesModified.slice(0, 12).forEach((f) => L.push(`  • ${f.file} ×${f.edits}`));
    L.push("");
  }

  // 使用者貼上的截圖：過去 recall 完全看不到圖（scan 只留 text block），交接時整張圖憑空消失。
  // 現在 dump 成暫存 PNG 並在此列出路徑，接手時用 read_image 就能真的看到那張圖。
  if (res.pastedImages && res.pastedImages.length) {
    L.push(`【使用者貼上的截圖】共 ${res.pastedImageTotal} 張 ← 這是文字看不到的證據，需要時用 read_image 開下面路徑`);
    res.pastedImages.forEach((im) => {
      const when = im.ts ? im.ts.slice(0, 16).replace("T", " ") : "";
      L.push(`  🖼 #${im.seq} ${im.mediaType} ~${im.sizeKB}KB ${when}`);
      if (im.near) L.push(`      出現在：「${im.near}」附近`);
      if (im.file) L.push(`      read_image → ${im.file}`);
      else L.push(`      （未 dump：超過上限或解碼失敗，需開原始 jsonl）`);
    });
    if (res.pastedImageTotal > res.pastedImages.length) {
      L.push(`  …（另有 ${res.pastedImageTotal - res.pastedImages.length} 張未 dump，超過張數上限）`);
    }
    L.push("");
  }

  if (res.sftpUploads && res.sftpUploads.length) {
    const totalUp = res.sftpUploads.reduce(
      (n, e) => n + (e.uploaded && e.uploaded.length ? e.uploaded.length : e.files ? e.files.length : 0),
      0
    );
    L.push(`【本場部署 / SFTP 上傳】（${res.sftpUploadCallTotal} 次呼叫，約 ${totalUp} 檔）← 查「上次推了哪些檔」看這裡`);
    res.sftpUploads.slice(0, 8).forEach((e) => {
      L.push(`  ▸ [${e.tool}]${e.summary ? ` ${e.summary}` : ""}`);
      const files = e.uploaded && e.uploaded.length ? e.uploaded : e.files || [];
      files.slice(0, 20).forEach((f) => L.push(`      • ${f}`));
      if (files.length > 20) L.push(`      …（共 ${files.length} 檔）`);
      if (e.skipped && e.skipped.length) L.push(`      ⏭ 另略過 ${e.skipped.length} 檔（相同/drift/排除）`);
    });
    L.push("");
  }

  if (res.sqlPhpRun && res.sqlPhpRun.length) {
    L.push(`【關鍵 SQL / PHP】（前 ${Math.min(res.sqlPhpRun.length, 8)}）`);
    res.sqlPhpRun.slice(0, 8).forEach((q) => L.push(`  • [${q.tool}] ${q.snippet}`));
    L.push("");
  }

  if (res.failedCalls && res.failedCalls.length) {
    L.push(`【失敗 / 被擋的工具呼叫】（共 ${res.failedCallTotal} 筆，列最近 ${Math.min(res.failedCalls.length, 10)}）← 查「為什麼某步失敗」看這裡`);
    res.failedCalls.slice(-10).forEach((e) => L.push(`  ✗ ${e.tool}\n      ↳ ${e.error}`));
    L.push("");
  }

  // 倒數第 2~4 則當「收尾脈絡」（摘要即可）；最後一則不放這，改用下面完整版
  if (res.closingNotes && res.closingNotes.length > 1) {
    L.push(`【收尾脈絡】（倒數第 2~4 則 assistant 訊息摘要）`);
    res.closingNotes.slice(-4, -1).forEach((n) => L.push(`  ▸ ${n}`));
    L.push("");
  }

  // 最後一則「完整」呈現——這是交接的真正依據（過去被砍到 260 字，害接手者看不到最終決定/抉擇）
  if (res.finalMessage) {
    L.push(`【上一場最後訊息（完整）】← 交接以這則為準，不是上面的 TODO`);
    res.finalMessage.split("\n").forEach((ln) => L.push(`  ${ln}`));
    if (res.finalMessageTruncated) L.push(`  …（超過 4000 字已截斷，需全文用 read_file 讀該場 jsonl）`);
    L.push("");
  }

  if (res.snapshot) {
    L.push(`📌 有 compact 快照：${res.snapshot}`);
    L.push(`   （需要完整敘事可用 read_file 讀此檔）`);
  }

  return L.join("\n");
}

function formatCandidates(reso, what) {
  if (reso.none) return `❌ 找不到任何專案歷史目錄（${PROJECTS_DIR}）。`;
  return (
    `⚠️ ${what}：需指定專案。可選 slug：\n` +
    reso.candidates.map((s) => `  • ${s}（${shortSlug(s)}）`).join("\n") +
    `\n→ 再呼叫一次並帶 project 關鍵字（如 project=\"myproject\"）。`
  );
}

// ============================================
// 工具邏輯
// ============================================
function formatChanged(res, projectLabel) {
  if (res.error) return `❌ 盤點失敗：${res.error}`;
  if (!res.files || res.files.length === 0) {
    return `📂 [${projectLabel}] 近 ${res.days || "?"} 天沒有 session 動過任何檔（掃 ${res.sessionCount} 場）。`;
  }
  const L = [];
  L.push(`📂 [${projectLabel}] 近 ${res.days} 天跨 session 變更盤點：${res.sessionCount} 場動過 ${res.fileCount} 個檔`);
  L.push(`（要「一口氣推」：先 git_status 取實際 M/A 檔，再與下表交集後餵給 sftp_upload_batch；本表是「誰改的」摘要）`);
  L.push("");
  res.files.forEach((f) => {
    const short = f.file.split(/[\\/]/).slice(-2).join("/");
    const sess = f.sessions.map((s) => `${s.session}(×${s.edits})`).join(" ");
    L.push(`  • ${short}  共×${f.total}  ← ${sess}`);
  });
  if (res.fileCount > res.files.length) L.push(`  …（另有 ${res.fileCount - res.files.length} 檔）`);
  return L.join("\n");
}

export async function handle(name, args) {
  const def = definitions.find((d) => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  if (name === "session_changed_files") {
    const reso = resolveSlug(args.project);
    if (!reso.slug) {
      return { content: [{ type: "text", text: formatCandidates(reso, "盤點變更") }] };
    }
    const days = Math.min(args.days || 14, 90);
    const res = await runScan(["changed", reso.slug, String(days)]);
    return { content: [{ type: "text", text: formatChanged(res, shortSlug(reso.slug)) }] };
  }

  if (name === "session_search") {
    const days = Math.min(args.days || 30, 180);
    const res = await runScan(["search", args.keyword, String(days)]);
    return { content: [{ type: "text", text: formatSearch(res, args.project) }] };
  }

  if (name === "session_recall") {
    const reso = resolveSlug(args.project);
    if (!reso.slug) {
      return { content: [{ type: "text", text: formatCandidates(reso, "回顧 session") }] };
    }
    const res = await runScan(["recall", reso.slug, args.selector || "prev"]);
    return { content: [{ type: "text", text: formatRecall(res) }] };
  }

  return { content: [{ type: "text", text: `未知工具：${name}` }] };
}
