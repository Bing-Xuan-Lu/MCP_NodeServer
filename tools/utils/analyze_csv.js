/**
 * analyze_csv — long-format CSV pivot/group/aggregate
 *
 * 用途：取代「跑 batch test 後手寫 PHP/Node 解析 33,000 row CSV 算 class distribution
 *      + per-cell aggregation + top mismatch ranking」這類即興腳本。
 *
 * 支援：
 *   - filter（exact / regex / range）先過濾
 *   - group_by 任意欄位組合（單欄或多欄）
 *   - aggregate：count / sum / avg / min / max / distinct / top_values
 *   - sort + head_limit
 *   - 輸出 markdown table
 */

import fs from "fs/promises";
import { resolveSecurePath } from "../../config.js";

export const definitions = [
  {
    name: "analyze_csv",
    description:
      "讀 CSV 做 group/filter/aggregate，輸出 markdown table。" +
      "取代每次跑完 batch test 後手寫 PHP/Node 腳本解析的流程。" +
      "支援 count/sum/avg/min/max/distinct/top_values 聚合，filter 支援 exact / regex / 範圍比較。",
    inputSchema: {
      type: "object",
      properties: {
        csv_path: { type: "string", description: "CSV 檔案路徑（相對 basePath 或絕對）" },
        delimiter: { type: "string", description: "欄位分隔符（預設 ','）", default: "," },
        has_header: { type: "boolean", description: "首列是否為欄位名（預設 true；false 時用 col_1/col_2... 自動命名）", default: true },
        filter: {
          type: "object",
          description:
            "篩選條件：{欄位名: 值}。值可為：" +
            "(1) 字串/數字 → 完全相等比對；" +
            "(2) {regex: 'pattern', flags: 'i'} → 正則比對；" +
            "(3) {gt|gte|lt|lte|ne: number} → 數值比較（會自動轉 Number）；" +
            "(4) {in: ['a','b']} → 列舉值之一；" +
            "(5) {not_in: ['a','b']} → 不在列舉內。多條件 AND。",
        },
        group_by: {
          type: "array",
          items: { type: "string" },
          description: "分組欄位（單欄或多欄組合）；不指定則對整份資料做 aggregate",
        },
        aggregate: {
          type: "object",
          description:
            "聚合定義：{欄位名: 'count'|'sum'|'avg'|'min'|'max'|'distinct'|'top_values'}。" +
            "count 不關心欄位內容（傳任意欄位皆可，常用 '*'）；" +
            "top_values 輸出該欄出現次數前 5 高的值（用 '|' 串接）；" +
            "distinct 輸出去重後的唯一值數量。",
        },
        sort_by: { type: "string", description: "輸出排序欄位（可為 group_by 欄位或聚合結果欄位如 'count' / 'sum_xxx'）" },
        sort_desc: { type: "boolean", description: "是否降冪排序（預設 true）", default: true },
        head_limit: { type: "number", description: "輸出最多列數（預設 50）", default: 50 },
        show_total: { type: "boolean", description: "是否輸出總筆數摘要列（預設 true）", default: true },
      },
      required: ["csv_path"],
    },
  },
];

// ── CSV parser：支援 quoted field、escaped quote、CRLF ──
function parseCsv(text, delim) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuote = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* skip, \n 會接管 */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function applyFilter(records, filter) {
  if (!filter || Object.keys(filter).length === 0) return records;
  const checks = Object.entries(filter).map(([col, cond]) => {
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if (cond.regex) {
        const re = new RegExp(cond.regex, cond.flags || "");
        return (r) => re.test(String(r[col] ?? ""));
      }
      if (cond.in) return (r) => cond.in.includes(r[col]);
      if (cond.not_in) return (r) => !cond.not_in.includes(r[col]);
      return (r) => {
        const v = Number(r[col]);
        if (cond.gt !== undefined && !(v > cond.gt)) return false;
        if (cond.gte !== undefined && !(v >= cond.gte)) return false;
        if (cond.lt !== undefined && !(v < cond.lt)) return false;
        if (cond.lte !== undefined && !(v <= cond.lte)) return false;
        if (cond.ne !== undefined && r[col] == cond.ne) return false;
        return true;
      };
    }
    return (r) => r[col] == cond; // 寬鬆相等（"3" == 3）
  });
  return records.filter((r) => checks.every((fn) => fn(r)));
}

