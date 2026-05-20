// tools/system/js_symbol.js — JS/Vue/TS 符號索引 + find_usages + trace_logic
// 依賴：@babel/parser（純 JS，無 native）
// 對應 PHP 端的 php_symbol.js + php_class.js

import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import { resolveSecurePath, CONFIG } from "../../config.js";

// ── 延遲載入 parser ───────────────────────────────────────────
let _parserMod = null;
async function getParser() {
  if (!_parserMod) _parserMod = await import("@babel/parser");
  return _parserMod;
}

// ── 索引快取 ──────────────────────────────────────────────────
const indexCache = new Map();
const INDEX_TTL = 4 * 60 * 60 * 1000; // 4 小時

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "js_symbol_index",
    description:
      "掃描 JS/TS/Vue 專案建立符號索引（function、class、object methods、`obj.method = fn` 賦值、export），結果快取 4 小時。後續 js_symbol_lookup / js_find_usages / js_trace_logic 都讀此索引。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "專案資料夾名稱（相對 basePath）" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "要掃描的子目錄（選填，預設掃整個專案的 .js/.ts/.jsx/.tsx/.vue）",
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "額外排除 glob（預設已排 node_modules/vendor/dist/build/.git/*.min.js）",
        },
        force: { type: "boolean", description: "強制重建索引（忽略快取）" },
      },
      required: ["project"],
    },
  },
  {
    name: "js_symbol_lookup",
    description:
      "找指定 JS 符號的定義位置 + 原始碼。支援 function 名稱、class 名稱、`obj.method` 點記號（例：`_login_popup.Show`）。省略 method 名只回傳該物件/類別的概覽。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "專案資料夾名稱" },
        symbol: { type: "string", description: "符號名稱，可用 `obj.method` 點記號" },
        include_body: { type: "boolean", description: "是否回傳完整原始碼（預設 true）" },
      },
      required: ["project", "symbol"],
    },
  },
  {
    name: "js_find_usages",
    description:
      "找出指定 JS 符號的所有呼叫/引用位置。支援 function、class、`obj.method` 點記號。比 Grep 準確（會排除字串/註解內 false positive）。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "專案資料夾名稱" },
        symbol: { type: "string", description: "符號名稱，可用 `obj.method` 點記號" },
        kind: {
          type: "string",
          enum: ["any", "call", "reference"],
          description: "any=全部 / call=只找函式呼叫 / reference=識別字引用（預設 any）",
        },
      },
      required: ["project", "symbol"],
    },
  },
  {
    name: "js_trace_logic",
    description:
      "追蹤 JS 函式內部的 if/switch/for/while/try/呼叫流程，輸出樹狀。適合理解「onclick → handler → fetch」這類事件鏈。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "專案資料夾名稱" },
        symbol: { type: "string", description: "進入點函式名（function 名 或 `obj.method`）" },
        file: { type: "string", description: "檔案路徑（相對專案目錄，選填）" },
        max_depth: { type: "number", description: "遞迴深度（預設 1，上限 3）" },
      },
      required: ["project", "symbol"],
    },
  },
];

// ============================================
// AST 走訪
// ============================================
const SKIP_KEYS = new Set([
  "loc", "start", "end", "range", "type", "extra",
  "leadingComments", "trailingComments", "innerComments",
  "comments", "tokens", "directives",
]);

function walkAST(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node, parent);
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c === "object") walkAST(c, visit, node);
    } else if (v && typeof v === "object") {
      walkAST(v, visit, node);
    }
  }
}

// ── 節點輔助 ──────────────────────────────────────────────────
function nameOf(n) {
  if (!n) return "";
  if (typeof n === "string") return n;
  if (n.type === "Identifier") return n.name;
  if (n.type === "StringLiteral") return n.value;
  if (n.type === "NumericLiteral") return String(n.value);
  if (n.type === "PrivateName") return "#" + (n.id?.name || "");
  return "";
}

/** MemberExpression / Identifier → "a.b.c" 點記號 */
function memberPath(node) {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (node.type === "Super") return "super";
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    const obj = memberPath(node.object);
    const propName = node.computed ? "" : nameOf(node.property);
    if (!propName) return obj; // computed property — 略過
    return obj ? `${obj}.${propName}` : propName;
  }
  return "";
}

function paramsOf(node) {
  return (node.params || []).map(p => {
    if (!p) return "?";
    if (p.type === "Identifier") return p.name;
    if (p.type === "AssignmentPattern") return (p.left?.name || "?") + "=...";
    if (p.type === "RestElement") return "..." + (p.argument?.name || "");
    if (p.type === "ObjectPattern") return "{...}";
    if (p.type === "ArrayPattern") return "[...]";
    return "?";
  });
}

function isFuncNode(n) {
  return !!n && (
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression" ||
    n.type === "FunctionDeclaration"
  );
}

