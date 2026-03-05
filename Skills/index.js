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
  {
    name: "php_upgrade",
    description:
      "PHP 7.x → 8.4 升級 Agent — 掃描資料夾內所有 PHP 檔案，自動修正為 PHP 8.4 相容語法",
    arguments: [
      {
        name: "targetDir",
        description: "要升級的資料夾路徑 (例如: myproject/cls/model)",
        required: true,
      },
    ],
  },
  {
    name: "dotnet_to_php",
    description:
      ".NET → PHP 翻寫 Agent — 讀取 C# Controller/Model/BLL/View，翻寫為 PHP 模組",
    arguments: [
      {
        name: "projectDir",
        description: "專案資料夾名稱 (例如: PG_Milestone_ERP)",
        required: true,
      },
      {
        name: "projectName",
        description: ".NET 專案名稱前綴 (例如: PNS)",
        required: true,
      },
      {
        name: "phpDir",
        description: "PHP 專案資料夾名稱 (例如: PG_Milestone_ERP_PHP)",
        required: true,
      },
      {
        name: "targetModule",
        description: "翻寫後 PHP 要放的資料夾名稱 (例如: empdailyreport)",
        required: true,
      },
      {
        name: "tableName",
        description: "對應的 MySQL 資料表名稱 (例如: EmpDailyReport)",
        required: true,
      },
    ],
  },
  {
    name: "php_net_to_php_test",
    description:
      "PHP 整合測試 Agent — 對 PHP 模組進行 CRUD、資料寫入、檔案上傳的完整測試",
    arguments: [
      {
        name: "projectDir",
        description: "專案資料夾名稱 (例如: PG_Milestone_ERP)",
        required: true,
      },
      {
        name: "phpDir",
        description: "PHP 專案資料夾名稱 (例如: PG_Milestone_ERP_PHP)",
        required: true,
      },
      {
        name: "targetModules",
        description:
          "要測試的模組名稱，逗號分隔 (例如: empmeetingnote, empdailyreport)",
        required: true,
      },
    ],
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

  if (name === "php_upgrade") {
    const targetDir = args.targetDir || "";
    const skillPath = path.join(SKILLS_DIR, "php_upgrade_agent.md");
    let content = await fs.readFile(skillPath, "utf-8");
    content = content.replace(/{{TARGET_DIR}}/g, targetDir);
    return {
      messages: [{ role: "user", content: { type: "text", text: content } }],
    };
  }

  if (name === "dotnet_to_php") {
    const projectDir = args.projectDir || "";
    const projectName = args.projectName || "";
    const phpDir = args.phpDir || "";
    const targetModule = args.targetModule || "";
    const tableName = args.tableName || "";
    const skillPath = path.join(SKILLS_DIR, "dotnet_to_php_agent.md");
    let content = await fs.readFile(skillPath, "utf-8");
    content = content.replace(/{{PROJECT_DIR}}/g, projectDir);
    content = content.replace(/{{PROJECT_NAME}}/g, projectName);
    content = content.replace(/{{PHP_DIR}}/g, phpDir);
    content = content.replace(/{{TARGET_MODULE}}/g, targetModule);
    content = content.replace(/{{TABLE_NAME}}/g, tableName);
    return {
      messages: [{ role: "user", content: { type: "text", text: content } }],
    };
  }

  if (name === "php_net_to_php_test") {
    const projectDir = args.projectDir || "";
    const phpDir = args.phpDir || "";
    const targetModules = args.targetModules || "";
    const skillPath = path.join(SKILLS_DIR, "php_net_to_php_net_to_php_test_agent.md");
    let content = await fs.readFile(skillPath, "utf-8");
    content = content.replace(/{{PROJECT_DIR}}/g, projectDir);
    content = content.replace(/{{PHP_DIR}}/g, phpDir);
    content = content.replace(/{{TARGET_MODULES}}/g, targetModules);
    return {
      messages: [{ role: "user", content: { type: "text", text: content } }],
    };
  }

  throw new Error(`找不到指定的 Skill (Prompt): ${name}`);
}