function aggregateGroup(records, aggregate) {
  const out = { count: records.length };
  if (!aggregate) return out;
  for (const [col, op] of Object.entries(aggregate)) {
    const key = op === "count" ? "count" : `${op}_${col}`;
    if (op === "count") {
      out.count = records.length;
    } else if (op === "sum" || op === "avg" || op === "min" || op === "max") {
      const nums = records.map((r) => Number(r[col])).filter((n) => Number.isFinite(n));
      if (nums.length === 0) { out[key] = null; continue; }
      if (op === "sum") out[key] = nums.reduce((a, b) => a + b, 0);
      else if (op === "avg") out[key] = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10000) / 10000;
      else if (op === "min") out[key] = Math.min(...nums);
      else if (op === "max") out[key] = Math.max(...nums);
    } else if (op === "distinct") {
      out[key] = new Set(records.map((r) => r[col])).size;
    } else if (op === "top_values") {
      const counter = new Map();
      for (const r of records) {
        const v = r[col];
        counter.set(v, (counter.get(v) || 0) + 1);
      }
      const top = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      out[key] = top.map(([v, n]) => `${v}(${n})`).join(" | ");
    } else {
      out[key] = `?op:${op}`;
    }
  }
  return out;
}

function formatMarkdownTable(rows, columns) {
  if (rows.length === 0) return "_（無資料）_";
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${columns.map((c) => String(r[c] ?? "")).join(" | ")} |`).join("\n");
  return `${header}\n${sep}\n${body}`;
}

export async function handle(name, args) {
  if (name !== "analyze_csv") return null;

  const csvPath = args?.csv_path;
  if (!csvPath) return { content: [{ type: "text", text: "錯誤：缺少 csv_path" }], isError: true };

  let abs;
  try { abs = resolveSecurePath(csvPath); }
  catch (e) { return { content: [{ type: "text", text: `路徑解析失敗：${e.message}` }], isError: true }; }

  let text;
  try { text = await fs.readFile(abs, "utf-8"); }
  catch (e) { return { content: [{ type: "text", text: `讀檔失敗：${e.message}` }], isError: true }; }

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const delim = args.delimiter || ",";
  const rawRows = parseCsv(text, delim);
  if (rawRows.length === 0) return { content: [{ type: "text", text: "❌ CSV 內無資料" }], isError: true };

  const hasHeader = args.has_header !== false;
  let columns;
  let dataRows;
  if (hasHeader) {
    columns = rawRows[0];
    dataRows = rawRows.slice(1);
  } else {
    columns = rawRows[0].map((_, i) => `col_${i + 1}`);
    dataRows = rawRows;
  }

  // 過濾空 row（純空白尾行）
  dataRows = dataRows.filter((r) => r.some((v) => v !== ""));

  const records = dataRows.map((r) => {
    const obj = {};
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = r[i] ?? "";
    return obj;
  });
  const totalRows = records.length;

  const filtered = applyFilter(records, args.filter);

  const groupBy = Array.isArray(args.group_by) ? args.group_by : [];
  const aggregate = args.aggregate || null;

  let outRows;
  let outCols;

  if (groupBy.length === 0) {
    const agg = aggregateGroup(filtered, aggregate);
    outCols = Object.keys(agg);
    outRows = [agg];
  } else {
    const groups = new Map();
    for (const r of filtered) {
      const key = groupBy.map((c) => r[c] ?? "").join("");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    outRows = [...groups.entries()].map(([key, recs]) => {
      const keyParts = key.split("");
      const row = {};
      groupBy.forEach((c, i) => { row[c] = keyParts[i]; });
      const agg = aggregateGroup(recs, aggregate);
      return { ...row, ...agg };
    });

    const aggKeys = aggregate
      ? Object.entries(aggregate).map(([col, op]) => (op === "count" ? "count" : `${op}_${col}`))
      : ["count"];
    outCols = [...groupBy, ...aggKeys];
  }

  if (args.sort_by && outCols.includes(args.sort_by)) {
    const desc = args.sort_desc !== false;
    outRows.sort((a, b) => {
      const av = a[args.sort_by]; const bv = b[args.sort_by];
      const aNum = Number(av); const bNum = Number(bv);
      const numCmp = Number.isFinite(aNum) && Number.isFinite(bNum);
      const cmp = numCmp ? aNum - bNum : String(av).localeCompare(String(bv));
      return desc ? -cmp : cmp;
    });
  }

  const headLimit = args.head_limit ?? 50;
  const truncated = outRows.length > headLimit;
  const displayed = truncated ? outRows.slice(0, headLimit) : outRows;

  const showTotal = args.show_total !== false;
  const summary = showTotal
    ? `📊 total=${totalRows} filtered=${filtered.length} groups=${outRows.length}${truncated ? ` (顯示前 ${headLimit})` : ""}\n\n`
    : "";

  const table = formatMarkdownTable(displayed, outCols);
  return { content: [{ type: "text", text: summary + table }] };
}