// ============================================
// 符號提取
// ============================================
/**
 * 從單一 AST 提取符號。
 * defs[]: {name, parent?, kind, line, endLine, file, params?, exported?}
 *   kind: function | class | variable | method | object_method | property
 * calls[]: {path, callee_root, line, file, type: 'call'|'new'}
 *   path: 完整 memberPath（例 _login_popup.Show）
 *   callee_root: 第一段識別字（例 _login_popup）
 */
function extractSymbols(ast, relPath) {
  const defs = [];
  const calls = [];

  // 第一階段：函式 / class / 變數 / 賦值
  walkAST(ast, (node) => {
    const line = node.loc?.start?.line || 0;
    const endLine = node.loc?.end?.line || line;

    switch (node.type) {
      case "FunctionDeclaration": {
        const name = nameOf(node.id);
        if (name) defs.push({
          name, kind: "function", line, endLine, file: relPath,
          params: paramsOf(node), async: !!node.async, generator: !!node.generator,
        });
        break;
      }

      case "ClassDeclaration":
      case "ClassExpression": {
        const name = nameOf(node.id);
        if (!name && node.type === "ClassExpression") break; // 匿名 class
        const ext = node.superClass ? memberPath(node.superClass) : null;
        defs.push({
          name: name || "(anonymous)", kind: "class", line, endLine, file: relPath, extends: ext,
        });
        // 提取 class methods
        if (node.body?.body) {
          for (const m of node.body.body) {
            if (m.type === "ClassMethod" || m.type === "ClassPrivateMethod") {
              const mName = nameOf(m.key);
              defs.push({
                name: mName, parent: name || "(anonymous)", kind: "method",
                line: m.loc?.start?.line || 0, endLine: m.loc?.end?.line || 0,
                file: relPath, params: paramsOf(m),
                visibility: m.type === "ClassPrivateMethod" ? "private" : "public",
                isStatic: !!m.static, methodKind: m.kind || "method", async: !!m.async,
              });
            } else if (m.type === "ClassProperty" || m.type === "ClassPrivateProperty") {
              const pName = nameOf(m.key);
              if (isFuncNode(m.value)) {
                defs.push({
                  name: pName, parent: name || "(anonymous)", kind: "method",
                  line: m.loc?.start?.line || 0, endLine: m.loc?.end?.line || 0,
                  file: relPath, params: paramsOf(m.value), isStatic: !!m.static,
                });
              } else {
                defs.push({
                  name: pName, parent: name || "(anonymous)", kind: "property",
                  line: m.loc?.start?.line || 0, endLine: m.loc?.end?.line || 0,
                  file: relPath, isStatic: !!m.static,
                });
              }
            }
          }
        }
        break;
      }

      case "VariableDeclarator": {
        const name = nameOf(node.id);
        if (!name) break;
        const init = node.init;
        if (isFuncNode(init)) {
          defs.push({
            name, kind: "function", line, endLine: init.loc?.end?.line || endLine,
            file: relPath, params: paramsOf(init), async: !!init.async,
          });
        } else if (init?.type === "ClassExpression") {
          // 已在 ClassExpression case 處理（會雙重觸發）→ 改用 parent walk 避免
          // 略過避免重複，ClassExpression 走訪時可能拿不到 var 名 → 在此追加
          const ext = init.superClass ? memberPath(init.superClass) : null;
          defs.push({ name, kind: "class", line, endLine, file: relPath, extends: ext, _viaVar: true });
          if (init.body?.body) {
            for (const m of init.body.body) {
              if (m.type === "ClassMethod") {
                defs.push({
                  name: nameOf(m.key), parent: name, kind: "method",
                  line: m.loc?.start?.line || 0, endLine: m.loc?.end?.line || 0,
                  file: relPath, params: paramsOf(m), isStatic: !!m.static, methodKind: m.kind,
                });
              }
            }
          }
        } else if (init?.type === "ObjectExpression") {
          defs.push({ name, kind: "variable", line, endLine, file: relPath, _hasObj: true });
          // 提取 object literal 的 methods
          for (const p of (init.properties || [])) {
            if (p.type === "ObjectProperty" && isFuncNode(p.value)) {
              defs.push({
                name: nameOf(p.key), parent: name, kind: "object_method",
                line: p.loc?.start?.line || 0,
                endLine: p.value.loc?.end?.line || p.loc?.end?.line || 0,
                file: relPath, params: paramsOf(p.value),
              });
            } else if (p.type === "ObjectMethod") {
              defs.push({
                name: nameOf(p.key), parent: name, kind: "object_method",
                line: p.loc?.start?.line || 0, endLine: p.loc?.end?.line || 0,
                file: relPath, params: paramsOf(p), methodKind: p.kind,
              });
            }
          }
        } else if (init?.type === "NewExpression" || init?.type === "CallExpression") {
          const calleeName = memberPath(init.callee);
          defs.push({
            name, kind: "variable", line, endLine, file: relPath,
            initFrom: init.type === "NewExpression" ? `new ${calleeName}(...)` : `${calleeName}(...)`,
          });
        } else if (init) {
          defs.push({ name, kind: "variable", line, endLine, file: relPath });
        } else {
          defs.push({ name, kind: "variable", line, endLine, file: relPath });
        }
        break;
      }

      case "AssignmentExpression": {
        // 處理 `Foo.bar = function() {}` / `Foo.prototype.bar = function() {}`
        if (node.operator !== "=") break;
        if (node.left?.type !== "MemberExpression") break;
        const fullPath = memberPath(node.left);
        if (!fullPath) break;
        const dot = fullPath.lastIndexOf(".");
        if (dot < 0) break;
        const parent = fullPath.slice(0, dot);
        const name = fullPath.slice(dot + 1);
        const right = node.right;
        if (isFuncNode(right)) {
          defs.push({
            name, parent, kind: "object_method",
            line, endLine: right.loc?.end?.line || endLine,
            file: relPath, params: paramsOf(right), async: !!right.async,
          });
        } else if (right?.type === "ObjectExpression") {
          // Foo.prototype = { a:fn, b:fn }
          for (const p of (right.properties || [])) {
            if (p.type === "ObjectProperty" && isFuncNode(p.value)) {
              defs.push({
                name: nameOf(p.key), parent: fullPath, kind: "object_method",
                line: p.loc?.start?.line || 0,
                endLine: p.value.loc?.end?.line || p.loc?.end?.line || 0,
                file: relPath, params: paramsOf(p.value),
              });
            } else if (p.type === "ObjectMethod") {
              defs.push({
                name: nameOf(p.key), parent: fullPath, kind: "object_method",
                line: p.loc?.start?.line || 0, endLine: p.loc?.end?.line || 0,
                file: relPath, params: paramsOf(p), methodKind: p.kind,
              });
            }
          }
        }
        break;
      }

      case "ExportNamedDeclaration": {
        // 標記 export
        if (node.declaration?.type === "FunctionDeclaration") {
          const name = nameOf(node.declaration.id);
          if (name) defs.push({
            name, kind: "function", line, endLine: node.declaration.loc?.end?.line || endLine,
            file: relPath, params: paramsOf(node.declaration), exported: true,
            async: !!node.declaration.async,
          });
        } else if (node.declaration?.type === "ClassDeclaration") {
          // 由 ClassDeclaration case 補上；這裡標記 exported
          // 不重複加入；下方在 buildIndex 結束時做 export 標記合併
        }
        // export { a, b } 形式：記錄 re-export references（先略）
        break;
      }

      case "ExportDefaultDeclaration": {
        const d = node.declaration;
        if (d?.type === "FunctionDeclaration") {
          const name = nameOf(d.id) || "default";
          defs.push({
            name, kind: "function", line, endLine: d.loc?.end?.line || endLine,
            file: relPath, params: paramsOf(d), exported: true, default: true,
          });
        } else if (d?.type === "Identifier") {
          // export default Foo — 記為 re-export，先不額外處理
        }
        break;
      }

      case "CallExpression":
      case "OptionalCallExpression": {
        const callee = node.callee;
        if (!callee) break;
        let p = memberPath(callee);
        if (!p && callee.type === "FunctionExpression") break; // IIFE
        if (!p) break;
        const root = p.split(".")[0];
        calls.push({ path: p, callee_root: root, line, file: relPath, type: "call" });
        break;
      }

      case "NewExpression": {
        const p = memberPath(node.callee);
        if (p) calls.push({ path: p, callee_root: p.split(".")[0], line, file: relPath, type: "new" });
        break;
      }
    }
  });

  // ── 第二輪：抓「自由 ObjectExpression 內的 methods」──────────
  // 場景：`return { Show: fn }`（工廠 pattern）、`new Foo({ onClick: fn })`（config 回呼）等
  // 第一輪已索引的（變數/賦值 parent 明確的）跳過，避免重複
  const seenMethodKeys = new Set(
    defs.filter(d => d.kind === "object_method" || d.kind === "method")
        .map(d => `${d.file}:${d.line}:${d.name}`)
  );
  walkAST(ast, (node) => {
    if (node.type === "ObjectProperty" && isFuncNode(node.value)) {
      const mName = nameOf(node.key);
      if (!mName) return;
      const ln = node.loc?.start?.line || 0;
      const key = `${relPath}:${ln}:${mName}`;
      if (seenMethodKeys.has(key)) return;
      seenMethodKeys.add(key);
      defs.push({
        name: mName, parent: null, kind: "object_method",
        line: ln, endLine: node.value.loc?.end?.line || node.loc?.end?.line || 0,
        file: relPath, params: paramsOf(node.value), _anonymous: true,
      });
    } else if (node.type === "ObjectMethod") {
      const mName = nameOf(node.key);
      if (!mName) return;
      const ln = node.loc?.start?.line || 0;
      const key = `${relPath}:${ln}:${mName}`;
      if (seenMethodKeys.has(key)) return;
      seenMethodKeys.add(key);
      defs.push({
        name: mName, parent: null, kind: "object_method",
        line: ln, endLine: node.loc?.end?.line || 0,
        file: relPath, params: paramsOf(node), methodKind: node.kind, _anonymous: true,
      });
    }
  });

  // 去重（ClassDeclaration + VariableDeclarator(_viaVar) 重複時保留有 parent 的版本）
  const dedupedDefs = [];
  const seenKey = new Set();
  for (const d of defs) {
    const key = `${d.file}:${d.line}:${d.name}:${d.parent || ""}:${d.kind}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    dedupedDefs.push(d);
  }

  return { defs: dedupedDefs, calls };
}

// ============================================
// 檔案解析
// ============================================
async function parseFile(filePath) {
  const parser = await getParser();
  let code;
  try {
    code = await fs.readFile(filePath, "utf-8");
  } catch (e) {
    return { ast: null, error: e.message };
  }

  const ext = path.extname(filePath).toLowerCase();
  let scriptOffset = 0;

  // .vue: 只抓 <script> 區段
  if (ext === ".vue") {
    const m = code.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return { ast: null, error: "no <script> in .vue" };
    scriptOffset = code.slice(0, m.index).split("\n").length - 1;
    code = m[1];
  }

  const isTS = ext === ".ts" || ext === ".tsx";
  const isJSX = ext === ".jsx" || ext === ".tsx" || ext === ".vue";

  const plugins = [
    "objectRestSpread", "asyncGenerators", "classProperties", "classPrivateProperties",
    "classPrivateMethods", "optionalChaining", "nullishCoalescingOperator",
    "dynamicImport", "decorators-legacy", "topLevelAwait",
  ];
  if (isJSX) plugins.push("jsx");
  if (isTS) plugins.push("typescript");

  try {
    const ast = parser.parse(code, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      errorRecovery: true,
      plugins,
    });
    return { ast, scriptOffset, code };
  } catch (e) {
    return { ast: null, error: e.message };
  }
}

// ============================================
// 建立索引
// ============================================
const DEFAULT_EXCLUDE = [
  "**/node_modules/**", "**/vendor/**", "**/.git/**", "**/dist/**",
  "**/build/**", "**/.next/**", "**/.nuxt/**", "**/out/**",
  "**/*.min.js", "**/*.bundle.js",
];

async function buildIndex(projectPath, scanPaths, excludePatterns) {
  const ignore = [...DEFAULT_EXCLUDE, ...(excludePatterns || [])];
  const exts = "{js,jsx,mjs,cjs,ts,tsx,vue}";

  let patterns;
  if (scanPaths && scanPaths.length > 0) {
    patterns = scanPaths.map(p => `${path.join(projectPath, p).replace(/\\/g, "/")}/**/*.${exts}`);
  } else {
    patterns = [`${projectPath.replace(/\\/g, "/")}/**/*.${exts}`];
  }

  const files = [];
  for (const pattern of patterns) {
    const matched = await glob(pattern, { ignore, nodir: true });
    files.push(...matched);
  }

  const index = {
    project: path.basename(projectPath),
    projectPath,
    fileCount: files.length,
    defs: [],
    calls: [],
    errors: [],
    builtAt: new Date().toISOString(),
  };

  for (const file of files) {
    const relPath = path.relative(projectPath, file).replace(/\\/g, "/");
    const { ast, error } = await parseFile(file);
    if (!ast) {
      index.errors.push({ file: relPath, error: error || "parse failed" });
      continue;
    }
    try {
      const { defs, calls } = extractSymbols(ast, relPath);
      index.defs.push(...defs);
      index.calls.push(...calls);
    } catch (e) {
      index.errors.push({ file: relPath, error: e.message });
    }
  }
  return index;
}

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
          return { path: candidate, hint: `⚠️ 自動修正路徑：原指定 \`${projectName}\` 不存在，已改用 \`${ent.name}/${projectName}\`。` };
        }
      } catch {}
    }
  } catch {}
  return { path: projectPath, hint: null, missing: true };
}

