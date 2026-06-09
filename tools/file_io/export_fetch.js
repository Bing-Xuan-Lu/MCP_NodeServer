// tools/file_io/export_fetch.js — 下載「需登入」的匯出檔並解析儲存格
// 解 send_http_request 拿到 binary 亂碼、且不帶 session 的痛點：
// 帶 cookie（或先 POST 登入取 cookie）下載 .xlsx/.xls/.csv，用 SheetJS 從 buffer 直接解析回傳可讀內容。

import { createRequire } from "module";
import { validateArgs } from "../_shared/utils.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

export const definitions = [
  {
    name: "fetch_export_file",
    description:
      "下載「需登入」的匯出檔（.xlsx/.xls/.csv）並解析儲存格回傳可讀內容。解 send_http_request 拿到 binary 亂碼、且不帶 session 的痛點。可直接帶 cookie，或用 login 先 POST 登入取得 session 再下載。適合 QC 後台匯出功能：驗證匯出非空白、欄位與列表一致。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "匯出檔下載 URL" },
        cookie: {
          type: "string",
          description: "驗證用 Cookie 標頭字串（如 'PHPSESSID=abc; foo=bar'）；已登入時帶這個最簡單",
        },
        login: {
          type: "object",
          description: "（選填）先 POST 登入建立 session 再下載",
          properties: {
            url: { type: "string", description: "登入 endpoint URL" },
            data: { type: "object", description: "登入表單欄位（帳號/密碼等）" },
            content_type: { type: "string", enum: ["form", "json"], description: "預設 form（x-www-form-urlencoded）" },
          },
        },
        headers: { type: "object", description: "（選填）額外請求標頭" },
        sheet: { type: "string", description: "（選填）工作表名稱或索引（預設第一個）；傳 '*' 列全部工作表" },
        format: { type: "string", enum: ["csv", "json"], description: "輸出格式：csv（預設，逐格可讀）/ json（每列物件）" },
        max_rows: { type: "number", description: "最多回傳幾列（預設 200，防爆量；上限 5000）" },
      },
      required: ["url"],
    },
  },
];

/** 從 Set-Cookie 陣列取 name=value（丟掉 Path/Expires 等 attributes） */
function cookieFromSetCookie(setCookieArr) {
  return (setCookieArr || []).map((c) => c.split(";")[0]).join("; ");
}

export async function handle(name, args) {
  if (name !== "fetch_export_file") return undefined;
  args = validateArgs(definitions[0].inputSchema, args);

  let cookie = args.cookie || "";

  // 1. 選擇性登入：POST 取 Set-Cookie 併入 cookie
  if (args.login && args.login.url) {
    const ct = args.login.content_type || "form";
    const loginHeaders = { ...(args.headers || {}) };
    let body;
    if (ct === "json") {
      body = JSON.stringify(args.login.data || {});
      loginHeaders["Content-Type"] = "application/json";
    } else {
      body = new URLSearchParams(args.login.data || {}).toString();
      loginHeaders["Content-Type"] = "application/x-www-form-urlencoded";
    }
    if (cookie) loginHeaders["Cookie"] = cookie;

    const lr = await fetch(args.login.url, { method: "POST", headers: loginHeaders, body, redirect: "manual" });
    const sc = typeof lr.headers.getSetCookie === "function" ? lr.headers.getSetCookie() : [];
    cookie = [cookie, cookieFromSetCookie(sc)].filter(Boolean).join("; ");
    if (!cookie) {
      return { content: [{ type: "text", text: `⚠️ 登入後沒拿到任何 Set-Cookie（status ${lr.status}）。可能登入失敗，或該站用其他驗證方式（如 token）。` }] };
    }
  }

  // 2. 下載匯出檔
  const dlHeaders = { ...(args.headers || {}) };
  if (cookie) dlHeaders["Cookie"] = cookie;

  let res, buf;
  try {
    res = await fetch(args.url, { headers: dlHeaders, redirect: "follow" });
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { content: [{ type: "text", text: `❌ 下載失敗：${err.message}` }] };
  }
  const ctype = res.headers.get("content-type") || "";

  // 偵測：拿到 HTML（多半被導去登入頁）而非試算表
  const head = buf.slice(0, 256).toString("utf-8").toLowerCase();
  if (/text\/html/.test(ctype) || head.includes("<!doctype html") || head.includes("<html")) {
    return { content: [{ type: "text", text:
      `❌ 下載到的是 HTML 不是試算表（content-type: ${ctype || "?"}, status ${res.status}）。\n` +
      `   多半是 cookie 失效被導去登入頁。請確認 cookie 有效，或用 login 參數先登入。` }] };
  }
  if (buf.length === 0) {
    return { content: [{ type: "text", text: `❌ 下載到 0 bytes（status ${res.status}）。匯出可能為空，或 URL 有誤。` }] };
  }

  // 3. 解析：xlsx/xls（二進位）走 buffer；csv/文字先以 UTF-8 解碼，避免 SheetJS 用錯 codepage 把中文變亂碼
  let workbook;
  try {
    const isBinary = (buf[0] === 0x50 && buf[1] === 0x4b) || (buf[0] === 0xd0 && buf[1] === 0xcf); // PK=xlsx / OLE=xls
    workbook = isBinary
      ? XLSX.read(buf, { type: "buffer" })
      : XLSX.read(buf.toString("utf-8"), { type: "string" });
  } catch (err) {
    return { content: [{ type: "text", text: `❌ 解析失敗（${err.message}）。content-type: ${ctype || "?"}, ${buf.length} bytes。` }] };
  }

  const maxRows = Math.min(Math.max(args.max_rows || 200, 1), 5000);
  const fmt = args.format || "csv";
  const wantSheets =
    args.sheet === "*"
      ? workbook.SheetNames
      : args.sheet
        ? [/^\d+$/.test(String(args.sheet)) ? workbook.SheetNames[Number(args.sheet)] : args.sheet]
        : [workbook.SheetNames[0]];

  const out = [
    `📥 ${args.url}`,
    `content-type: ${ctype || "?"} · ${buf.length} bytes · 工作表: ${workbook.SheetNames.join(", ")}`,
    ``,
  ];

  for (const sn of wantSheets) {
    const ws = workbook.Sheets[sn];
    if (!ws) { out.push(`⚠️ 找不到工作表「${sn}」`); continue; }
    const ref = ws["!ref"] || "A1";
    const range = XLSX.utils.decode_range(ref);
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;
    out.push(`## ${sn}（${totalRows} 列 × ${totalCols} 欄${totalRows > maxRows ? `，僅顯示前 ${maxRows} 列` : ""}）`);
    if (fmt === "json") {
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" }).slice(0, maxRows);
      out.push("```json", JSON.stringify(rows, null, 2), "```");
    } else {
      let csv = XLSX.utils.sheet_to_csv(ws);
      const csvRows = csv.split(/\r?\n/);
      if (csvRows.length > maxRows) csv = csvRows.slice(0, maxRows).join("\n");
      out.push("```csv", csv, "```");
    }
    out.push("");
  }

  return { content: [{ type: "text", text: out.join("\n") }] };
}
