import fs from "fs/promises";
import path from "path";
import { resolveSecurePath } from "../../config.js";
import { validateArgs, normalizeArrayArg } from "../_shared/utils.js";

// 防 Reward Hacking：保護測試相關檔案，防止 Claude 為了讓測試通過而修改測試本身
const PROTECTED_PATTERNS = [
  /\btests?\//i,              // tests/ 或 test/ 目錄
  /__tests__\//i,             // __tests__/ 目錄
  /\.test\.(php|js|ts)$/i,    // *.test.php / *.test.js / *.test.ts
  /_test\.(php|js|ts)$/i,     // *_test.php / *_test.js
  /Test\.php$/,               // PHPUnit 慣例：*Test.php
  /_mcp_audit\.log$/i,        // SQL audit log（append-only，不可被覆寫）
];

// Whitespace-flexible 比對：將所有空白序列（含 tabs/spaces/newlines）視為等價，
// 用於 indent 容錯失敗後的最後一層 fallback。回傳 content 中對應的原始 slice，找不到則 null。
function whitespaceFlexFind(content, search) {
  const flexChars = [];
  const origIdx = [];
  let inWs = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (/\s/.test(c)) {
      if (!inWs) { flexChars.push(' '); origIdx.push(i); inWs = true; }
    } else {
      flexChars.push(c); origIdx.push(i); inWs = false;
    }
  }
  const cFlex = flexChars.join('');
  const sFlex = search.replace(/\s+/g, ' ');
  if (!sFlex) return null;
  const pos = cFlex.indexOf(sFlex);
  if (pos < 0) return null;
  const startOrig = origIdx[pos];
  const endFlex = pos + sFlex.length;
  const endOrig = endFlex >= origIdx.length ? content.length : origIdx[endFlex];
  return content.slice(startOrig, endOrig);
}

