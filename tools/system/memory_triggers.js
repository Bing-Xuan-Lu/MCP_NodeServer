// tools/system/memory_triggers.js
// 批次管理 memory frontmatter 的 `triggers` 欄位，配合 hooks/memory-auto-recall.js
//
// 三個工具：
//   list_memory_triggers — 列出當前專案 memory 與 triggers 狀態（哪些已設、哪些缺）
//   memory_add_triggers — 為單一 memory 設定/更新 triggers
//   memory_remove_triggers — 移除 triggers 欄位

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { validateArgs } from "../_shared/utils.js";

const HOME = process.env.HOME || process.env.USERPROFILE || "";
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "list_memory_triggers",
    description:
      "列出指定專案 memory 目錄下所有 .md 檔的 triggers 設定狀態（未設、已設、值內容）。配合 memory-auto-recall hook 使用。預設掃當前專案，可傳 project_id 改掃別的（如 'd--Project-PG-dbox3'）。",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "~/.claude/projects/ 下的專案 ID（如 d--Project-PG-dbox3）。省略則用當前 CWD 推導。",
        },
        only_missing: {
          type: "boolean",
          description: "只列出尚未設定 triggers 的 memory（預設 false）",
        },
      },
      required: [],
    },
  },
  {
    name: "memory_add_triggers",
    description:
      "為一個 memory .md 檔的 frontmatter 設定或更新 `triggers` 欄位。若該檔已有 triggers，merge_mode='replace' 整段覆蓋（預設）、'merge' 合併陣列。檔案路徑限制在 ~/.claude/projects/*/memory/ 範圍內。",
    inputSchema: {
      type: "object",
      properties: {
        memory_file: {
          type: "string",
          description: "memory .md 絕對路徑，或相對於 ~/.claude/projects/ 的路徑（如 d--Project-PG-dbox3/memory/feedback_xxx.md）",
        },
        triggers: {
          type: "object",
          description: "triggers 內容",
          properties: {
            tools: { type: "array", items: { type: "string" }, description: "tool name 或 glob（mcp__*__apply_diff）" },
            path_patterns: { type: "array", items: { type: "string" }, description: "比對 tool_input JSON 是否含這些字串（lowercase 比對）" },
            prompt_keywords: { type: "array", items: { type: "string" }, description: "比對最近 3 條 user prompt 內文" },
            reinject_after_tool_calls: { type: "integer", description: "幾次 tool call 後重注（預設 30）" },
          },
        },
        merge_mode: {
          type: "string",
          enum: ["replace", "merge"],
          description: "replace = 整段覆蓋；merge = 陣列項目去重合併、純量覆蓋（預設 replace）",
        },
      },
      required: ["memory_file", "triggers"],
    },
  },
  {
    name: "memory_remove_triggers",
    description: "移除指定 memory 的 triggers 欄位，恢復為純 memory（不被 memory-auto-recall hook 注入）。",
    inputSchema: {
      type: "object",
      properties: {
        memory_file: { type: "string", description: "memory .md 路徑（同 memory_add_triggers）" },
      },
      required: ["memory_file"],
    },
  },
];

// ============================================
// 安全路徑解析（限制在 ~/.claude/projects/ 內）
// ============================================
function resolveMemoryPath(input) {
  let p = input;
  if (!path.isAbsolute(p)) {
    p = path.join(PROJECTS_DIR, p);
  }
  p = path.resolve(p);
  const projectsResolved = path.resolve(PROJECTS_DIR);
  if (!p.startsWith(projectsResolved)) {
    throw new Error(`路徑必須在 ${PROJECTS_DIR} 之下：${p}`);
  }
  if (!p.endsWith(".md")) {
    throw new Error(`memory_file 必須是 .md 檔：${p}`);
  }
  return p;
}

