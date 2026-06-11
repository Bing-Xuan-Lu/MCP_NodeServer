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
      "掃描 PHP 專案建立符號索引（class、method、function、常數），結果快取 4 小時。後續 find_usages / find_hierarchy / find_dependencies 都讀此索引。若指定 file（或 project 直接傳 .php 檔路徑），改列出「該檔」的 class/method/function/常數清單含行號，而非整個專案統計。",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "專案資料夾名稱（相對 basePath）；也可直接傳單一 .php 檔路徑以列該檔符號",
        },
        file: {
          type: "string",
          description: "單一檔案路徑（相對 project）。提供時列出該檔的 class/method/function/常數清單，而非專案統計",
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
  {
    name: "trace_logic",
    description:
      "追蹤 PHP 函式/方法的業務邏輯流程：解析 if/switch/迴圈/呼叫/回傳，輸出樹狀流程圖。適合理解「某個參數走哪條分支」這類問題。",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "專案資料夾名稱（相對 basePath）",
        },
        function_name: {
          type: "string",
          description: "要追蹤的函式或 method 名稱",
        },
        class_name: {
          type: "string",
          description: "Class 名稱（追蹤 method 時填寫；省略則搜尋全域函式）",
        },
        file: {
          type: "string",
          description: "指定檔案路徑（相對專案目錄，省略則從索引自動查找）",
        },
        max_depth: {
          type: "number",
          description: "遞迴追蹤呼叫深度（預設 1 只分析進入點，2 = 追一層子呼叫，上限 3）",
        },
      },
      required: ["project", "function_name"],
    },
  },
  {
    name: "find_dead_symbols",
    description:
      "掃整個 PHP 專案找出『零引用』的死碼候選：用符號索引列出所有 class/method/function 定義，再用全專案呼叫記錄反查，列出沒有任何 new / static / 方法呼叫 / extends / implements 指向的符號。取代逐一 find_usages 土法煉鋼。" +
      "分三層信心：global function 零呼叫（高）、method 名稱零呼叫且非魔術方法（中）、class 型別用途未追蹤（低）。" +
      "偵測到專案有 call_user_func / array_map 等動態呼叫時全面降信心並提醒。" +
      "本工具看不到字串 callback、動態類名（new $cls）、型別提示、instanceof、::class、::CONST 常數存取等引用，刪除前務必人工複查。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "專案資料夾名稱（相對 basePath）" },
        paths: { type: "array", items: { type: "string" }, description: "限定掃描的子目錄（選填，預設整個專案）" },
        exclude: { type: "array", items: { type: "string" }, description: "額外排除的 glob（預設已排 vendor/node_modules/.git/cache/tmp）" },
        types: {
          type: "array",
          items: { type: "string", enum: ["function", "method", "class"] },
          description: "只檢查指定符號種類（預設全查）",
        },
        include_magic: { type: "boolean", description: "是否一併列魔術方法（__construct 等），預設 false 排除", default: false },
        max_list: { type: "number", description: "每類最多列幾筆，預設 200", default: 200 },
        force: { type: "boolean", description: "強制重建索引（忽略快取）" },
      },
      required: ["project"],
    },
  },
];

// 隱式呼叫的魔術方法（不會出現在一般呼叫記錄裡，死碼判定要排除）
const MAGIC_METHODS = new Set([
  "__construct", "__destruct", "__call", "__callstatic", "__get", "__set",
  "__isset", "__unset", "__sleep", "__wakeup", "__serialize", "__unserialize",
  "__tostring", "__invoke", "__set_state", "__clone", "__debuginfo",
]);

// 出現這些呼叫代表專案有動態 dispatch / callback，死碼判定可能漏報
const DYNAMIC_DISPATCH = new Set([
  "call_user_func", "call_user_func_array", "is_callable", "method_exists",
  "function_exists", "spl_autoload_register", "register_shutdown_function",
  "register_tick_function", "array_map", "array_filter", "array_walk",
  "usort", "uasort", "uksort", "preg_replace_callback",
]);

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
      case "interface":
      case "enum": {
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

/**
 * 偵測 projectPath 不存在時，於 basePath 一層子目錄中搜尋相同名稱的巢狀專案
 * 例：使用者輸入 `MyProject_PHP` 但實際路徑是 `MyProject/MyProject_PHP`
 */
async function resolveNestedProject(projectPath) {
  try { await fs.access(projectPath); return { path: projectPath, hint: null }; } catch {}
  const projectName = path.basename(projectPath);
  const parent = path.dirname(projectPath);
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const candidate = path.join(parent, ent.name, projectName);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          return {
            path: candidate,
            hint: `⚠️ 自動修正路徑：原指定 \`${projectName}\` 不存在，已改用 \`${ent.name}/${projectName}\`。建議下次直接傳完整路徑。`,
          };
        }
      } catch {}
    }
  } catch {}
  return { path: projectPath, hint: null, missing: true };
}

