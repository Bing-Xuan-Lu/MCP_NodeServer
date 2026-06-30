// tools/system/css_class.js — CSS class 索引：定義位置 + 跨檔引用
// 依賴：postcss, postcss-selector-parser
// 對應前端版本的「class_method_lookup + find_usages」

import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import { resolveSecurePath, CONFIG } from "../../config.js";

let _postcss = null;
let _selectorParser = null;
async function getPostcss() {
  if (!_postcss) _postcss = (await import("postcss")).default;
  if (!_selectorParser) _selectorParser = (await import("postcss-selector-parser")).default;
  return { postcss: _postcss, selectorParser: _selectorParser };
}

const indexCache = new Map();
const INDEX_TTL = 4 * 60 * 60 * 1000;

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "css_class_lookup",
    description:
      "找指定 CSS class 在所有 .css/.scss/.sass/.less 中的定義位置 + selector + 規則內容。回傳每筆 rule 的 selector、@media 上下文、檔案行號。比 Grep 準（會處理 .name.active / .parent > .name 這類組合，並回報是否為主規則）。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "專案資料夾名稱（相對 basePath）" },
        class_name: { type: "string", description: "CSS class 名稱（不含開頭點，例：`Popup-login`）" },
        include_body: { type: "boolean", description: "是否回傳 rule body（declarations，預設 true）" },
        paths: { type: "array", items: { type: "string" }, description: "限定子目錄（選填）" },
      },
      required: ["project", "class_name"],
    },
  },
  {
    name: "css_find_usages",
    description:
      "找指定 CSS class 在 PHP/HTML/JS/TS/Vue/JSX 中的引用位置。涵蓋 `class=\"...\"` / `className=\"...\"` / `addClass/removeClass/toggleClass('...')` / Vue `:class=\"...\"`。比 Grep 準（會解析 attribute 內多 class、排除字串中名稱誤匹配）。",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "專案資料夾名稱" },
        class_name: { type: "string", description: "CSS class 名稱（不含開頭點）" },
        paths: { type: "array", items: { type: "string" }, description: "限定子目錄（選填）" },
        exts: {
          type: "array", items: { type: "string" },
          description: "副檔名（預設 php/html/htm/twig/blade.php/js/jsx/ts/tsx/vue）",
        },
      },
      required: ["project", "class_name"],
    },
  },
];

// ============================================
// CSS 索引
// ============================================
const DEFAULT_CSS_EXCLUDE = [
  "**/node_modules/**", "**/vendor/**", "**/.git/**", "**/dist/**",
  "**/build/**", "**/*.min.css",
];

