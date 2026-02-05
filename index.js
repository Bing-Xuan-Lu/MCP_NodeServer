import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";
import fs from "fs/promises";
import path from "path";
import { createRequire } from "module";
import "dotenv/config";

// 建立 require 以相容 CommonJS 套件
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const { HyperFormula } = require("hyperformula");

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
    capabilities: { tools: {} },
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
        return {
          content: [
            { type: "text", text: `✅ 影響列數: ${res.affectedRows || 0}` },
          ],
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
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `MCP Error: ${error.message}` }],
    };
  }
});

// 4. 啟動
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ MCP Server v5.0.0 (Full Integration) Started.");