async function getIndex(project, opts = {}) {
  const rawPath = resolveSecurePath(project);
  const resolved = await resolveNestedProject(rawPath);
  const projectPath = resolved.path;
  const cacheKey = projectPath;

  if (!opts.force && indexCache.has(cacheKey)) {
    const cached = indexCache.get(cacheKey);
    if (Date.now() - cached.timestamp < INDEX_TTL) {
      return { ...cached.index, _pathHint: resolved.hint };
    }
  }
  const index = await buildIndex(projectPath, opts.paths, opts.exclude);
  index._pathHint = resolved.hint;
  indexCache.set(cacheKey, { index, timestamp: Date.now() });
  return index;
}

// ============================================
// trace_logic helpers
// ============================================
function exprToStr(n, maxLen = 80) {
  const s = _expr(n);
  return s.length > maxLen ? s.slice(0, maxLen - 3) + "..." : s;
}

function _expr(n) {
  if (!n || typeof n !== "object") return String(n ?? "");
  switch (n.type) {
    case "Identifier": return n.name;
    case "ThisExpression": return "this";
    case "Super": return "super";
    case "StringLiteral": return n.value.length > 30 ? `'${n.value.slice(0, 27)}...'` : `'${n.value}'`;
    case "NumericLiteral": case "BooleanLiteral": case "BigIntLiteral":
      return String(n.value);
    case "NullLiteral": return "null";
    case "TemplateLiteral": return "`...`";
    case "MemberExpression":
    case "OptionalMemberExpression": {
      const o = _expr(n.object);
      const p = n.computed ? `[${_expr(n.property)}]` : nameOf(n.property);
      return n.computed ? `${o}${p}` : `${o}.${p}`;
    }
    case "CallExpression":
    case "OptionalCallExpression": {
      const c = _expr(n.callee);
      const args = (n.arguments || []).map(_expr).join(", ");
      return `${c}(${args})`;
    }
    case "NewExpression":
      return `new ${_expr(n.callee)}(${(n.arguments || []).map(_expr).join(", ")})`;
    case "BinaryExpression":
    case "LogicalExpression":
      return `${_expr(n.left)} ${n.operator} ${_expr(n.right)}`;
    case "UnaryExpression":
      return `${n.operator}${_expr(n.argument)}`;
    case "UpdateExpression":
      return n.prefix ? `${n.operator}${_expr(n.argument)}` : `${_expr(n.argument)}${n.operator}`;
    case "AssignmentExpression":
      return `${_expr(n.left)} ${n.operator} ${_expr(n.right)}`;
    case "ConditionalExpression":
      return `${_expr(n.test)} ? ${_expr(n.consequent)} : ${_expr(n.alternate)}`;
    case "ArrayExpression":
      return `[${(n.elements || []).slice(0, 3).map(_expr).join(", ")}${n.elements?.length > 3 ? ", ..." : ""}]`;
    case "ObjectExpression": return "{...}";
    case "ArrowFunctionExpression":
    case "FunctionExpression": return "function(){...}";
    case "AwaitExpression": return `await ${_expr(n.argument)}`;
    case "SpreadElement": return `...${_expr(n.argument)}`;
    case "ParenthesizedExpression": return `(${_expr(n.expression)})`;
    case "SequenceExpression": return (n.expressions || []).map(_expr).join(", ");
    default: return `{${n.type}}`;
  }
}