// ============================================
// 找當前專案 memory dir（與 hook 同邏輯，省略 fallback）
// ============================================
function currentProjectId() {
  const cwd = process.cwd().replace(/\\/g, "/");
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const drive = parts[0].replace(":", "").toLowerCase();
  const rest = parts.slice(1).join("-");
  const candidates = [
    `${drive}--${rest}`,
    `${drive}--${rest.replace(/_/g, "-")}`,
    `${drive}--${parts[1]}`,
    `${drive}--${parts[1].replace(/_/g, "-")}`,
  ];
  for (const id of candidates) {
    if (fsSync.existsSync(path.join(PROJECTS_DIR, id, "memory"))) return id;
  }
  return null;
}

// ============================================
// Frontmatter 解析 / 序列化（與 hook 共用最小子集）
// ============================================
function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { frontmatter: null, frontmatterLines: [], body: text, hadFrontmatter: false };
  return {
    frontmatter: m[1],
    body: m[2],
    hadFrontmatter: true,
  };
}

function parseScalar(s) {
  if (s === "") return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

function parseYamlBlock(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const result = {};
  const stack = [{ obj: result, indent: -1, key: null }];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const indent = line.match(/^ */)[0].length;
    const stripped = line.slice(indent);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (stripped.startsWith("- ")) {
      const val = parseScalar(stripped.slice(2).trim());
      const arrKey = stack[stack.length - 1].key;
      if (arrKey && Array.isArray(parent[arrKey])) parent[arrKey].push(val);
      i++; continue;
    }
    const kv = stripped.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const rawVal = kv[2];
      if (!rawVal) {
        const nextLine = lines.slice(i + 1).find(l => l.trim() && !l.trim().startsWith("#"));
        if (nextLine && nextLine.slice(nextLine.match(/^ */)[0].length).startsWith("- ")) {
          parent[key] = [];
          stack.push({ obj: parent, indent, key });
        } else {
          parent[key] = {};
          stack.push({ obj: parent[key], indent, key: null });
        }
      } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
        parent[key] = rawVal.slice(1, -1).split(",").map(s => parseScalar(s.trim())).filter(s => s !== "");
      } else {
        parent[key] = parseScalar(rawVal);
      }
      i++; continue;
    }
    i++;
  }
  return result;
}

// 把整個 frontmatter object 序列化回 YAML（保留我們關心的子集格式）
function serializeFrontmatter(obj) {
  const lines = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.every(v => typeof v !== "object")) {
        lines.push(`${key}: [${value.map(serializeScalar).join(", ")}]`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${serializeScalar(item)}`);
      }
    } else if (typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k2, v2] of Object.entries(value)) {
        if (Array.isArray(v2)) {
          lines.push(`  ${k2}: [${v2.map(serializeScalar).join(", ")}]`);
        } else if (typeof v2 === "object" && v2 !== null) {
          lines.push(`  ${k2}:`);
          for (const [k3, v3] of Object.entries(v2)) lines.push(`    ${k3}: ${serializeScalar(v3)}`);
        } else {
          lines.push(`  ${k2}: ${serializeScalar(v2)}`);
        }
      }
    } else {
      lines.push(`${key}: ${serializeScalar(value)}`);
    }
  }
  return lines.join("\n");
}

function serializeScalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  // 含特殊字元才加引號
  if (/[:#\[\]{},&*!|>'"%@`]/.test(s)) return JSON.stringify(s);
  return s;
}

