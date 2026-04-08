// tools/system/php_symbol.js — PHP 符號索引與交叉引用（基於 AST，取代 RAG）
// 依賴：php-parser (pure JS, zero native deps)

import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import { validateArgs } from "../_shared/utils.js";
import { resolveSecurePath } from "../../config.js";

// 延遲載入
let Engine = null;
function getParser() {
  if (!Engine) {
    // php-parser 是 CJS，動態 import
    Engine = import("php-parser").then(m => m.default || m);
  }
  return Engine;
}

// 索引快取：project -> { symbols, timestamp }
const indexCache = new Map();
const INDEX_TTL = 4 * 60 * 60 * 1000; // 4 小時

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "symbol_index",
    description:
      "掃描 PHP 專案建立符號索引（class、method、function、常數），結果快取 4 小時。後續 find_usages / find_hierarchy / find_dependencies 都讀此索引。",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "專案資料夾名稱（相對 basePath）",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "要掃描的子目錄（選填，預設掃整個專案的 PHP 檔）",
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "排除的 glob pattern（預設排除 vendor/, node_modules/, .git/）",
        },
        force: {
          type: "boolean",
          description: "強制重建索引（忽略快取）",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "find_usages",
    description:
      "找出指定 class 或 method 在專案中所有被呼叫/引用的位置。無索引時自動建立。",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "專案資料夾名稱",
        },
        class_name: {
          type: "string",
          description: "要搜尋的 class 名稱",
        },
        method_name: {
          type: "string",
          description: "要搜尋的 method 名稱（選填，省略則找 class 的所有引用）",
        },
      },
      required: ["project", "class_name"],
    },
  },
  {
    name: "find_hierarchy",
    description:
      "列出指定 class 的繼承鏈：父類別、子類別、實作的 interface。無索引時自動建立。",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "專案資料夾名稱",
        },
        class_name: {
          type: "string",
          description: "要查詢的 class 名稱",
        },
      },
      required: ["project", "class_name"],
    },
  },
  {
    name: "find_dependencies",
    description:
      "列出指定檔案的 include/require 依賴（它引用了誰、誰引用了它）。無索引時自動建立。",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "專案資料夾名稱",
        },
        file: {
          type: "string",
          description: "檔案路徑（相對專案目錄）",
        },
      },
      required: ["project", "file"],
    },
  },
];

// ============================================
// AST 遍歷與符號提取
// ============================================

/** 遞迴走訪 AST 節點 */
function walkAST(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  // 走所有子節點
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "kind") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === "object" && child.kind) walkAST(child, visitor);
      }
    } else if (val && typeof val === "object" && val.kind) {
      walkAST(val, visitor);
    }
  }
}

/** 從單一檔案提取符號 */
function extractSymbols(ast, relPath) {
  const result = {
    classes: [],     // { name, line, extends, implements[], methods[], properties[] }
    functions: [],   // { name, line }
    calls: [],       // { type, className, methodName, line }
    includes: [],    // { path, once, line }
    constants: [],   // { name, line }
  };

  walkAST(ast, (node) => {
    const line = node.loc?.start?.line || 0;

    switch (node.kind) {
      case "class":
      case "trait":
      case "interface": {
        const cls = {
          name: typeof node.name === "string" ? node.name : node.name?.name || "",
          kind: node.kind,
          line,
          extends: node.extends ? (typeof node.extends === "string" ? node.extends : node.extends.name || "") : null,
          implements: (node.implements || []).map(i => typeof i === "string" ? i : i.name || ""),
          methods: [],
          properties: [],
          file: relPath,
        };
        // 提取 methods 和 properties
        if (node.body) {
          for (const member of node.body) {
            if (member.kind === "method") {
              const mName = typeof member.name === "string" ? member.name : member.name?.name || "";
              cls.methods.push({
                name: mName,
                line: member.loc?.start?.line || 0,
                visibility: member.visibility || "public",
                isStatic: !!member.isStatic,
                isAbstract: !!member.isAbstract,
                params: (member.arguments || []).map(a => {
                  const pName = typeof a.name === "string" ? a.name : a.name?.name || "";
                  return `$${pName}`;
                }),
              });
            } else if (member.kind === "propertystatement") {
              for (const prop of (member.properties || [])) {
                const pName = typeof prop.name === "string" ? prop.name : prop.name?.name || "";
                cls.properties.push({
                  name: `$${pName}`,
                  line: prop.loc?.start?.line || 0,
                  visibility: member.visibility || "public",
                  isStatic: !!member.isStatic,
                });
              }
            } else if (member.kind === "classconstant") {
              for (const c of (member.constants || [])) {
                const cName = typeof c.name === "string" ? c.name : c.name?.name || "";
                result.constants.push({ name: `${cls.name}::${cName}`, line: c.loc?.start?.line || 0, file: relPath });
              }
            }
          }
        }
        result.classes.push(cls);
        break;
      }

      case "function": {
        const fname = typeof node.name === "string" ? node.name : node.name?.name || "";
        result.functions.push({ name: fname, line, file: relPath });
        break;
      }

      case "call": {
        const what = node.what;
        if (!what) break;

        if (what.kind === "staticlookup") {
          // Foo::bar()
          const cls = typeof what.what === "string" ? what.what : what.what?.name || "";
          const method = typeof what.offset === "string" ? what.offset : what.offset?.name || "";
          result.calls.push({ type: "static", className: cls, methodName: method, line, file: relPath });
        } else if (what.kind === "propertylookup") {
          // $obj->method()
          const method = typeof what.offset === "string" ? what.offset : what.offset?.name || "";
          // 嘗試推導 $obj 的 class（有限的 type inference）
          const varName = what.what?.name || "";
          result.calls.push({ type: "method", className: "", varName: `$${varName}`, methodName: method, line, file: relPath });
        } else if (what.kind === "name" || what.kind === "identifier") {
          // global function call
          const fname = typeof what === "string" ? what : what.name || "";
          result.calls.push({ type: "function", className: "", methodName: fname, line, file: relPath });
        }
        break;
      }

      case "new": {
        const what = node.what;
        const cls = typeof what === "string" ? what : what?.name || "";
        if (cls && cls !== "self" && cls !== "static" && cls !== "parent") {
          result.calls.push({ type: "new", className: cls, methodName: "__construct", line, file: relPath });
        }
        break;
      }

      case "include": {
        let target = "";
        if (node.target) {
          if (node.target.kind === "string") target = node.target.value || "";
          else if (node.target.kind === "encapsed") target = "(dynamic)";
          else target = "(expression)";
        }
        result.includes.push({ path: target, once: !!node.once, require: !!node.require, line, file: relPath });
        break;
      }
    }
  });

  return result;
}

