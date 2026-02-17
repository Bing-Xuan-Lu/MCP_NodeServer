import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";
import fs from "fs/promises";
import path from "path";
import { createRequire } from "module";
import "dotenv/config";
import { exec } from "child_process";
import util from "util";
const execPromise = util.promisify(exec);
import os from "os";

// 建立 require 以相容 CommonJS 套件
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const { HyperFormula } = require("hyperformula");
const crypto = require('crypto');

/**
 * MCP Server v5.0.0 - 全功能整合版
 * 整合：檔案系統 / 資料庫 / Excel 批次讀取 / HyperFormula 邏輯追蹤
 */

const server = new Server(
  {
    name: "project-migration-assistant-pro",
    version: "5.0.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  },
);

// ============================================
// 1. 配置與輔助函式
// ============================================
const CONFIG = {
  //basePath: process.env.BASE_PROJECT_PATH || "D:\\Project",
  basePath: "D:\\Project\\",
  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "pnsdb",
  },
};

// 路徑安全檢查
function resolveSecurePath(userPath) {
  const targetPath = path.resolve(CONFIG.basePath, userPath);
  const normalizedTarget = targetPath.toLowerCase();
  const normalizedBase = CONFIG.basePath.toLowerCase();

  if (!normalizedTarget.startsWith(normalizedBase)) {
    throw new Error(`安全限制：禁止存取路徑 ${targetPath}`);
  }
  return targetPath;
}

// HyperFormula 資料準備 (關鍵：保留公式)
function getHFData(workbook) {
  const sheetsData = {};
  workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    // 如果工作表為空，給一個預設範圍
    const rangeRef = worksheet["!ref"] || "A1:A1";
    const range = XLSX.utils.decode_range(rangeRef);
    const sheetArray = [];

    for (let r = 0; r <= range.e.r; ++r) {
      const row = [];
      for (let c = 0; c <= range.e.c; ++c) {
        const cell = worksheet[XLSX.utils.encode_cell({ r, c })];
        // 確保公式被 HyperFormula 識別 (加上 =)
        if (cell && cell.f) row.push(`=${cell.f}`);
        else if (cell && cell.v !== undefined) row.push(cell.v);
        else row.push(null);
      }
      sheetArray.push(row);
    }
    sheetsData[sheetName] = sheetArray;
  });
  return sheetsData;
}