/** 取得或建立索引 */
async function getIndex(project, opts = {}) {
  const rawPath = resolveSecurePath(project);
  const resolved = await resolveNestedProject(rawPath);
  const projectPath = resolved.path;
  const cacheKey = projectPath;

  if (!opts.force && indexCache.has(cacheKey)) {
    const cached = indexCache.get(cacheKey);
    if (Date.now() - cached.timestamp < INDEX_TTL) {
      return { ...cached.index, _pathHint: resolved.hint, _missing: resolved.missing };
    }
  }

  const index = await buildIndex(projectPath, opts.paths, opts.exclude);
  index._pathHint = resolved.hint;
  index._missing = resolved.missing;
  indexCache.set(cacheKey, { index, timestamp: Date.now() });
  return index;
}

// ============================================
// trace_logic helpers
// ============================================

/** AST expression → readable PHP string (truncated at maxLen) */
function exprToStr(n, maxLen = 80) {
  if (!n) return "";
  const s = _expr(n);
  return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s;
}

function _expr(n) {
  if (!n || typeof n !== "object") return String(n ?? "");
  switch (n.kind) {
    case "variable": { const nm = typeof n.name === "string" ? n.name : n.name?.name || "?"; return `$${nm}`; }
    case "string": return n.value?.length > 30 ? `'${n.value.slice(0, 27)}...'` : `'${n.value}'`;
    case "number": return String(n.value);
    case "boolean": return n.value ? "true" : "false";
    case "nullkeyword": return "null";
    case "name": case "identifier": return n.name || "";
    case "bin": return `${_expr(n.left)} ${n.type} ${_expr(n.right)}`;
    case "unary": return `${n.type}${_expr(n.what)}`;
    case "post": return `${_expr(n.what)}${n.type}`;
    case "pre": return `${n.type}${_expr(n.what)}`;
    case "cast": return `(${n.type})${_expr(n.what)}`;
    case "parenthesis": return `(${_expr(n.inner)})`;
    case "propertylookup": return `${_expr(n.what)}->${_expr(n.offset)}`;
    case "staticlookup": return `${_expr(n.what)}::${_expr(n.offset)}`;
    case "offsetlookup": return `${_expr(n.what)}[${n.offset ? _expr(n.offset) : ""}]`;
    case "call": return `${_expr(n.what)}(${(n.arguments || []).map(_expr).join(", ")})`;
    case "new": { const a = (n.arguments || []).map(_expr).join(", "); return a ? `new ${_expr(n.what)}(${a})` : `new ${_expr(n.what)}`; }
    case "assign": case "assignref": return `${_expr(n.left)} = ${_expr(n.right)}`;
    case "retif": return `${_expr(n.test)} ? ${_expr(n.trueExpr)} : ${_expr(n.falseExpr)}`;
    case "isset": return `isset(${(n.arguments || []).map(_expr).join(", ")})`;
    case "empty": return `empty(${_expr(n.expression)})`;
    case "array": {
      const items = (n.items || []).slice(0, 3).map(i => i?.key ? `${_expr(i.key)} => ${_expr(i.value)}` : _expr(i?.value));
      return n.items?.length > 3 ? `[${items.join(", ")}, ...]` : `[${items.join(", ")}]`;
    }
    case "encapsed": return '"..."';
    case "staticreference": return "static";
    case "selfreference": return "self";
    case "parentreference": return "parent";
    default: return `{${n.kind}}`;
  }
}

/** Normalize body to statement array */
function stmtsOf(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (body.kind === "block") return body.children || [];
  return [body];
}

