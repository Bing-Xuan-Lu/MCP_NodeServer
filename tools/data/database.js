import mysql from "mysql2/promise";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { validateArgs } from "../_shared/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_CONFIG_FILE = path.join(__dirname, "..", ".mcp_db_config.json");
const AUDIT_LOG = path.join(__dirname, "..", "..", "Project", "_mcp_audit.log");

// ============================================
// 防 Reward Hacking：危險語句檢查 + Audit Log
// ============================================

// 判斷單條 SQL 是否危險，回傳 null（安全）或 { block, reason }
function checkDangerousStmt(sql) {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase().replace(/\s+/g, " ");
  const keyword = upper.match(/^(DELETE|UPDATE|DROP|TRUNCATE)\b/)?.[1];
  if (!keyword) return null; // SELECT / INSERT / CREATE / ALTER / SHOW 等 → 安全

  // 例外：測試清理（MCP_TEST_ 標記是 php_crud_test.md 定義的正式清理 pattern）
  if (keyword === "DELETE" && trimmed.toUpperCase().includes("MCP_TEST_")) return null;

  // 硬性封鎖：DELETE / UPDATE 無 WHERE（幾乎不可能是故意的）
  if ((keyword === "DELETE" || keyword === "UPDATE") && !upper.includes(" WHERE ")) {
    return { block: true, reason: `${keyword} 無 WHERE 條件，可能影響整張表` };
  }

  // 軟性閘門（需 confirm: true）
  return {
    block: false,
    reason: `${keyword} 可能修改/刪除業務資料，需加 confirm: true 確認`,
  };
}

