import mysql from "mysql2/promise";

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
    description:
      "設定資料庫連線 (設定後同一次對話內的所有查詢都會使用此連線)",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "資料庫主機 (預設 127.0.0.1)" },
        port: { type: "number", description: "埠號 (預設 3306)" },
        user: { type: "string", description: "使用者名稱 (預設 root)" },
        password: { type: "string", description: "密碼" },
        database: { type: "string", description: "資料庫名稱" },
      },
      required: ["database"],
    },
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
      error: errorResp("尚未設定資料庫連線。", ["呼叫 set_database 設定連線後重試"]),
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
      const isConn = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(err.message);
      const isDb   = /Unknown database|ER_BAD_DB_ERROR/i.test(err.message);
      const hints = isAuth
        ? ["確認使用者名稱與密碼是否正確", "確認該使用者有權限存取此資料庫"]
        : isConn
        ? ["確認 host 與 port 是否正確", "確認 MySQL 服務正在執行中"]
        : isDb
        ? [`資料庫「${dbConfig.database}」不存在，確認資料庫名稱後重試`]
        : ["確認 host、port、user、password、database 後重新呼叫 set_database"];
      return errorResp(`連線失敗：${err.message}`, hints);
    } finally {
      if (conn) await conn.end();
    }

    currentDb = dbConfig;
    return {
      content: [
        {
          type: "text",
          text: `✅ 已連線到 ${dbConfig.database}@${dbConfig.host}:${dbConfig.port} (user: ${dbConfig.user})`,
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
      const isNotFound = /Table .* doesn't exist|ER_NO_SUCH_TABLE/i.test(err.message);
      return errorResp(`查詢結構失敗：${err.message}`, isNotFound
        ? [`資料表「${args.table_name}」不存在，確認資料表名稱是否正確`]
        : ["確認目前連線的資料庫是否正確（呼叫 get_current_db 確認）"]
      );
    } finally {
      await conn.end();
    }
  }

  // ── execute_sql ──
  if (name === "execute_sql") {
    const check = requireDb();
    if (!check.ok) return check.error;

    // 拆分多條 SQL（以分號分隔，忽略字串內的分號）
    const statements = splitSQL(args.sql);

    // 單條：維持原邏輯
    if (statements.length <= 1) {
      const sql = statements[0] || args.sql.trim();
      const conn = await mysql.createConnection(check.config);
      try {
        const [res] = await conn.execute(sql);
        if (Array.isArray(res)) {
          return {
            content: [{ type: "text", text: `查詢結果 (${res.length} 筆)：\n${formatRows(res)}` }],
          };
        } else {
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
        return errorResp(`SQL 執行失敗：${err.message}`, sqlErrorHints(err));
      } finally {
        await conn.end();
      }
    }

    // 多條：逐條執行，收集結果
    const conn = await mysql.createConnection(check.config);
    const results = [];
    let successCount = 0;
    let failCount = 0;
    try {
      for (let i = 0; i < statements.length; i++) {
        const sql = statements[i];
        const label = `[${i + 1}/${statements.length}]`;
        try {
          const [res] = await conn.execute(sql);
          successCount++;
          const preview = sql.substring(0, 60) + (sql.length > 60 ? "…" : "");
          if (Array.isArray(res)) {
            results.push(`${label} ✅ ${res.length} 筆 ← ${preview}`);
          } else {
            results.push(`${label} ✅ 影響 ${res.affectedRows} 列 ← ${preview}`);
          }
        } catch (err) {
          failCount++;
          results.push(`${label} ❌ ${err.message}\n  ${sql.substring(0, 80)}`);
          if (i < statements.length - 1) {
            results.push(`⚠️ 因第 ${i + 1} 條失敗，已跳過剩餘 ${statements.length - i - 1} 條語句`);
          }
          break;
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `批次執行結果（共 ${statements.length} 條，成功 ${successCount}，失敗 ${failCount}）：\n\n${results.join('\n\n')}`,
          },
        ],
      };
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
          const cols = rows.map((r) => `  ${r.Field} (${r.Type})${r.Key === "PRI" ? " [PK]" : ""}${r.Extra ? ` ${r.Extra}` : ""}`);
          results.push(`📋 ${table}（${rows.length} 欄）:\n${cols.join("\n")}`);
        } catch (err) {
          results.push(`❌ ${table}：${err.message}`);
        }
      }
      return {
        content: [{ type: "text", text: results.join("\n\n") }],
      };
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
    let successCount = 0;
    let failCount = 0;

    try {
      for (let i = 0; i < args.queries.length; i++) {
        const q = args.queries[i];
        const label = q.label || `Query ${i + 1}`;
        const tag = `[${i + 1}/${args.queries.length}] ${label}`;
        try {
          const [res] = await conn.execute(q.sql);
          successCount++;
          if (Array.isArray(res)) {
            results.push(`${tag} ✅ ${res.length} 筆\n${formatRows(res)}`);
          } else {
            results.push(`${tag} ✅ 影響 ${res.affectedRows} 列${res.insertId ? `，ID: ${res.insertId}` : ""}`);
          }
        } catch (err) {
          failCount++;
          results.push(`${tag} ❌ ${err.message}\n  ${q.sql.substring(0, 80)}`);
          // 不中斷：批次模式各查詢獨立，繼續執行下一條
        }
      }
      return {
        content: [{
          type: "text",
          text: `批次結果（${args.queries.length} 條，✅${successCount} ❌${failCount}）：\n\n${results.join("\n\n---\n\n")}`,
        }],
      };
    } finally {
      await conn.end();
    }
  }
}