// ============================================
// 2. 定義工具清單
// ============================================
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // --- [檔案系統工具] ---
    {
      name: "list_files",
      description: "列出目錄內容",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "read_file",
      description: "讀取檔案內容",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "create_file",
      description: "建立或覆寫檔案",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "apply_diff",
      description: "修改檔案 (Search & Replace 模式)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          search: { type: "string" },
          replace: { type: "string" },
        },
        required: ["path", "search", "replace"],
      },
    },
    {
      name: "run_php_script",
      description:
        "在伺服器上執行 PHP 腳本 (CLI 模式)，並回傳輸出結果 (Stdout/Stderr)",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "PHP 檔案路徑 (例如: test_case.php)",
          },
          args: {
            type: "string",
            description: "選填：傳遞給腳本的參數 (例如: id=1)",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "send_http_request",
      description:
        "發送 HTTP 請求。支援 Multipart 實體檔案上傳 (讀取本地檔案傳送給 PHP)。",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "完整網址" },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE"],
            default: "GET",
          },
          headers: { type: "object", description: "自訂標頭" },
          data: { type: "string", description: "一般欄位資料 (JSON 字串)" },
          files: {
            type: "array",
            description: "檔案列表",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "表單欄位名稱 (例如 'file_upload')",
                },
                filePath: {
                  type: "string",
                  description: "本地實體檔案路徑 (優先使用)",
                }, // 新增這個
                filename: {
                  type: "string",
                  description: "上傳後的檔名 (選填)",
                },
                content: {
                  type: "string",
                  description: "純文字內容 (若無 filePath 則用此模擬)",
                },
              },
              required: ["name"],
            },
          },
        },
        required: ["url"],
      },
    },
    // [新增] 讀取 Log 尾部
    {
      name: "tail_log",
      description: "讀取檔案最後 N 行 (適用於查看 PHP Error Log)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Log 檔案路徑" },
          lines: {
            type: "number",
            description: "要讀取的行數 (預設 50)",
            default: 50,
          },
        },
        required: ["path"],
      },
    },
    // [新增] 自動化 PHP 測試環境
    {
      name: "run_php_test",
      description: "自動建立測試環境 (Session/Config) 並執行 PHP 腳本",
      inputSchema: {
        type: "object",
        properties: {
          targetPath: { type: "string", description: "要測試的 PHP 檔案路徑" },
          configPath: {
            type: "string",
            description: "設定檔路徑 (例如 config.php)",
          },
          sessionData: {
            type: "string",
            description: "模擬 $_SESSION 的 JSON 資料",
          },
          postData: { type: "string", description: "模擬 $_POST 的 JSON 資料" },
        },
        required: ["targetPath"],
      },
    },

    // --- [資料庫工具] ---
    {
      name: "get_db_schema",
      description: "查看資料表結構",
      inputSchema: {
        type: "object",
        properties: { table_name: { type: "string" } },
        required: ["table_name"],
      },
    },
    {
      name: "execute_sql",
      description: "執行 SQL 指令 (DDL/DML)",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
    },

    // --- [Excel 基礎工具] ---
    {
      name: "get_excel_values_batch",
      description:
        "批次讀取 Excel 儲存格 (省 Token 版)，支援範圍 (A1:B10) 或列表 (['A1','C3'])",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          sheet: { type: "string" },
          range: { type: "string", description: "範圍 e.g. 'A1:C10'" },
          cells: {
            type: "array",
            items: { type: "string" },
            description: "列表 e.g. ['A1', 'D5']",
          },
        },
        required: ["path"],
      },
    },

    // --- [Excel 進階邏輯工具] ---
    {
      name: "trace_excel_logic",
      description:
        "追蹤 Excel 邏輯鏈。支援「追蹤引用」(來源) 與「追蹤從屬」(影響)。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          sheet: { type: "string" },
          cell: { type: "string" },
          mode: {
            type: "string",
            enum: ["precedents", "dependents"],
            description: "precedents=追蹤引用(來源), dependents=追蹤從屬(影響)",
            default: "precedents",
          },
          depth: { type: "number", description: "追蹤深度 (預設 3)" },
        },
        required: ["path", "sheet", "cell"],
      },
    },
    {
      name: "simulate_excel_change",
      description: "模擬修改 Excel 數值並重算結果 (不修改原檔)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          sheet: { type: "string" },
          changeCell: { type: "string" },
          newValue: { type: "number" },
          targetCell: { type: "string" },
        },
        required: ["path", "sheet", "changeCell", "newValue", "targetCell"],
      },
    },
    {
      name: "create_bookmark_folder",
      description: "在指定的父資料夾底下，建立一個新的空資料夾 (例如在 '書籤列 > 改CODE之路' 底下建立 '【Python】')。",
      inputSchema: {
        type: "object",
        properties: {
          parentPath: { 
            type: "string", 
            description: "父資料夾的路徑 (例如 '書籤列 > 改CODE之路')" 
          },
          newFolderName: { 
            type: "string", 
            description: "新資料夾的名稱 (例如 '【Python】')" 
          },
          profilePath: { type: "string" }
        },
        required: ["parentPath", "newFolderName"]
      }
    },
    {
      name: "scan_and_clean_bookmarks",
      description:
        "掃描 Chrome 書籤。若發現無效連結 (404/DNS Error)，可選擇直接移除。支援自動備份。",
      inputSchema: {
        type: "object",
        properties: {
          profilePath: {
            type: "string",
            description: "Chrome User Data 路徑 (選填)",
          },
          checkLimit: {
            type: "number",
            description: "限制檢查數量 (預設 100)",
            default: 100,
          },
          autoRemove: {
            type: "boolean",
            description:
              "是否自動刪除無效書籤？(預設 false，設為 true 則會直接刪除並存檔)",
            default: false,
          },
        },
      },
    },
    {
      name: "remove_chrome_bookmarks",
      description:
        "刪除 Chrome 書籤中的特定網址 (請務必先關閉 Chrome)。會自動建立備份。",
      inputSchema: {
        type: "object",
        properties: {
          urls: {
            type: "array",
            items: { type: "string" },
            description:
              "要刪除的網址清單 (例如 ['http://bad-site.com', '...'])",
          },
          profilePath: {
            type: "string",
            description: "Chrome User Data 路徑 (選填)",
          },
        },
        required: ["urls"],
      },
    },
    // 1. 查看資料夾結構 (ls -R)
    {
      name: "get_bookmark_structure",
      description:
        "取得 Chrome 書籤的資料夾結構 (不列出網址，只列出資料夾名稱與層級)，讓 AI 了解目前的分類狀況。",
      inputSchema: {
        type: "object",
        properties: {
          profilePath: { type: "string" },
        },
      },
    },
    // 3. 智慧搬移 (mv + grep)
    {
      name: "move_bookmarks",
      description:
        "將書籤從來源資料夾搬移到目標資料夾。支援關鍵字篩選 (例如：把 '未分類' 裡面含有 'docker' 的網址都搬到 'DevOps')。",
      inputSchema: {
        type: "object",
        properties: {
          sourcePath: { type: "string", description: "來源資料夾路徑" },
          targetPath: { type: "string", description: "目標資料夾路徑" },
          keyword: {
            type: "string",
            description: "篩選關鍵字 (選填，若不填則移動該資料夾內所有書籤)",
          },
          profilePath: { type: "string" },
        },
        required: ["sourcePath", "targetPath"],
      },
    },
    // 1. 取得特定資料夾內容 (讓 AI "看到" 書籤)
    {
      name: "get_folder_contents",
      description:
        "取得指定資料夾內的所有書籤清單 (回傳 ID, Title, URL)，用於讓 AI 分析分類。",
      inputSchema: {
        type: "object",
        properties: {
          folderPath: {
            type: "string",
            description: "資料夾路徑 (例如: '書籤列 > 改CODE之路')",
          },
          profilePath: { type: "string" },
        },
        required: ["folderPath"],
      },
    },
    // 2. 依照 ID 精準搬移 (讓 AI "執行" 分類)
    {
      name: "move_specific_bookmarks",
      description:
        "將指定的書籤 ID 列表搬移到目標資料夾。⚠️ 極重要限制：由於系統傳輸限制，每次呼叫此工具的 'bookmarkIds' 陣列長度「絕對不可超過 20 個」。若需搬移大量書籤，你必須分多次呼叫。",
      inputSchema: {
        type: "object",
        properties: {
          bookmarkIds: {
            type: "array",
            items: { type: "string" },
            description:
              "要搬移的書籤 ID 陣列 (Max limit: 20 items per request)",
          },
          targetPath: { type: "string", description: "目標資料夾路徑" },
          profilePath: { type: "string" },
        },
        required: ["bookmarkIds", "targetPath"],
      },
    },
    {
      name: "sort_bookmarks",
      description:
        "將指定資料夾內的書籤進行排序 (規則：資料夾置頂，並依名稱 A-Z / 中文筆劃排序)。",
      inputSchema: {
        type: "object",
        properties: {
          folderPath: {
            type: "string",
            description: "要排序的資料夾路徑 (例如 '書籤列 > 改CODE之路')",
          },
          profilePath: { type: "string" },
        },
        required: ["folderPath"],
      },
    },
    // [新增] 重新命名資料夾
    {
      name: "rename_bookmark_folder",
      description: "修改書籤資料夾的名稱 (例如將 'C# .net' 改為 'NET')。",
      inputSchema: {
        type: "object",
        properties: {
          folderPath: {
            type: "string",
            description: "原資料夾路徑 (例如 '書籤列 > C# .net')",
          },
          newName: { type: "string", description: "新的名稱 (例如 'NET')" },
          profilePath: { type: "string" },
        },
        required: ["folderPath", "newName"],
      },
    },
    // [新增] 刪除資料夾
    {
      name: "delete_bookmark_folder",
      description:
        "刪除指定的書籤資料夾。 (預設只能刪除空資料夾，除非開啟強制模式)",
      inputSchema: {
        type: "object",
        properties: {
          folderPath: { type: "string", description: "要刪除的資料夾路徑" },
          force: {
            type: "boolean",
            description:
              "是否強制刪除？(若設為 true，即使資料夾內有書籤也會一併刪除)",
            default: false,
          },
          profilePath: { type: "string" },
        },
        required: ["folderPath"],
      },
    },
    {
      name: "fetch_page_summary",
      description:
        "讀取網頁內容並自動提取摘要 (省 Token 模式)。只會回傳標題、描述與前 2000 字純文字。",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "網址" },
        },
        required: ["url"],
      },
    },
    {
      name: "export_bookmarks_to_html",
      description:
        "將目前的書籤導出為標準 HTML 格式 (Netscape Format)，可用於直接匯入 Chrome 或其他瀏覽器。",
      inputSchema: {
        type: "object",
        properties: {
          outputFilename: {
            type: "string",
            description: "導出的檔案名稱 (預設: bookmarks_cleaned.html)",
            default: "bookmarks_cleaned.html",
          },
          profilePath: { type: "string" },
        },
      },
    },
    {
      name: "remove_duplicates",
      description:
        "掃描整個書籤設定檔，移除重複的網址 (Duplicate URLs)。保留最早建立的那一個，刪除後來的重複項。",
      inputSchema: {
        type: "object",
        properties: {
          profilePath: { type: "string" },
        },
      },
    },
  ],
}));

