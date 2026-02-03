// ============================================
// MCP Server v4.0.3 - 新增批次讀取功能
// ============================================
// 修改說明：
// 1. 新增 get_excel_values_batch 工具
// 2. 支援範圍讀取（range）和列表讀取（cells）
// 3. 大幅減少 Token 消耗

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import mysql from 'mysql2/promise';
import xlsx from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { HyperFormula } from 'hyperformula';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// 配置
// ============================================
const CONFIG = {
  basePath: "D:\\Project\\",
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'pnsdb'
  },
  api: {
    baseUrl: process.env.API_BASE_URL || 'http://localhost:8011',
    timeout: parseInt(process.env.API_TIMEOUT || '30000')
  }
};

// ============================================
// 工具函數
// ============================================
function resolveSecurePath(userPath) {
  const targetPath = path.resolve(CONFIG.basePath, userPath);
  
  // Windows 路徑不區分大小寫，統一轉小寫比對
  const normalizedTarget = targetPath.toLowerCase();
  const normalizedBase = CONFIG.basePath.toLowerCase();
  
  if (!normalizedTarget.startsWith(normalizedBase)) {
    throw new Error(`安全限制：禁止存取路徑 ${targetPath}`);
  }
  
  return targetPath;
}

let dbPool = null;
async function getDbConnection() {
  if (!dbPool) {
    dbPool = mysql.createPool({
      ...CONFIG.db,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
  }
  return dbPool;
}

// ============================================
// MCP Server 設定
// ============================================
const server = new Server(
  {
    name: "project-migration-assistant-pro",
    version: "4.0.3",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ============================================
// 工具列表
// ============================================
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_excel_value",
      description: "讀取單一 Excel 儲存格的值",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Excel 檔案路徑" },
          sheet: { type: "string", description: "工作表名稱" },
          cell: { type: "string", description: "儲存格地址，例如: A1" }
        },
        required: ["path"]
      }
    },
    {
      name: "get_excel_values_batch",
      description: "批次讀取多個 Excel 儲存格（支援範圍或列表）- 一次讀取多個儲存格，大幅節省 Token",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Excel 檔案路徑" },
          sheet: { type: "string", description: "工作表名稱（預設第一個）" },
          cells: {
            type: "array",
            items: { type: "string" },
            description: "儲存格列表，例如: ['A1', 'B2', 'C3']（與 range 二選一）"
          },
          range: {
            type: "string",
            description: "儲存格範圍，例如: 'A1:C10' 或 'E1:E100'（與 cells 二選一）"
          }
        },
        required: ["path"]
      }
    },
    {
      name: "trace_excel_logic",
      description: "追蹤 Excel 儲存格的計算邏輯和依賴關係",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Excel 檔案路徑" },
          sheet: { type: "string", description: "工作表名稱" },
          cell: { type: "string", description: "儲存格地址" },
          depth: { type: "number", description: "追蹤深度（預設 3）" }
        },
        required: ["path", "sheet", "cell"]
      }
    },
    // ... 其他工具保持不變
  ]
}));

// ============================================
// 工具執行處理
// ============================================
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // ========== 單一儲存格讀取 ==========
      case "get_excel_value": {
        const filePath = resolveSecurePath(args.path);
        const workbook = xlsx.readFile(filePath);
        const sheetName = args.sheet || workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const cellAddress = args.cell || 'A1';
        const cell = worksheet[cellAddress];
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              cell: cellAddress,
              value: cell ? cell.v : null
            }, null, 2)
          }]
        };
      }

      // ========== 批次讀取（新增）==========
      case "get_excel_values_batch": {
        const filePath = resolveSecurePath(args.path);
        const workbook = xlsx.readFile(filePath);
        const sheetName = args.sheet || workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        let results = {};

        if (args.range) {
          // 範圍模式：A1:C10
          const range = xlsx.utils.decode_range(args.range);
          for (let R = range.s.r; R <= range.e.r; R++) {
            for (let C = range.s.c; C <= range.e.c; C++) {
              const cellAddress = xlsx.utils.encode_cell({ r: R, c: C });
              const cell = worksheet[cellAddress];
              results[cellAddress] = cell ? cell.v : null;
            }
          }
        } else if (args.cells && Array.isArray(args.cells)) {
          // 列表模式：['A1', 'B2', 'C3']
          for (const cellAddress of args.cells) {
            const cell = worksheet[cellAddress];
            results[cellAddress] = cell ? cell.v : null;
          }
        } else {
          throw new Error("必須提供 cells（陣列）或 range（字串）參數");
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2)
          }]
        };
      }

      // ========== 追蹤邏輯（已修正）==========
      case "trace_excel_logic": {
        const filePath = resolveSecurePath(args.path);
        const workbook = xlsx.readFile(filePath);
        const sheetName = args.sheet;
        const cellAddress = args.cell;
        const maxDepth = args.depth || 3;

        const sheetData = {};
        for (const name of workbook.SheetNames) {
          sheetData[name] = xlsx.utils.sheet_to_json(workbook.Sheets[name], { 
            header: 1, 
            defval: null 
          });
        }

        const hf = HyperFormula.buildFromSheets(sheetData);
        const sheetId = hf.getSheetId(sheetName);
        
        if (sheetId === undefined || sheetId === null) {
          throw new Error(`找不到工作表: ${sheetName}`);
        }

        const parsed = xlsx.utils.decode_cell(cellAddress);
        const addr = { sheet: sheetId, col: parsed.c, row: parsed.r };

        const trace = [];
        const visited = new Set();

        function traceCell(cellAddr, depth) {
          if (depth > maxDepth) return;
          
          const key = `${cellAddr.sheet}-${cellAddr.col}-${cellAddr.row}`;
          if (visited.has(key)) return;
          visited.add(key);

          let cellSheet, cellStr;
          try {
            cellSheet = hf.getSheetName(cellAddr.sheet);
            cellStr = hf.simpleCellAddressToString(cellAddr, cellSheet);
          } catch (err) {
            return;
          }

          let value = null, formula = null;
          try {
            value = hf.getCellValue(cellAddr);
            formula = hf.getCellFormula(cellAddr);
          } catch (err) {
            // 忽略錯誤
          }

          trace.push({
            depth,
            cell: cellStr,
            value,
            formula: formula || null
          });

          let precedents = [];
          try {
            precedents = hf.getCellPrecedents(cellAddr);
          } catch (err) {
            return;
          }

          for (const p of precedents) {
            // 多層驗證
            if (p.sheet === undefined || p.sheet === null) continue;
            
            let pSheet;
            try {
              pSheet = hf.getSheetName(p.sheet);
            } catch (err) {
              continue;
            }
            
            if (!pSheet) continue;
            
            traceCell(p, depth + 1);
          }
        }

        traceCell(addr, 0);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ trace }, null, 2)
          }]
        };
      }

      default:
        throw new Error(`未知工具: ${name}`);
    }

  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `MCP 錯誤: ${error.message}\n堆疊: ${error.stack}`
      }],
      isError: true
    };
  }
});

// ============================================
// 啟動伺服器
// ============================================
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("✅ MCP Server v4.0.3 已啟動 (批次讀取版)");
}

main().catch(console.error);
