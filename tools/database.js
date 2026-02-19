import mysql from "mysql2/promise";
import { CONFIG } from "../config.js";

// ============================================
// 工具定義
// ============================================
export const definitions = [
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
// 工具邏輯
// ============================================
export async function handle(name, args) {
  if (name === "get_db_schema") {
    const conn = await mysql.createConnection(CONFIG.db);
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

  if (name === "execute_sql") {
    const conn = await mysql.createConnection(CONFIG.db);
    try {
      const [res] = await conn.execute(args.sql);
      if (Array.isArray(res)) {
        return {
          content: [
            {
              type: "text",
              text: `🔍 查詢結果 (${res.length} 筆)：\n${JSON.stringify(res, null, 2)}`,
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
