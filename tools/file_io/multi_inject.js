// tools/file_io/multi_inject.js — multi_file_inject
// 跨檔案 anchor-based 插入相同片段（11 檔同步 CSS、header 注入等場景）
// 自動處理 CRLF/LF + indent 偵測 + idempotent skip

import fs from "fs/promises";
import { resolveSecurePath } from "../../config.js";
import { validateArgs } from "../_shared/utils.js";

export const definitions = [
  {
    name: "multi_file_inject",
    description:
      "跨多個檔案以 anchor 為基準插入相同片段（CSS link、header 注入、共用 import 等場景）。" +
      "自動偵測 CRLF/LF、可繼承 anchor 縮排、可 idempotent 跳過已含內容的檔案。" +
      "比 apply_diff_batch 更靈活：只需錨點不需精確 old_string。",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "要修改的檔案路徑清單（相對 basePath 或絕對路徑）",
        },
        anchor: {
          type: "string",
          description: "錨點字串（每行第一個出現處），或設 anchor_regex 改用 regex 匹配",
        },
        anchor_regex: {
          type: "string",
          description: "錨點 regex（pattern 字串，flags 固定為 m）。與 anchor 二擇一。",
        },
        position: {
          type: "string",
          enum: ["before", "after", "replace_line"],
          description: "插入位置：錨點行的前/後，或取代整行",
          default: "after",
        },
        content: {
          type: "string",
          description: "要插入的內容（多行用 \\n 分隔，不需在尾端加換行）",
        },
        preserve_indent: {
          type: "boolean",
          description: "是否將 anchor 行的縮排前綴套到每行 content（預設 true）",
          default: true,
        },
        skip_if_present: {
          type: "boolean",
          description: "若檔案已含 content（精確比對 trim 後）則跳過此檔（idempotent，預設 true）",
          default: true,
        },
        match_occurrence: {
          type: "string",
          enum: ["first", "last", "all"],
          description: "錨點命中多次時要插在哪一個位置（預設 first；all 會在每個命中處都插入）",
          default: "first",
        },
        dry_run: {
          type: "boolean",
          description: "預演模式：只回報會做什麼，不寫入檔案",
          default: false,
        },
      },
      required: ["files", "content"],
    },
  },
];

function detectEol(text) {
  return /\r\n/.test(text) ? "\r\n" : "\n";
}

function getIndent(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1] : "";
}

function applyIndent(content, indent) {
  if (!indent) return content;
  return content
    .split("\n")
    .map((l) => (l.length > 0 ? indent + l : l))
    .join("\n");
}

function findAnchorLines(lines, anchor, anchorRegex) {
  const re = anchorRegex ? new RegExp(anchorRegex) : null;
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (re ? re.test(lines[i]) : lines[i].includes(anchor)) {
      hits.push(i);
    }
  }
  return hits;
}

async function processFile(filePath, opts) {
  const {
    anchor, anchorRegex, position, content,
    preserveIndent, skipIfPresent, matchOccurrence, dryRun,
  } = opts;

  let original;
  try {
    original = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    return { file: filePath, status: "error", message: `讀取失敗：${err.message}` };
  }

  if (skipIfPresent && original.includes(content.trim())) {
    return { file: filePath, status: "skipped_present", message: "檔案已含目標內容" };
  }

  const eol = detectEol(original);
  const lines = original.split(/\r?\n/);
  const hits = findAnchorLines(lines, anchor, anchorRegex);

  if (hits.length === 0) {
    return { file: filePath, status: "anchor_not_found", message: `錨點未匹配：${anchor || anchorRegex}` };
  }

  // 決定插入位置（從後往前處理避免行號偏移）
  let targets;
  if (matchOccurrence === "all") targets = [...hits].reverse();
  else if (matchOccurrence === "last") targets = [hits[hits.length - 1]];
  else targets = [hits[0]];

  const insertedLineNumbers = [];
  for (const lineIdx of targets) {
    const indent = preserveIndent ? getIndent(lines[lineIdx]) : "";
    const block = applyIndent(content, indent);
    const blockLines = block.split("\n");

    if (position === "before") {
      lines.splice(lineIdx, 0, ...blockLines);
      insertedLineNumbers.push(lineIdx + 1);
    } else if (position === "replace_line") {
      lines.splice(lineIdx, 1, ...blockLines);
      insertedLineNumbers.push(lineIdx + 1);
    } else {
      // after
      lines.splice(lineIdx + 1, 0, ...blockLines);
      insertedLineNumbers.push(lineIdx + 2);
    }
  }

  const updated = lines.join(eol);
  if (!dryRun) {
    try {
      await fs.writeFile(filePath, updated, "utf-8");
    } catch (err) {
      return { file: filePath, status: "error", message: `寫入失敗：${err.message}` };
    }
  }

  return {
    file: filePath,
    status: dryRun ? "would_insert" : "inserted",
    inserted_at_lines: insertedLineNumbers,
    eol: eol === "\r\n" ? "CRLF" : "LF",
    indent_preserved: preserveIndent && getIndent(lines[targets[0]]) !== "",
  };
}

export async function handle(name, args) {
  const def = definitions.find((d) => d.name === name);
  if (!def) return undefined;
  args = validateArgs(def.inputSchema, args);

  if (name !== "multi_file_inject") return undefined;

  const {
    files,
    anchor,
    anchor_regex: anchorRegex,
    position = "after",
    content,
    preserve_indent: preserveIndent = true,
    skip_if_present: skipIfPresent = true,
    match_occurrence: matchOccurrence = "first",
    dry_run: dryRun = false,
  } = args;

  if (!anchor && !anchorRegex) {
    return {
      isError: true,
      content: [{ type: "text", text: "需提供 anchor 或 anchor_regex 之一。" }],
    };
  }
  if (anchor && anchorRegex) {
    return {
      isError: true,
      content: [{ type: "text", text: "anchor 與 anchor_regex 二擇一，不可同時提供。" }],
    };
  }

  const results = [];
  for (const f of files) {
    const resolved = resolveSecurePath(f);
    const r = await processFile(resolved, {
      anchor, anchorRegex, position, content,
      preserveIndent, skipIfPresent, matchOccurrence, dryRun,
    });
    results.push(r);
  }

  // 摘要表格
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  const lines = [
    `${dryRun ? "🔍 multi_file_inject (DRY RUN)" : "✏️ multi_file_inject"} — ${files.length} 檔`,
    `📊 ${summary}`,
    ``,
    `| 檔案 | 狀態 | 行號 | EOL | 縮排 | 訊息 |`,
    `|------|------|------|-----|------|------|`,
  ];
  for (const r of results) {
    lines.push(
      `| ${r.file} | ${r.status} | ${(r.inserted_at_lines || []).join(",") || "-"} | ${r.eol || "-"} | ${r.indent_preserved ? "✓" : "-"} | ${r.message || ""} |`
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