/** 掃描專案建立完整索引 */
async function buildIndex(projectPath, scanPaths, excludePatterns) {
  const PhpParser = await getParser();
  const parser = new PhpParser({
    parser: { extractDoc: false, php7: true, suppressErrors: true },
    ast: { withPositions: true, withSource: false },
  });

  const defaultExclude = ["**/vendor/**", "**/node_modules/**", "**/.git/**", "**/cache/**", "**/tmp/**"];
  const ignore = [...defaultExclude, ...(excludePatterns || [])];

  // 決定掃描路徑
  let patterns;
  if (scanPaths && scanPaths.length > 0) {
    patterns = scanPaths.map(p => {
      const full = path.join(projectPath, p).replace(/\\/g, "/");
      return `${full}/**/*.php`;
    });
  } else {
    patterns = [`${projectPath.replace(/\\/g, "/")}/**/*.php`];
  }

  // 找到所有 PHP 檔案
  const files = [];
  for (const pattern of patterns) {
    const matched = await glob(pattern, { ignore, nodir: true });
    files.push(...matched);
  }

  const index = {
    project: path.basename(projectPath),
    projectPath,
    fileCount: files.length,
    classes: [],     // 所有 class 定義
    functions: [],   // 所有 function 定義
    calls: [],       // 所有呼叫
    includes: [],    // 所有 include/require
    constants: [],   // 所有常數
    errors: [],      // 解析失敗的檔案
    builtAt: new Date().toISOString(),
  };

  for (const file of files) {
    const relPath = path.relative(projectPath, file).replace(/\\/g, "/");
    try {
      const code = await fs.readFile(file, "utf-8");
      const ast = parser.parseCode(code, relPath);
      const symbols = extractSymbols(ast, relPath);
      index.classes.push(...symbols.classes);
      index.functions.push(...symbols.functions);
      index.calls.push(...symbols.calls);
      index.includes.push(...symbols.includes);
      index.constants.push(...symbols.constants);
    } catch (err) {
      index.errors.push({ file: relPath, error: err.message });
    }
  }

  return index;
}

/** 取得或建立索引 */
async function getIndex(project, opts = {}) {
  const projectPath = resolveSecurePath(project);
  const cacheKey = projectPath;

  if (!opts.force && indexCache.has(cacheKey)) {
    const cached = indexCache.get(cacheKey);
    if (Date.now() - cached.timestamp < INDEX_TTL) {
      return cached.index;
    }
  }

  const index = await buildIndex(projectPath, opts.paths, opts.exclude);
  indexCache.set(cacheKey, { index, timestamp: Date.now() });
  return index;
}