async function buildCssIndex(projectPath, scanPaths) {
  const { postcss, selectorParser } = await getPostcss();
  const ignore = DEFAULT_CSS_EXCLUDE;
  const exts = "{css,scss,sass,less}";

  let patterns;
  if (scanPaths && scanPaths.length > 0) {
    patterns = scanPaths.map(p => `${path.join(projectPath, p).replace(/\\/g, "/")}/**/*.${exts}`);
  } else {
    patterns = [`${projectPath.replace(/\\/g, "/")}/**/*.${exts}`];
  }

  const files = [];
  for (const p of patterns) files.push(...await glob(p, { ignore, nodir: true }));

  // classMap: className → [{ file, line, selector, mediaCtx, classRoleInSelector, declarations }]
  const classMap = new Map();
  const errors = [];

  for (const file of files) {
    const relPath = path.relative(projectPath, file).replace(/\\/g, "/");
    let css;
    try { css = await fs.readFile(file, "utf-8"); }
    catch (e) { errors.push({ file: relPath, error: e.message }); continue; }

    let root;
    try {
      root = postcss.parse(css, { from: file });
    } catch (e) {
      errors.push({ file: relPath, error: e.message });
      continue;
    }

    // 走訪所有 rule，記錄 selector + @media 上下文
    root.walkRules((rule) => {
      // 取得 @media 鏈
      const mediaCtx = [];
      let p = rule.parent;
      while (p && p.type !== "root") {
        if (p.type === "atrule") mediaCtx.unshift(`@${p.name} ${p.params}`);
        p = p.parent;
      }

      // 取得 declarations 摘要
      const decls = [];
      rule.walkDecls(d => decls.push(`${d.prop}: ${d.value}${d.important ? " !important" : ""}`));

      // 解析 selector 拆出 class 名單
      const selectors = (rule.selectors || [rule.selector]);
      for (const sel of selectors) {
        let foundClasses = [];
        try {
          selectorParser((selRoot) => {
            selRoot.walkClasses(c => foundClasses.push(c.value));
          }).processSync(sel);
        } catch {
          // selector 解析失敗就略過該 selector
          continue;
        }
        // 分析 class 在 selector 中的角色：
        //   leaf = selector 結尾段、可能是主要規則
        //   compound = 與其他 class 串連（.X.Y）
        //   ancestor = 出現在組合子前段（祖先選擇器）
        const segments = sel.split(/[\s>+~]+/).filter(Boolean);
        const lastSeg = segments[segments.length - 1] || "";

        const uniq = [...new Set(foundClasses)];
        for (const cls of uniq) {
          const inLast = lastSeg.includes("." + cls);
          const isCompound = inLast && /\.[\w-]+\.[\w-]+/.test(lastSeg);
          const role = inLast ? (isCompound ? "compound" : "leaf") : "ancestor";

          if (!classMap.has(cls)) classMap.set(cls, []);
          classMap.get(cls).push({
            file: relPath,
            line: rule.source?.start?.line || 0,
            endLine: rule.source?.end?.line || 0,
            selector: sel.trim(),
            fullSelector: rule.selector,
            mediaCtx: mediaCtx.length ? mediaCtx.join(" / ") : null,
            role,
            declCount: decls.length,
            declarations: decls,
          });
        }
      }
    });
  }

  return {
    project: path.basename(projectPath),
    projectPath,
    fileCount: files.length,
    classMap,
    errors,
    builtAt: new Date().toISOString(),
  };
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
          return { path: candidate, hint: `⚠️ 路徑自動修正為 \`${ent.name}/${projectName}\`` };
        }
      } catch {}
    }
  } catch {}
  return { path: projectPath, hint: null, missing: true };
}

async function getCssIndex(project, opts = {}) {
  const rawPath = resolveSecurePath(project);
  const resolved = await resolveNestedProject(rawPath);
  const projectPath = resolved.path;
  const key = projectPath + "|" + (opts.paths || []).join(",");

  if (!opts.force && indexCache.has(key)) {
    const cached = indexCache.get(key);
    if (Date.now() - cached.timestamp < INDEX_TTL) {
      return { ...cached.index, _pathHint: resolved.hint };
    }
  }
  const index = await buildCssIndex(projectPath, opts.paths);
  index._pathHint = resolved.hint;
  indexCache.set(key, { index, timestamp: Date.now() });
  return index;
}

