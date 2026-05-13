// tools/system/php_text_search.js — php_text_search
// 純文字搜尋 PHP 專案：SQL 表名、字串常數、註解、設定關鍵字等
// AST 工具失靈時的合法 escape valve（不必再 # mcp-fallback: 繞 hook）
// 不支援搜 class/function/method 名稱——那是 symbol_index / class_method_lookup 的職責

import path from "path";
import { glob } from "glob";
import fs from "fs/promises";
import { validateArgs } from "../_shared/utils.js";
import { resolveSecurePath } from "../../config.js";

// 拒絕的 pattern：用來搜 PHP 結構符號的，應該走 AST
const STRUCTURAL_PATTERNS = [
  { re: /^\s*function\s+\w+\s*\(/i, hint: "搜函式定義 → symbol_index / class_method_lookup" },
  { re: /^\s*(public|protected|private)\s+(static\s+)?function\s+/i, hint: "搜方法定義 → class_method_lookup" },
  { re: /^\s*(abstract\s+)?class\s+\w+/i, hint: "搜 class 定義 → symbol_index / find_hierarchy" },
  { re: /^\s*(extends|implements)\s+\w+/i, hint: "搜繼承關係 → find_hierarchy" },
  { re: /^->\w+\s*\(/, hint: "搜 method 呼叫 → find_usages" },
  { re: /^::\w+\s*\(/, hint: "搜靜態方法呼叫 → find_usages" },
];

export const definitions = [
  {
    name: "php_text_search",
    description:
      "PHP 專案純文字搜尋（SQL 表名/欄位、字串常數、註解、設定 key 等）。AST 工具不適用時的合法路徑——不必加 # mcp-fallback: 繞 hook。\n" +
      "**禁用情境**：搜 class/function/method 定義或呼叫。請改用 symbol_index / class_method_lookup / find_usages。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "專案資料夾名稱（相對 basePath，可含父層）" },
        pattern: { type: "string", description: "搜尋字串或 regex（依 use_regex 決定）" },
        use_regex: { type: "boolean", description: "是否將 pattern 視為 regex（預設 false 純文字）", default: false },
        case_sensitive: { type: "boolean", description: "是否區分大小寫（預設 false）", default: false },
        scope: {
          type: "array",
          items: { type: "string" },
          description: "限縮搜尋的子目錄（相對專案根，如 [\"adminControl\", \"cls/model\"]）",
        },
        glob: {
          type: "string",
          description: "檔案 glob（預設 **/*.php，可改為 **/*.{php,inc} 等）",
          default: "**/*.php",
        },
        max_results: { type: "number", description: "結果上限（預設 100）", default: 100 },
        context_lines: { type: "number", description: "每個結果前後顯示行數（預設 0）", default: 0 },
        force_full_scan: {
          type: "boolean",
          description: "明確覆寫全專案散搜門檻（無 scope 且專案 .php > 1500 時必要）。請先評估能否補 scope 或改用 DB schema 查詢。",
          default: false,
        },
      },
      required: ["project", "pattern"],
    },
  },
];

const FULL_SCAN_THRESHOLD = 1500;

function checkStructural(pattern, useRegex) {
  // pattern 形似 PHP 結構語法 → 拒絕並指引正確工具
  for (const sp of STRUCTURAL_PATTERNS) {
    // 直接看 pattern 是否匹配結構正則（無論 use_regex）
    if (sp.re.test(pattern)) return sp.hint;
  }
  return null;
}

async function resolveNestedProject(projectPath) {
  try { await fs.access(projectPath); return projectPath; } catch {}
  const projectName = path.basename(projectPath);
  const parent = path.dirname(projectPath);
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const candidate = path.join(parent, ent.name, projectName);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) return candidate;
      } catch {}
    }
  } catch {}
  return projectPath;
}

