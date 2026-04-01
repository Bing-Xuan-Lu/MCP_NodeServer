import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import { resolveSecurePath, CONFIG } from "../config.js";

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "file_to_prompt",
    description:
      "將多個檔案內容打包成結構化 prompt（支援 glob pattern）。" +
      "用途：一次將整個模組/目錄的程式碼餵給 LLM，免手動逐檔指定。",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "檔案路徑清單（相對 basePath 或絕對路徑）",
        },
        glob: {
          type: "string",
          description:
            "glob pattern（如 PG_dbox3/admin/**/*.php）。相對 basePath 解析。",
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description:
            "排除的 glob pattern（如 ['**/vendor/**', '**/node_modules/**']）",
        },
        format: {
          type: "string",
          enum: ["xml", "markdown", "plain"],
          description: "輸出格式（預設 xml，LLM 最容易解析）",
          default: "xml",
        },
        max_lines: {
          type: "integer",
          description: "每檔最多行數，0=不限（預設 500）",
          default: 500,
        },
        max_files: {
          type: "integer",
          description: "最多處理幾個檔案（預設 50，防止意外展開太多）",
          default: 50,
        },
        show_tree: {
          type: "boolean",
          description: "是否在開頭顯示檔案樹狀結構（預設 true）",
          default: true,
        },
      },
    },
  },
  {
    name: "file_to_prompt_preview",
    description:
      "預覽 file_to_prompt 會匹配哪些檔案（不讀取內容，僅列出檔案清單與大小）。" +
      "用於確認 glob pattern 正確後再執行 file_to_prompt。",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "檔案路徑清單",
        },
        glob: {
          type: "string",
          description: "glob pattern",
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "排除的 glob pattern",
        },
      },
    },
  },
];

// ============================================
// 內部工具函式
// ============================================

/** 收集所有目標檔案（paths + glob 合併去重） */
async function collectFiles(args) {
  const fileSet = new Set();

  // 1. 明確指定的路徑
  if (args.paths && args.paths.length > 0) {
    for (const p of args.paths) {
      fileSet.add(resolveSecurePath(p));
    }
  }

  // 2. glob pattern 展開
  if (args.glob) {
    const basePath = CONFIG.basePath.replace(/\\/g, "/");
    const pattern = args.glob.replace(/\\/g, "/");
    const fullPattern = path.isAbsolute(pattern)
      ? pattern
      : `${basePath}${pattern}`;

    const defaultExclude = [
      "**/node_modules/**",
      "**/vendor/**",
      "**/.git/**",
      "**/storage/framework/**",
    ];
    const userExclude = (args.exclude || []).map((e) => e.replace(/\\/g, "/"));
    const ignore = [...defaultExclude, ...userExclude];

    const matches = await glob(fullPattern, {
      nodir: true,
      ignore,
      windowsPathsNoEscape: true,
    });

    for (const m of matches) {
      // resolveSecurePath 會驗證安全性
      try {
        fileSet.add(resolveSecurePath(m));
      } catch {
        // 跳過不在允許範圍的檔案
      }
    }
  }

  return [...fileSet].sort();
}

/** 產生檔案樹狀結構 */
function buildTree(filePaths, basePath) {
  const normalized = basePath.replace(/\\/g, "/").replace(/\/$/, "");
  const relatives = filePaths.map((f) => {
    const rel = f.replace(/\\/g, "/").replace(normalized + "/", "");
    return rel;
  });

  // 簡易樹狀：依目錄分組
  const dirs = {};
  for (const rel of relatives) {
    const dir = path.dirname(rel).replace(/\\/g, "/");
    if (!dirs[dir]) dirs[dir] = [];
    dirs[dir].push(path.basename(rel));
  }

  const lines = [];
  const sortedDirs = Object.keys(dirs).sort();
  for (const dir of sortedDirs) {
    lines.push(`📁 ${dir}/`);
    for (const file of dirs[dir].sort()) {
      lines.push(`   ${file}`);
    }
  }
  return lines.join("\n");
}

