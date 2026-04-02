import { createRequire } from "module";
import { resolveSecurePath } from "../../config.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const { HyperFormula } = require("hyperformula");

// ============================================
// 內部 Helper
// ============================================
function getHFData(workbook) {
  const sheetsData = {};
  workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const rangeRef = worksheet["!ref"] || "A1:A1";
    const range = XLSX.utils.decode_range(rangeRef);
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

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "get_excel_values_batch",
    description: "批次讀取 Excel 儲存格 (省 Token 版)，支援範圍 (A1:B10) 或列表 (['A1','C3'])",
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
  {
    name: "trace_excel_logic",
    description: "追蹤 Excel 邏輯鏈。支援「追蹤引用」(來源) 與「追蹤從屬」(影響)。",
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
];

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  if (name === "get_excel_values_batch") {
    const fullPath = resolveSecurePath(args.path);
    const workbook = XLSX.readFile(fullPath);
    const sheetName = args.sheet || workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const results = {};

    const readCell = (addr) => {
      const cell = worksheet[addr];
      return {
        value: cell ? cell.v : null,
        formula: cell && cell.f ? `=${cell.f}` : null,
      };
    };

    if (args.range) {
      const range = XLSX.utils.decode_range(args.range);
      for (let R = range.s.r; R <= range.e.r; ++R) {
        for (let C = range.s.c; C <= range.e.c; ++C) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C });
          results[addr] = readCell(addr);
        }
      }
    } else if (args.cells && Array.isArray(args.cells)) {
      args.cells.forEach((addr) => { results[addr] = readCell(addr); });
    } else {
      throw new Error("必須提供 range 或 cells 參數");
    }

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }

  if (name === "trace_excel_logic") {
    const fullPath = resolveSecurePath(args.path);
    const workbook = XLSX.readFile(fullPath);
    const hf = HyperFormula.buildFromSheets(getHFData(workbook), { licenseKey: "gpl-v3" });

    const maxDepth = args.depth || 3;
    const mode = args.mode || "precedents";
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
        const relatedCells =
          mode === "dependents" ? hf.getCellDependents(addr) : hf.getCellPrecedents(addr);

        for (const p of relatedCells) {
          const pSheetName = hf.getSheetName(p.sheet);
          const pStr = hf.simpleCellAddressToString(p, pSheetName);
          const fromStr = hf.simpleCellAddressToString(addr, hf.getSheetName(addr.sheet));
          const directionArrow = mode === "dependents" ? "影響 ->" : "<- 來自";

          if (!visited.has(pStr)) {
            visited.add(pStr);
            results.push({
              level: d + 1,
              relationship: `${fromStr} ${directionArrow} ${pStr}`,
              cell: pStr,
              value: hf.getCellValue(p),
              formula: hf.getCellFormula(p) || "(數值)",
            });
            queue.push({ addr: p, d: d + 1 });
          }
        }
      } catch (e) {}
    }

    const title = mode === "dependents" ? "衝擊分析 (Impact Analysis)" : "邏輯溯源 (Root Cause)";
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
    const hf = HyperFormula.buildFromSheets(getHFData(workbook), { licenseKey: "gpl-v3" });

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
}
