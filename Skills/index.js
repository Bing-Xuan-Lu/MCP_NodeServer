import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Skills MD 檔放在 ../Skills/ 目錄
const SKILLS_DIR = path.join(__dirname, "..", "Skills");

// ============================================
// Prompts 清單 (ListPromptsRequestSchema 用)
// ============================================
export const definitions = [
  {
    name: "php_crud_generator",
    description:
      "PHP CRUD 產生器 — 根據資料表自動產生完整後台模組 (model + add/update/del/list)",
    arguments: [
      {
        name: "tableName",
        description: "要生成的資料表名稱 (例如: tbl_product)",
        required: true,
      },
    ],
  },
  {
    name: "bookmark_organizer",
    description:
      "Chrome 書籤整理 Agent — 提供完整的書籤分類、清理、排序範例 Prompt",
    arguments: [],
  },
];

// ============================================
// Prompt 內容讀取 (GetPromptRequestSchema 用)
// ============================================
export async function getPrompt(name, args = {}) {
  if (name === "php_crud_generator") {
    const tableName = args.tableName || "unknown_table";
    const skillPath = path.join(SKILLS_DIR, "php_crud_agent.md");
    let content = await fs.readFile(skillPath, "utf-8");
    content = content.replace(/{{TABLE_NAME}}/g, tableName);
    return {
      messages: [{ role: "user", content: { type: "text", text: content } }],
    };
  }

  if (name === "bookmark_organizer") {
    const skillPath = path.join(SKILLS_DIR, "bookmark_agent.md");
    const content = await fs.readFile(skillPath, "utf-8");
    return {
      messages: [{ role: "user", content: { type: "text", text: content } }],
    };
  }

  throw new Error(`找不到指定的 Skill (Prompt): ${name}`);
}
