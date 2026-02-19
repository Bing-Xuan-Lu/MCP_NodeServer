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
    description: "讀取檔案內容",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
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
    const content = await fs.readFile(fullPath, "utf-8");
    return { content: [{ type: "text", text: content }] };
  }

  if (name === "create_file") {
    const fullPath = resolveSecurePath(args.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, args.content, "utf-8");
    return { content: [{ type: "text", text: `✅ 檔案已建立: ${args.path}` }] };
  }

  if (name === "apply_diff") {
    const fullPath = resolveSecurePath(args.path);
    const content = await fs.readFile(fullPath, "utf-8");
    if (!content.includes(args.search)) throw new Error("比對失敗：找不到 search 區塊");
    await fs.writeFile(fullPath, content.replace(args.search, args.replace), "utf-8");
    return { content: [{ type: "text", text: `✅ 檔案已更新: ${args.path}` }] };
  }
}