// 將非 SELECT 語句寫入 append-only audit log
async function auditSQL(sql, dbName) {
  try {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${dbName || "?"}] ${sql.replace(/\s+/g, " ").slice(0, 500)}\n`;
    await fs.appendFile(AUDIT_LOG, line, "utf-8");
  } catch {
    // audit 失敗不影響主流程
  }
}

// ============================================
// 記憶體狀態：多連線管理
// ============================================
const dbPool = new Map();  // key = database name, value = config object
let defaultDb = null;      // 最後一次 set_database 的 database name

// 啟動時自動載入已儲存的連線設定（密碼為空，需免密或手動補足）
try {
  const raw = JSON.parse(await fs.readFile(DB_CONFIG_FILE, "utf-8"));

  // 新格式：{ default, connections: { name: config } }
  if (raw && raw.connections && typeof raw.connections === "object") {
    for (const [name, config] of Object.entries(raw.connections)) {
      dbPool.set(name, { password: "", ...config });
    }
    defaultDb = raw.default || null;
    if (defaultDb && !dbPool.has(defaultDb)) defaultDb = dbPool.keys().next().value || null;
    console.error(`[database] 自動載入 ${dbPool.size} 個連線，預設：${defaultDb || "無"}`);
  }
  // 舊格式相容：單一物件 { host, port, user, database }
  else if (raw && raw.database) {
    dbPool.set(raw.database, { password: "", ...raw });
    defaultDb = raw.database;
    console.error(`[database] 自動載入連線（舊格式遷移）: ${raw.database}@${raw.host || "127.0.0.1"}:${raw.port || 3306}`);
  }
} catch {
  // 無設定檔或格式錯誤，略過
}

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "set_database",
    description: "設定資料庫連線。支援多連線：不同 database 各自儲存，最後設定的為預設連線。",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "資料庫主機", default: "127.0.0.1" },
        port: { type: "number", description: "埠號", default: 3306 },
        user: { type: "string", description: "使用者名稱", default: "root" },
        password: { type: "string", description: "密碼" },
        database: { type: "string", description: "資料庫名稱" },
        remember: { type: "boolean", description: "是否記住此連線設定（密碼除外）供下次自動載入" },
      },
      required: ["database"],
    },
  },
  {
    name: "load_db_connection",
    description: "從本地設定檔載入上次記住的資料庫連線設定",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_current_db",
    description: "查看目前所有已設定的資料庫連線（含預設標記）",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_db_schema",
    description: "查看資料表結構",
    inputSchema: {
      type: "object",
      properties: {
        table_name: { type: "string" },
        database: { type: "string", description: "指定資料庫名稱（不傳則用預設連線）" },
      },
      required: ["table_name"],
    },
  },
  {
    name: "execute_sql",
    description: "執行 SQL 指令 (DDL/DML)，支援多條語句以分號分隔、逐條執行。DELETE/UPDATE/DROP/TRUNCATE 需加 confirm: true。可指定 database 切換連線。",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string" },
        database: { type: "string", description: "指定資料庫名稱（不傳則用預設連線）" },
        confirm: {
          type: "boolean",
          description: "對 DELETE/UPDATE/DROP/TRUNCATE 必須明確傳 true，表示已確認操作不是為了規避測試失敗",
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "get_db_schema_batch",
    description: "批次查看多張資料表結構（減少 tool call 來回）",
    inputSchema: {
      type: "object",
      properties: {
        table_names: {
          type: "array",
          items: { type: "string" },
          description: "資料表名稱陣列",
        },
        database: { type: "string", description: "指定資料庫名稱（不傳則用預設連線）" },
      },
      required: ["table_names"],
    },
  },
  {
    name: "execute_sql_batch",
    description: "批次執行多組獨立 SQL（各自獨立連線，互不影響，不會因某條失敗而中斷）",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "查詢標籤（選填，方便識別）" },
              sql: { type: "string", description: "SQL 語句" },
            },
            required: ["sql"],
          },
          description: "SQL 查詢陣列",
        },
        database: { type: "string", description: "指定資料庫名稱（不傳則用預設連線）" },
        confirm: {
          type: "boolean",
          description: "批次中含 DELETE/UPDATE/DROP/TRUNCATE 時必須傳 true",
        },
      },
      required: ["queries"],
    },
  },
];

// ============================================
// 內部：保存連線設定 (不含密碼，多連線格式)
// ============================================
async function saveAllDbConfigs() {
  try {
    const connections = {};
    for (const [name, config] of dbPool.entries()) {
      const { password, ...safeConfig } = config;
      connections[name] = safeConfig;
    }
    const data = { default: defaultDb, connections };
    await fs.writeFile(DB_CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ============================================
// 內部：讀取連線設定
// ============================================
async function loadDbConfig() {
  try {
    const raw = JSON.parse(await fs.readFile(DB_CONFIG_FILE, "utf-8"));
    // 新格式
    if (raw && raw.connections && typeof raw.connections === "object") {
      return raw;
    }
    // 舊格式 → 轉換
    if (raw && raw.database) {
      return { default: raw.database, connections: { [raw.database]: raw } };
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================
// 內部：統一錯誤回應格式（含根因 + 建議動作）
// ============================================
function errorResp(message, nextActions = []) {
  const parts = [message];
  if (nextActions.length > 0) {
    parts.push("建議動作：");
    nextActions.forEach((a) => parts.push(`  • ${a}`));
  }
  return { isError: true, content: [{ type: "text", text: parts.join("\n") }] };
}

// ============================================
// 內部：取得連線設定，未設定時回傳錯誤
// ============================================
function requireDb(database) {
  const key = database || defaultDb;
  if (!key || !dbPool.has(key)) {
    const available = dbPool.size > 0
      ? `可用連線：${[...dbPool.keys()].join(", ")}`
      : "";
    return {
      ok: false,
      error: errorResp(
        database
          ? `找不到資料庫 "${database}" 的連線設定。${available}`
          : `尚未設定資料庫連線。`,
        ["呼叫 set_database 設定連線或 load_db_connection 載入設定後重試"]
      ),
    };
  }
  return { ok: true, config: dbPool.get(key) };
}

// ============================================
// 內部：SQL 錯誤分類提示
// ============================================
function sqlErrorHints(err) {
  const isSyntax  = /ER_PARSE_ERROR|You have an error in your SQL/i.test(err.message);
  const isNoTable = /ER_NO_SUCH_TABLE|doesn't exist/i.test(err.message);
  const isNoCol   = /ER_BAD_FIELD_ERROR|Unknown column/i.test(err.message);
  return isSyntax
    ? ["檢查 SQL 語法，特別是引號、括號、關鍵字拼寫"]
    : isNoTable
    ? ["呼叫 get_db_schema 確認資料表名稱是否存在"]
    : isNoCol
    ? ["呼叫 get_db_schema 確認欄位名稱是否正確"]
    : ["確認 SQL 語句後重試"];
}

// ============================================
// 內部：拆分多條 SQL（考慮字串內分號）
// ============================================
function splitSQL(sql) {
  const statements = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let escaped = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }
    if (ch === "`" && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
      current += ch;
      continue;
    }

    if (ch === ";" && !inSingleQuote && !inDoubleQuote && !inBacktick) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);

  return statements;
}

// ============================================
// 內部：SELECT 結果格式化（緊湊表格，省 token）
// ============================================
const MAX_ROWS = 100;       // 回傳行數上限
const MAX_COL_WIDTH = 120;  // 單欄位截斷字元數