export async function handle(name, args) {
  const def = definitions.find((d) => d.name === name);
  if (!def) return undefined;
  args = validateArgs(def.inputSchema, args);
  if (name !== "php_text_search") return undefined;

  const {
    project, pattern,
    use_regex: useRegex = false,
    case_sensitive: caseSensitive = false,
    scope, glob: globPattern = "**/*.php",
    max_results: maxResults = 100,
    context_lines: contextLines = 0,
    force_full_scan: forceFullScan = false,
  } = args;

  // 結構搜尋拒絕
  const structHint = checkStructural(pattern, useRegex);
  if (structHint) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `❌ 此 pattern 看起來在搜 PHP 結構語法（class/function/method）。\n` +
              `   php_text_search 僅供搜純文字（SQL、字串常數、註解、設定 key）。\n` +
              `   建議：${structHint}\n` +
              `   如果你真的要搜文字（例如註解中的 "function" 字眼），請改寫 pattern 避開結構樣式。`,
      }],
    };
  }

  let regex;
  try {
    if (useRegex) {
      regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
    } else {
      const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      regex = new RegExp(esc, caseSensitive ? "g" : "gi");
    }
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Regex 解析失敗：${err.message}` }] };
  }

  // 解析專案路徑（含巢狀修正）
  const rawPath = resolveSecurePath(project);
  const projectPath = await resolveNestedProject(rawPath);

  // 收集檔案
  const patterns = scope && scope.length > 0
    ? scope.map((s) => path.posix.join(s.replace(/\\/g, "/"), globPattern))
    : [globPattern];

  const files = [];
  for (const p of patterns) {
    const matched = await glob(p, {
      cwd: projectPath,
      nodir: true,
      ignore: ["vendor/**", "node_modules/**", ".git/**", "uploads/**", "cache/**"],
    });
    files.push(...matched);
  }
  if (files.length === 0) {
    return { content: [{ type: "text", text: `⚠️ 未找到符合 glob (${globPattern}) 的檔案。` }] };
  }

  // 大專案散搜守門：無 scope + 檔案數 > 門檻 → BLOCK（除非明確 force_full_scan）
  const hasScope = scope && Array.isArray(scope) && scope.length > 0;
  if (!hasScope && files.length > FULL_SCAN_THRESHOLD && !forceFullScan) {
    return {
      isError: true,
      content: [{
        type: "text",
        text:
          `❌ 全專案散搜被擋下：${files.length} 個 .php 檔超過門檻 ${FULL_SCAN_THRESHOLD}，命中率通常極低、燒 token。\n` +
          `   pattern="${pattern}"\n\n` +
          `請三擇一：\n` +
          `  (A) 加 scope 縮小範圍（建議）：scope: ["adminControl/xxx", "cls/model"]\n` +
          `  (B) 若搜 DB 欄位名 → 改用 set_database + execute_sql 查 INFORMATION_SCHEMA，比掃檔案精準 100 倍\n` +
          `  (C) 若真的需要全掃 → 加 force_full_scan: true 並在對話內說明理由\n`,
      }],
    };
  }

  const hits = [];
  for (const rel of files) {
    if (hits.length >= maxResults) break;
    const full = path.join(projectPath, rel);
    let content;
    try { content = await fs.readFile(full, "utf-8"); } catch { continue; }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        const ctx = [];
        for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
          ctx.push({ line: j + 1, text: lines[j], match: j === i });
        }
        hits.push({ file: rel.replace(/\\/g, "/"), line: i + 1, text: lines[i], context: contextLines > 0 ? ctx : undefined });
        if (hits.length >= maxResults) break;
      }
    }
  }

  const out = [
    `🔎 php_text_search: ${pattern}${useRegex ? " (regex)" : ""}${caseSensitive ? " (case-sensitive)" : ""}`,
    `📁 ${files.length} 檔掃描，命中 ${hits.length}${hits.length >= maxResults ? " (達上限)" : ""}`,
    ``,
  ];
  if (hits.length === 0) {
    out.push(`未找到匹配。`);
  } else if (contextLines > 0) {
    for (const h of hits) {
      out.push(`📄 ${h.file}:${h.line}`);
      for (const c of h.context) {
        const marker = c.match ? "→" : " ";
        out.push(`  ${marker} ${String(c.line).padStart(5)} | ${c.text}`);
      }
      out.push(``);
    }
  } else {
    for (const h of hits) {
      out.push(`${h.file}:${h.line}: ${h.text.trim().slice(0, 200)}`);
    }
  }
  return { content: [{ type: "text", text: out.join("\n") }] };
}