/** Extract control flow tree from AST statements */
function traceStmts(stmts) {
  const flow = [];
  for (const s of stmts) {
    if (!s || typeof s !== "object") continue;
    const L = s.loc?.start?.line || 0;

    switch (s.kind) {
      case "if": {
        const branches = [{ label: exprToStr(s.test), body: traceStmts(stmtsOf(s.body)) }];
        let alt = s.alternate;
        while (alt) {
          if (alt.kind === "if") {
            branches.push({ label: `elseif (${exprToStr(alt.test)})`, body: traceStmts(stmtsOf(alt.body)) });
            alt = alt.alternate;
          } else {
            branches.push({ label: "else", body: traceStmts(stmtsOf(alt)) });
            alt = null;
          }
        }
        flow.push({ type: "if", condition: exprToStr(s.test), line: L, branches });
        break;
      }

      case "switch": {
        const cases = [];
        for (const c of (s.body?.children || s.body || [])) {
          if (c.kind === "case") {
            cases.push({ label: c.test ? exprToStr(c.test) : "default", body: traceStmts(stmtsOf(c.body)) });
          }
        }
        flow.push({ type: "switch", condition: exprToStr(s.test), line: L, cases });
        break;
      }

      case "for": {
        const init = (s.init || []).map(x => exprToStr(x)).join(", ");
        const test = (s.test || []).map(x => exprToStr(x)).join(", ");
        const incr = (s.increment || []).map(x => exprToStr(x)).join(", ");
        flow.push({ type: "loop", sub: "for", cond: `${init}; ${test}; ${incr}`, line: L, body: traceStmts(stmtsOf(s.body)) });
        break;
      }

      case "foreach": {
        const key = s.key ? `${_expr(s.key)} => ` : "";
        flow.push({ type: "loop", sub: "foreach", cond: `${_expr(s.source)} as ${key}${_expr(s.value)}`, line: L, body: traceStmts(stmtsOf(s.body)) });
        break;
      }

      case "while":
        flow.push({ type: "loop", sub: "while", cond: exprToStr(s.test), line: L, body: traceStmts(stmtsOf(s.body)) });
        break;

      case "do":
        flow.push({ type: "loop", sub: "do-while", cond: exprToStr(s.test), line: L, body: traceStmts(stmtsOf(s.body)) });
        break;

      case "return":
        flow.push({ type: "return", text: s.expr ? exprToStr(s.expr) : "(void)", line: L });
        break;

      case "throw":
        flow.push({ type: "throw", text: exprToStr(s.what), line: L });
        break;

      case "try": {
        const catches = (s.catches || []).map(c => ({
          types: (c.what || []).map(x => typeof x === "string" ? x : x.name || "Exception").join("|"),
          var: c.variable ? _expr(c.variable) : "",
          body: traceStmts(stmtsOf(c.body)),
        }));
        flow.push({ type: "try", line: L, body: traceStmts(stmtsOf(s.body)), catches, finally: s.always ? traceStmts(stmtsOf(s.always)) : null });
        break;
      }

      case "expressionstatement": {
        const e = s.expression;
        if (!e) break;
        if (e.kind === "call" || e.kind === "new") {
          flow.push({ type: "call", text: exprToStr(e), line: L });
        } else if (e.kind === "assign" || e.kind === "assignref") {
          const r = e.right;
          if (r && (r.kind === "call" || r.kind === "new" || r.kind === "retif")) {
            flow.push({ type: "assign", text: exprToStr(e), line: L });
          } else {
            const lhs = _expr(e.left);
            const rhsStr = exprToStr(e.right);
            // Include property/static assigns, or non-trivial RHS (skip $i = 0 etc.)
            if (lhs.includes("->") || lhs.includes("::") || rhsStr.length > 10) {
              flow.push({ type: "assign", text: exprToStr(e), line: L });
            }
          }
        }
        break;
      }

      case "continue":
        flow.push({ type: "continue", level: s.level ? exprToStr(s.level) : "", line: L });
        break;

      case "block":
        flow.push(...traceStmts(s.children || []));
        break;

      case "echo": {
        const vals = (s.expressions || s.arguments || []).map(x => exprToStr(x)).join(", ");
        flow.push({ type: "echo", text: vals, line: L });
        break;
      }

      default: break;
    }
  }
  return flow;
}

