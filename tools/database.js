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
// 內部：取得連線設定，未設定時回傳錯誤
// ============================================
function requireDb() {
  if (!currentDb) {
    return {
      ok: false,
      error: {
        isError: true,
        content: [
          {
            type: "text",
            text: "尚未設定資料庫連線，請先呼叫 set_database 設定連線。",
          },
        ],
      },
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
      return {
        isError: true,
        content: [{ type: "text", text: `連線失敗: ${err.message}` }],
      };
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
      return { isError: true, content: [{ type: "text", text: `SQL 錯誤: ${err.message}` }] };
    } finally {
      await conn.end();
    }
  }
}
