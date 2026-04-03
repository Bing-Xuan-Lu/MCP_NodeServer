import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { CONFIG, EXTRA_ALLOWED_PATHS } from "../../config.js";
import { validateArgs } from "../_shared/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, "..", "Skills", "commands");
const DEPLOY_DIR = path.join(os.homedir(), ".claude", "commands");

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "save_claude_skill",
    description:
      "將新技能儲存為 Claude Code 斜線指令 (.md)，並立即部署到 ~/.claude/commands/。" +
      "Claude 可從對話中提取可重用的 Prompt 模式，呼叫此工具自動建立新技能。",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "技能名稱（不含 .md，英文小寫加底線，例如 api_tester）",
        },
        content: {
          type: "string",
          description: "技能的完整 Markdown 內容（包含標題、說明、步驟等）",
        },
        description: {
          type: "string",
          description: "技能的簡短說明（選填，用於 list_skills 顯示）",
        },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "list_claude_skills",
    description:
      "列出所有已建立的 Claude Code Skills，並顯示各技能是否已部署到 ~/.claude/commands/",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "delete_claude_skill",
    description:
      "刪除指定的 Claude Code Skill（從 Skills/commands/ 和 ~/.claude/commands/ 同時移除）",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "技能名稱（不含 .md）",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "grant_path_access",
    description:
      "將指定路徑加入 Runtime 白名單，允許 MCP 檔案工具存取 D:\\Project\\ 以外的目錄。" +
      "⚠️ 必須在使用者明確確認安全後才能呼叫。重啟 MCP Server 後白名單自動清空。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要開放存取的絕對路徑（例如 D:\\Develop\\）",
        },
        reason: {
          type: "string",
          description: "開放原因（例如：使用者需要讀取專案外的設定檔）",
        },
      },
      required: ["path", "reason"],
    },
  },
  {
    name: "list_allowed_paths",
    description: "列出目前 MCP 檔案工具允許存取的所有路徑（預設 basePath + Runtime 白名單）",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "revoke_path_access",
    description: "從 Runtime 白名單移除指定路徑（不影響預設 basePath）",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要移除的路徑",
        },
      },
      required: ["path"],
    },
  },
];

// ============================================
// 工具處理
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  if (name === "save_claude_skill")   return saveSkill(args);
  if (name === "list_claude_skills")  return listSkills();
  if (name === "delete_claude_skill") return deleteSkill(args);
  if (name === "grant_path_access")   return grantPath(args);
  if (name === "list_allowed_paths")  return listPaths();
  if (name === "revoke_path_access")  return revokePath(args);
}

// ── save_skill ────────────────────────────────────────────
async function saveSkill({ name, content, description }) {
  // 名稱安全檢查（只允許英數字與底線/連字號）
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return {
      isError: true,
      content: [{ type: "text", text: `技能名稱格式錯誤：只允許小寫英數字、底線、連字號。收到：${name}` }],
    };
  }

  const srcPath    = path.join(SKILLS_DIR, `${name}.md`);
  const deployPath = path.join(DEPLOY_DIR, `${name}.md`);
  const results    = [];

  // 1. 確保目錄存在
  await fs.mkdir(SKILLS_DIR, { recursive: true });
  await fs.mkdir(DEPLOY_DIR,  { recursive: true });

  // 2. 儲存到 Skills/commands/
  await fs.writeFile(srcPath, content, "utf-8");
  results.push(`✅ 已儲存：${srcPath}`);

  // 3. 部署到 ~/.claude/commands/
  await fs.copyFile(srcPath, deployPath);
  results.push(`✅ 已部署：${deployPath}`);

  results.push("");
  results.push(`🎉 技能 /${name} 已建立！`);
  results.push("⚠️  請重啟 Claude Code 讓新指令生效（若目前不在 MCP 對話中可能需要重載）。");
  if (description) results.push(`📝 說明：${description}`);

  return {
    content: [{ type: "text", text: results.join("\n") }],
  };
}

