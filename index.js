import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";
import fs from "fs/promises";
import path from "path";
import { createRequire } from 'module';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const { HyperFormula } = require('hyperformula');

const server = new Server({
  name: "project-migration-assistant-pro",
  version: "4.0.2",
}, {
  capabilities: { tools: {} },
});

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

function getHFData(workbook) {
  const sheetsData = {};
  workbook.SheetNames.forEach(sheetName => {
    const worksheet = workbook.Sheets[sheetName];
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:A1');
    const sheetArray = [];
    for (let r = 0; r <= range.e.r; ++r) {
      const row = [];
      for (let c = 0; c <= range.e.c; ++c) {
        const cell = worksheet[XLSX.utils.encode_cell({ r, c })];
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

async function httpRequest(url, options = {}) {
  const https = await import('https');
  const http = await import('http');
  const urlParsed = new URL(url);
  const protocol = urlParsed.protocol === 'https:' ? https : http;
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Request timeout')), CONFIG.api.timeout);

    const req = protocol.request(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...options.headers }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        try {
          resolve({ status: res.statusCode, data: res.statusCode === 200 ? JSON.parse(data) : data, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });

    req.on('error', (err) => { clearTimeout(timeout); reject(err); });
    if (options.body) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "list_files", description: "列出目錄檔案", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "read_file", description: "讀取純文字檔案", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "create_file", description: "建立新檔案", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
    { name: "apply_diff", description: "精確修改代碼", inputSchema: { type: "object", properties: { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" } }, required: ["path", "search", "replace"] } },
    { name: "get_db_schema", description: "讀取資料庫結構", inputSchema: { type: "object", properties: { table_name: { type: "string" } }, required: ["table_name"] } },
    { name: "execute_sql", description: "執行 SQL", inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
    { name: "trace_excel_logic", description: "追蹤 Excel 邏輯鏈", inputSchema: { type: "object", properties: { path: { type: "string" }, sheet: { type: "string" }, cell: { type: "string" }, depth: { type: "number" } }, required: ["path", "sheet", "cell"] } },
    { name: "simulate_excel_change", description: "模擬修改數值並重算", inputSchema: { type: "object", properties: { path: { type: "string" }, sheet: { type: "string" }, changeCell: { type: "string" }, newValue: { type: "number" }, targetCell: { type: "string" } }, required: ["path", "sheet", "changeCell", "newValue", "targetCell"] } },
    { name: "get_excel_value", description: "讀取 Excel 儲存格原始值", inputSchema: { type: "object", properties: { path: { type: "string" }, sheet: { type: "string" }, cell: { type: "string" } }, required: ["path", "sheet", "cell"] } },
    { name: "recalculate_excel", description: "重新計算 Excel 儲存格", inputSchema: { type: "object", properties: { path: { type: "string" }, sheet: { type: "string" }, cell: { type: "string" } }, required: ["path", "sheet", "cell"] } },
    { name: "call_php_api", description: "呼叫 PHP API", inputSchema: { type: "object", properties: { endpoint: { type: "string" }, method: { type: "string" }, params: { type: "object" } }, required: ["endpoint"] } },
    { name: "cross_validate", description: "交叉驗證", inputSchema: { type: "object", properties: { excelPath: { type: "string" }, sheet: { type: "string" }, cell: { type: "string" }, apiEndpoint: { type: "string" }, apiMethod: { type: "string" }, apiParams: { type: "object" } }, required: ["excelPath", "sheet", "cell", "apiEndpoint"] } },
    { name: "batch_cross_validate", description: "批次交叉驗證", inputSchema: { type: "object", properties: { testCases: { type: "array" }, reportPath: { type: "string" } }, required: ["testCases"] } }
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "list_files") {
      const fullPath = resolveSecurePath(args.path || ".");
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      return { content: [{ type: "text", text: entries.map(e => e.isDirectory() ? `[DIR] ${e.name}` : `[FILE] ${e.name}`).join("\n") }] };
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
      return { content: [{ type: "text", text: `✅ 檔案已建立: ${args.path}` }] };
    }

    if (name === "apply_diff") {
      const fullPath = resolveSecurePath(args.path);
      const content = await fs.readFile(fullPath, "utf-8");
      if (!content.includes(args.search)) throw new Error("找不到匹配的 search 區塊");
      await fs.writeFile(fullPath, content.replace(args.search, args.replace), "utf-8");
      return { content: [{ type: "text", text: `✅ 檔案已更新: ${args.path}` }] };
    }

    if (name === "get_db_schema") {
      const conn = await mysql.createConnection(CONFIG.db);
      const [rows] = await conn.execute(`DESCRIBE ${args.table_name}`);
      await conn.end();
      return { content: [{ type: "text", text: rows.map(r => `${r.Field} (${r.Type})`).join("\n") }] };
    }

    if (name === "execute_sql") {
      const conn = await mysql.createConnection(CONFIG.db);
      const [res] = await conn.execute(args.sql);
      await conn.end();
      return { content: [{ type: "text", text: `✅ 影響列數: ${res.affectedRows || 0}` }] };
    }

    // ✅ 完全修正的 trace_excel_logic
    if (name === "trace_excel_logic") {
      const fullPath = resolveSecurePath(args.path);
      const workbook = XLSX.readFile(fullPath);
      const hf = HyperFormula.buildFromSheets(getHFData(workbook), { licenseKey: 'gpl-v3' });
      
      const startId = hf.getSheetId(args.sheet);
      if (startId === undefined) {
        const availableSheets = workbook.SheetNames.join(', ');
        throw new Error(`找不到工作表 "${args.sheet}"。可用的工作表：${availableSheets}`);
      }
      
      const maxDepth = args.depth || 1;
      const results = [];
      const visited = new Set();
      
      let startAddr;
      try {
        startAddr = hf.simpleCellAddressFromString(args.cell, startId);
      } catch (err) {
        throw new Error(`無效的儲存格位置 "${args.cell}": ${err.message}`);
      }
      
      let queue = [{ addr: startAddr, d: 0 }];
      visited.add(`${args.sheet}!${args.cell}`);

      while (queue.length > 0) {
        const { addr, d } = queue.shift();
        if (d >= maxDepth) continue;

        try {
          const precedents = hf.getCellPrecedents(addr);
          
          for (const p of precedents) {
            // ✅ 檢查 sheet ID 是否有效
            if (p.sheet === undefined || p.sheet === null) {
              continue; // 跳過無效引用
            }
            
            let pSheet;
            try {
              pSheet = hf.getSheetName(p.sheet);
            } catch (err) {
              continue; // 跳過無法取得名稱的工作表
            }
            
            if (!pSheet) continue;
            
            let pStr;
            try {
              pStr = hf.simpleCellAddressToString(p, pSheet);
            } catch (err) {
              continue; // 跳過無法轉換的位址
            }
            
            if (!visited.has(pStr)) {
              visited.add(pStr);
              
              // ✅ 安全取得來源儲存格資訊
              let fromStr = `${args.sheet}!${args.cell}`;
              try {
                const fromSheet = hf.getSheetName(addr.sheet);
                if (fromSheet) {
                  fromStr = hf.simpleCellAddressToString(addr, fromSheet);
                }
              } catch (err) {
                // 使用預設值
              }
              
              // ✅ 安全取得值和公式
              let cellValue = null;
              let cellFormula = null;
              try {
                cellValue = hf.getCellValue(p);
                cellFormula = hf.getCellFormula(p);
              } catch (err) {
                // 使用預設值
              }
              
              results.push({
                level: d + 1,
                from: fromStr,
                to: pStr,
                value: cellValue,
                formula: cellFormula || "(常數)"
              });
              
              queue.push({ addr: p, d: d + 1 });
            }
          }
        } catch (err) {
          // 如果整個儲存格處理失敗，記錄但繼續
          console.error(`處理儲存格時發生錯誤: ${err.message}`);
        }
      }
      
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }

    if (name === "simulate_excel_change") {
      const fullPath = resolveSecurePath(args.path);
      const workbook = XLSX.readFile(fullPath);
      const hf = HyperFormula.buildFromSheets(getHFData(workbook), { licenseKey: 'gpl-v3' });
      
      const sheetId = hf.getSheetId(args.sheet);
      if (sheetId === undefined) throw new Error(`找不到工作表: ${args.sheet}`);
      
      const cAddr = hf.simpleCellAddressFromString(args.changeCell, sheetId);
      const tAddr = hf.simpleCellAddressFromString(args.targetCell, sheetId);
      
      const before = hf.getCellValue(tAddr);
      hf.setCellContents(cAddr, [[args.newValue]]);
      const after = hf.getCellValue(tAddr);
      
      return { content: [{ type: "text", text: `模擬結果：\n修改 [${args.changeCell}] 為 ${args.newValue}\n[${args.targetCell}] 從 ${before} 變為 ${after}` }] };
    }

    if (name === "get_excel_value") {
      const fullPath = resolveSecurePath(args.path);
      const workbook = XLSX.readFile(fullPath);
      const worksheet = workbook.Sheets[args.sheet];
      if (!worksheet) throw new Error(`找不到工作表: ${args.sheet}`);
      
      const cell = worksheet[args.cell];
      const result = { cell: args.cell, value: cell?.v ?? null, formula: cell?.f ?? null, type: cell?.t ?? null };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "recalculate_excel") {
      const fullPath = resolveSecurePath(args.path);
      const workbook = XLSX.readFile(fullPath);
      const hf = HyperFormula.buildFromSheets(getHFData(workbook), { licenseKey: 'gpl-v3' });
      
      const sheetId = hf.getSheetId(args.sheet);
      if (sheetId === undefined) throw new Error(`找不到工作表: ${args.sheet}`);
      
      const cellAddr = hf.simpleCellAddressFromString(args.cell, sheetId);
      const result = { cell: args.cell, recalculatedValue: hf.getCellValue(cellAddr), formula: hf.getCellFormula(cellAddr) || null };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "call_php_api") {
      let url = args.endpoint.startsWith('http') ? args.endpoint : `${CONFIG.api.baseUrl}${args.endpoint}`;
      const method = args.method || 'GET';
      const options = { method };
      
      if (method === 'POST') {
        options.body = args.params || {};
      } else if (method === 'GET' && args.params) {
        const queryString = new URLSearchParams(args.params).toString();
        url += (url.includes('?') ? '&' : '?') + queryString;
      }
      
      const response = await httpRequest(url, options);
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
    }

    if (name === "cross_validate") {
      const fullPath = resolveSecurePath(args.excelPath);
      const workbook = XLSX.readFile(fullPath);
      const worksheet = workbook.Sheets[args.sheet];
      if (!worksheet) throw new Error(`找不到工作表: ${args.sheet}`);
      
      const excelCell = worksheet[args.cell];
      const excelOriginalValue = excelCell?.v ?? null;
      const excelFormula = excelCell?.f ?? null;
      
      const hf = HyperFormula.buildFromSheets(getHFData(workbook), { licenseKey: 'gpl-v3' });
      const sheetId = hf.getSheetId(args.sheet);
      if (sheetId === undefined) throw new Error(`找不到工作表: ${args.sheet}`);
      
      const cellAddr = hf.simpleCellAddressFromString(args.cell, sheetId);
      const excelRecalcValue = hf.getCellValue(cellAddr);
      
      const apiUrl = args.apiEndpoint.startsWith('http') ? args.apiEndpoint : `${CONFIG.api.baseUrl}${args.apiEndpoint}`;
      const apiResponse = await httpRequest(apiUrl, { method: args.apiMethod || 'POST', body: args.apiParams });
      const phpValue = apiResponse.data?.result ?? apiResponse.data;
      
      const result = {
        testCase: { excel: args.excelPath, sheet: args.sheet, cell: args.cell, api: args.apiEndpoint },
        values: { excelOriginal: excelOriginalValue, excelRecalculated: excelRecalcValue, phpApi: phpValue },
        formula: excelFormula,
        validation: {
          excelConsistent: excelOriginalValue === excelRecalcValue,
          phpMatchesExcel: Math.abs((phpValue ?? 0) - (excelRecalcValue ?? 0)) < 0.01,
          allMatch: excelOriginalValue === excelRecalcValue && Math.abs((phpValue ?? 0) - (excelRecalcValue ?? 0)) < 0.01
        },
        differences: {
          excelDiff: excelOriginalValue !== excelRecalcValue ? (excelRecalcValue - excelOriginalValue) : 0,
          phpDiff: Math.abs((phpValue ?? 0) - (excelRecalcValue ?? 0))
        },
        timestamp: new Date().toISOString()
      };
      
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "batch_cross_validate") {
      const results = [];
      
      for (const testCase of args.testCases) {
        try {
          const fullPath = resolveSecurePath(testCase.excelPath);
          const workbook = XLSX.readFile(fullPath);
          const worksheet = workbook.Sheets[testCase.sheet];
          
          const excelCell = worksheet[testCase.cell];
          const excelOriginalValue = excelCell?.v ?? null;
          
          const hf = HyperFormula.buildFromSheets(getHFData(workbook), { licenseKey: 'gpl-v3' });
          const sheetId = hf.getSheetId(testCase.sheet);
          const cellAddr = hf.simpleCellAddressFromString(testCase.cell, sheetId);
          const excelRecalcValue = hf.getCellValue(cellAddr);
          
          const apiUrl = testCase.apiEndpoint.startsWith('http') ? testCase.apiEndpoint : `${CONFIG.api.baseUrl}${testCase.apiEndpoint}`;
          const apiResponse = await httpRequest(apiUrl, { method: testCase.apiMethod || 'POST', body: testCase.apiParams });
          const phpValue = apiResponse.data?.result ?? apiResponse.data;
          
          results.push({
            name: testCase.name,
            status: 'success',
            excelOriginal: excelOriginalValue,
            excelRecalculated: excelRecalcValue,
            phpApi: phpValue,
            passed: Math.abs((phpValue ?? 0) - (excelRecalcValue ?? 0)) < 0.01
          });
        } catch (error) {
          results.push({ name: testCase.name, status: 'error', error: error.message });
        }
      }
      
      const summary = {
        total: results.length,
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed && r.status === 'success').length,
        errors: results.filter(r => r.status === 'error').length,
        results
      };
      
      if (args.reportPath) {
        const reportPath = resolveSecurePath(args.reportPath);
        await fs.writeFile(reportPath, JSON.stringify(summary, null, 2), 'utf-8');
      }
      
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `MCP 錯誤: ${err.message}\n堆疊: ${err.stack}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ MCP Server v4.0.2 已啟動 (完整錯誤處理版)");