function formatRows(rows) {
  if (!rows.length) return "(0 筆)";
  const display = rows.slice(0, MAX_ROWS);
  const keys = Object.keys(display[0]);
  const lines = display.map((r) =>
    keys.map((k) => {
      const v = r[k] == null ? "NULL" : String(r[k]);
      return v.length > MAX_COL_WIDTH ? v.slice(0, MAX_COL_WIDTH) + "…" : v;
    }).join(" | ")
  );
  let out = keys.join(" | ") + "\n" + lines.join("\n");
  if (rows.length > MAX_ROWS) out += `\n... 共 ${rows.length} 筆，僅顯示前 ${MAX_ROWS} 筆`;
  return out;
}

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  // ── set_database ──
  if (name === "set_database") {
    const dbConfig = {
      host: args.host,
      port: args.port,
      user: args.user,
      password: args.password || "",
      database: args.database,
    };

    // 測試連線
    let conn;
    try {
      conn = await mysql.createConnection(dbConfig);
      await conn.ping();
    } catch (err) {
      const isAuth = /Access denied|ER_ACCESS_DENIED/i.test(err.message);
      const hints = isAuth
        ? ["確認使用者名稱與密碼是否正確"]
        : ["確認 host、port、database 是否正確"];
      return errorResp(`連線失敗：${err.message}`, hints);
    } finally {
      if (conn) await conn.end();
    }

    dbPool.set(dbConfig.database, dbConfig);
    defaultDb = dbConfig.database;

    let msg = `✅ 已連線到 ${dbConfig.database}@${dbConfig.host}:${dbConfig.port} (user: ${dbConfig.user})`;
    if (dbPool.size > 1) {
      msg += `\n📊 目前共 ${dbPool.size} 個連線：${[...dbPool.keys()].join(", ")}（預設：${defaultDb}）`;
    }

    if (args.remember) {
      const saved = await saveAllDbConfigs();
      if (saved) msg += "\n💾 連線設定已持久化至 .mcp_db_config.json";
    }

    return { content: [{ type: "text", text: msg }] };
  }

  // ── load_db_connection ──
  if (name === "load_db_connection") {
    const data = await loadDbConfig();
    if (!data) {
      return errorResp("找不到已儲存的連線設定。", ["請先呼叫 set_database 並開啟 remember 選項"]);
    }

    let loaded = 0;
    for (const [name, config] of Object.entries(data.connections)) {
      if (!dbPool.has(name)) {
        dbPool.set(name, { ...config, password: "" });
        loaded++;
      }
    }
    if (data.default && dbPool.has(data.default)) {
      defaultDb = data.default;
    }

    return {
      content: [
        {
          type: "text",
          text: `📂 已載入 ${loaded} 個新連線（共 ${dbPool.size} 個）：${[...dbPool.keys()].join(", ")}（預設：${defaultDb || "無"}）\n⚠️ 密碼為空，若連線失敗請手動呼叫 set_database 補足密碼。`,
        },
      ],
    };
  }

  // ── get_current_db ──
  if (name === "get_current_db") {
    if (dbPool.size === 0) {
      return {
        content: [{ type: "text", text: "尚未設定任何資料庫連線。" }],
      };
    }
    const lines = [];
    for (const [name, config] of dbPool.entries()) {
      const marker = name === defaultDb ? " ← 預設" : "";
      lines.push(`${name}: ${config.host}:${config.port} (user: ${config.user})${marker}`);
    }
    return {
      content: [
        {
          type: "text",
          text: `📊 已設定 ${dbPool.size} 個連線：\n${lines.join("\n")}`,
        },
      ],
    };
  }

  // ── get_db_schema ──
  if (name === "get_db_schema") {
    const check = requireDb(args.database);
    if (!check.ok) return check.error;

    const conn = await mysql.createConnection(check.config);
    try {
      const [rows] = await conn.execute(`DESCRIBE ${args.table_name}`);
      return {
        content: [
          { type: "text", text: `[${check.config.database}] ${args.table_name}:\n` + rows.map((r) => `${r.Field} (${r.Type})`).join("\n") },
        ],
      };
    } catch (err) {
      return errorResp(`查詢結構失敗：${err.message}`);
    } finally {
      await conn.end();
    }
  }

  // ── execute_sql ──
  if (name === "execute_sql") {
    const check = requireDb(args.database);
    if (!check.ok) return check.error;

    const statements = splitSQL(args.sql);

    // 危險語句預檢
    const dangerList = [];
    for (const sql of statements) {
      const d = checkDangerousStmt(sql);
      if (d) dangerList.push({ sql: sql.slice(0, 120), ...d });
    }
    const blocked = dangerList.filter((d) => d.block);
    const needConfirm = dangerList.filter((d) => !d.block);
    if (blocked.length > 0) {
      return {
        isError: true,
        content: [{ type: "text", text: `⛔ 封鎖 ${blocked.length} 條危險語句：\n${blocked.map((d) => `  • ${d.reason}：${d.sql}`).join("\n")}` }],
      };
    }
    if (needConfirm.length > 0 && !args.confirm) {
      return {
        isError: true,
        content: [{ type: "text", text: `⚠️ 以下語句需加 confirm: true 才能執行（防止誤刪業務資料）：\n${needConfirm.map((d) => `  • ${d.reason}：${d.sql}`).join("\n")}` }],
      };
    }

    const conn = await mysql.createConnection(check.config);
    const results = [];
    const dbLabel = check.config.database;
    try {
      for (let i = 0; i < statements.length; i++) {
        const sql = statements[i];
        try {
          const [res] = await conn.execute(sql);
          if (Array.isArray(res)) {
            results.push(`[${i + 1}] 查詢結果 (${res.length} 筆)：\n${formatRows(res)}`);
          } else {
            // 非 SELECT 寫入 audit log
            const upper = sql.trim().toUpperCase();
            if (!upper.startsWith("SELECT") && !upper.startsWith("SHOW") && !upper.startsWith("DESCRIBE")) {
              await auditSQL(sql, dbLabel);
            }
            results.push(`[${i + 1}] ✅ 執行成功。影響列數: ${res.affectedRows}`);
          }
        } catch (err) {
          const code = err.code ? ` [${err.code}]` : "";
          const sqlState = err.sqlState ? ` (SQLSTATE ${err.sqlState})` : "";
          results.push(`[${i + 1}] ❌ 失敗${code}${sqlState}：${err.message}`);
          break;
        }
      }
      const header = dbPool.size > 1 ? `🗄️ [${dbLabel}]\n` : "";
      return { content: [{ type: "text", text: header + results.join("\n\n") }] };
    } finally {
      await conn.end();
    }
  }

  // ── get_db_schema_batch ──
  if (name === "get_db_schema_batch") {
    const check = requireDb(args.database);
    if (!check.ok) return check.error;

    const conn = await mysql.createConnection(check.config);
    const results = [];
    const dbLabel = check.config.database;
    try {
      for (const table of args.table_names) {
        try {
          const [rows] = await conn.execute(`DESCRIBE \`${table}\``);
          const cols = rows.map((r) => `  ${r.Field} (${r.Type})`);
          results.push(`📋 ${table}:\n${cols.join("\n")}`);
        } catch (err) {
          results.push(`❌ ${table}：${err.message}`);
        }
      }
      const header = dbPool.size > 1 ? `🗄️ [${dbLabel}]\n` : "";
      return { content: [{ type: "text", text: header + results.join("\n\n") }] };
    } finally {
      await conn.end();
    }
  }

  // ── execute_sql_batch ──
  if (name === "execute_sql_batch") {
    const check = requireDb(args.database);
    if (!check.ok) return check.error;

    // 危險語句預檢（所有批次項目）
    const dangerList = [];
    for (const q of args.queries) {
      const d = checkDangerousStmt(q.sql);
      if (d) dangerList.push({ label: q.label || q.sql.slice(0, 60), ...d });
    }
    const blocked = dangerList.filter((d) => d.block);
    const needConfirm = dangerList.filter((d) => !d.block);
    if (blocked.length > 0) {
      return {
        isError: true,
        content: [{ type: "text", text: `⛔ 封鎖 ${blocked.length} 條危險語句：\n${blocked.map((d) => `  • ${d.reason}：${d.label}`).join("\n")}` }],
      };
    }
    if (needConfirm.length > 0 && !args.confirm) {
      return {
        isError: true,
        content: [{ type: "text", text: `⚠️ 批次中有 ${needConfirm.length} 條語句需加 confirm: true：\n${needConfirm.map((d) => `  • ${d.reason}：${d.label}`).join("\n")}` }],
      };
    }

    const conn = await mysql.createConnection(check.config);
    const results = [];
    const dbLabel = check.config.database;
    try {
      for (const q of args.queries) {
        const label = q.label || "SQL";
        try {
          const [res] = await conn.execute(q.sql);
          if (Array.isArray(res)) {
            // SELECT 結果：回傳實際資料
            results.push(`${label}: 查詢結果 (${res.length} 筆)：\n${formatRows(res)}`);
          } else {
            // DML：寫入 audit log + 回傳影響列數
            const upper = q.sql.trim().toUpperCase();
            if (!upper.startsWith("SELECT") && !upper.startsWith("SHOW") && !upper.startsWith("DESCRIBE")) {
              await auditSQL(q.sql, dbLabel);
            }
            results.push(`${label}: ✅ 成功（影響 ${res.affectedRows} 列）`);
          }
        } catch (err) {
          const code = err.code ? ` [${err.code}]` : "";
          const sqlState = err.sqlState ? ` (SQLSTATE ${err.sqlState})` : "";
          results.push(`${label}: ❌${code}${sqlState} ${err.message}`);
        }
      }
      const header = dbPool.size > 1 ? `🗄️ [${dbLabel}]\n` : "";
      return { content: [{ type: "text", text: header + results.join("\n") }] };
    } finally {
      await conn.end();
    }
  }
}
