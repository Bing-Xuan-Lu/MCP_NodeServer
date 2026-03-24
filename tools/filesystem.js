import fs from "fs/promises";
import path from "path";
import { resolveSecurePath } from "../config.js";

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
];

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
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

    if (!content.includes(search)) {
      // 提供更有用的錯誤訊息：顯示 search 前 80 字元方便除錯
      const preview = search.slice(0, 80).replace(/\n/g, "\\n");
      throw new Error(`比對失敗：找不到 search 區塊（前 80 字元：${preview}）`);
    }

    let result = content.replace(search, replace);

    // 還原原始換行風格
    if (hasCRLF) result = result.replace(/\n/g, "\r\n");

    await fs.writeFile(fullPath, result, "utf-8");
    return { content: [{ type: "text", text: `✅ 檔案已更新: ${args.path}` }] };
  }
}