function stmtsOf(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (body.type === "BlockStatement") return body.body || [];
  return [body];
}

function traceStmts(stmts) {
  const flow = [];
  for (const s of stmts) {
    if (!s || typeof s !== "object") continue;
    const L = s.loc?.start?.line || 0;

    switch (s.type) {
      case "IfStatement": {
        const branches = [{ label: exprToStr(s.test), body: traceStmts(stmtsOf(s.consequent)) }];
        let alt = s.alternate;
        while (alt) {
          if (alt.type === "IfStatement") {
            branches.push({ label: `else if (${exprToStr(alt.test)})`, body: traceStmts(stmtsOf(alt.consequent)) });
            alt = alt.alternate;
          } else {
            branches.push({ label: "else", body: traceStmts(stmtsOf(alt)) });
            alt = null;
          }
        }
        flow.push({ type: "if", condition: exprToStr(s.test), line: L, branches });
        break;
      }
      case "SwitchStatement": {
        const cases = (s.cases || []).map(c => ({
          label: c.test ? exprToStr(c.test) : "default",
          body: traceStmts(c.consequent || []),
        }));
        flow.push({ type: "switch", condition: exprToStr(s.discriminant), line: L, cases });
        break;
      }
      case "ForStatement":
        flow.push({
          type: "loop", sub: "for",
          cond: `${s.init ? exprToStr(s.init) : ""}; ${s.test ? exprToStr(s.test) : ""}; ${s.update ? exprToStr(s.update) : ""}`,
          line: L, body: traceStmts(stmtsOf(s.body)),
        });
        break;
      case "ForInStatement":
      case "ForOfStatement":
        flow.push({
          type: "loop", sub: s.type === "ForInStatement" ? "for-in" : "for-of",
          cond: `${exprToStr(s.left)} ${s.type === "ForInStatement" ? "in" : "of"} ${exprToStr(s.right)}`,
          line: L, body: traceStmts(stmtsOf(s.body)),
        });
        break;
      case "WhileStatement":
        flow.push({ type: "loop", sub: "while", cond: exprToStr(s.test), line: L, body: traceStmts(stmtsOf(s.body)) });
        break;
      case "DoWhileStatement":
        flow.push({ type: "loop", sub: "do-while", cond: exprToStr(s.test), line: L, body: traceStmts(stmtsOf(s.body)) });
        break;
      case "TryStatement":
        flow.push({
          type: "try", line: L,
          body: traceStmts(stmtsOf(s.block)),
          catch: s.handler ? { var: s.handler.param ? exprToStr(s.handler.param) : "", body: traceStmts(stmtsOf(s.handler.body)) } : null,
          finally: s.finalizer ? traceStmts(stmtsOf(s.finalizer)) : null,
        });
        break;
      case "ReturnStatement":
        flow.push({ type: "return", text: s.argument ? exprToStr(s.argument) : "(void)", line: L });
        break;
      case "ThrowStatement":
        flow.push({ type: "throw", text: exprToStr(s.argument), line: L });
        break;
      case "BreakStatement":
        flow.push({ type: "break", line: L });
        break;
      case "ContinueStatement":
        flow.push({ type: "continue", line: L });
        break;
      case "ExpressionStatement": {
        const e = s.expression;
        if (e?.type === "CallExpression" || e?.type === "OptionalCallExpression" || e?.type === "NewExpression") {
          flow.push({ type: "call", text: exprToStr(e), line: L });
        } else if (e?.type === "AssignmentExpression") {
          flow.push({ type: "assign", text: exprToStr(e), line: L });
        } else if (e?.type === "AwaitExpression") {
          flow.push({ type: "await", text: exprToStr(e), line: L });
        } else {
          flow.push({ type: "expr", text: exprToStr(e), line: L });
        }
        break;
      }
      case "VariableDeclaration":
        for (const d of (s.declarations || [])) {
          flow.push({
            type: "var", kind: s.kind || "var", line: L,
            text: `${nameOf(d.id) || "?"}${d.init ? " = " + exprToStr(d.init) : ""}`,
          });
        }
        break;
      case "BlockStatement":
        flow.push(...traceStmts(s.body || []));
        break;
    }
  }
  return flow;
}

