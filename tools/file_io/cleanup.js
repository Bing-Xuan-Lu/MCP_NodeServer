import fs from "fs/promises";
import path from "path";

// 白名單：只允許這些路徑下的遞迴刪除（避免誤刪業務資料）
// 規則：路徑經正規化後必須以下列任一 prefix 開頭，且不可包含 `..`
const ALLOWED_PREFIXES = [
  "D:/tmp/",
  "C:/Users/tarag/AppData/Local/Temp/",
  "/tmp/",
];

// 額外允許：路徑中含這些 segment（更彈性，覆蓋專案內 _tmp_remote/_drift 暫存）
const ALLOWED_SEGMENTS = [
  "/_tmp_remote/",
  "/_drift/",
  "/_tmp/",
  "/.tmp/",
];

function normalize(p) {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isAllowed(absPath) {
  const norm = normalize(absPath);
  if (norm.includes("/../") || norm.includes("/..\\")) return false;
  if (ALLOWED_PREFIXES.some((pre) => norm.toLowerCase().startsWith(pre.toLowerCase()))) return true;
  if (ALLOWED_SEGMENTS.some((seg) => norm.toLowerCase().includes(seg.toLowerCase()))) return true;
  return false;
}

export const definitions = [
  {
    name: "cleanup_path",
    description:
      "白名單 tmp 路徑安全遞迴刪除。僅允許刪除 D:/tmp/、系統 Temp、或路徑含 /_tmp_remote/ /_drift/ /_tmp/ /.tmp/ 等明確暫存 segment。需 confirm:true。\n" +
      "用途：drift 比對 / sftp 暫存清理，避開 Bash rm -rf 與 # mcp-fallback 計數。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要刪除的絕對路徑（檔案或目錄）",
        },
        confirm: {
          type: "boolean",
          description: "必須 true 才實際執行刪除",
        },
        dry_run: {
          type: "boolean",
          description: "預覽會刪掉什麼，不實際刪除",
        },
      },
      required: ["path"],
    },
  },
];

async function listEntries(target) {
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) return [{ path: target, type: "file" }];
    const out = [];
    async function walk(dir) {
      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) {
          await walk(full);
          out.push({ path: full, type: "dir" });
        } else {
          out.push({ path: full, type: "file" });
        }
      }
    }
    await walk(target);
    out.push({ path: target, type: "dir" });
    return out;
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

export async function handle(name, args) {
  if (name !== "cleanup_path") return null;

  const target = args?.path;
  if (!target) {
    return { content: [{ type: "text", text: "錯誤：缺少 path 參數" }], isError: true };
  }

  const absPath = path.isAbsolute(target) ? target : path.resolve(target);
  if (!isAllowed(absPath)) {
    return {
      content: [
        {
          type: "text",
          text:
            `❌ 拒絕：「${absPath}」不在白名單內。\n` +
            `允許的路徑 prefix：${ALLOWED_PREFIXES.join(", ")}\n` +
            `允許的 segment：${ALLOWED_SEGMENTS.join(", ")}\n` +
            `如需清理其他路徑，請手動處理或先 mv 到白名單目錄。`,
        },
      ],
      isError: true,
    };
  }

  const entries = await listEntries(absPath);
  if (entries.length === 0) {
    return { content: [{ type: "text", text: `路徑不存在或已清空：${absPath}` }] };
  }

  if (args.dry_run) {
    const preview = entries.slice(0, 50).map((e) => `  ${e.type === "dir" ? "[D]" : "[F]"} ${e.path}`).join("\n");
    const more = entries.length > 50 ? `\n  ... 共 ${entries.length} 項（顯示前 50）` : "";
    return {
      content: [
        {
          type: "text",
          text: `[dry_run] 將刪除 ${entries.length} 項：\n${preview}${more}\n\n要實際執行請加 confirm:true（移除 dry_run）`,
        },
      ],
    };
  }

  if (!args.confirm) {
    return {
      content: [
        {
          type: "text",
          text:
            `⚠️ 即將刪除 ${entries.length} 項於：${absPath}\n` +
            `要繼續請加 confirm:true，或先用 dry_run:true 預覽。`,
        },
      ],
      isError: true,
    };
  }

  let deleted = 0,
    errors = [];
  try {
    const stat = await fs.stat(absPath);
    if (stat.isDirectory()) {
      await fs.rm(absPath, { recursive: true, force: true });
    } else {
      await fs.unlink(absPath);
    }
    deleted = entries.length;
  } catch (e) {
    errors.push(e.message);
  }

  return {
    content: [
      {
        type: "text",
        text:
          `✅ 已清除 ${deleted} 項：${absPath}` +
          (errors.length ? `\n部分錯誤：${errors.join("; ")}` : ""),
      },
    ],
  };
}
