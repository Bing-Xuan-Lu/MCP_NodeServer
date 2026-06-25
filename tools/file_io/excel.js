import { createRequire } from "module";
import { resolveSecurePath } from "../../config.js";
import { validateArgs } from "../_shared/utils.js";

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
    description:
      "批次讀取 Excel 儲存格，支援範圍 (A1:B10) 或列表 (['A1','C3'])。" +
      "輸出預設 compact（range→2D 值陣列、cells→平面 {addr:value}），比舊的逐格 {value,formula} 物件省 90%+ token，" +
      "大範圍（如 A1:Z60）一次讀完不再被迫切小塊。需同時看公式請用 format:'object'，或 render:'formula' 讓 compact/csv 每格放公式。",
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
        format: {
          type: "string",
          enum: ["compact", "csv", "object"],
          description:
            "輸出格式：compact=2D 值陣列(range)/平面 {addr:value}(cells)，最省 token（預設）；" +
            "csv=CSV 文字（最精簡，適合大範圍貼給人看）；object=每格 {value,formula} 詳列（需同時看值與公式時用）",
          default: "compact",
        },
        render: {
          type: "string",
          enum: ["value", "formula"],
          description: "compact/csv 模式下每格放什麼：value=計算值（預設）；formula=有公式放公式、否則放值。object 模式不受此影響（恆含兩者）",
          default: "value",
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
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  if (name === "get_excel_values_batch") {
    const fullPath = resolveSecurePath(args.path);
    const workbook = XLSX.readFile(fullPath);
    const sheetName = args.sheet || workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const format = args.format || "compact";
    const render = args.render || "value";
    const text = (t) => ({ content: [{ type: "text", text: t }] });

    // object 模式：每格 {value, formula}（舊行為，需同時看值與公式時用）
    const readCellObj = (addr) => {
      const cell = worksheet[addr];
      return { value: cell ? cell.v : null, formula: cell && cell.f ? `=${cell.f}` : null };
    };
    // compact/csv 模式：依 render 取單一值（公式或計算值）
    const renderCell = (addr) => {
      const cell = worksheet[addr];
      if (!cell) return null;
      if (render === "formula") return cell.f ? `=${cell.f}` : (cell.v !== undefined ? cell.v : null);
      return cell.v !== undefined ? cell.v : null;
    };
    const csvEsc = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    if (args.range) {
      const range = XLSX.utils.decode_range(args.range);
      if (format === "object") {
        const results = {};
        for (let R = range.s.r; R <= range.e.r; ++R)
          for (let C = range.s.c; C <= range.e.c; ++C) {
            const addr = XLSX.utils.encode_cell({ r: R, c: C });
            results[addr] = readCellObj(addr);
          }
        return text(JSON.stringify(results, null, 2));
      }
      // compact / csv：建 2D（每列由左到右）
      const rows = [];
      for (let R = range.s.r; R <= range.e.r; ++R) {
        const row = [];
        for (let C = range.s.c; C <= range.e.c; ++C)
          row.push(renderCell(XLSX.utils.encode_cell({ r: R, c: C })));
        rows.push(row);
      }
      const startAddr = XLSX.utils.encode_cell(range.s);
      const head = `# ${sheetName}!${args.range}（左上=${startAddr}，每列由左到右；render=${render}）`;
      if (format === "csv") {
        return text(`${head}\n${rows.map((r) => r.map(csvEsc).join(",")).join("\n")}`);
      }
      return text(`${head}\n${JSON.stringify(rows)}`);
    } else if (args.cells && Array.isArray(args.cells)) {
      if (format === "object") {
        const results = {};
        args.cells.forEach((addr) => { results[addr] = readCellObj(addr); });
        return text(JSON.stringify(results, null, 2));
      }
      const flat = {};
      args.cells.forEach((addr) => { flat[addr] = renderCell(addr); });
      if (format === "csv") {
        return text(`# render=${render}\n${Object.entries(flat).map(([a, v]) => `${a},${csvEsc(v)}`).join("\n")}`);
      }
      return text(JSON.stringify(flat));
    } else {
      throw new Error("必須提供 range 或 cells 參數");
    }
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