// ── list_skills ───────────────────────────────────────────
async function listSkills() {
  let srcFiles = [];
  try {
    const entries = await fs.readdir(SKILLS_DIR, { recursive: true });
    srcFiles = entries
      .filter((f) => f.endsWith(".md") && path.basename(f) !== "_skill_template.md")
      .map((f) => path.basename(f));
  } catch {
    // 目錄不存在
  }

  let deployedFiles = new Set();
  try {
    const entries = await fs.readdir(DEPLOY_DIR);
    entries.filter((f) => f.endsWith(".md")).forEach((f) => deployedFiles.add(f));
  } catch {
    // 目錄不存在
  }

  if (srcFiles.length === 0) {
    return {
      content: [{ type: "text", text: "目前 Skills/commands/ 中沒有任何技能。" }],
    };
  }

  const lines = ["# 已建立的 Skills\n"];
  for (const file of srcFiles.sort()) {
    const skillName = file.replace(".md", "");
    const deployed  = deployedFiles.has(file) ? "✅ 已部署" : "⚠️  未部署";
    const isInternal = skillName.includes("_internal") ? " [內部私用]" : "";
    lines.push(`- /${skillName}${isInternal}  ${deployed}`);
  }

  lines.push("");
  lines.push(`共 ${srcFiles.length} 個技能，部署目錄：${DEPLOY_DIR}`);

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

// ── delete_skill ──────────────────────────────────────────
async function deleteSkill({ name }) {
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return {
      isError: true,
      content: [{ type: "text", text: `技能名稱格式錯誤：${name}` }],
    };
  }

  // 遞迴搜尋來源（支援子資料夾）
  let srcPath = path.join(SKILLS_DIR, `${name}.md`);
  try {
    const entries = await fs.readdir(SKILLS_DIR, { recursive: true });
    const rel = entries.find((e) => path.basename(e) === `${name}.md`);
    if (rel) srcPath = path.join(SKILLS_DIR, rel);
  } catch { /* 找不到就用預設路徑 */ }

  const deployPath = path.join(DEPLOY_DIR, `${name}.md`);
  const results    = [];

  // 刪除來源
  try {
    await fs.unlink(srcPath);
    results.push(`✅ 已刪除：${srcPath}`);
  } catch {
    results.push(`⚠️  來源不存在：${srcPath}`);
  }

  // 刪除部署版本
  try {
    await fs.unlink(deployPath);
    results.push(`✅ 已刪除：${deployPath}`);
  } catch {
    results.push(`⚠️  部署版本不存在：${deployPath}`);
  }

  results.push(`\n技能 /${name} 已移除。重啟 Claude Code 後生效。`);

  return {
    content: [{ type: "text", text: results.join("\n") }],
  };
}

// ── grant_path_access ─────────────────────────────────────
function grantPath({ path: targetPath, reason }) {
  const resolved = path.resolve(targetPath);
  EXTRA_ALLOWED_PATHS.add(resolved);

  const lines = [
    `✅ 已開放路徑：${resolved}`,
    `📝 原因：${reason}`,
    ``,
    `目前白名單（共 ${EXTRA_ALLOWED_PATHS.size} 筆）：`,
    ...Array.from(EXTRA_ALLOWED_PATHS).map((p) => `  · ${p}`),
    ``,
    `⚠️  此設定僅在本次 MCP Session 有效，重啟 MCP Server 後自動清空。`,
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

// ── list_allowed_paths ────────────────────────────────────
function listPaths() {
  const lines = [
    `# 目前允許存取的路徑`,
    ``,
    `🔒 預設 basePath（永久）：`,
    `  · ${CONFIG.basePath}`,
  ];

  if (EXTRA_ALLOWED_PATHS.size > 0) {
    lines.push(``, `🔓 Runtime 白名單（重啟後清空）：`);
    for (const p of EXTRA_ALLOWED_PATHS) {
      lines.push(`  · ${p}`);
    }
  } else {
    lines.push(``, `🔓 Runtime 白名單：（空）`);
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
  };
}

// ── revoke_path_access ────────────────────────────────────
function revokePath({ path: targetPath }) {
  const resolved = path.resolve(targetPath);
  const existed  = EXTRA_ALLOWED_PATHS.delete(resolved);

  const msg = existed
    ? `✅ 已從白名單移除：${resolved}`
    : `⚠️  路徑不在白名單中：${resolved}`;

  return {
    content: [{ type: "text", text: msg }],
  };
}