function renderFlow(flow, indent = "  ") {
  const out = [];
  for (const n of flow) {
    const tag = n.line ? `  ⟨L${n.line}⟩` : "";
    switch (n.type) {
      case "if":
        out.push(`${indent}┌─ if (${n.condition})${tag}`);
        for (const b of n.branches) {
          out.push(`${indent}│  ▸ ${b.label}`);
          out.push(...renderFlow(b.body, indent + "│    "));
        }
        out.push(`${indent}└─ /if`);
        break;
      case "switch":
        out.push(`${indent}┌─ switch (${n.condition})${tag}`);
        for (const c of n.cases) {
          out.push(`${indent}│  ▸ case ${c.label}`);
          out.push(...renderFlow(c.body, indent + "│    "));
        }
        out.push(`${indent}└─ /switch`);
        break;
      case "loop":
        out.push(`${indent}┌─ ${n.sub} (${n.cond})${tag}`);
        out.push(...renderFlow(n.body, indent + "│  "));
        out.push(`${indent}└─ /${n.sub}`);
        break;
      case "try":
        out.push(`${indent}┌─ try${tag}`);
        out.push(...renderFlow(n.body, indent + "│  "));
        if (n.catch) {
          out.push(`${indent}│  catch (${n.catch.var})`);
          out.push(...renderFlow(n.catch.body, indent + "│    "));
        }
        if (n.finally) {
          out.push(`${indent}│  finally`);
          out.push(...renderFlow(n.finally, indent + "│    "));
        }
        out.push(`${indent}└─ /try`);
        break;
      case "return": out.push(`${indent}⏎ return ${n.text}${tag}`); break;
      case "throw": out.push(`${indent}💥 throw ${n.text}${tag}`); break;
      case "call": out.push(`${indent}→ ${n.text}${tag}`); break;
      case "assign": out.push(`${indent}= ${n.text}${tag}`); break;
      case "await": out.push(`${indent}⏳ ${n.text}${tag}`); break;
      case "var": out.push(`${indent}${n.kind} ${n.text}${tag}`); break;
      case "break": out.push(`${indent}break${tag}`); break;
      case "continue": out.push(`${indent}continue${tag}`); break;
      case "expr": out.push(`${indent}${n.text}${tag}`); break;
    }
  }
  return out;
}