// ============================================
// 3. 實作工具邏輯
// ============================================
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ----------------------------------------
    // A. 檔案系統
    // ----------------------------------------
    if (name === "list_files") {
      const fullPath = resolveSecurePath(args.path || ".");
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      return {
        content: [
          {
            type: "text",
            text: entries
              .map((e) =>
                e.isDirectory() ? `[DIR] ${e.name}` : `[FILE] ${e.name}`,
              )
              .join("\n"),
          },
        ],
      };
    }

    if (name === "read_file") {
      const fullPath = resolveSecurePath(args.path);
      const content = await fs.readFile(fullPath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    }

    if (name === "create_file") {
      const fullPath = resolveSecurePath(args.path);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, args.content, "utf-8");
      return {
        content: [{ type: "text", text: `✅ 檔案已建立: ${args.path}` }],
      };
    }

    if (name === "apply_diff") {
      const fullPath = resolveSecurePath(args.path);
      const content = await fs.readFile(fullPath, "utf-8");
      if (!content.includes(args.search))
        throw new Error("比對失敗：找不到 search 區塊");
      await fs.writeFile(
        fullPath,
        content.replace(args.search, args.replace),
        "utf-8",
      );
      return {
        content: [{ type: "text", text: `✅ 檔案已更新: ${args.path}` }],
      };
    }

    if (name === "run_php_script") {
      const fullPath = resolveSecurePath(args.path);
      // 安全性檢查：確保是 .php 檔案
      if (!fullPath.endsWith(".php")) {
        throw new Error("安全限制：只能執行 .php 檔案");
      }

      try {
        // 執行 php 指令
        const cmd = `php "${fullPath}" ${args.args || ""}`;
        const { stdout, stderr } = await execPromise(cmd);

        return {
          content: [
            {
              type: "text",
              text: `📝 PHP 執行結果：\n${stdout}\n${stderr ? `⚠️ 錯誤輸出：\n${stderr}` : ""}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `執行失敗: ${error.message}` }],
        };
      }
    }

    // ----------------------------------------
    // [更新] HTTP 請求 (支援實體檔案上傳)
    // ----------------------------------------
    if (name === "send_http_request") {
      try {
        const headers = args.headers || {};
        let body = null;

        if (args.files && Array.isArray(args.files) && args.files.length > 0) {
          const formData = new FormData();

          // 1. 一般欄位
          if (args.data) {
            try {
              const fields =
                typeof args.data === "string"
                  ? JSON.parse(args.data)
                  : args.data;
              for (const [key, value] of Object.entries(fields)) {
                formData.append(key, value);
              }
            } catch (e) {}
          }

          // 2. 檔案處理 (關鍵更新)
          for (const file of args.files) {
            let blob;
            let finalFilename = file.filename;

            if (file.filePath) {
              // [關鍵] 讀取本地實體檔案
              const fullPath = resolveSecurePath(file.filePath);
              const fileBuffer = await fs.readFile(fullPath);
              blob = new Blob([fileBuffer]);
              if (!finalFilename) finalFilename = path.basename(fullPath);
            } else {
              // 舊模式：使用假內容
              blob = new Blob([file.content || ""], { type: "text/plain" });
              if (!finalFilename) finalFilename = "test.txt";
            }

            formData.append(file.name, blob, finalFilename);
          }

          body = formData;
          delete headers["Content-Type"]; // 讓 fetch 自動產生 Boundary
        } else {
          // ... (維持原本 JSON/Form 處理邏輯) ...
          body = args.data;
          if (
            headers["Content-Type"] &&
            headers["Content-Type"].includes(
              "application/x-www-form-urlencoded",
            ) &&
            body
          ) {
            try {
              const jsonBody = JSON.parse(body);
              body = new URLSearchParams(jsonBody).toString();
            } catch (e) {}
          }
        }

        const options = { method: args.method || "GET", headers: headers };
        if (args.method !== "GET" && args.method !== "HEAD" && body)
          options.body = body;

        const response = await fetch(args.url, options);
        const text = await response.text();

        return {
          content: [
            {
              type: "text",
              text: `🌐 HTTP ${response.status}\n${text.substring(0, 2000)}`,
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `請求失敗: ${error.message}` }],
        };
      }
    }

    // ----------------------------------------
    // [新增] tail_log (讀取最後 N 行)
    // ----------------------------------------
    if (name === "tail_log") {
      const fullPath = resolveSecurePath(args.path);
      const content = await fs.readFile(fullPath, "utf-8");
      const lines = content.split(/\r?\n/);
      const n = args.lines || 50;
      const lastLines = lines.slice(-n).join("\n");

      return { content: [{ type: "text", text: lastLines }] };
    }

    // ----------------------------------------
    // [新增] run_php_test (Wrapper 模式)
    // ----------------------------------------
    if (name === "run_php_test") {
      const targetPath = resolveSecurePath(args.targetPath);
      const configPath = args.configPath
        ? resolveSecurePath(args.configPath)
        : null;

      // 1. 建立 Wrapper PHP 檔案內容
      let wrapperCode = "<?php\n";

      // 模擬 Session
      if (args.sessionData) {
        wrapperCode += "session_start();\n";
        wrapperCode += `$_SESSION = json_decode('${args.sessionData.replace(/'/g, "\\'")}', true);\n`;
      }

      // 模擬 POST (如果是 CLI 執行，需手動注入)
      if (args.postData) {
        wrapperCode += `$_POST = json_decode('${args.postData.replace(/'/g, "\\'")}', true);\n`;
      }

      // 引入 Config
      if (configPath) {
        // 轉換為 PHP 可用的絕對路徑格式 (Windows 斜線處理)
        const phpConfigPath = configPath.replace(/\\/g, "/");
        wrapperCode += `require_once '${phpConfigPath}';\n`;
      }

      // 引入目標檔案
      const phpTargetPath = targetPath.replace(/\\/g, "/");
      wrapperCode += `require '${phpTargetPath}';\n`;

      // 2. 寫入暫存檔
      const tempFile = path.join(
        path.dirname(targetPath),
        `_mcp_runner_${Date.now()}.php`,
      );
      await fs.writeFile(tempFile, wrapperCode);

      try {
        // 3. 執行
        const cmd = `php "${tempFile}"`;
        const { stdout, stderr } = await execPromise(cmd);
        return {
          content: [
            {
              type: "text",
              text: `📝 測試結果：\n${stdout}\n${stderr ? `⚠️ 錯誤：\n${stderr}` : ""}`,
            },
          ],
        };
      } finally {
        // 4. 清理暫存檔
        await fs.unlink(tempFile).catch(() => {});
      }
    }

    // ----------------------------------------
    // B. 資料庫
    // ----------------------------------------
    if (name === "get_db_schema") {
      const conn = await mysql.createConnection(CONFIG.db);
      try {
        const [rows] = await conn.execute(`DESCRIBE ${args.table_name}`);
        return {
          content: [
            {
              type: "text",
              text: rows.map((r) => `${r.Field} (${r.Type})`).join("\n"),
            },
          ],
        };
      } finally {
        await conn.end();
      }
    }

    if (name === "execute_sql") {
      const conn = await mysql.createConnection(CONFIG.db);
      try {
        const [res] = await conn.execute(args.sql);

        if (Array.isArray(res)) {
          // 如果是 SELECT，res 會是一個陣列 (資料列)
          return {
            content: [
              {
                type: "text",
                text: `🔍 查詢結果 (${res.length} 筆)：\n${JSON.stringify(res, null, 2)}`,
              },
            ],
          };
        } else {
          // 如果是 INSERT/UPDATE/DELETE，res 會是物件 (包含 affectedRows)
          return {
            content: [
              {
                type: "text",
                text: `✅ 執行成功。影響列數: ${res.affectedRows}, 新增 ID: ${res.insertId || "無"}`,
              },
            ],
          };
        }
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `SQL 錯誤: ${err.message}` }],
        };
      } finally {
        await conn.end();
      }
    }

    // ----------------------------------------
    // C. Excel 批次讀取 (xlsx)
    // ----------------------------------------
    if (name === "get_excel_values_batch") {
      const fullPath = resolveSecurePath(args.path);
      const workbook = XLSX.readFile(fullPath);
      const sheetName = args.sheet || workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];

      const results = {};

      // 定義一個讀取單格的內部函式 (統一回傳格式)
      const readCell = (addr) => {
        const cell = worksheet[addr];
        return {
          value: cell ? cell.v : null, // 顯示值 (例如: 1050)
          formula: cell && cell.f ? `=${cell.f}` : null, // 公式 (例如: =A1*1.05)
        };
      };

      if (args.range) {
        // 模式 1: 範圍讀取 (A1:C10)
        const range = XLSX.utils.decode_range(args.range);
        for (let R = range.s.r; R <= range.e.r; ++R) {
          for (let C = range.s.c; C <= range.e.c; ++C) {
            const addr = XLSX.utils.encode_cell({ r: R, c: C });
            results[addr] = readCell(addr);
          }
        }
      } else if (args.cells && Array.isArray(args.cells)) {
        // 模式 2: 指定列表 (['A1', 'D5'])
        args.cells.forEach((addr) => {
          results[addr] = readCell(addr);
        });
      } else {
        throw new Error("必須提供 range 或 cells 參數");
      }

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }

    // ----------------------------------------
    // D. Excel 邏輯追蹤 (HyperFormula)
    // ----------------------------------------
    if (name === "trace_excel_logic") {
      const fullPath = resolveSecurePath(args.path);
      const workbook = XLSX.readFile(fullPath);
      const hf = HyperFormula.buildFromSheets(getHFData(workbook), {
        licenseKey: "gpl-v3",
      });

      const maxDepth = args.depth || 3;
      const mode = args.mode || "precedents"; // 預設查來源
      const results = [];
      const visited = new Set();

      const sheetId = hf.getSheetId(args.sheet);
      if (sheetId === undefined) throw new Error(`找不到工作表: ${args.sheet}`);

      const startAddr = hf.simpleCellAddressFromString(args.cell, sheetId);
      let queue = [{ addr: startAddr, d: 0 }];
      visited.add(`${args.sheet}!${args.cell}`);

      while (queue.length > 0) {
        const { addr, d } = queue.shift();
        if (d >= maxDepth) continue;

        try {
          // 關鍵切換：根據模式選擇 API
          let relatedCells = [];
          if (mode === "dependents") {
            // 查從屬 (誰用了我)
            relatedCells = hf.getCellDependents(addr);
          } else {
            // 查引用 (我用了誰)
            relatedCells = hf.getCellPrecedents(addr);
          }

          for (const p of relatedCells) {
            const pSheetName = hf.getSheetName(p.sheet);
            const pStr = hf.simpleCellAddressToString(p, pSheetName);

            // 為了讓 Agent 更好讀，我們組裝一個易懂的描述
            const fromStr = hf.simpleCellAddressToString(
              addr,
              hf.getSheetName(addr.sheet),
            );
            const directionArrow =
              mode === "dependents" ? "影響 ->" : "<- 來自";

            if (!visited.has(pStr)) {
              visited.add(pStr);

              results.push({
                level: d + 1,
                relationship: `${fromStr} ${directionArrow} ${pStr}`, // 視覺化關係
                cell: pStr,
                value: hf.getCellValue(p),
                formula: hf.getCellFormula(p) || "(數值)",
              });

              queue.push({ addr: p, d: d + 1 });
            }
          }
        } catch (e) {
          // 忽略錯誤繼續執行
        }
      }

      const title =
        mode === "dependents"
          ? "衝擊分析 (Impact Analysis)"
          : "邏輯溯源 (Root Cause)";
      return {
        content: [
          {
            type: "text",
            text:
              `🔍 ${title} 結果 (${args.sheet}!${args.cell})：\n` +
              JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    if (name === "simulate_excel_change") {
      const fullPath = resolveSecurePath(args.path);
      const workbook = XLSX.readFile(fullPath);
      const hf = HyperFormula.buildFromSheets(getHFData(workbook), {
        licenseKey: "gpl-v3",
      });

      const sheetId = hf.getSheetId(args.sheet);
      const cAddr = hf.simpleCellAddressFromString(args.changeCell, sheetId);
      const tAddr = hf.simpleCellAddressFromString(args.targetCell, sheetId);

      const before = hf.getCellValue(tAddr);
      hf.setCellContents(cAddr, [[args.newValue]]);
      const after = hf.getCellValue(tAddr);

      return {
        content: [
          {
            type: "text",
            text: `模擬: 改 [${args.changeCell}]為 ${args.newValue} -> [${args.targetCell}] 變更: ${before} => ${after}`,
          },
        ],
      };
    }
    if (name === "scan_and_clean_bookmarks") {
      // 1. 路徑處理
      let bookmarkPath = args.profilePath;
      if (!bookmarkPath) {
        const localAppData =
          process.env.LOCALAPPDATA ||
          path.join(os.homedir(), "AppData", "Local");
        bookmarkPath = path.join(
          localAppData,
          "Google",
          "Chrome",
          "User Data",
          "Default",
          "Bookmarks",
        );
      }

      // 檢查檔案
      try {
        await fs.access(bookmarkPath);
      } catch (e) {
        throw new Error(`找不到 Chrome 書籤檔: ${bookmarkPath}`);
      }

      // 2. 讀取 JSON
      const content = await fs.readFile(bookmarkPath, "utf-8");
      let data = JSON.parse(content);

      // 收集所有連結 (物件參考)
      const allNodes = [];
      const traverse = (node, pathName) => {
        if (node.url) {
          // 只處理 http/https，忽略 javascript: 或 chrome:// 等特殊書籤
          if (node.url.startsWith("http")) {
            allNodes.push({ node: node, path: pathName });
          }
        }
        if (node.children) {
          const newPath = pathName ? `${pathName} > ${node.name}` : node.name;
          node.children.forEach((child) => traverse(child, newPath));
        }
      };

      if (data.roots.bookmark_bar) traverse(data.roots.bookmark_bar, "書籤列");
      if (data.roots.other) traverse(data.roots.other, "其他書籤");
      if (data.roots.synced) traverse(data.roots.synced, "行動裝置");

      // 3. 準備掃描
      const limit = args.checkLimit || 100;
      const nodesToCheck = allNodes.slice(0, limit);
      const badUrls = new Set(); // 用來存要刪除的 URL 原文
      const reportLog = [];

      // 4. 開始檢測 (平行處理)
      // 排除內網 / 本機網址 (不檢測，直接跳過)
      const isPrivateUrl = (url) => {
        try {
          const hostname = new URL(url).hostname;
          return (
            hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            hostname.startsWith("192.168.") ||
            hostname.startsWith("10.") ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
            hostname.endsWith(".local") ||
            hostname.endsWith(".internal")
          );
        } catch { return false; }
      };

      let skippedPrivate = 0;

      // 定義檢測函數
      const checkNode = async (item) => {
        // 跳過內網 IP
        if (isPrivateUrl(item.node.url)) {
          skippedPrivate++;
          return;
        }

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10000);
          const fetchOpts = {
            signal: controller.signal,
            redirect: "follow",
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
          };

          // 先嘗試 HEAD，失敗 (405/403) 則 fallback GET
          let res = await fetch(item.node.url, { ...fetchOpts, method: "HEAD" });
          if (res.status === 405 || res.status === 403) {
            const controller2 = new AbortController();
            const timer2 = setTimeout(() => controller2.abort(), 10000);
            res = await fetch(item.node.url, { ...fetchOpts, method: "GET", signal: controller2.signal });
            clearTimeout(timer2);
          }
          clearTimeout(timer);

          if (res.status >= 400) {
            badUrls.add(item.node.url);
            reportLog.push(`❌ [${res.status}] ${item.node.url}`);
          }
        } catch (err) {
          // DNS 錯誤或連線失敗
          badUrls.add(item.node.url);
          reportLog.push(
            `❌ [Error] ${item.node.url} (${err.cause?.code || err.message})`,
          );
        }
      };

      // 分批執行 (一次 20 個)
      for (let i = 0; i < nodesToCheck.length; i += 20) {
        const batch = nodesToCheck.slice(i, i + 20);
        await Promise.all(batch.map(checkNode));
      }

      // 5. 執行刪除邏輯 (如果 autoRemove = true)
      let resultText = `🔍 掃描 ${nodesToCheck.length} 個書籤，發現 ${badUrls.size} 個失效。\n`;
      if (skippedPrivate > 0) {
        resultText += `⏭️ 跳過 ${skippedPrivate} 個內網/本機網址 (192.168.x / 10.x / localhost)。\n`;
      }

      if (args.autoRemove && badUrls.size > 0) {
        // (A) 先備份
        const timestamp = new Date()
          .toISOString()
          .replace(/[-:T.]/g, "")
          .slice(0, 14);
        const backupPath = `${bookmarkPath}.bak.${timestamp}`;
        await fs.copyFile(bookmarkPath, backupPath);

        // (B) 遞迴刪除函式
        let deletedCount = 0;
        const removeRecursive = (node) => {
          if (!node.children) return;
          const initialLen = node.children.length;
          node.children = node.children.filter((child) => {
            if (child.url && badUrls.has(child.url)) {
              return false; // 刪除
            }
            if (child.children) removeRecursive(child);
            return true;
          });
          deletedCount += initialLen - node.children.length;
        };

        if (data.roots.bookmark_bar) removeRecursive(data.roots.bookmark_bar);
        if (data.roots.other) removeRecursive(data.roots.other);
        if (data.roots.synced) removeRecursive(data.roots.synced);

        // (C) 寫入硬碟
        await fs.writeFile(
          bookmarkPath,
          JSON.stringify(data, null, 2),
          "utf-8",
        );

        resultText += `\n✅ **已執行自動清理**\n`;
        resultText += `- 成功移除: ${deletedCount} 個\n`;
        resultText += `- 備份檔案: ${backupPath}\n`;
        resultText += `- 請重新啟動 Chrome。\n`;
      } else if (badUrls.size > 0) {
        resultText +=
          `\n⚠️ 建議移除清單 (尚未刪除，請設 autoRemove=true):\n` +
          reportLog.join("\n");
      } else {
        resultText += `🎉 恭喜，檢查範圍內的書籤都是健康的！`;
      }

      return { content: [{ type: "text", text: resultText }] };
    }
    if (name === "remove_chrome_bookmarks") {
      // 1. 取得書籤路徑
      let bookmarkPath = args.profilePath;
      if (!bookmarkPath) {
        const localAppData =
          process.env.LOCALAPPDATA ||
          path.join(os.homedir(), "AppData", "Local");
        bookmarkPath = path.join(
          localAppData,
          "Google",
          "Chrome",
          "User Data",
          "Default",
          "Bookmarks",
        );
      }

      // 2. 安全檢查與備份 (非常重要！)
      try {
        await fs.access(bookmarkPath);
      } catch (e) {
        throw new Error(`找不到書籤檔: ${bookmarkPath}`);
      }

      // 建立備份檔名: Bookmarks.bak.20231027_120000
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:T.]/g, "")
        .slice(0, 14);
      const backupPath = `${bookmarkPath}.bak.${timestamp}`;
      await fs.copyFile(bookmarkPath, backupPath); // 👈 這裡執行備份

      // 3. 讀取與處理
      const content = await fs.readFile(bookmarkPath, "utf-8");
      let data = JSON.parse(content);
      const targets = new Set(args.urls); // 轉成 Set 加速比對
      let removedCount = 0;

      // 定義遞迴刪除函數
      const removeRecursive = (node) => {
        if (!node.children) return;

        // 過濾掉要刪除的連結
        const originalLength = node.children.length;
        node.children = node.children.filter((child) => {
          // 如果是網址且在刪除清單中，就移除 (回傳 false)
          if (child.url && targets.has(child.url)) {
            return false;
          }
          // 如果是資料夾，繼續遞迴往下找
          if (child.children) {
            removeRecursive(child);
          }
          return true; // 保留
        });

        // 計算這一層刪了幾個
        removedCount += originalLength - node.children.length;
      };

      // 對 Chrome 書籤的三大根目錄進行清理
      if (data.roots.bookmark_bar) removeRecursive(data.roots.bookmark_bar);
      if (data.roots.other) removeRecursive(data.roots.other);
      if (data.roots.synced) removeRecursive(data.roots.synced);

      // 4. 寫回檔案
      if (removedCount > 0) {
        // 寫入 JSON (縮排 2 格保持美觀)
        await fs.writeFile(
          bookmarkPath,
          JSON.stringify(data, null, 2),
          "utf-8",
        );
        return {
          content: [
            {
              type: "text",
              text: `✅ 已成功刪除 ${removedCount} 個書籤。\n\n⚠️ 原始檔案已備份至：\n${backupPath}\n\n請重新啟動 Chrome 以查看變更。`,
            },
          ],
        };
      } else {
        return {
          content: [
            { type: "text", text: "⚠️ 未發現符合的網址，沒有刪除任何書籤。" },
          ],
        };
      }
    }
    // ==========================================
    // 書籤重構工具組 (Refactoring Tools)
    // ==========================================

    // Helper: 讀取並解析書籤
    const loadBookmarks = async (profilePath) => {
      let bookmarkPath = profilePath;
      if (!bookmarkPath) {
        const localAppData =
          process.env.LOCALAPPDATA ||
          path.join(os.homedir(), "AppData", "Local");
        bookmarkPath = path.join(
          localAppData,
          "Google",
          "Chrome",
          "User Data",
          "Default",
          "Bookmarks",
        );
      }
      const content = await fs.readFile(bookmarkPath, "utf-8");
      return { data: JSON.parse(content), path: bookmarkPath };
    };

    // Helper: 根據路徑字串找節點 (例如 "書籤列 > Tech > Docker")
    const findNodeByPath = (roots, pathStr) => {
      const parts = pathStr.split(">").map((s) => s.trim());
      // 決定起點
      let current = null;
      const rootName = parts.shift(); // "書籤列", "其他書籤", "行動裝置"

      if (rootName === "書籤列") current = roots.bookmark_bar;
      else if (rootName === "其他書籤") current = roots.other;
      else if (rootName === "行動裝置") current = roots.synced;
      else return null;

      // 開始往下找
      for (const part of parts) {
        if (!current.children) return null;
        const found = current.children.find(
          (child) => child.type === "folder" && child.name === part,
        );
        if (!found) return null;
        current = found;
      }
      return current;
    };

    // ----------------------------------------
    // [補回] 建立新資料夾
    // ----------------------------------------
    if (name === "create_bookmark_folder") {
      const { data, path: filePath } = await loadBookmarks(args.profilePath);

      const parentNode = findNodeByPath(data.roots, args.parentPath);

      if (!parentNode) {
        return {
          isError: true,
          content: [{ type: "text", text: `❌ 錯誤：找不到父資料夾 '${args.parentPath}'` }]
        };
      }

      if (!parentNode.children) parentNode.children = [];

      const existingFolder = parentNode.children.find(
        c => c.type === 'folder' && c.name === args.newFolderName
      );

      if (existingFolder) {
        return {
          content: [{ type: "text", text: `⚠️ 資料夾已存在：'${args.newFolderName}' 已經在 '${args.parentPath}' 底下，無需重複建立。` }]
        };
      }

      const newFolder = {
        date_added: (Date.now() * 1000).toString(),
        guid: crypto.randomUUID(),
        id: Math.floor(Math.random() * 1000000).toString(),
        name: args.newFolderName,
        type: "folder",
        children: []
      };

      parentNode.children.push(newFolder);
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

      return {
        content: [{
          type: "text",
          text: `✅ 資料夾建立成功！\n已在 '${args.parentPath}' 底下建立新資料夾：'${args.newFolderName}'`
        }]
      };
    }

    if (name === "get_bookmark_structure") {
      const { data } = await loadBookmarks(args.profilePath);

      // 遞迴產生樹狀圖 (只含資料夾)
      const buildTree = (node) => {
        if (!node.children) return null;
        const folders = node.children
          .filter((c) => c.type === "folder") // 只看資料夾
          .map((c) => {
            const sub = buildTree(c);
            return sub ? { [c.name]: sub } : c.name;
          });
        // 順便統計該資料夾下的連結數
        const linkCount = node.children.filter((c) => c.type === "url").length;
        return folders.length > 0
          ? { __links: linkCount, folders }
          : { __links: linkCount };
      };

      const structure = {
        書籤列: buildTree(data.roots.bookmark_bar),
        其他書籤: buildTree(data.roots.other),
        行動裝置: buildTree(data.roots.synced),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(structure, null, 2) }],
      };
    }

    if (name === "create_bookmark_folder") {
      const { data, path: filePath } = await loadBookmarks(args.profilePath);
      const parentNode = findNodeByPath(data.roots, args.parentPath);

      if (!parentNode) throw new Error(`找不到父資料夾: ${args.parentPath}`);

      // 檢查是否已存在
      const exists = parentNode.children.find(
        (c) => c.name === args.newFolderName && c.type === "folder",
      );
      if (exists)
        return {
          content: [
            { type: "text", text: `⚠️ 資料夾已存在: ${args.newFolderName}` },
          ],
        };

      // 建立新節點 (ID 隨便給一個唯一的)
      const newId = Date.now().toString();
      const newFolder = {
        date_added: newId,
        id: newId,
        name: args.newFolderName,
        type: "folder",
        children: [],
      };

      parentNode.children.push(newFolder);
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

      return {
        content: [
          {
            type: "text",
            text: `✅ 資料夾已建立: ${args.parentPath} > ${args.newFolderName}`,
          },
        ],
      };
    }

    if (name === "move_bookmarks") {
      const { data, path: filePath } = await loadBookmarks(args.profilePath);

      // 1. 找來源與目標
      const sourceNode = findNodeByPath(data.roots, args.sourcePath);
      const targetNode = findNodeByPath(data.roots, args.targetPath);

      if (!sourceNode) throw new Error(`找不到來源: ${args.sourcePath}`);
      if (!targetNode) throw new Error(`找不到目標: ${args.targetPath}`);

      // 2. 篩選要搬移的書籤
      const toMove = [];
      const keep = [];

      sourceNode.children.forEach((child) => {
        if (!args.keyword) {
          // 沒關鍵字 → 全部搬移 (書籤 + 資料夾)
          toMove.push(child);
        } else {
          const kw = args.keyword.toLowerCase();
          if (child.type === "url") {
            if (child.name.toLowerCase().includes(kw) || child.url.toLowerCase().includes(kw)) {
              toMove.push(child);
            } else {
              keep.push(child);
            }
          } else if (child.type === "folder") {
            // 資料夾：比對名稱，符合就整個搬走
            if (child.name.toLowerCase().includes(kw)) {
              toMove.push(child);
            } else {
              keep.push(child);
            }
          } else {
            keep.push(child);
          }
        }
      });

      if (toMove.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `⚠️ 在 '${args.sourcePath}' 中找不到符合 '${args.keyword || "*"}' 的書籤。`,
            },
          ],
        };
      }

      // 3. 執行搬移
      sourceNode.children = keep; // 移除來源
      targetNode.children.push(...toMove); // 加入目標

      // 4. 存檔 (先備份)
      const backupPath = `${filePath}.bak.reorg.${Date.now()}`;
      await fs.copyFile(filePath, backupPath);
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

      return {
        content: [
          {
            type: "text",
            text: `✅ 已將 ${toMove.length} 個書籤從 [${args.sourcePath}] 搬移至 [${args.targetPath}]。`,
          },
        ],
      };
    }
    // Helper 保持不變 (loadBookmarks, findNodeByPath) ...

    if (name === "get_folder_contents") {
      try {
        // 1. 確保 Helper 函數存在 (讀取書籤)
        const loadBookmarks = async (profilePath) => {
          let bookmarkPath = profilePath;
          if (!bookmarkPath) {
            const localAppData =
              process.env.LOCALAPPDATA ||
              path.join(os.homedir(), "AppData", "Local");
            bookmarkPath = path.join(
              localAppData,
              "Google",
              "Chrome",
              "User Data",
              "Default",
              "Bookmarks",
            );
          }
          const content = await fs.readFile(bookmarkPath, "utf-8");
          return { data: JSON.parse(content), path: bookmarkPath };
        };

        // 2. 確保 Helper 函數存在 (搜尋路徑)
        const findNodeByPath = (roots, pathStr) => {
          if (!pathStr) return null;
          const parts = pathStr.split(">").map((s) => s.trim());
          let current = null;
          const rootName = parts.shift();

          if (rootName === "書籤列") current = roots.bookmark_bar;
          else if (rootName === "其他書籤") current = roots.other;
          else if (rootName === "行動裝置") current = roots.synced;
          else return null;

          for (const part of parts) {
            if (!current.children) return null;
            const found = current.children.find(
              (child) => child.type === "folder" && child.name === part,
            );
            if (!found) return null;
            current = found;
          }
          return current;
        };

        // 3. 執行主邏輯
        console.log(`正在讀取書籤: ${args.folderPath}`); // Debug Log
        const { data } = await loadBookmarks(args.profilePath);
        const targetNode = findNodeByPath(data.roots, args.folderPath);

        if (!targetNode) {
          // 如果找不到，回傳明確的錯誤訊息，而不是讓程式崩潰
          return {
            content: [
              {
                type: "text",
                text: `❌ 錯誤：找不到資料夾 '${args.folderPath}'。請先確認路徑是否正確 (例如：'書籤列 > 改CODE之路')。`,
              },
            ],
            isError: true,
          };
        }

        // 4. 抓取書籤 (只抓 URL 類型)
        const files = targetNode.children
          .filter((c) => c.type === "url")
          .map((c) => ({
            id: c.id,
            name: c.name,
            // url: c.url // 如果需要網址可解開註解
          }));

        // 5. 回傳結果 (這是最重要的 return)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(files, null, 2),
            },
          ],
        };
      } catch (error) {
        // 捕捉未預期的錯誤
        return {
          content: [
            { type: "text", text: `❌ 程式執行錯誤: ${error.message}` },
          ],
          isError: true,
        };
      }
    }

    if (name === "move_specific_bookmarks") {
      const { data, path: filePath } = await loadBookmarks(args.profilePath);

      // 1. 找到目標資料夾
      const targetNode = findNodeByPath(data.roots, args.targetPath);
      if (!targetNode) throw new Error(`找不到目標資料夾: ${args.targetPath}`);

      // 2. 建立 ID 查找表 (Set)
      const idsToMove = new Set(args.bookmarkIds);
      const movedItems = [];

      // 3. 遞迴搜尋並移除 (因為書籤可能散落在不同子目錄，或是我們只針對來源目錄搜尋)
      // 這裡假設我們只從「全域」搜尋這些 ID 並搬移，比較保險
      const removeRecursive = (node) => {
        if (!node.children) return;

        // 分離出要搬的 和 要留的
        const toKeep = [];
        node.children.forEach((child) => {
          if (child.type === "url" && idsToMove.has(child.id)) {
            movedItems.push(child); // 抓出來
          } else {
            toKeep.push(child); // 留著
            if (child.children) removeRecursive(child); // 繼續往下找
          }
        });
        node.children = toKeep;
      };

      // 掃描三大根目錄
      if (data.roots.bookmark_bar) removeRecursive(data.roots.bookmark_bar);
      if (data.roots.other) removeRecursive(data.roots.other);
      if (data.roots.synced) removeRecursive(data.roots.synced);

      // 4. 放入目標
      if (movedItems.length > 0) {
        targetNode.children.push(...movedItems);

        // 備份並存檔
        const backupPath = `${filePath}.bak.move.${Date.now()}`;
        await fs.copyFile(filePath, backupPath);
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

        return {
          content: [
            {
              type: "text",
              text: `✅ 已成功搬移 ${movedItems.length} 個書籤到 '${args.targetPath}'。`,
            },
          ],
        };
      } else {
        return {
          content: [
            { type: "text", text: "⚠️ 找不到指定的書籤 ID，未進行任何搬移。" },
          ],
        };
      }
    }

    // ----------------------------------------
    // 書籤排序功能
    // ----------------------------------------
    if (name === "sort_bookmarks") {
      // 1. 讀取書籤 (使用之前的 Helper)
      const { data, path: filePath } = await loadBookmarks(args.profilePath); // 確保 loadBookmarks 已定義

      // 2. 找到目標節點 (使用之前的 Helper)
      const targetNode = findNodeByPath(data.roots, args.folderPath); // 確保 findNodeByPath 已定義

      if (!targetNode) {
        return {
          isError: true,
          content: [
            { type: "text", text: `❌ 找不到資料夾: ${args.folderPath}` },
          ],
        };
      }

      if (!targetNode.children || targetNode.children.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `⚠️ 資料夾 '${args.folderPath}' 是空的，無需排序。`,
            },
          ],
        };
      }

      // 3. 執行排序邏輯
      // 規則 A: 資料夾 (type: folder) 排在前面
      // 規則 B: 同類型時，依照 name 進行語系排序 (支援中文)
      targetNode.children.sort((a, b) => {
        // 先比類型 (資料夾優先)
        if (a.type === "folder" && b.type !== "folder") return -1;
        if (a.type !== "folder" && b.type === "folder") return 1;

        // 再比名稱 (中文/英文排序)
        return a.name.localeCompare(b.name, "zh-TW", { sensitivity: "base" });
      });

      // 4. 寫入存檔 (含備份)
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:T.]/g, "")
        .slice(0, 14);
      const backupPath = `${filePath}.bak.sort.${timestamp}`;
      await fs.copyFile(filePath, backupPath);
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

      return {
        content: [
          {
            type: "text",
            text: `✅ 已完成排序！\n資料夾 '${args.folderPath}' 內的項目已依照 [資料夾優先 -> 名稱排序] 重新排列。\n原始檔案已備份。`,
          },
        ],
      };
    }
    // ----------------------------------------
    // [新增] 資料夾改名與刪除工具
    // ----------------------------------------

    if (name === "rename_bookmark_folder") {
      const { data, path: filePath } = await loadBookmarks(args.profilePath);
      const targetNode = findNodeByPath(data.roots, args.folderPath);

      if (!targetNode) {
        return {
          isError: true,
          content: [
            { type: "text", text: `❌ 找不到資料夾: ${args.folderPath}` },
          ],
        };
      }

      // 修改名稱
      const oldName = targetNode.name;
      targetNode.name = args.newName;

      // 存檔
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

      return {
        content: [
          {
            type: "text",
            text: `✅ 改名成功！\n已將 '${oldName}' 修改為 '${args.newName}'。`,
          },
        ],
      };
    }

    if (name === "delete_bookmark_folder") {
      const { data, path: filePath } = await loadBookmarks(args.profilePath);

      // 1. 解析路徑，分離出 "父路徑" 和 "目標資料夾名稱"
      // 例如: "書籤列 > A > B"  => Parent: "書籤列 > A", Target: "B"
      const pathParts = args.folderPath.split(">").map((s) => s.trim());
      const targetName = pathParts.pop(); // 拿出最後一個 (要刪除的)
      const parentPath = pathParts.join(" > "); // 剩下的就是父路徑

      if (!parentPath) {
        return {
          isError: true,
          content: [
            { type: "text", text: `❌ 無法刪除根目錄 (書籤列/其他書籤)！` },
          ],
        };
      }

      // 2. 找到父節點
      const parentNode = findNodeByPath(data.roots, parentPath);
      if (!parentNode) {
        return {
          isError: true,
          content: [{ type: "text", text: `❌ 找不到父資料夾: ${parentPath}` }],
        };
      }

      // 3. 在父節點中找到目標
      const targetIndex = parentNode.children.findIndex(
        (c) => c.type === "folder" && c.name === targetName,
      );
      if (targetIndex === -1) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `❌ 在 '${parentPath}' 底下找不到名為 '${targetName}' 的資料夾。`,
            },
          ],
        };
      }

      const targetNode = parentNode.children[targetIndex];

      // 4. 安全檢查 (除非 force=true，否則不刪除非空資料夾)
      if (
        targetNode.children &&
        targetNode.children.length > 0 &&
        !args.force
      ) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `⚠️ 刪除失敗：資料夾 '${targetName}' 不是空的 (裡面有 ${targetNode.children.length} 個項目)。\n若要強制刪除，請設定 force: true。`,
            },
          ],
        };
      }

      // 5. 執行刪除 (從陣列中移除)
      parentNode.children.splice(targetIndex, 1);

      // 6. 存檔 (備份)
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:T.]/g, "")
        .slice(0, 14);
      const backupPath = `${filePath}.bak.del.${timestamp}`;
      await fs.copyFile(filePath, backupPath);
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");

      return {
        content: [
          {
            type: "text",
            text: `🗑️ 已成功刪除資料夾: ${args.folderPath}\n(原始檔案已備份)`,
          },
        ],
      };
    }
    // ----------------------------------------
    // [新增] 網頁讀取與清洗工具 (Token Saver)
    // ----------------------------------------
    if (name === "fetch_page_summary") {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10秒超時

        const res = await fetch(args.url, {
          signal: controller.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        });
        clearTimeout(timeout);

        if (res.status !== 200) {
          return {
            content: [
              { type: "text", text: `無法讀取網頁: HTTP ${res.status}` },
            ],
          };
        }

        const html = await res.text();

        // --- 清洗邏輯 (不使用 Cheerio，手動 Regex 處理) ---

        // 1. 抓取 Title
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : "No Title";

        // 2. 抓取 Meta Description
        const metaMatch = html.match(
          /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i,
        );
        const description = metaMatch ? metaMatch[1].trim() : "";

        // 3. 移除 Script, Style, Comments, SVG
        cleanText = cleanText.replace(/<[^>]+>/g, " ");

        // 4. 移除所有 HTML Tags (<div...>, </a> 等)
        cleanText = cleanText.replace(/<[^>]+>/g, " ");

        // 5. 移除多餘空白、換行與常見 HTML Entity
        cleanText = cleanText
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        // 6. 截斷長度 (只取前 2000 字)
        const summary = cleanText.substring(0, 2000);

        // 組合最終回傳內容
        const result = `
【網頁標題】: ${title}
【網頁描述】: ${description}
【內文摘要】: ${summary}... (已截斷)
        `.trim();

        return { content: [{ type: "text", text: result }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `讀取失敗: ${error.message}` }],
        };
      }
    }
    // ----------------------------------------
    // [新增] 導出書籤為 HTML (Netscape 格式)
    // ----------------------------------------
    if (name === "export_bookmarks_to_html") {
      const { data } = await loadBookmarks(args.profilePath);
      const outputFile = args.outputFilename || "bookmarks_cleaned.html";

      // Netscape 格式標頭
      let htmlContent = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

      // 遞迴轉換函式
      const processNode = (node) => {
        let output = "";

        if (node.type === "url") {
          // 處理網址: <DT><A HREF="...">Title</A>
          output += `    <DT><A HREF="${node.url}" ADD_DATE="${node.date_added || Date.now()}">${node.name}</A>\n`;
        } else if (node.type === "folder") {
          // 處理資料夾
          // 注意: Chrome 的書籤列需要特殊屬性 PERSONAL_TOOLBAR_FOLDER="true"
          let extraAttr = "";
          if (node.name === "書籤列" || node.name === "Bookmarks bar") {
            extraAttr = ` PERSONAL_TOOLBAR_FOLDER="true"`;
          }

          output += `    <DT><H3${extraAttr} ADD_DATE="${node.date_added || Date.now()}">${node.name}</H3>\n`;
          output += `    <DL><p>\n`;

          if (node.children) {
            node.children.forEach((child) => {
              output += processNode(child);
            });
          }

          output += `    </DL><p>\n`;
        }
        return output;
      };

      // 依序處理三大根目錄
      // 1. 書籤列
      if (data.roots.bookmark_bar) {
        // 為了讓匯入時結構正確，我們通常把 bookmark_bar 的 children 展開在最上層，
        // 或者保留 bookmark_bar 資料夾本身。
        // 這裡我們選擇保留資料夾結構，讓 Chrome 匯入時能辨識。
        htmlContent += processNode(data.roots.bookmark_bar);
      }

      // 2. 其他書籤
      if (data.roots.other) {
        htmlContent += processNode(data.roots.other);
      }

      // 3. 行動裝置書籤 (選用，通常匯入時會變成資料夾)
      if (data.roots.synced) {
        htmlContent += processNode(data.roots.synced);
      }

      htmlContent += `</DL><p>`;

      // 寫入檔案
      const finalPath = path.resolve(process.cwd(), outputFile);
      await fs.writeFile(finalPath, htmlContent, "utf-8");

      return {
        content: [
          {
            type: "text",
            text: `✅ 書籤匯出成功！\n檔案位置: ${finalPath}\n\n您可以開啟 Chrome -> 書籤 -> 匯入書籤和設定 -> 選擇此 HTML 檔案。`,
          },
        ],
      };
    }
    if (name === "remove_duplicates") {
      const { data, path: filePath } = await loadBookmarks(args.profilePath);
      const urlMap = new Map(); // 用來記錄已經看過的 URL
      let removeCount = 0;

      // 遞迴遍歷並標記要刪除的節點
      const traverseAndMark = (node) => {
        if (!node.children) return;

        // 從後往前迴圈，這樣刪除時不會影響索引
        for (let i = node.children.length - 1; i >= 0; i--) {
          const child = node.children[i];

          if (child.type === "url") {
            if (urlMap.has(child.url)) {
              // 發現重複！刪除這個 (保留先被記錄到的，通常是遍歷順序前面的)
              node.children.splice(i, 1);
              removeCount++;
            } else {
              // 第一次看到，記錄下來
              urlMap.set(child.url, true);
            }
          } else if (child.type === "folder") {
            traverseAndMark(child);
          }
        }
      };

      // 開始掃描三大根目錄
      if (data.roots.bookmark_bar) traverseAndMark(data.roots.bookmark_bar);
      if (data.roots.other) traverseAndMark(data.roots.other);
      if (data.roots.synced) traverseAndMark(data.roots.synced);

      // 存檔
      if (removeCount > 0) {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      }

      return {
        content: [
          {
            type: "text",
            text: `✅ 重複移除完成！\n共刪除了 ${removeCount} 個重複的書籤連結。`,
          },
        ],
      };
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `MCP Error: ${error.message}` }],
    };
  }
});

// ============================================
// 5. 定義 Prompts (Agent Skills)
// ============================================

// A. 列出有哪些 Skills
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "php_crud_generator",
        description: "PHP CRUD 產生器 (讀取 MD 範本)",
        arguments: [
          {
            name: "tableName",
            description: "要生成的資料表名稱 (例如: products)",
            required: true,
          },
        ],
      },
    ],
  };
});

// B. 讀取 Skill 內容 (讀取 MD 檔並替換變數)
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const promptName = request.params.name;
  const args = request.params.arguments || {};

  if (promptName === "php_crud_generator") {
    const tableName = args.tableName || "unknown_table";

    // 讀取 MD 檔案內容
    const skillPath = path.resolve(CONFIG.basePath, "skills/generate_crud.md");
    let promptContent = await fs.readFile(skillPath, "utf-8");

    // 簡單的模板替換 (把 {{TABLE_NAME}} 換成真的表名)
    promptContent = promptContent.replace(/{{TABLE_NAME}}/g, tableName);

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: promptContent,
          },
        },
      ],
    };
  }

  throw new Error("找不到指定的 Skill (Prompt)");
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ MCP Server v5.0.0 (Full Integration) Started.");
