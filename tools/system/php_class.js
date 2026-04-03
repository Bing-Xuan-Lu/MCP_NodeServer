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

  // 搜尋 class 檔案
  const projectPath = resolveSecurePath(project);
  const filePath = await findClassFile(projectPath, class_name);

  if (!filePath) {
    return {
      content: [{
        type: "text",
        text: `❌ 找不到 class "${class_name}"。\n搜尋範圍：\n` +
          `  1. ${project}/cls/model/${class_name}.class.php\n` +
          `  2. ${project}/**/${class_name}.class.php\n` +
          `  3. ${project}/**/${class_name}.php\n` +
          `  4. ${project}/cls/model/traits/*.php`,
      }],
    };
  }

  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const relPath = path.relative(CONFIG.basePath, filePath).replace(/\\/g, "/");

  // 解析 class 資訊
  const classInfo = parseClassInfo(lines);

  if (method_name) {
    // 指定 method：回傳該方法完整原始碼
    const method = findMethod(lines, method_name);
    if (!method) {
      // 列出所有方法讓使用者知道有哪些
      const overview = classInfo.methods
        .map(m => `  L${String(m.line).padStart(4)} | ${m.visibility} ${m.name}(${m.params})`)
        .join("\n");
      return {
        content: [{
          type: "text",
          text: `❌ 在 ${relPath} 中找不到方法 "${method_name}"。\n\n可用方法：\n${overview}`,
        }],
      };
    }

    const result = {
      file: relPath,
      class: classInfo.name,
      extends: classInfo.extends,
      method: method_name,
      line_start: method.startLine,
      line_end: method.endLine,
    };

    if (include_body) {
      // 帶行號的原始碼
      const codeLines = lines.slice(method.startLine - 1, method.endLine);
      result.code = codeLines
        .map((l, i) => `${String(method.startLine + i).padStart(4)} | ${l}`)
        .join("\n");
    } else {
      result.signature = method.signature;
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } else {
    // 未指定 method：回傳 class 概覽
    const result = {
      file: relPath,
      class: classInfo.name,
      extends: classInfo.extends,
      implements: classInfo.implements,
      traits: classInfo.traits,
      total_lines: lines.length,
      methods_overview: classInfo.methods.map(m => ({
        line: m.line,
        visibility: m.visibility,
        method: m.name,
        params: m.params,
        ...(m.isStatic ? { static: true } : {}),
      })),
    };

    // 表格格式
    const table = classInfo.methods
      .map(m => {
        const vis = m.visibility === "public" ? "pub" : m.visibility === "protected" ? "pro" : "pri";
        const stat = m.isStatic ? " static" : "";
        return `  L${String(m.line).padStart(4)} | ${vis}${stat} ${m.name}(${m.params})`;
      })
      .join("\n");

    const header = [
      `File: ${relPath} (${lines.length} lines)`,
      `Class: ${classInfo.name}${classInfo.extends ? ` extends ${classInfo.extends}` : ""}`,
      ...(classInfo.implements ? [`Implements: ${classInfo.implements}`] : []),
      ...(classInfo.traits.length > 0 ? [`Traits: ${classInfo.traits.join(", ")}`] : []),
      `\nMethods (${classInfo.methods.length}):`,
      table,
    ].join("\n");

    return { content: [{ type: "text", text: header }] };
  }
}

// ============================================
// 檔案搜尋
// ============================================
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
