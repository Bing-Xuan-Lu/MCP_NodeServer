// tools/php_class.js — class_method_lookup
// 給定 PHP class 名稱 + method 名稱（可選），直接回傳完整函式原始碼（含行號）

import fs from "fs/promises";
import path from "path";
import { validateArgs } from "../_shared/utils.js";
import { glob } from "glob";
import { resolveSecurePath, CONFIG } from "../../config.js";

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "class_method_lookup",
    description:
      "給定 PHP class 名稱 + method 名稱（可選），直接回傳完整函式原始碼（含行號）。省去 Grep → Read 兩步，一次到位。若省略 method_name 則回傳 class 概覽（所有方法簽名+行號）。",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "專案資料夾名稱（如 PG_dbox3）",
        },
        class_name: {
          type: "string",
          description: "PHP class 名稱（如 news, blog, order）",
        },
        method_name: {
          type: "string",
          description: "方法名稱（如 getAll, add）。省略則回傳 class 概覽",
        },
        include_body: {
          type: "boolean",
          description: "是否包含函式完整內容（預設 true）。false 時只回傳簽名+行號",
        },
      },
      required: ["project", "class_name"],
    },
  },
];

// ============================================
// 實作
// ============================================
async function handleClassMethodLookup(args) {
  const { project, class_name, method_name, include_body = true } = args;

  // 搜尋 class 檔案（含巢狀專案自動修正）
  const rawPath = resolveSecurePath(project);
  const resolved = await resolveNestedProject(rawPath);
  const projectPath = resolved.path;
  const pathHint = resolved.hint;
  const filePath = await findClassFile(projectPath, class_name);

  if (!filePath) {
    const lines = [`❌ 找不到 class "${class_name}"。`];
    if (resolved.missing) {
      lines.push(`⚠️ 專案路徑不存在：${rawPath}`);
      lines.push(`   提示：請確認 project 參數是否需要包含父層資料夾（例：\`Parent/${project}\`）。`);
    } else {
      lines.push(`搜尋範圍：`);
      lines.push(`  1. ${project}/cls/model/${class_name}.class.php`);
      lines.push(`  2. ${project}/**/${class_name}.class.php`);
      lines.push(`  3. ${project}/**/${class_name}.php`);
      lines.push(`  4. ${project}/cls/model/traits/*.php`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const relPath = path.relative(CONFIG.basePath, filePath).replace(/\\/g, "/");

  // 解析 class 資訊
  const classInfo = parseClassInfo(lines);

  // 解析 trait 方法（遞迴讀 use Trait; 引入的 trait 檔）
  const traitMethods = await collectTraitMethods(projectPath, classInfo.traits);

  if (method_name) {
    // 指定 method：先找本檔，找不到再找 trait
    let method = findMethod(lines, method_name);
    let methodSourceFile = filePath;
    let methodSourceLines = lines;
    let methodSourceTrait = null;

    if (!method) {
      // 在 trait 中找
      for (const tm of traitMethods) {
        const found = findMethod(tm.lines, method_name);
        if (found) {
          method = found;
          methodSourceFile = tm.filePath;
          methodSourceLines = tm.lines;
          methodSourceTrait = tm.traitName;
          break;
        }
      }
    }

    if (!method) {
      const ownOverview = classInfo.methods
        .map(m => `  L${String(m.line).padStart(4)} | ${m.visibility} ${m.name}(${m.params})  [${classInfo.name}]`)
        .join("\n");
      const traitOverview = traitMethods.flatMap(tm =>
        tm.methods.map(m => `  L${String(m.line).padStart(4)} | ${m.visibility} ${m.name}(${m.params})  [${tm.traitName}]`)
      ).join("\n");
      const sections = [`❌ 在 ${classInfo.name}（含 trait）中找不到方法 "${method_name}"。`];
      if (ownOverview) sections.push(`\n本身方法：\n${ownOverview}`);
      if (traitOverview) sections.push(`\nTrait 方法：\n${traitOverview}`);
      return { content: [{ type: "text", text: sections.join("\n") }] };
    }

    const sourceRel = path.relative(CONFIG.basePath, methodSourceFile).replace(/\\/g, "/");
    const result = {
      file: sourceRel,
      class: classInfo.name,
      extends: classInfo.extends,
      method: method_name,
      line_start: method.startLine,
      line_end: method.endLine,
      ...(methodSourceTrait ? { source_trait: methodSourceTrait } : {}),
    };

    if (include_body) {
      const codeLines = methodSourceLines.slice(method.startLine - 1, method.endLine);
      result.code = codeLines
        .map((l, i) => `${String(method.startLine + i).padStart(4)} | ${l}`)
        .join("\n");
    } else {
      result.signature = method.signature;
    }

    const text = pathHint
      ? `${pathHint}\n${JSON.stringify(result, null, 2)}`
      : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }] };
  } else {
    // 未指定 method：回傳 class 概覽（含 trait 方法）
    const ownMethodsTable = classInfo.methods
      .map(m => {
        const vis = m.visibility === "public" ? "pub" : m.visibility === "protected" ? "pro" : "pri";
        const stat = m.isStatic ? " static" : "";
        return `  L${String(m.line).padStart(4)} | ${vis}${stat} ${m.name}(${m.params})  [${classInfo.name}]`;
      })
      .join("\n");

    const traitMethodsTable = traitMethods.flatMap(tm =>
      tm.methods.map(m => {
        const vis = m.visibility === "public" ? "pub" : m.visibility === "protected" ? "pro" : "pri";
        const stat = m.isStatic ? " static" : "";
        return `  L${String(m.line).padStart(4)} | ${vis}${stat} ${m.name}(${m.params})  [${tm.traitName}]`;
      })
    ).join("\n");

    const totalMethods = classInfo.methods.length + traitMethods.reduce((s, tm) => s + tm.methods.length, 0);
    const traitFilesInfo = traitMethods.map(tm =>
      `  - ${tm.traitName} → ${path.relative(CONFIG.basePath, tm.filePath).replace(/\\/g, "/")} (${tm.methods.length} methods)`
    ).join("\n");

    const header = [
      `File: ${relPath} (${lines.length} lines)`,
      `Class: ${classInfo.name}${classInfo.extends ? ` extends ${classInfo.extends}` : ""}`,
      ...(classInfo.implements ? [`Implements: ${classInfo.implements}`] : []),
      ...(classInfo.traits.length > 0 ? [`Traits (use): ${classInfo.traits.join(", ")}`] : []),
      ...(traitFilesInfo ? [`\nTrait 來源檔：\n${traitFilesInfo}`] : []),
      `\nMethods (${totalMethods} total: ${classInfo.methods.length} 本身 + ${totalMethods - classInfo.methods.length} traits):`,
      ownMethodsTable,
      ...(traitMethodsTable ? [traitMethodsTable] : []),
    ].join("\n");

    return { content: [{ type: "text", text: pathHint ? `${pathHint}\n${header}` : header }] };
  }
}