/** 取得相對路徑（用於顯示） */
function getRelativePath(fullPath) {
  const base = CONFIG.basePath.replace(/\\/g, "/").replace(/\/$/, "");
  const full = fullPath.replace(/\\/g, "/");
  if (full.startsWith(base + "/")) {
    return full.slice(base.length + 1);
  }
  return full;
}

/** 格式化單一檔案 */
function formatFile(relPath, content, format) {
  switch (format) {
    case "xml":
      return `<file path="${relPath}">\n${content}\n</file>`;
    case "markdown":
      // 從副檔名推斷語言
      const ext = path.extname(relPath).slice(1);
      const langMap = {
        php: "php", js: "javascript", ts: "typescript", py: "python",
        css: "css", html: "html", sql: "sql", json: "json", md: "markdown",
        sh: "bash", yml: "yaml", yaml: "yaml", xml: "xml",
      };
      const lang = langMap[ext] || ext || "";
      return `### ${relPath}\n\n\`\`\`${lang}\n${content}\n\`\`\``;
    case "plain":
      return `=== ${relPath} ===\n${content}\n=== end ===`;
    default:
      return `<file path="${relPath}">\n${content}\n</file>`;
  }
}

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  if (name === "file_to_prompt_preview") {
    const files = await collectFiles(args);

    if (files.length === 0) {
      return {
        content: [{ type: "text", text: "⚠️ 沒有匹配到任何檔案。請檢查路徑或 glob pattern。" }],
      };
    }

    // 取得每個檔案的大小
    const info = [];
    let totalSize = 0;
    for (const f of files) {
      try {
        const stat = await fs.stat(f);
        totalSize += stat.size;
        info.push(`  ${getRelativePath(f)}  (${formatSize(stat.size)})`);
      } catch {
        info.push(`  ${getRelativePath(f)}  (無法讀取)`);
      }
    }

    const summary = [
      `📋 匹配 ${files.length} 個檔案，總計 ${formatSize(totalSize)}`,
      "",
      ...info,
    ];

    return { content: [{ type: "text", text: summary.join("\n") }] };
  }

  if (name === "file_to_prompt") {
    const files = await collectFiles(args);
    const format = args.format || "xml";
    const maxLines = args.max_lines ?? 500;
    const maxFiles = args.max_files ?? 50;
    const showTree = args.show_tree ?? true;

    if (files.length === 0) {
      return {
        content: [{ type: "text", text: "⚠️ 沒有匹配到任何檔案。請檢查路徑或 glob pattern。" }],
      };
    }

    if (files.length > maxFiles) {
      return {
        content: [{
          type: "text",
          text:
            `⚠️ 匹配到 ${files.length} 個檔案，超過上限 ${maxFiles}。\n` +
            `請縮小 glob 範圍或增加 max_files 參數。\n` +
            `提示：先用 file_to_prompt_preview 確認範圍。`,
        }],
      };
    }

    const parts = [];

    // 檔案樹
    if (showTree) {
      parts.push(`📁 檔案結構（${files.length} 個檔案）：\n${buildTree(files, CONFIG.basePath)}\n`);
    }

    // 逐檔讀取 + 格式化
    let totalLines = 0;
    let truncatedCount = 0;

    for (const f of files) {
      const relPath = getRelativePath(f);
      try {
        const raw = await fs.readFile(f, "utf-8");
        const lines = raw.split(/\r?\n/);
        totalLines += lines.length;

        let content;
        if (maxLines > 0 && lines.length > maxLines) {
          content = lines.slice(0, maxLines).join("\n") +
            `\n... (截斷：共 ${lines.length} 行，僅顯示前 ${maxLines} 行)`;
          truncatedCount++;
        } else {
          content = lines.join("\n");
        }

        parts.push(formatFile(relPath, content, format));
      } catch (err) {
        parts.push(formatFile(relPath, `❌ 讀取失敗：${err.message}`, format));
      }
    }

    // 統計摘要
    const stats = [
      `📊 共 ${files.length} 個檔案，${totalLines} 行`,
    ];
    if (truncatedCount > 0) {
      stats.push(`（${truncatedCount} 個檔案因超過 ${maxLines} 行被截斷）`);
    }
    parts.push(stats.join(""));

    return { content: [{ type: "text", text: parts.join("\n\n") }] };
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
