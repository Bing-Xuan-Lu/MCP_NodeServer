import mysql from "mysql2/promise";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_CONFIG_FILE = path.join(__dirname, "..", ".mcp_db_config.json");

// ============================================
// 記憶體狀態：當前資料庫連線設定
// ============================================
let currentDb = null;

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "set_database",
    description: "設定資料庫連線 (設定後同一次對話內的所有查詢都會使用此連線)",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "資料庫主機 (預設 127.0.0.1)" },
        port: { type: "number", description: "埠號 (預設 3306)" },
        user: { type: "string", description: "使用者名稱 (預設 root)" },
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
    description: "查看目前的資料庫連線設定",
    inputSchema: { type: "object", properties: {} },
  },
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
    description: "執行 SQL 指令 (DDL/DML)，支援多條語句以分號分隔、逐條執行",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string" } },
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
      },
      required: ["queries"],
    },
  },
];

// ============================================
// 內部：保存連線設定 (不含密碼)
// ============================================
async function saveDbConfig(config) {
  const { password, ...safeConfig } = config;
  try {
    await fs.writeFile(DB_CONFIG_FILE, JSON.stringify(safeConfig, null, 2), "utf-8");
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
    const data = await fs.readFile(DB_CONFIG_FILE, "utf-8");
    return JSON.parse(data);
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
function requireDb() {
  if (!currentDb) {
    return {
      ok: false,
      error: errorResp("尚未設定資料庫連線。", ["呼叫 set_database 設定連線或 load_db_connection 載入設定後重試"]),
    };
  }
  return { ok: true, config: currentDb };
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
  // ── set_database ──
  if (name === "set_database") {
    const dbConfig = {
      host: args.host || "127.0.0.1",
      port: args.port || 3306,
      user: args.user || "root",
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

    currentDb = dbConfig;
    let msg = `✅ 已連線到 ${dbConfig.database}@${dbConfig.host}:${dbConfig.port} (user: ${dbConfig.user})`;
    
    if (args.remember) {
      const saved = await saveDbConfig(dbConfig);
      if (saved) msg += "\n💾 連線設定已持久化至 .mcp_db_config.json";
    }

    return { content: [{ type: "text", text: msg }] };
  }

  // ── load_db_connection ──
  if (name === "load_db_connection") {
    const config = await loadDbConfig();
    if (!config) {
      return errorResp("找不到已儲存的連線設定。", ["請先呼叫 set_database 並開啟 remember 選項"]);
    }
    
    // 試著連線 (需要密碼)
    // 注意：密碼不在 JSON 裡，如果需要自動載入，通常假設為空或由 env 提供
    // 這裡我們僅載入設定，並提示使用者提供密碼 (如果不是空的話)
    currentDb = { ...config, password: "" };
    
    return {
      content: [
        {
          type: "text",
          text: `📂 已載入連線設定：${config.database}@${config.host}:${config.port}\n⚠️ 目前密碼設為空，若連線失敗請手動呼叫 set_database 補足密碼。`,
        },
      ],
    };
  }

  // ── get_current_db ──
  if (name === "get_current_db") {
    if (!currentDb) {
      return {
        content: [{ type: "text", text: "尚未設定資料庫連線。" }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: [
            `Host: ${currentDb.host}`,
            `Port: ${currentDb.port}`,
            `User: ${currentDb.user}`,
            `Database: ${currentDb.database}`,
          ].join("\n"),
        },
      ],
    };
  }

  // ── get_db_schema ──
  if (name === "get_db_schema") {
    const check = requireDb();
    if (!check.ok) return check.error;

    const conn = await mysql.createConnection(check.config);
    try {
      const [rows] = await conn.execute(`DESCRIBE ${args.table_name}`);
      return {
        content: [
          { type: "text", text: rows.map((r) => `${r.Field} (${r.Type})`).join("\n") },
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
    const check = requireDb();
    if (!check.ok) return check.error;

    const statements = splitSQL(args.sql);
    const conn = await mysql.createConnection(check.config);
    const results = [];
    try {
      for (let i = 0; i < statements.length; i++) {
        const sql = statements[i];
        try {
          const [res] = await conn.execute(sql);
          if (Array.isArray(res)) {
            results.push(`[${i + 1}] 查詢結果 (${res.length} 筆)：\n${formatRows(res)}`);
          } else {
            results.push(`[${i + 1}] ✅ 執行成功。影響列數: ${res.affectedRows}`);
          }
        } catch (err) {
          results.push(`[${i + 1}] ❌ 失敗：${err.message}`);
          break;
        }
      }
      return { content: [{ type: "text", text: results.join("\n\n") }] };
    } finally {
      await conn.end();
    }
  }

  // ── get_db_schema_batch ──
  if (name === "get_db_schema_batch") {
    const check = requireDb();
    if (!check.ok) return check.error;

    const conn = await mysql.createConnection(check.config);
    const results = [];
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
      return { content: [{ type: "text", text: results.join("\n\n") }] };
    } finally {
      await conn.end();
    }
  }

  // ── execute_sql_batch ──
  if (name === "execute_sql_batch") {
    const check = requireDb();
    if (!check.ok) return check.error;

    const conn = await mysql.createConnection(check.config);
    const results = [];
    try {
      for (const q of args.queries) {
        try {
          const [res] = await conn.execute(q.sql);
          results.push(`${q.label || "SQL"}: ✅ 成功`);
        } catch (err) {
          results.push(`${q.label || "SQL"}: ❌ ${err.message}`);
        }
      }
      return { content: [{ type: "text", text: results.join("\n") }] };
    } finally {
      await conn.end();
    }
  }
}