// ============================================
// 實作
// ============================================
async function handleList(args) {
  const projectId = args.project_id || currentProjectId();
  if (!projectId) {
    return { content: [{ type: "text", text: "❌ 找不到當前專案 memory dir。請傳 project_id。" }] };
  }
  const memDir = path.join(PROJECTS_DIR, projectId, "memory");
  try {
    await fs.access(memDir);
  } catch {
    return { content: [{ type: "text", text: `❌ memory dir 不存在：${memDir}` }] };
  }

  const results = [];
  async function walk(dir, rel = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === "reports" || e.name === "_private" || e.name.startsWith(".")) continue;
        await walk(fp, r);
      } else if (e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md") {
        try {
          const text = await fs.readFile(fp, "utf-8");
          const sp = splitFrontmatter(text);
          let triggers = null;
          let name = path.basename(e.name, ".md");
          let description = "";
          if (sp.hadFrontmatter) {
            const fm = parseYamlBlock(sp.frontmatter);
            triggers = fm.triggers || null;
            name = fm.name || name;
            description = fm.description || "";
          }
          results.push({ relPath: r, name, description, hasTriggers: !!triggers, triggers });
        } catch {}
      }
    }
  }
  await walk(memDir);

  const filtered = args.only_missing ? results.filter(r => !r.hasTriggers) : results;
  const total = results.length;
  const withTriggers = results.filter(r => r.hasTriggers).length;

  const lines = [
    `📊 ${projectId} memory triggers 狀態（${withTriggers}/${total} 已設）：`,
    "",
  ];
  for (const r of filtered) {
    const tag = r.hasTriggers ? "✅" : "⬜";
    lines.push(`${tag} ${r.relPath}`);
    if (r.hasTriggers) {
      const t = r.triggers;
      const parts = [];
      if (t.tools) parts.push(`tools=${(t.tools || []).length}`);
      if (t.path_patterns) parts.push(`paths=${(t.path_patterns || []).length}`);
      if (t.prompt_keywords) parts.push(`kw=${(t.prompt_keywords || []).length}`);
      if (t.reinject_after_tool_calls) parts.push(`reinject=${t.reinject_after_tool_calls}`);
      lines.push(`   ${parts.join(", ")}`);
    }
  }
  if (!args.only_missing && total > 0) {
    lines.push("", `提示：⬜ 為尚未設 triggers 的 memory（不會被 auto-recall hook 注入）`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleAdd(args) {
  const memPath = resolveMemoryPath(args.memory_file);
  const text = await fs.readFile(memPath, "utf-8");
  const sp = splitFrontmatter(text);

  let fmObj = {};
  let bodyText = text;
  if (sp.hadFrontmatter) {
    fmObj = parseYamlBlock(sp.frontmatter);
    bodyText = sp.body;
  }

  const mergeMode = args.merge_mode || "replace";
  if (mergeMode === "replace" || !fmObj.triggers) {
    fmObj.triggers = args.triggers;
  } else {
    const existing = fmObj.triggers;
    const incoming = args.triggers;
    const merged = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
      if (Array.isArray(v) && Array.isArray(existing[k])) {
        merged[k] = [...new Set([...existing[k], ...v])];
      } else {
        merged[k] = v;
      }
    }
    fmObj.triggers = merged;
  }

  const newFm = serializeFrontmatter(fmObj);
  const newContent = `---\n${newFm}\n---\n${bodyText.startsWith("\n") ? bodyText.slice(1) : bodyText}`;
  await fs.writeFile(memPath, newContent, "utf-8");

  return {
    content: [{
      type: "text",
      text: `✅ 已更新 ${path.relative(PROJECTS_DIR, memPath)} 的 triggers（${mergeMode}）\n\ntriggers:\n${serializeFrontmatter({ triggers: fmObj.triggers }).split("\n").map(l => "  " + l).join("\n")}`,
    }],
  };
}

async function handleRemove(args) {
  const memPath = resolveMemoryPath(args.memory_file);
  const text = await fs.readFile(memPath, "utf-8");
  const sp = splitFrontmatter(text);
  if (!sp.hadFrontmatter) {
    return { content: [{ type: "text", text: `⚠️ ${memPath} 沒有 frontmatter` }] };
  }
  const fmObj = parseYamlBlock(sp.frontmatter);
  if (!fmObj.triggers) {
    return { content: [{ type: "text", text: `⚠️ ${memPath} 本來就沒有 triggers` }] };
  }
  delete fmObj.triggers;
  const newFm = serializeFrontmatter(fmObj);
  const newContent = `---\n${newFm}\n---\n${sp.body.startsWith("\n") ? sp.body.slice(1) : sp.body}`;
  await fs.writeFile(memPath, newContent, "utf-8");
  return { content: [{ type: "text", text: `✅ 已移除 ${path.relative(PROJECTS_DIR, memPath)} 的 triggers` }] };
}

// ============================================
// handle 路由
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  if (name === "list_memory_triggers") return handleList(args);
  if (name === "memory_add_triggers") return handleAdd(args);
  if (name === "memory_remove_triggers") return handleRemove(args);
  return null;
}