// ============================================
// 找 symbol 的定義節點（給 lookup 與 trace_logic 用）
// ============================================
function parseSymbol(symbol) {
  const idx = symbol.lastIndexOf(".");
  if (idx < 0) return { name: symbol, parent: null };
  return { name: symbol.slice(idx + 1), parent: symbol.slice(0, idx) };
}

function findDefs(index, symbol) {
  const { name, parent } = parseSymbol(symbol);
  const matches = [];
  for (const d of index.defs) {
    if (d.name !== name) continue;
    if (parent === null) {
      // 不限父層：純 function/class/變數
      if (!d.parent || d.kind === "method" || d.kind === "object_method") matches.push(d);
    } else {
      // 指定父層：必須吻合
      if (d.parent === parent) matches.push(d);
    }
  }
  return matches;
}

// 讀取定義原始碼
async function readDefBody(index, def, includeBody = true) {
  if (!includeBody) return null;
  const full = path.join(index.projectPath, def.file);
  const code = await fs.readFile(full, "utf-8");
  const lines = code.split(/\r?\n/);
  const start = Math.max(0, (def.line || 1) - 1);
  const end = Math.min(lines.length, (def.endLine || def.line || start + 1));
  return lines.slice(start, end).join("\n");
}

// ============================================
// Handlers
// ============================================
async function handleSymbolIndex(args) {
  const { project, paths: scanPaths, exclude, force } = args;
  const index = await getIndex(project, { paths: scanPaths, exclude, force });

  const lines = [];
  if (index._pathHint) lines.push(index._pathHint, "");
  lines.push(`# JS/TS 符號索引 — ${index.project}`);
  lines.push(`掃描 ${index.fileCount} 個檔案`);
  lines.push(`建立時間：${index.builtAt}`);
  lines.push(`快取 TTL：4 小時`);
  lines.push("");
  lines.push(`## 統計`);
  const byKind = {};
  for (const d of index.defs) byKind[d.kind] = (byKind[d.kind] || 0) + 1;
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${k.padEnd(16)} ${n}`);
  }
  lines.push(`  ${"calls".padEnd(16)} ${index.calls.length}`);
  if (index.errors.length) {
    lines.push("");
    lines.push(`## 解析失敗 (${index.errors.length})`);
    for (const e of index.errors.slice(0, 10)) lines.push(`  ✗ ${e.file}: ${e.error}`);
    if (index.errors.length > 10) lines.push(`  ... 還有 ${index.errors.length - 10} 個`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleSymbolLookup(args) {
  const { project, symbol, include_body = true } = args;
  const index = await getIndex(project);
  const { name, parent } = parseSymbol(symbol);

  const matches = findDefs(index, symbol);
  const lines = [];
  if (index._pathHint) lines.push(index._pathHint, "");
  lines.push(`# 查詢符號：\`${symbol}\``);

  if (matches.length === 0) {
    // 找不到完全吻合，給近似建議
    const near = index.defs.filter(d => d.name === name).slice(0, 5);
    lines.push(`❌ 找不到 \`${symbol}\` 的定義。`);
    if (near.length > 0) {
      lines.push("");
      lines.push(`## 近似名稱（name=${name}，parent 不同）`);
      for (const d of near) {
        lines.push(`  - ${d.parent ? d.parent + "." : ""}${d.name} (${d.kind}) — ${d.file}:${d.line}`);
      }
    }
    // 也試試「parent 是該變數（其 init 是 new/call）」的情況
    if (parent) {
      const parentDefs = index.defs.filter(d => d.name === parent && d.kind === "variable" && d.initFrom);
      if (parentDefs.length > 0) {
        lines.push("");
        lines.push(`## 父物件 \`${parent}\` 的初始化（可能來源）`);
        for (const d of parentDefs) {
          lines.push(`  - ${d.file}:${d.line} → ${d.initFrom}`);
        }
        lines.push(`  💡 可改用 js_symbol_lookup 查 \`${parent.split(".").pop()}\` 或對應 class 找 \`${name}\` 方法`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  lines.push(`找到 ${matches.length} 個定義`);
  lines.push("");
  for (const d of matches) {
    const head = `## ${d.parent ? d.parent + "." : ""}${d.name}  (${d.kind}${d.async ? " async" : ""}${d.isStatic ? " static" : ""})`;
    lines.push(head);
    lines.push(`📁 ${d.file}:${d.line}${d.endLine && d.endLine !== d.line ? `-${d.endLine}` : ""}`);
    if (d.params) lines.push(`📝 參數：(${d.params.join(", ")})`);
    if (d.extends) lines.push(`📥 extends ${d.extends}`);
    if (d.exported) lines.push(`📤 exported${d.default ? " (default)" : ""}`);
    if (include_body) {
      const body = await readDefBody(index, d, true);
      if (body) {
        lines.push("");
        lines.push("```js");
        lines.push(body);
        lines.push("```");
      }
    }
    lines.push("");
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleFindUsages(args) {
  const { project, symbol, kind = "any" } = args;
  const index = await getIndex(project);
  const { name, parent } = parseSymbol(symbol);
  const fullPath = symbol;

  // 比對方式：
  //   parent 存在：呼叫的 path 必須等於 fullPath
  //   parent 不存在：path 等於 name（裸函式呼叫）或 path 結尾為 .name（成員呼叫）
  const callMatches = [];
  for (const c of index.calls) {
    if (parent) {
      if (c.path === fullPath) callMatches.push(c);
    } else {
      if (c.path === name || c.path.endsWith("." + name)) callMatches.push(c);
    }
  }

  const lines = [];
  if (index._pathHint) lines.push(index._pathHint, "");
  lines.push(`# 引用查詢：\`${symbol}\`（kind=${kind}）`);

  if (kind === "any" || kind === "call") {
    lines.push("");
    lines.push(`## 函式呼叫 (${callMatches.length})`);
    if (callMatches.length === 0) lines.push("  (無)");
    else {
      // 依檔案分組
      const byFile = new Map();
      for (const c of callMatches) {
        if (!byFile.has(c.file)) byFile.set(c.file, []);
        byFile.get(c.file).push(c);
      }
      for (const [f, arr] of [...byFile.entries()].sort()) {
        lines.push(`  📁 ${f}`);
        for (const c of arr.slice(0, 50)) {
          lines.push(`     L${c.line}  ${c.type === "new" ? "new " : ""}${c.path}(...)`);
        }
        if (arr.length > 50) lines.push(`     ... 還有 ${arr.length - 50} 筆`);
      }
    }
  }

  // reference 模式：MemberExpression 字面引用（不在 CallExpression 內也算）
  // 為了避免再走一輪 AST，這裡用備用做法：grep 字串比對作 fallback（精度較低）
  // TODO: 若需精確 reference 索引，需在 extractSymbols 階段另存 refs 陣列
  if (kind === "reference") {
    lines.push("");
    lines.push(`## 字面引用（reference 模式目前僅回傳 call，需 reference 索引才完整）`);
    lines.push(`  💡 暫以 call 結果替代；若需 MemberExpression 純引用，請改用 Grep 補查。`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleTraceLogic(args) {
  const { project, symbol, file, max_depth = 1 } = args;
  const maxD = Math.max(1, Math.min(3, max_depth));
  const index = await getIndex(project);
  const { name } = parseSymbol(symbol);

  let candidates = findDefs(index, symbol);
  if (file) candidates = candidates.filter(d => d.file === file || d.file === file.replace(/\\/g, "/"));

  const lines = [];
  if (index._pathHint) lines.push(index._pathHint, "");
  lines.push(`# 邏輯追蹤：\`${symbol}\``);

  if (candidates.length === 0) {
    lines.push(`❌ 找不到 \`${symbol}\` 的定義。`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // 多個候選：列出讓使用者挑
  if (candidates.length > 1 && !file) {
    lines.push(`⚠️ 找到 ${candidates.length} 個定義，請指定 \`file\` 參數：`);
    for (const d of candidates) lines.push(`  - ${d.file}:${d.line}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  const def = candidates[0];
  lines.push(`📁 ${def.file}:${def.line}`);
  if (def.params) lines.push(`📝 參數：(${def.params.join(", ")})`);
  lines.push("");

  // 重新解析該檔，定位函式 body
  const fullFile = path.join(index.projectPath, def.file);
  const { ast } = await parseFile(fullFile);
  if (!ast) {
    lines.push(`❌ 解析失敗：${def.file}`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // 找 body
  let bodyNode = null;
  walkAST(ast, (n) => {
    if (bodyNode) return;
    const ln = n.loc?.start?.line;
    if (ln !== def.line) return;
    if (n.type === "FunctionDeclaration" && nameOf(n.id) === name) bodyNode = n.body;
    else if ((n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") && n.body) bodyNode = n.body;
    else if (n.type === "ClassMethod" && nameOf(n.key) === name) bodyNode = n.body;
    else if (n.type === "ObjectMethod" && nameOf(n.key) === name) bodyNode = n.body;
  });

  if (!bodyNode) {
    // 退而求其次：用最寬鬆的方式找
    walkAST(ast, (n) => {
      if (bodyNode) return;
      if ((isFuncNode(n) || n.type === "ClassMethod" || n.type === "ObjectMethod") &&
          n.loc?.start?.line === def.line) bodyNode = n.body;
    });
  }

  if (!bodyNode) {
    lines.push(`⚠️ 已找定義但無法定位函式 body。`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  const flow = traceStmts(stmtsOf(bodyNode));
  lines.push("```");
  lines.push(...renderFlow(flow, ""));
  lines.push("```");

  if (maxD > 1) {
    lines.push("");
    lines.push(`💡 max_depth=${maxD} 已啟用，但子呼叫遞迴追蹤尚未實作（PHP 版有，JS 版 v1 略）`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ============================================
// Dispatch
// ============================================
export async function handle(name, args) {
  switch (name) {
    case "js_symbol_index": return handleSymbolIndex(args);
    case "js_symbol_lookup": return handleSymbolLookup(args);
    case "js_find_usages": return handleFindUsages(args);
    case "js_trace_logic": return handleTraceLogic(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