// ============================================
// css_class_lookup
// ============================================
async function handleClassLookup(args) {
  const { project, class_name, include_body = true, paths: scanPaths } = args;
  const index = await getCssIndex(project, { paths: scanPaths });
  const rules = index.classMap.get(class_name) || [];

  const lines = [];
  if (index._pathHint) lines.push(index._pathHint, "");
  lines.push(`# CSS class 查詢：\`.${class_name}\``);

  if (rules.length === 0) {
    lines.push(`❌ 找不到 \`.${class_name}\` 的規則定義。`);
    // 近似建議
    const lc = class_name.toLowerCase();
    const near = [...index.classMap.keys()].filter(k => {
      const klc = k.toLowerCase();
      return klc.includes(lc) || lc.includes(klc);
    }).slice(0, 10);
    if (near.length > 0) {
      lines.push("");
      lines.push(`## 近似名稱`);
      for (const n of near) lines.push(`  - .${n}  (${index.classMap.get(n).length} 條規則)`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // 分組：leaf / compound / ancestor
  const groups = { leaf: [], compound: [], ancestor: [] };
  for (const r of rules) (groups[r.role] || (groups.leaf = groups.leaf || [])).push(r);

  lines.push(`找到 ${rules.length} 條規則`);
  lines.push(`  主規則 (leaf): ${groups.leaf.length}　組合 (compound): ${groups.compound.length}　祖先 (ancestor): ${groups.ancestor.length}`);
  lines.push("");

  const sections = [
    ["主規則（selector 結尾且僅含 .class）", groups.leaf],
    ["組合選擇器（.class + 其他 class，如 .X.active）", groups.compound],
    ["作為祖先選擇器（.class .child）", groups.ancestor],
  ];

  for (const [title, arr] of sections) {
    if (!arr || arr.length === 0) continue;
    lines.push(`## ${title}`);
    // 依檔案分組
    const byFile = new Map();
    for (const r of arr) {
      if (!byFile.has(r.file)) byFile.set(r.file, []);
      byFile.get(r.file).push(r);
    }
    for (const [f, items] of [...byFile.entries()].sort()) {
      lines.push(`  📁 ${f}`);
      for (const r of items) {
        const mediaTag = r.mediaCtx ? `  [${r.mediaCtx}]` : "";
        lines.push(`     L${r.line}  \`${r.fullSelector}\`${mediaTag}`);
        if (include_body && r.declarations.length > 0) {
          for (const d of r.declarations.slice(0, 12)) lines.push(`        ${d};`);
          if (r.declarations.length > 12) lines.push(`        ... 還有 ${r.declarations.length - 12} 條 declaration`);
        }
      }
    }
    lines.push("");
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ============================================
// css_find_usages — 在 PHP/HTML/JS/Vue 找 class 引用
// ============================================
const DEFAULT_USAGE_EXTS = ["php", "html", "htm", "twig", "js", "jsx", "ts", "tsx", "vue"];
const DEFAULT_USAGE_EXCLUDE = [
  "**/node_modules/**", "**/vendor/**", "**/.git/**", "**/dist/**",
  "**/build/**", "**/*.min.js", "**/*.bundle.js",
];

// 從 attribute 字串提取 class 名單（支援 "a b c" 與 JSX template { 'a b': x }）
function extractClassesFromAttr(value) {
  // 直接 split 空白；若含 { 或 ?? 等模板符號，做寬鬆掃描
  const tokens = value.split(/[\s,]+/).filter(Boolean);
  const classes = [];
  for (const t of tokens) {
    // 去除引號、括號、模板殘片
    const cleaned = t.replace(/^['"`]+|['"`]+$/g, "").replace(/[{}()?:]/g, "").trim();
    if (/^[\w-]+$/.test(cleaned)) classes.push(cleaned);
  }
  return classes;
}

async function scanFileForClass(filePath, className) {
  let code;
  try { code = await fs.readFile(filePath, "utf-8"); }
  catch { return []; }

  const matches = [];
  const lines = code.split(/\r?\n/);
  const classRe = new RegExp(`\\b${className.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`);

  // 先快速過濾：整檔含 className 才進細掃
  if (!classRe.test(code)) return [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!classRe.test(line)) continue;

    // 模式 1: class="..." / class='...'
    const classAttrs = [
      ...line.matchAll(/\bclass\s*=\s*"([^"]*)"/g),
      ...line.matchAll(/\bclass\s*=\s*'([^']*)'/g),
      ...line.matchAll(/\bclassName\s*=\s*"([^"]*)"/g),
      ...line.matchAll(/\bclassName\s*=\s*'([^']*)'/g),
      // Vue :class="'foo'" / :class="{ foo: bar }" — 用寬鬆 fallback
      ...line.matchAll(/:class\s*=\s*"([^"]*)"/g),
      ...line.matchAll(/:class\s*=\s*'([^']*)'/g),
    ];
    for (const m of classAttrs) {
      const classes = extractClassesFromAttr(m[1]);
      if (classes.includes(className)) {
        matches.push({ line: i + 1, type: "attr", context: line.trim().slice(0, 200), snippet: m[0] });
      }
    }

    // 模式 2: jQuery addClass('foo')/removeClass/toggleClass/hasClass
    const jqCalls = [
      ...line.matchAll(/\.(addClass|removeClass|toggleClass|hasClass)\s*\(\s*['"]([^'"]+)['"]/g),
    ];
    for (const m of jqCalls) {
      const classes = extractClassesFromAttr(m[2]);
      if (classes.includes(className)) {
        matches.push({ line: i + 1, type: `jq:${m[1]}`, context: line.trim().slice(0, 200), snippet: m[0] });
      }
    }

    // 模式 3: classList.add/remove/toggle/contains('foo')
    const dlistCalls = [
      ...line.matchAll(/\.classList\.(add|remove|toggle|contains|replace)\s*\(\s*['"]([^'"]+)['"]/g),
    ];
    for (const m of dlistCalls) {
      const cls = m[2];
      if (cls === className) {
        matches.push({ line: i + 1, type: `classList:${m[1]}`, context: line.trim().slice(0, 200), snippet: m[0] });
      }
    }

    // 模式 4: $(".foo") / document.querySelector(".foo") / querySelectorAll
    const selCalls = [
      ...line.matchAll(/\$\s*\(\s*['"]([^'"]*?)['"]\s*[,)]/g),
      ...line.matchAll(/querySelector(?:All)?\s*\(\s*['"]([^'"]*?)['"]\s*\)/g),
      ...line.matchAll(/getElementsByClassName\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ];
    for (const m of selCalls) {
      const sel = m[1];
      // 解析 selector 字串，看是否含 .className（後面接 word boundary）
      const reSel = new RegExp(`\\.${className.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?![\\w-])`);
      if (reSel.test(sel) || sel === className /* getElementsByClassName 不帶點 */) {
        matches.push({ line: i + 1, type: "selector", context: line.trim().slice(0, 200), snippet: m[0] });
      }
    }
  }

  // 去重（同行同類型同 snippet）
  const seen = new Set();
  return matches.filter(m => {
    const k = `${m.line}|${m.type}|${m.snippet}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function handleFindUsages(args) {
  const { project, class_name, paths: scanPaths, exts } = args;
  const projRawPath = resolveSecurePath(project);
  const resolved = await resolveNestedProject(projRawPath);
  const projectPath = resolved.path;

  const useExts = (exts && exts.length > 0) ? exts : DEFAULT_USAGE_EXTS;
  const extPattern = `{${useExts.join(",")}}`;

  let patterns;
  if (scanPaths && scanPaths.length > 0) {
    patterns = scanPaths.map(p => `${path.join(projectPath, p).replace(/\\/g, "/")}/**/*.${extPattern}`);
  } else {
    patterns = [`${projectPath.replace(/\\/g, "/")}/**/*.${extPattern}`];
  }

  const files = [];
  for (const p of patterns) files.push(...await glob(p, { ignore: DEFAULT_USAGE_EXCLUDE, nodir: true }));

  const lines = [];
  if (resolved.hint) lines.push(resolved.hint, "");
  lines.push(`# CSS class 引用查詢：\`.${class_name}\``);
  lines.push(`掃描 ${files.length} 個檔案（副檔名：${useExts.join(", ")}）`);
  lines.push("");

  const allMatches = [];
  for (const f of files) {
    const ms = await scanFileForClass(f, class_name);
    if (ms.length === 0) continue;
    const rel = path.relative(projectPath, f).replace(/\\/g, "/");
    for (const m of ms) allMatches.push({ file: rel, ...m });
  }

  if (allMatches.length === 0) {
    lines.push(`❌ 沒有任何引用。`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // 統計
  const byType = {};
  for (const m of allMatches) byType[m.type] = (byType[m.type] || 0) + 1;

  lines.push(`找到 ${allMatches.length} 筆引用，分布於 ${new Set(allMatches.map(m => m.file)).size} 個檔案`);
  lines.push(`引用類型：${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push("");

  // 依檔案分組輸出
  const byFile = new Map();
  for (const m of allMatches) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file).push(m);
  }
  for (const [f, arr] of [...byFile.entries()].sort()) {
    lines.push(`📁 ${f}  (${arr.length})`);
    for (const m of arr.slice(0, 30)) {
      lines.push(`   L${m.line}  [${m.type}]  ${m.snippet}`);
    }
    if (arr.length > 30) lines.push(`   ... 還有 ${arr.length - 30} 筆`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ============================================
// Dispatch
// ============================================
export async function handle(name, args) {
  switch (name) {
    case "css_class_lookup": return handleClassLookup(args);
    case "css_find_usages": return handleFindUsages(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