/** Render flow tree to text with box-drawing characters */
function renderFlow(nodes, prefix = "") {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const last = i === nodes.length - 1;
    const cur = last ? "└─ " : "├─ ";
    const nxt = last ? "   " : "│  ";
    const tag = n.line ? ` :${n.line}` : "";

    switch (n.type) {
      case "if": {
        out.push(`${prefix}${cur}if (${n.condition})${tag}`);
        const hasManyBranches = n.branches.length > 1;
        for (let b = 0; b < n.branches.length; b++) {
          const br = n.branches[b];
          if (b === 0 && !hasManyBranches) {
            // single if without else — body directly under if
            out.push(...renderFlow(br.body, prefix + nxt));
          } else if (b === 0) {
            // then branch with else coming
            out.push(`${prefix}${nxt}├─ then`);
            out.push(...renderFlow(br.body, prefix + nxt + "│  "));
          } else {
            const bLast = b === n.branches.length - 1;
            const bCur = bLast ? "└─ " : "├─ ";
            const bNxt = bLast ? "   " : "│  ";
            out.push(`${prefix}${nxt}${bCur}${br.label}`);
            out.push(...renderFlow(br.body, prefix + nxt + bNxt));
          }
        }
        break;
      }

      case "switch":
        out.push(`${prefix}${cur}switch (${n.condition})${tag}`);
        for (let c = 0; c < n.cases.length; c++) {
          const cs = n.cases[c];
          const cLast = c === n.cases.length - 1;
          const cCur = cLast ? "└─ " : "├─ ";
          const cNxt = cLast ? "   " : "│  ";
          out.push(`${prefix}${nxt}${cCur}case ${cs.label}`);
          out.push(...renderFlow(cs.body, prefix + nxt + cNxt));
        }
        break;

      case "loop":
        out.push(`${prefix}${cur}${n.sub} (${n.cond})${tag}`);
        out.push(...renderFlow(n.body, prefix + nxt));
        break;

      case "try":
        out.push(`${prefix}${cur}try${tag}`);
        out.push(...renderFlow(n.body, prefix + nxt));
        for (let c = 0; c < n.catches.length; c++) {
          const ct = n.catches[c];
          const hasFinally = !!n.finally;
          const cLast = c === n.catches.length - 1 && !hasFinally;
          const cCur = cLast ? "└─ " : "├─ ";
          const cNxt = cLast ? "   " : "│  ";
          out.push(`${prefix}${nxt}${cCur}catch (${ct.types} ${ct.var})`);
          out.push(...renderFlow(ct.body, prefix + nxt + cNxt));
        }
        if (n.finally) {
          out.push(`${prefix}${nxt}└─ finally`);
          out.push(...renderFlow(n.finally, prefix + nxt + "   "));
        }
        break;

      case "call":
        out.push(`${prefix}${cur}→ ${n.text}${tag}`);
        if (n.subFlow) out.push(...renderFlow(n.subFlow, prefix + nxt));
        break;

      case "assign":
        out.push(`${prefix}${cur}${n.text}${tag}`);
        if (n.subFlow) out.push(...renderFlow(n.subFlow, prefix + nxt));
        break;

      case "continue":
        out.push(`${prefix}${cur}continue${n.text ? " " + n.text : ""}${tag}`);
        break;

      case "return":
        out.push(`${prefix}${cur}⏎ return ${n.text}${tag}`);
        break;

      case "throw":
        out.push(`${prefix}${cur}💥 throw ${n.text}${tag}`);
        break;

      case "echo":
        out.push(`${prefix}${cur}echo ${n.text}${tag}`);
        break;
    }
  }
  return out;
}

/** Find a function/method AST node in parsed AST */
function findFuncInAST(ast, funcName, className) {
  let found = null;
  const fnLower = funcName.toLowerCase();
  const clsLower = className ? className.toLowerCase() : null;

  // Collect trait names used by the target class (for fallback)
  const usedTraits = [];

  walkAST(ast, (node) => {
    if (found) return;
    if (clsLower && (node.kind === "class" || node.kind === "trait" || node.kind === "interface" || node.kind === "enum")) {
      const name = typeof node.name === "string" ? node.name : node.name?.name || "";
      if (name.toLowerCase() === clsLower && node.body) {
        // Collect `use TraitName` declarations
        for (const member of node.body) {
          if (member.kind === "traituse") {
            for (const t of (member.traits || [])) {
              const tName = typeof t === "string" ? t : t.name || "";
              if (tName) usedTraits.push(tName.toLowerCase());
            }
          }
        }
        // Search direct methods
        for (const member of node.body) {
          if (member.kind === "method") {
            const mName = typeof member.name === "string" ? member.name : member.name?.name || "";
            if (mName.toLowerCase() === fnLower) { found = member; return; }
          }
        }
      }
    } else if (!clsLower && node.kind === "function") {
      const name = typeof node.name === "string" ? node.name : node.name?.name || "";
      if (name.toLowerCase() === fnLower) { found = node; }
    }
  });

  // Fallback: search in used traits (same file)
  if (!found && usedTraits.length > 0) {
    walkAST(ast, (node) => {
      if (found) return;
      if (node.kind === "trait") {
        const name = typeof node.name === "string" ? node.name : node.name?.name || "";
        if (usedTraits.includes(name.toLowerCase()) && node.body) {
          for (const member of node.body) {
            if (member.kind === "method") {
              const mName = typeof member.name === "string" ? member.name : member.name?.name || "";
              if (mName.toLowerCase() === fnLower) { found = member; return; }
            }
          }
        }
      }
    });
  }

  return found;
}