// ============================================
// Trait 解析
// ============================================
async function findTraitFile(projectPath, traitName) {
  // 優先位置
  const primaryPaths = [
    path.join(projectPath, "cls", "model", "traits", `${traitName}.php`),
    path.join(projectPath, "cls", "traits", `${traitName}.php`),
    path.join(projectPath, "traits", `${traitName}.php`),
    path.join(projectPath, "cls", "model", `${traitName}.php`),
  ];
  for (const p of primaryPaths) {
    try { await fs.access(p); return p; } catch {}
  }
  // 廣域搜尋
  const matches = await glob(`**/${traitName}.php`, {
    cwd: projectPath,
    nodir: true,
    ignore: ["vendor/**", "node_modules/**", ".git/**", "uploads/**"],
    maxDepth: 6,
  });
  return matches.length > 0 ? path.join(projectPath, matches[0]) : null;
}

async function collectTraitMethods(projectPath, traitNames) {
  const result = [];
  for (const traitName of traitNames) {
    const tFile = await findTraitFile(projectPath, traitName);
    if (!tFile) continue;
    try {
      const content = await fs.readFile(tFile, "utf-8");
      const tLines = content.split(/\r?\n/);
      const tInfo = parseClassInfo(tLines); // 對 trait 同樣有效（trait 與 class 結構相似）
      result.push({
        traitName,
        filePath: tFile,
        lines: tLines,
        methods: tInfo.methods,
      });
    } catch {}
  }
  return result;
}