// ============================================
// Handle
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (!def) return undefined;
  args = validateArgs(def.inputSchema, args);

  // ── symbol_index ──
  if (name === "symbol_index") {
    const index = await getIndex(args.project, {
      paths: args.paths,
      exclude: args.exclude,
      force: args.force,
    });

    const classCount = index.classes.length;
    const methodCount = index.classes.reduce((sum, c) => sum + c.methods.length, 0);
    const funcCount = index.functions.length;
    const callCount = index.calls.length;
    const includeCount = index.includes.length;

    const lines = [
      `📊 Symbol Index: ${index.project}`,
      ``,
      `| 項目 | 數量 |`,
      `|------|------|`,
      `| PHP 檔案 | ${index.fileCount} |`,
      `| Classes / Traits / Interfaces | ${classCount} |`,
      `| Methods | ${methodCount} |`,
      `| Functions | ${funcCount} |`,
      `| 呼叫記錄 | ${callCount} |`,
      `| Include/Require | ${includeCount} |`,
      `| 解析錯誤 | ${index.errors.length} |`,
      ``,
      `⏱️ 快取 10 分鐘，期間 find_usages / find_hierarchy / find_dependencies 免重建。`,
    ];

    if (index.errors.length > 0 && index.errors.length <= 10) {
      lines.push(``, `**解析錯誤：**`);
      for (const e of index.errors) {
        lines.push(`- ${e.file}: ${e.error}`);
      }
    } else if (index.errors.length > 10) {
      lines.push(``, `**解析錯誤前 5 筆：**`);
      for (const e of index.errors.slice(0, 5)) {
        lines.push(`- ${e.file}: ${e.error}`);
      }
      lines.push(`- ...共 ${index.errors.length} 筆`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // ── find_usages ──
  if (name === "find_usages") {
    const index = await getIndex(args.project);
    const { class_name, method_name } = args;
    const cn = class_name.toLowerCase();
    const mn = method_name ? method_name.toLowerCase() : null;

    const results = [];

    for (const call of index.calls) {
      // Static call: Foo::bar()
      if (call.type === "static" && call.className.toLowerCase() === cn) {
        if (!mn || call.methodName.toLowerCase() === mn) {
          results.push(call);
        }
      }
      // new Foo()
      if (call.type === "new" && call.className.toLowerCase() === cn) {
        if (!mn || mn === "__construct") {
          results.push(call);
        }
      }
      // $obj->method() — 無法確定 class，但 method 名稱匹配就列出
      if (call.type === "method" && mn && call.methodName.toLowerCase() === mn) {
        results.push(call);
      }
    }

    // 也找 extends / implements 引用
    const classRefs = [];
    if (!mn) {
      for (const cls of index.classes) {
        if (cls.extends && cls.extends.toLowerCase() === cn) {
          classRefs.push({ type: "extends", className: cls.name, file: cls.file, line: cls.line });
        }
        for (const impl of cls.implements) {
          if (impl.toLowerCase() === cn) {
            classRefs.push({ type: "implements", className: cls.name, file: cls.file, line: cls.line });
          }
        }
      }
    }

    // 找定義位置
    const defClass = index.classes.find(c => c.name.toLowerCase() === cn);
    const defMethod = defClass && mn
      ? defClass.methods.find(m => m.name.toLowerCase() === mn)
      : null;

    const lines = [`🔍 Find Usages: ${class_name}${method_name ? "::" + method_name : ""}`, ``];

    if (defClass) {
      lines.push(`**定義位置：** ${defClass.file}:${defClass.line} (${defClass.kind})`);
      if (defMethod) {
        lines.push(`**Method 定義：** ${defClass.file}:${defMethod.line} (${defMethod.visibility}${defMethod.isStatic ? " static" : ""})`);
      }
      lines.push(``);
    } else {
      lines.push(`⚠️ 索引中找不到 ${class_name} 的定義（可能在 vendor 或未掃描目錄）`, ``);
    }

    if (results.length === 0 && classRefs.length === 0) {
      lines.push(`找不到任何引用。`);
    } else {
      if (results.length > 0) {
        lines.push(`**呼叫引用（${results.length} 處）：**`, ``);
        lines.push(`| # | 類型 | 呼叫 | 檔案 | 行 |`);
        lines.push(`|---|------|------|------|-----|`);
        const sorted = results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
        for (let i = 0; i < sorted.length; i++) {
          const r = sorted[i];
          const callStr = r.type === "new" ? `new ${r.className}()`
            : r.type === "static" ? `${r.className}::${r.methodName}()`
            : `${r.varName}->${r.methodName}()`;
          lines.push(`| ${i + 1} | ${r.type} | \`${callStr}\` | ${r.file} | ${r.line} |`);
        }
      }

      if (classRefs.length > 0) {
        lines.push(``, `**類別引用（extends/implements，${classRefs.length} 處）：**`, ``);
        for (const ref of classRefs) {
          lines.push(`- ${ref.className} ${ref.type} ${class_name} → ${ref.file}:${ref.line}`);
        }
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // ── find_hierarchy ──
  if (name === "find_hierarchy") {
    const index = await getIndex(args.project);
    const cn = args.class_name.toLowerCase();

    const target = index.classes.find(c => c.name.toLowerCase() === cn);
    if (!target) {
      return { content: [{ type: "text", text: `❌ 索引中找不到 class "${args.class_name}"。請確認已執行 symbol_index 且名稱正確。` }] };
    }

    // 向上找父類別鏈
    const ancestors = [];
    let current = target;
    const visited = new Set([cn]);
    while (current?.extends) {
      const parentName = current.extends.toLowerCase();
      if (visited.has(parentName)) break; // 防環
      visited.add(parentName);
      const parent = index.classes.find(c => c.name.toLowerCase() === parentName);
      ancestors.push({
        name: current.extends,
        found: !!parent,
        file: parent?.file || "(外部/vendor)",
        line: parent?.line || 0,
      });
      current = parent;
    }

    // 向下找子類別
    const children = index.classes
      .filter(c => c.extends && c.extends.toLowerCase() === cn)
      .map(c => ({ name: c.name, kind: c.kind, file: c.file, line: c.line }));

    // 找實作者（如果 target 是 interface）
    const implementors = index.classes
      .filter(c => c.implements.some(i => i.toLowerCase() === cn))
      .map(c => ({ name: c.name, kind: c.kind, file: c.file, line: c.line }));

    const lines = [
      `🌳 Class Hierarchy: ${target.name}`,
      ``,
      `**定義：** ${target.file}:${target.line} (${target.kind})`,
      `**Methods：** ${target.methods.length}`,
      `**Implements：** ${target.implements.length > 0 ? target.implements.join(", ") : "—"}`,
      ``,
    ];

    // 繼承鏈視覺化
    if (ancestors.length > 0) {
      lines.push(`**繼承鏈（↑ 父類別）：**`);
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i];
        const indent = "  ".repeat(ancestors.length - 1 - i);
        lines.push(`${indent}${a.name} ${a.found ? `→ ${a.file}:${a.line}` : "(外部)"}`);
      }
      lines.push(`${"  ".repeat(ancestors.length)}└─ **${target.name}** ← 目前查詢`);
    }

    if (children.length > 0) {
      lines.push(``, `**子類別（${children.length} 個）：**`);
      for (const c of children) {
        lines.push(`- ${c.name} (${c.kind}) → ${c.file}:${c.line}`);
      }
    }

    if (implementors.length > 0) {
      lines.push(``, `**實作者（${implementors.length} 個）：**`);
      for (const c of implementors) {
        lines.push(`- ${c.name} (${c.kind}) → ${c.file}:${c.line}`);
      }
    }

    if (ancestors.length === 0 && children.length === 0 && implementors.length === 0) {
      lines.push(`此 class 沒有繼承關係（獨立）。`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // ── find_dependencies ──
  if (name === "find_dependencies") {
    const index = await getIndex(args.project);
    const targetFile = args.file.replace(/\\/g, "/");

    // 這個檔案引用了誰
    const outgoing = index.includes.filter(inc => inc.file === targetFile);

    // 誰引用了這個檔案
    const incoming = index.includes.filter(inc => {
      if (!inc.path || inc.path === "(dynamic)" || inc.path === "(expression)") return false;
      // 嘗試比對 include 路徑與目標檔案
      const incPath = inc.path.replace(/\\/g, "/");
      return targetFile.endsWith(incPath) || incPath.endsWith(targetFile) || incPath === targetFile;
    });

    const lines = [
      `📦 Dependencies: ${targetFile}`,
      ``,
    ];

    if (outgoing.length > 0) {
      lines.push(`**引用了（${outgoing.length} 個）：**`, ``);
      for (const inc of outgoing) {
        const tag = inc.require ? (inc.once ? "require_once" : "require") : (inc.once ? "include_once" : "include");
        lines.push(`- L${inc.line}: \`${tag}\` → ${inc.path}`);
      }
    } else {
      lines.push(`**引用了：** 無 include/require`);
    }

    lines.push(``);

    if (incoming.length > 0) {
      lines.push(`**被引用（${incoming.length} 處）：**`, ``);
      for (const inc of incoming) {
        const tag = inc.require ? (inc.once ? "require_once" : "require") : (inc.once ? "include_once" : "include");
        lines.push(`- ${inc.file}:${inc.line} → \`${tag}\``);
      }
    } else {
      lines.push(`**被引用：** 索引中未找到（可能透過動態路徑引用）`);
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  return undefined;
}
