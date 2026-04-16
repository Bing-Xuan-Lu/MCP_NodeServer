import fs from "fs/promises";
import path from "path";
import { resolveSecurePath } from "../../config.js";
import { validateArgs } from "../_shared/utils.js";

// 防 Reward Hacking：保護測試相關檔案，防止 Claude 為了讓測試通過而修改測試本身
const PROTECTED_PATTERNS = [
  /\btests?\//i,              // tests/ 或 test/ 目錄
  /__tests__\//i,             // __tests__/ 目錄
  /\.test\.(php|js|ts)$/i,    // *.test.php / *.test.js / *.test.ts
  /_test\.(php|js|ts)$/i,     // *_test.php / *_test.js
  /Test\.php$/,               // PHPUnit 慣例：*Test.php
  /_mcp_audit\.log$/i,        // SQL audit log（append-only，不可被覆寫）
];

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

    let result;
    if (content.includes(search)) {
      // 精確比對成功
      result = content.replace(search, () => replace);
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
        result = content.replace(origSlice, () => replace);
      } else {
        const preview = search.slice(0, 80).replace(/\n/g, "\\n");
        throw new Error(`比對失敗：找不到 search 區塊（前 80 字元：${preview}）`);
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
    return { content: [{ type: "text", text: `✅ ${args.path}（第 ${startLine} 行，-${removedLines} +${addedLines} 行，淨 ${deltaStr}）` }] };
  }

  if (name === "apply_diff_batch") {
    if (!args.diffs || args.diffs.length === 0) {
      return { isError: true, content: [{ type: "text", text: "diffs 陣列不可為空。" }] };
    }
    const normalize = (s) => s.replace(/\r\n/g, "\n");
    const results = [];
    let okCount = 0;

    for (const diff of args.diffs) {
      try {
        checkProtected(diff.path);
        const fullPath = resolveSecurePath(diff.path);
        const raw = await fs.readFile(fullPath, "utf-8");
        const hasCRLF = raw.includes("\r\n");

        const content = normalize(raw);
        const search = normalize(diff.search);
        const replace = normalize(diff.replace);

        let result;
        if (content.includes(search)) {
          result = content.replace(search, () => replace);
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
            result = content.replace(origSlice, () => replace);
          } else {
            const preview = search.slice(0, 80).replace(/\n/g, "\\n");
            results.push(`❌ ${diff.path}：比對失敗（前 80 字元：${preview}）`);
            continue;
          }
        }
        if (hasCRLF) result = result.replace(/\n/g, "\r\n");

        await fs.writeFile(fullPath, result, "utf-8");
        const startLine = content.slice(0, content.indexOf(search)).split("\n").length;
        const removedLines = search.split("\n").length;
        const addedLines = replace.split("\n").length;
        const delta = addedLines - removedLines;
        const deltaStr = delta === 0 ? "±0" : delta > 0 ? `+${delta}` : `${delta}`;
        results.push(`✅ ${diff.path}（第 ${startLine} 行，-${removedLines} +${addedLines} 行，淨 ${deltaStr}）`);
        okCount++;
      } catch (err) {
        results.push(`❌ ${diff.path}：${err.message}`);
      }
    }

    return {
      content: [{ type: "text", text: `批次修改完成：${okCount}/${args.diffs.length} 成功\n\n${results.join("\n")}` }],
    };
  }
}