function hexPreview(s, len = 48) {
  const buf = Buffer.from(s.slice(0, len), 'utf-8');
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function buildDiffMismatchError(content, search) {
  const preview = search.slice(0, 80).replace(/\n/g, '\\n');
  const sHex = hexPreview(search);
  // 嘗試找出 search 第一行在 content 中的近似位置，dump 對應 content hex 供比對
  const firstLine = search.split('\n')[0].trim().slice(0, 24);
  let nearbyHex = '(無相似上下文)';
  if (firstLine) {
    const idx = content.indexOf(firstLine);
    if (idx >= 0) {
      nearbyHex = hexPreview(content.slice(idx, idx + 48));
    }
  }
  return new Error(
    `比對失敗：找不到 search 區塊\n` +
    `  search 前 80 字: ${preview}\n` +
    `  search hex(48): ${sHex}\n` +
    `  最近 content hex: ${nearbyHex}\n` +
    `  提示：若是 tab/space 不一致，工具已嘗試 indent 與 whitespace-flex fallback 仍無匹配，` +
    `請重新 read_file 確認原始空白後再傳 search。`
  );
}

function checkProtected(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const hit = PROTECTED_PATTERNS.find((p) => p.test(normalized));
  if (hit) {
    throw new Error(
      `⛔ 防 Reward Hacking 保護：「${filePath}」是受保護的測試檔案（符合規則 ${hit}）。\n` +
      `若確需修改，請使用者在對話中明確授權後再操作。`
    );
  }
}

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "list_files",
    description: "列出目錄內容",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description:
      "讀取檔案內容（支援分段）。大檔案會自動截斷並提示用 offset/limit 分段讀取。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: {
          type: "integer",
          description: "起始行號（從 1 開始，預設 1）",
        },
        limit: {
          type: "integer",
          description: "讀取行數（預設全部，大檔案自動截斷為 2000 行）",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "create_file",
    description: "建立或覆寫檔案",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_files_batch",
    description: "批次讀取多個檔案（減少 tool call 來回）。每個檔案回傳前 200 行摘要。",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "檔案路徑陣列",
        },
        summary_lines: {
          type: "integer",
          description: "每個檔案回傳的行數上限（預設 200）",
        },
      },
      required: ["paths"],
    },
  },
  {
    name: "list_files_batch",
    description: "批次列出多個目錄內容（減少 tool call 來回）",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "目錄路徑陣列",
        },
      },
      required: ["paths"],
    },
  },
  {
    name: "create_file_batch",
    description: "批次建立或覆寫多個檔案（減少 tool call 來回）",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "檔案路徑" },
              content: { type: "string", description: "檔案內容" },
            },
            required: ["path", "content"],
          },
          description: "檔案陣列，每項含 path 與 content",
        },
      },
      required: ["files"],
    },
  },
  {
    name: "list_files_recursive",
    description: "遞迴列出目錄樹狀結構（一次 call 取得完整子目錄）。適合規劃批次任務、了解專案結構。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "根目錄路徑" },
        max_depth: { type: "integer", description: "最大遞迴深度（預設 3，0 = 無限）" },
        dirs_only: { type: "boolean", description: "只列目錄，不列檔案（預設 false）" },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "排除的目錄/副檔名關鍵字（例如 ['node_modules', '.git', '.zip']，預設排除 .zip .rar .exe .apk .mp4 .mov .apk node_modules .git bin obj）",
        },
        max_entries: { type: "integer", description: "最大回傳項目數（預設 500，防止過大輸出）" },
      },
      required: ["path"],
    },
  },
  {
    name: "apply_diff",
    description: "修改檔案 (Search & Replace 模式)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        search: { type: "string" },
        replace: { type: "string" },
        occurrence: { type: "string", enum: ["first", "all"], description: "替換第一個匹配或全部匹配，預設 first" },
      },
      required: ["path", "search", "replace"],
    },
  },
  {
    name: "apply_diff_batch",
    description: "批次修改多個檔案（Search & Replace 模式）。每項指定 path/search/replace，一次 call 完成多檔修改。",
    inputSchema: {
      type: "object",
      properties: {
        diffs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "檔案路徑" },
              search: { type: "string", description: "搜尋字串" },
              replace: { type: "string", description: "取代字串" },
              occurrence: { type: "string", enum: ["first", "all"], description: "替換第一個或全部匹配，預設 first" },
            },
            required: ["path", "search", "replace"],
          },
          description: "修改清單，每項含 path、search、replace",
        },
      },
      required: ["diffs"],
    },
  },
];

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  if (name === "list_files") {
    const fullPath = resolveSecurePath(args.path || ".");
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return {
      content: [
        {
          type: "text",
          text: entries
            .map((e) => (e.isDirectory() ? `[DIR] ${e.name}` : `[FILE] ${e.name}`))
            .join("\n"),
        },
      ],
    };
  }

  if (name === "read_file") {
    const fullPath = resolveSecurePath(args.path);
    const raw = await fs.readFile(fullPath, "utf-8");
    const lines = raw.split(/\r?\n/);
    const totalLines = lines.length;

    const MAX_LINES = 2000;
    const offset = Math.max(1, args.offset || 1);
    const limit = args.limit || totalLines;
    const startIdx = offset - 1; // 轉為 0-based
    const slice = lines.slice(startIdx, startIdx + limit);

    const truncated = !args.offset && !args.limit && totalLines > MAX_LINES;
    const output = truncated ? lines.slice(0, MAX_LINES) : slice;
    const actualEnd = truncated ? MAX_LINES : Math.min(startIdx + limit, totalLines);

    let header = `📄 ${args.path}（${totalLines} 行，顯示 ${offset}–${actualEnd}）`;
    if (truncated) {
      header += `\n⚠️ 檔案過大，已截斷為前 ${MAX_LINES} 行。使用 offset/limit 參數分段讀取。`;
    }

    const numbered = output.map((line, i) => {
      const lineNum = (truncated ? i : startIdx + i) + 1;
      return `${String(lineNum).padStart(5)} | ${line}`;
    });

    return { content: [{ type: "text", text: `${header}\n${numbered.join("\n")}` }] };
  }

  if (name === "read_files_batch") {
    const maxLines = args.summary_lines || 200;
    const results = [];
    args.paths = normalizeArrayArg(args.paths);
    for (const p of args.paths) {
      try {
        const fullPath = resolveSecurePath(p);
        const raw = await fs.readFile(fullPath, "utf-8");
        const lines = raw.split(/\r?\n/);
        const truncated = lines.length > maxLines;
        const output = truncated ? lines.slice(0, maxLines) : lines;
        const numbered = output.map((line, i) => `${String(i + 1).padStart(5)} | ${line}`);
        let header = `📄 ${p}（${lines.length} 行${truncated ? `，顯示前 ${maxLines} 行` : ""}）`;
        results.push(`${header}\n${numbered.join("\n")}`);
      } catch (err) {
        results.push(`❌ ${p}：${err.message}`);
      }
    }
    return { content: [{ type: "text", text: results.join("\n\n---\n\n") }] };
  }

  if (name === "list_files_batch") {
    const results = [];
    args.paths = normalizeArrayArg(args.paths);
    for (const p of args.paths) {
      try {
        const fullPath = resolveSecurePath(p || ".");
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? `[DIR] ${e.name}` : `[FILE] ${e.name}`));
        results.push(`📁 ${p}（${entries.length} 項）:\n${lines.join("\n")}`);
      } catch (err) {
        results.push(`❌ ${p}：${err.message}`);
      }
    }
    return { content: [{ type: "text", text: results.join("\n\n") }] };
  }

  if (name === "create_file") {
    checkProtected(args.path);
    const fullPath = resolveSecurePath(args.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, args.content, "utf-8");
    return { content: [{ type: "text", text: `✅ 檔案已建立: ${args.path}` }] };
  }

  if (name === "create_file_batch") {
    if (!args.files || args.files.length === 0) {
      return { isError: true, content: [{ type: "text", text: "files 陣列不可為空。" }] };
    }
    const results = [];
    let okCount = 0;
    for (const file of args.files) {
      try {
        checkProtected(file.path);
        const fullPath = resolveSecurePath(file.path);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, file.content, "utf-8");
        results.push(`✅ ${file.path}`);
        okCount++;
      } catch (err) {
        results.push(`❌ ${file.path}：${err.message}`);
      }
    }
    return {
      content: [{ type: "text", text: `批次建立完成：${okCount}/${args.files.length} 成功\n\n${results.join("\n")}` }],
    };
  }

  if (name === "list_files_recursive") {
    const DEFAULT_EXCLUDE = [".zip", ".rar", ".exe", ".apk", ".mp4", ".mov", ".tar", ".gz", "node_modules", ".git", "bin", "obj", ".vs", "packages"];
    let exclude = args.exclude || DEFAULT_EXCLUDE;
    if (!Array.isArray(exclude)) exclude = String(exclude).split(",").map(s => s.trim());
    const maxDepth = args.max_depth ?? 3;
    const dirsOnly = args.dirs_only || false;
    const maxEntries = args.max_entries || 500;

    const rootFull = resolveSecurePath(args.path);
    const lines = [];
    let count = 0;
    let truncated = false;

    async function walk(dir, depth, prefix) {
      if (count >= maxEntries) { truncated = true; return; }
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch { return; }

      for (let i = 0; i < entries.length; i++) {
        if (count >= maxEntries) { truncated = true; return; }
        const e = entries[i];
        const isLast = i === entries.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const childPrefix = prefix + (isLast ? "    " : "│   ");

        // 排除檢查
        const nameL = e.name.toLowerCase();
        if (exclude.some(ex => nameL.includes(ex.toLowerCase()))) continue;

        if (e.isDirectory()) {
          lines.push(`${prefix}${connector}📁 ${e.name}`);
          count++;
          if (maxDepth === 0 || depth < maxDepth) {
            await walk(path.join(dir, e.name), depth + 1, childPrefix);
          }
        } else if (!dirsOnly) {
          lines.push(`${prefix}${connector}${e.name}`);
          count++;
        }
      }
    }

    await walk(rootFull, 1, "");
    let header = `📂 ${args.path}（${count} 項，深度 ${maxDepth === 0 ? "無限" : maxDepth}）`;
    if (truncated) header += `\n⚠️ 已達上限 ${maxEntries} 項，結果被截斷。請縮小範圍或增加 max_entries。`;
    return { content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }] };
  }

  if (name === "apply_diff") {
    checkProtected(args.path);
    const fullPath = resolveSecurePath(args.path);
    const raw = await fs.readFile(fullPath, "utf-8");

    // 偵測原始檔案的換行風格
    const hasCRLF = raw.includes("\r\n");
    const normalize = (s) => s.replace(/\r\n/g, "\n");

    const content = normalize(raw);
    const search = normalize(args.search);
    const replace = normalize(args.replace);
    const occurrence = args.occurrence === "all" ? "all" : "first";

    let result;
    let matchCount = 0;
    let replacedCount = 0;
    if (content.includes(search)) {
      // 精確比對成功
      matchCount = content.split(search).length - 1;
      if (occurrence === "all") {
        result = content.split(search).join(replace);
        replacedCount = matchCount;
      } else {
        result = content.replace(search, () => replace);
        replacedCount = 1;
      }
    } else {
      // Fallback：縮排容錯比對（tab↔space 正規化）
      const indentNorm = s => s.replace(/^[ \t]+/gm, m => m.replace(/\t/g, '    ').replace(/ {2,}/g, ss => ' '.repeat(ss.length)));
      const cNorm = indentNorm(content);
      const sNorm = indentNorm(search);
      if (cNorm.includes(sNorm)) {
        // 找到正規化後的位置，用原始 content 的對應行做替換
        const normIdx = cNorm.indexOf(sNorm);
        const beforeMatch = cNorm.slice(0, normIdx);
        const matchLineStart = beforeMatch.lastIndexOf('\n') + 1;
        const matchLineEnd = normIdx + sNorm.length;
        // 在原始 content 中找對應的行範圍
        const origLines = content.split('\n');
        const normLines = cNorm.split('\n');
        const startLine = beforeMatch.split('\n').length - 1;
        const searchLineCount = search.split('\n').length;
        const origSlice = origLines.slice(startLine, startLine + searchLineCount).join('\n');
        matchCount = content.split(origSlice).length - 1;
        if (occurrence === "all") {
          result = content.split(origSlice).join(replace);
          replacedCount = matchCount;
        } else {
          result = content.replace(origSlice, () => replace);
          replacedCount = 1;
        }
      } else {
        // 第三層 fallback：whitespace-flexible（所有空白序列視為等價）
        const flexSlice = whitespaceFlexFind(content, search);
        if (flexSlice) {
          matchCount = content.split(flexSlice).length - 1;
          if (occurrence === "all") {
            result = content.split(flexSlice).join(replace);
            replacedCount = matchCount;
          } else {
            result = content.replace(flexSlice, () => replace);
            replacedCount = 1;
          }
        } else {
          throw buildDiffMismatchError(content, search);
        }
      }
    }

    // 還原原始換行風格
    if (hasCRLF) result = result.replace(/\n/g, "\r\n");

    await fs.writeFile(fullPath, result, "utf-8");

    const startLine = content.slice(0, content.indexOf(search)).split("\n").length;
    const removedLines = search.split("\n").length;
    const addedLines = replace.split("\n").length;
    const delta = addedLines - removedLines;
    const deltaStr = delta === 0 ? "±0" : delta > 0 ? `+${delta}` : `${delta}`;
    const unprocessed = matchCount - replacedCount;
    const isPartial = unprocessed > 0;
    const icon = isPartial ? "⚠️" : "✅";
    const occNote = matchCount > 1
      ? `（匹配 ${matchCount} 處，已處理 ${replacedCount}${isPartial ? `，剩 ${unprocessed} 處未處理，如需全部替換請傳 occurrence:"all"` : ""}）`
      : "";
    return { content: [{ type: "text", text: `${icon} ${args.path}（第 ${startLine} 行，-${removedLines} +${addedLines} 行，淨 ${deltaStr}）${occNote}` }] };
  }

  if (name === "apply_diff_batch") {
    if (!args.diffs || args.diffs.length === 0) {
      return { isError: true, content: [{ type: "text", text: "diffs 陣列不可為空。" }] };
    }
    const normalize = (s) => s.replace(/\r\n/g, "\n");
    const results = [];
    let okCount = 0;
    let partialCount = 0;

    for (const diff of args.diffs) {
      try {
        checkProtected(diff.path);
        const fullPath = resolveSecurePath(diff.path);
        const raw = await fs.readFile(fullPath, "utf-8");
        const hasCRLF = raw.includes("\r\n");

        const content = normalize(raw);
        const search = normalize(diff.search);
        const replace = normalize(diff.replace);
        const occurrence = diff.occurrence === "all" ? "all" : "first";

        let result;
        let matchCount = 0;
        let replacedCount = 0;
        if (content.includes(search)) {
          matchCount = content.split(search).length - 1;
          if (occurrence === "all") {
            result = content.split(search).join(replace);
            replacedCount = matchCount;
          } else {
            result = content.replace(search, () => replace);
            replacedCount = 1;
          }
        } else {
          // Fallback：縮排容錯比對
          const indentNorm = s => s.replace(/^[ \t]+/gm, m => m.replace(/\t/g, '    ').replace(/ {2,}/g, ss => ' '.repeat(ss.length)));
          const cNorm = indentNorm(content);
          const sNorm = indentNorm(search);
          if (cNorm.includes(sNorm)) {
            const normIdx = cNorm.indexOf(sNorm);
            const beforeMatch = cNorm.slice(0, normIdx);
            const origLines = content.split('\n');
            const startLine = beforeMatch.split('\n').length - 1;
            const searchLineCount = search.split('\n').length;
            const origSlice = origLines.slice(startLine, startLine + searchLineCount).join('\n');
            matchCount = content.split(origSlice).length - 1;
            if (occurrence === "all") {
              result = content.split(origSlice).join(replace);
              replacedCount = matchCount;
            } else {
              result = content.replace(origSlice, () => replace);
              replacedCount = 1;
            }
          } else {
            // 第三層 fallback：whitespace-flexible
            const flexSlice = whitespaceFlexFind(content, search);
            if (flexSlice) {
              matchCount = content.split(flexSlice).length - 1;
              if (occurrence === "all") {
                result = content.split(flexSlice).join(replace);
                replacedCount = matchCount;
              } else {
                result = content.replace(flexSlice, () => replace);
                replacedCount = 1;
              }
            } else {
              const errMsg = buildDiffMismatchError(content, search).message.replace(/\n/g, ' | ');
              results.push(`❌ ${diff.path}：${errMsg}`);
              continue;
            }
          }
        }
        if (hasCRLF) result = result.replace(/\n/g, "\r\n");

        await fs.writeFile(fullPath, result, "utf-8");
        const startLine = content.slice(0, content.indexOf(search)).split("\n").length;
        const removedLines = search.split("\n").length;
        const addedLines = replace.split("\n").length;
        const delta = addedLines - removedLines;
        const deltaStr = delta === 0 ? "±0" : delta > 0 ? `+${delta}` : `${delta}`;
        const unprocessed = matchCount - replacedCount;
        const isPartial = unprocessed > 0;
        const icon = isPartial ? "⚠️" : "✅";
        const occNote = matchCount > 1
          ? `（匹配 ${matchCount}，處理 ${replacedCount}${isPartial ? `，剩 ${unprocessed} 未處理，如需全部替換請傳 occurrence:"all"` : ""}）`
          : "";
        results.push(`${icon} ${diff.path}（第 ${startLine} 行，-${removedLines} +${addedLines} 行，淨 ${deltaStr}）${occNote}`);
        okCount++;
        if (isPartial) partialCount++;
      } catch (err) {
        results.push(`❌ ${diff.path}：${err.message}`);
      }
    }

    const partialNote = partialCount > 0
      ? `\n⚠️ 其中 ${partialCount} 項有多重匹配未全替換（預設 occurrence:"first"），請檢視 ⚠️ 標記的檔案是否需補跑 occurrence:"all"。`
      : "";
    return {
      content: [{ type: "text", text: `批次修改完成：${okCount}/${args.diffs.length} 成功${partialNote}\n\n${results.join("\n")}` }],
    };
  }
}
