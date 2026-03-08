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
    description: "執行 SQL 指令 (DDL/DML)",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
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

    const conn = await mysql.createConnection(check.config);
    try {
      const [res] = await conn.execute(args.sql);
      if (Array.isArray(res)) {
        return {
          content: [
            {
              type: "text",
              text: `查詢結果 (${res.length} 筆)：\n${JSON.stringify(res, null, 2)}`,
            },
          ],
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
      const isSyntax  = /ER_PARSE_ERROR|You have an error in your SQL/i.test(err.message);
      const isNoTable = /ER_NO_SUCH_TABLE|doesn't exist/i.test(err.message);
      const isNoCol   = /ER_BAD_FIELD_ERROR|Unknown column/i.test(err.message);
      const hints = isSyntax
        ? ["檢查 SQL 語法，特別是引號、括號、關鍵字拼寫"]
        : isNoTable
        ? ["呼叫 get_db_schema 確認資料表名稱是否存在"]
        : isNoCol
        ? ["呼叫 get_db_schema 確認欄位名稱是否正確"]
        : ["確認 SQL 語句後重試"];
      return errorResp(`SQL 執行失敗：${err.message}`, hints);
    } finally {
      await conn.end();
    }
  }
}