/** Create a parser instance for trace_logic */
async function createParser() {
  const PhpParser = await getParser();
  return new PhpParser({
    parser: { extractDoc: false, php7: true, suppressErrors: true },
    ast: { withPositions: true, withSource: false },
  });
}

/** Recursively enrich call nodes with sub-flow (depth tracing) */
async function enrichCalls(flowNodes, index, projectPath, parser, depth, maxDepth, visited) {
  if (depth >= maxDepth) return;
  for (const node of flowNodes) {
    // Recurse into sub-structures
    if (node.branches) for (const b of node.branches) await enrichCalls(b.body, index, projectPath, parser, depth, maxDepth, visited);
    if (node.cases) for (const c of node.cases) await enrichCalls(c.body, index, projectPath, parser, depth, maxDepth, visited);
    if (node.body && Array.isArray(node.body)) await enrichCalls(node.body, index, projectPath, parser, depth, maxDepth, visited);
    if (node.catches) for (const c of node.catches) await enrichCalls(c.body, index, projectPath, parser, depth, maxDepth, visited);
    if (node.finally) await enrichCalls(node.finally, index, projectPath, parser, depth, maxDepth, visited);

    // Enrich call/assign nodes
    if (node.type !== "call" && node.type !== "assign") continue;
    // Extract function name from the text (last function call pattern)
    const callMatch = node.text.match(/(?:->|::|^|\b)(\w+)\s*\(/);
    if (!callMatch) continue;
    const calledName = callMatch[1].toLowerCase();
    if (visited.has(calledName)) continue;

    // Search index for this function
    let targetFile = null;
    let targetClass = null;
    // Check methods first
    for (const cls of index.classes) {
      const m = cls.methods.find(m => m.name.toLowerCase() === calledName);
      if (m) { targetFile = cls.file; targetClass = cls.name; break; }
    }
    // Then global functions
    if (!targetFile) {
      const func = index.functions.find(f => f.name.toLowerCase() === calledName);
      if (func) targetFile = func.file;
    }
    if (!targetFile) continue;

    visited.add(calledName);
    try {
      const filePath = path.join(projectPath, targetFile);
      const code = await fs.readFile(filePath, "utf-8");
      const ast = parser.parseCode(code, targetFile);
      const funcNode = findFuncInAST(ast, callMatch[1], targetClass);
      if (funcNode) {
        const subFlow = traceStmts(stmtsOf(funcNode.body));
        if (subFlow.length > 0) {
          node.subFlow = subFlow;
          await enrichCalls(subFlow, index, projectPath, parser, depth + 1, maxDepth, visited);
        }
      }
    } catch { /* skip files that can't be parsed */ }
  }
}

/** 列出單一檔案的符號清單（class/method/function/常數），供 symbol_index 單檔模式用 */
async function listFileSymbols(filePath, label) {
  let code;
  try {
    code = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    return { content: [{ type: "text", text: `❌ 無法讀取檔案：${label}（${err.message}）` }] };
  }
  const parser = await createParser();
  let ast;
  try {
    ast = parser.parseCode(code, label);
  } catch (err) {
    return { content: [{ type: "text", text: `❌ PHP 解析失敗：${label}（${err.message}）` }] };
  }

  const sym = extractSymbols(ast, label);
  const lines = [`📄 Symbol List: ${label}`, ``];

  if (sym.classes.length === 0 && sym.functions.length === 0 && sym.constants.length === 0) {
    lines.push(`（此檔無 class / function / 常數定義）`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  for (const cls of sym.classes) {
    const ext = cls.extends ? ` extends ${cls.extends}` : "";
    const impl = cls.implements.length ? ` implements ${cls.implements.join(", ")}` : "";
    lines.push(`### ${cls.kind} ${cls.name}${ext}${impl}  (L${cls.line})`);
    if (cls.methods.length) {
      lines.push(`| method | 行 | 可見性 | 參數 |`, `|--------|----|--------|------|`);
      for (const m of cls.methods) {
        const vis = `${m.visibility}${m.isStatic ? " static" : ""}${m.isAbstract ? " abstract" : ""}`;
        lines.push(`| ${m.name} | ${m.line} | ${vis} | ${m.params.join(", ")} |`);
      }
    } else {
      lines.push(`（無 method）`);
    }
    if (cls.properties.length) {
      lines.push(``, `屬性：` + cls.properties.map(p => `${p.name}(L${p.line})`).join(", "));
    }
    lines.push(``);
  }

  if (sym.functions.length) {
    lines.push(`### 全域函式`, `| function | 行 |`, `|----------|----|`);
    for (const f of sym.functions) lines.push(`| ${f.name} | ${f.line} |`);
    lines.push(``);
  }

  if (sym.constants.length) {
    lines.push(`### 常數`, sym.constants.map(c => `${c.name}(L${c.line})`).join(", "), ``);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
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
    // 單檔模式：指定 file，或 project 直接傳 .php 檔路徑 → 列該檔符號清單（非專案統計）
    let singleFilePath = null;
    let singleFileLabel = null;
    if (args.file) {
      const base = (await resolveNestedProject(resolveSecurePath(args.project))).path;
      singleFilePath = path.join(base, args.file);
      singleFileLabel = args.file.replace(/\\/g, "/");
    } else if (/\.php$/i.test(args.project)) {
      singleFilePath = resolveSecurePath(args.project);
      singleFileLabel = path.basename(args.project);
    }
    if (singleFilePath) {
      return await listFileSymbols(singleFilePath, singleFileLabel);
    }

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

    const lines = [];
    if (index._pathHint) lines.push(index._pathHint, ``);
    if (index._missing) {
      lines.push(`❌ 專案路徑不存在：${args.project}`);
      lines.push(`   提示：請確認 project 參數是否需要包含父層資料夾（例：\`Parent/${args.project}\`）。`);
      lines.push(``);
    } else if (index.fileCount === 0) {
      lines.push(`⚠️ 此路徑未找到任何 PHP 檔。可能原因：`);
      lines.push(`   1. project 參數錯誤（缺父層？）；2. paths 參數限制過嚴；3. 檔案全在 vendor/ 等排除路徑下。`);
      lines.push(``);
    }
    lines.push(
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
      `⏱️ 快取 4 小時，期間 find_usages / find_hierarchy / find_dependencies 免重建。`,
    );

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

  // ── trace_logic ──
  if (name === "trace_logic") {
    const maxDepth = Math.min(Math.max(args.max_depth || 1, 1), 3);
    const projectPath = resolveSecurePath(args.project);
    const index = await getIndex(args.project);
    const parser = await createParser();

    // 1. Find the target function/method definition
    let targetFile = args.file || null;
    let targetClass = args.class_name || null;
    const funcName = args.function_name;

    if (!targetFile) {
      // Search index
      if (targetClass) {
        const cls = index.classes.find(c => c.name.toLowerCase() === targetClass.toLowerCase());
        if (cls) {
          const m = cls.methods.find(m => m.name.toLowerCase() === funcName.toLowerCase());
          if (m) targetFile = cls.file;
        }
      } else {
        // Try global function first
        const func = index.functions.find(f => f.name.toLowerCase() === funcName.toLowerCase());
        if (func) {
          targetFile = func.file;
        } else {
          // Try as method in any class
          for (const cls of index.classes) {
            const m = cls.methods.find(m => m.name.toLowerCase() === funcName.toLowerCase());
            if (m) { targetFile = cls.file; targetClass = cls.name; break; }
          }
        }
      }
    }

    if (!targetFile) {
      return { content: [{ type: "text", text: `❌ 找不到 ${targetClass ? targetClass + "::" : ""}${funcName}。請確認已執行 symbol_index，或用 file 參數指定檔案。` }] };
    }

    // 2. Read and parse the file
    const filePath = path.join(projectPath, targetFile);
    let code;
    try {
      code = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      return { content: [{ type: "text", text: `❌ 無法讀取 ${targetFile}: ${err.message}` }] };
    }

    let ast;
    try {
      ast = parser.parseCode(code, targetFile);
    } catch (err) {
      return { content: [{ type: "text", text: `❌ PHP 解析失敗 ${targetFile}: ${err.message}` }] };
    }

    // 3. Find the function AST node
    const funcNode = findFuncInAST(ast, funcName, targetClass);
    if (!funcNode) {
      return { content: [{ type: "text", text: `❌ 在 ${targetFile} 中找不到 ${targetClass ? targetClass + "::" : ""}${funcName} 的定義。` }] };
    }

    // 4. Build flow tree
    const body = stmtsOf(funcNode.body);
    const flowTree = traceStmts(body);

    // 5. Recursive depth tracing
    if (maxDepth > 1 && flowTree.length > 0) {
      const visited = new Set([funcName.toLowerCase()]);
      await enrichCalls(flowTree, index, projectPath, parser, 1, maxDepth, visited);
    }

    // 6. Format output
    const params = (funcNode.arguments || []).map(a => {
      const pName = typeof a.name === "string" ? a.name : a.name?.name || "?";
      return `$${pName}`;
    }).join(", ");

    const header = targetClass
      ? `${targetClass}::${funcName}(${params})`
      : `${funcName}(${params})`;

    const startLine = funcNode.loc?.start?.line || 0;
    const endLine = funcNode.loc?.end?.line || 0;

    const lines = [
      `🔀 Logic Trace: ${header}`,
      `📍 ${targetFile}:${startLine}-${endLine}`,
      `📊 depth: ${maxDepth}`,
      ``,
      header,
    ];
    lines.push(...renderFlow(flowTree));

    if (flowTree.length === 0) {
      lines.push(`   (empty body)`);
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

  // ── find_dead_symbols ──
  if (name === "find_dead_symbols") {
    const index = await getIndex(args.project, {
      paths: args.paths,
      exclude: args.exclude,
      force: args.force,
    });

    if (index._missing) {
      return { content: [{ type: "text", text: `❌ 專案路徑不存在：${args.project}` }] };
    }
    if (index.fileCount === 0) {
      return { content: [{ type: "text", text: `⚠️ 此路徑未找到任何 PHP 檔，無法分析。` }] };
    }

    // 反查用集合（全部小寫）
    const calledFunc = new Set();   // 全域函式呼叫
    const calledMethod = new Set(); // static / $obj->method / new(__construct)
    const usedClass = new Set();    // new / static / extends / implements
    let hasDynamic = false;

    for (const c of index.calls) {
      const mn = (c.methodName || "").toLowerCase();
      const cn = (c.className || "").toLowerCase();
      if (c.type === "function" && mn) {
        calledFunc.add(mn);
        if (DYNAMIC_DISPATCH.has(mn)) hasDynamic = true;
      } else if (c.type === "static") {
        if (mn) calledMethod.add(mn);
        if (cn) usedClass.add(cn);
      } else if (c.type === "method") {
        if (mn) calledMethod.add(mn);
      } else if (c.type === "new") {
        calledMethod.add("__construct");
        if (cn) usedClass.add(cn);
      }
    }
    for (const cls of index.classes) {
      if (cls.extends) usedClass.add(cls.extends.toLowerCase());
      for (const i of (cls.implements || [])) usedClass.add(i.toLowerCase());
    }

    const types = (args.types && args.types.length) ? new Set(args.types) : new Set(["function", "method", "class"]);
    const cap = args.max_list || 200;

    // 候選蒐集
    const deadFuncs = [];
    const deadMethods = [];   // { class, name, line, file, visibility, gray, grayReason }
    const deadClasses = [];

    if (types.has("function")) {
      for (const f of index.functions) {
        if (!calledFunc.has(f.name.toLowerCase())) deadFuncs.push(f);
      }
    }
    if (types.has("method")) {
      for (const cls of index.classes) {
        const subtype = !!cls.extends || (cls.implements && cls.implements.length > 0)
          || cls.kind === "interface" || cls.kind === "trait";
        for (const m of cls.methods) {
          const ml = m.name.toLowerCase();
          if (!args.include_magic && MAGIC_METHODS.has(ml)) continue;
          if (calledMethod.has(ml)) continue;
          let grayReason = "";
          if (m.isAbstract) grayReason = "abstract";
          else if (cls.kind === "interface") grayReason = "interface 契約";
          else if (cls.kind === "trait") grayReason = "trait 方法";
          else if (subtype) grayReason = "可能覆寫父類/實作介面";
          deadMethods.push({ class: cls.name, name: m.name, line: m.line, file: cls.file, visibility: m.visibility, gray: !!grayReason, grayReason });
        }
      }
    }
    if (types.has("class")) {
      for (const cls of index.classes) {
        if (!usedClass.has(cls.name.toLowerCase())) deadClasses.push(cls);
      }
    }

    const byLoc = (a, b) => (a.file || "").localeCompare(b.file || "") || (a.line - b.line);
    deadFuncs.sort(byLoc);
    deadMethods.sort(byLoc);
    deadClasses.sort(byLoc);

    // method 拆成中信心（純粹零呼叫）與灰色（可能覆寫/介面/trait/abstract）
    const methodSolid = deadMethods.filter(m => !m.gray);
    const methodGray = deadMethods.filter(m => m.gray);

    const lines = [];
    if (index._pathHint) lines.push(index._pathHint, ``);
    lines.push(
      `🧹 Dead Symbol Scan: ${index.project}`,
      ``,
      `掃描 ${index.fileCount} 檔 · class ${index.classes.length} · function ${index.functions.length} · 呼叫記錄 ${index.calls.length}`,
      `候選：🔴 死函式 ${deadFuncs.length} · 🟡 零呼叫 method ${methodSolid.length} · ⚪ 灰色 method ${methodGray.length} · 🔵 未引用 class ${deadClasses.length}`,
      ``,
    );

    if (hasDynamic) {
      lines.push(`⚠️ 偵測到專案使用 call_user_func / array_map / usort 等動態呼叫或 callback —`,
                 `   以名稱反查的死碼判定可能漏報（某符號其實被字串/變數動態呼叫）。刪除前務必逐一複查。`, ``);
    }

    const fmtFuncRows = (arr) => {
      const rows = arr.slice(0, cap).map((f, i) => `| ${i + 1} | \`${f.name}()\` | ${f.file}:${f.line} |`);
      return [`| # | 函式 | 位置 |`, `|---|------|------|`, ...rows,
              arr.length > cap ? `… 另有 ${arr.length - cap} 筆（調高 max_list 取得）` : ""].filter(Boolean);
    };
    const fmtMethodRows = (arr, withReason) => {
      const head = withReason ? `| # | 方法 | 可見性 | 位置 | 灰色原因 |` : `| # | 方法 | 可見性 | 位置 |`;
      const sep = withReason ? `|---|------|--------|------|----------|` : `|---|------|--------|------|`;
      const rows = arr.slice(0, cap).map((m, i) => withReason
        ? `| ${i + 1} | \`${m.class}::${m.name}()\` | ${m.visibility} | ${m.file}:${m.line} | ${m.grayReason} |`
        : `| ${i + 1} | \`${m.class}::${m.name}()\` | ${m.visibility} | ${m.file}:${m.line} |`);
      return [head, sep, ...rows, arr.length > cap ? `… 另有 ${arr.length - cap} 筆` : ""].filter(Boolean);
    };

    if (types.has("function")) {
      lines.push(`## 🔴 死函式候選（高信心 · global function 零呼叫）`, ``);
      lines.push(...(deadFuncs.length ? fmtFuncRows(deadFuncs) : ["（無）"]), ``);
    }
    if (types.has("method")) {
      lines.push(`## 🟡 零呼叫 method（中信心 · 名稱在全專案無任何呼叫，已排除魔術方法）`, ``);
      lines.push(...(methodSolid.length ? fmtMethodRows(methodSolid, false) : ["（無）"]), ``);
      lines.push(`## ⚪ 灰色 method（低信心 · 可能是覆寫/介面/trait/abstract，勿直接刪）`, ``);
      lines.push(...(methodGray.length ? fmtMethodRows(methodGray, true) : ["（無）"]), ``);
    }
    if (types.has("class")) {
      lines.push(`## 🔵 未引用 class（低信心 · 型別提示/instanceof/::class/::CONST 常數存取不在追蹤範圍）`, ``);
      const rows = deadClasses.slice(0, cap).map((c, i) => `| ${i + 1} | \`${c.name}\` (${c.kind}) | ${c.file}:${c.line} |`);
      lines.push(...(deadClasses.length
        ? [`| # | 類別 | 位置 |`, `|---|------|------|`, ...rows, deadClasses.length > cap ? `… 另有 ${deadClasses.length - cap} 筆` : ""].filter(Boolean)
        : ["（無）"]), ``);
    }

    lines.push(
      `---`,
      `刪除流程建議：對 🔴 可較放心刪；🟡 先 find_usages 該名稱二次確認（跨檔同名方法會互相遮蔽）；⚪🔵 必須人工讀檔確認無動態/型別引用再刪。`,
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  return undefined;
}