// ============================================
// 檔案搜尋
// ============================================
/**
 * 偵測 projectPath 不存在時，於 basePath 一層子目錄中搜尋相同名稱的巢狀專案
 * 例：使用者輸入 `PG_Milestone_ERP_PHP` 但實際路徑是 `PG_Milestone_ERP/PG_Milestone_ERP_PHP`
 */
async function resolveNestedProject(projectPath) {
  try { await fs.access(projectPath); return { path: projectPath, hint: null }; } catch {}
  const projectName = path.basename(projectPath);
  const parent = path.dirname(projectPath); // 通常是 basePath
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

async function findClassFile(projectPath, className) {
  // 優先路徑（最常見的位置）
  const primaryPaths = [
    path.join(projectPath, "cls", "model", `${className}.class.php`),
    path.join(projectPath, "cls", "model", "traits", `${className}.php`),
  ];

  for (const p of primaryPaths) {
    try {
      await fs.access(p);
      return p;
    } catch { /* not found, continue */ }
  }

  // 擴大搜尋
  const patterns = [
    `**/${className}.class.php`,
    `**/${className}.php`,
  ];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: projectPath,
      nodir: true,
      ignore: ["vendor/**", "node_modules/**", ".git/**", "uploads/**"],
      maxDepth: 6,
    });
    if (matches.length > 0) {
      return path.join(projectPath, matches[0]);
    }
  }

  return null;
}

// ============================================
// Class 解析
// ============================================
function parseClassInfo(lines) {
  const info = {
    name: "",
    extends: "",
    implements: "",
    traits: [],
    methods: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // class 宣告
    const classMatch = line.match(/^\s*(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+(.+?))?(?:\s*\{|\s*$)/);
    if (classMatch) {
      info.name = classMatch[1];
      info.extends = classMatch[2] || "";
      info.implements = classMatch[3]?.trim() || "";
    }

    // trait use
    const traitMatch = line.match(/^\s*use\s+([\w,\s]+);/);
    if (traitMatch && info.name) {
      const traits = traitMatch[1].split(",").map(t => t.trim()).filter(Boolean);
      info.traits.push(...traits);
    }

    // 方法定義
    const methodMatch = line.match(/^\s*(public|protected|private)?\s*(static\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
    if (methodMatch) {
      info.methods.push({
        line: i + 1,
        visibility: methodMatch[1] || "public",
        isStatic: !!methodMatch[2],
        name: methodMatch[3],
        params: methodMatch[4].trim(),
        signature: line,
      });
    }
  }

  return info;
}

// ============================================
// 方法定位（含完整函式體）
// ============================================
function findMethod(lines, methodName) {
  // 找到 function 定義行
  let startLine = -1;
  let signature = "";

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(new RegExp(`\\bfunction\\s+${escapeRegex(methodName)}\\s*\\(`));
    if (match) {
      startLine = i;
      signature = lines[i].trim();
      break;
    }
  }

  if (startLine === -1) return null;

  // 找函式結尾：追蹤 brace depth
  let braceDepth = 0;
  let foundFirstBrace = false;
  let endLine = startLine;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];

    // 簡單計算（不處理字串/註解中的大括號，對 PHP 夠用）
    for (const ch of line) {
      if (ch === "{") {
        braceDepth++;
        foundFirstBrace = true;
      } else if (ch === "}") {
        braceDepth--;
      }
    }

    if (foundFirstBrace && braceDepth <= 0) {
      endLine = i;
      break;
    }
  }

  return {
    startLine: startLine + 1, // 1-based
    endLine: endLine + 1,
    signature,
  };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================
// handle 路由
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  if (name === "class_method_lookup") return handleClassMethodLookup(args);
  return null;
}
