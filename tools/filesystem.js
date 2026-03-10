import fs from "fs/promises";
import path from "path";
import { resolveSecurePath } from "../config.js";

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

  if (name === "create_file") {
    const fullPath = resolveSecurePath(args.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, args.content, "utf-8");
    return { content: [{ type: "text", text: `✅ 檔案已建立: ${args.path}` }] };
  }

  if (name === "apply_diff") {
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
