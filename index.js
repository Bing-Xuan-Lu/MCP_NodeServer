import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";
import fs from "fs/promises";
import path from "path";

// 1. 初始化 Server
const server = new Server({
  name: "full-stack-php-builder",
  version: "2.0.0",
}, {
  capabilities: { tools: {} },
});

const basePath = "D:\\Develop";
const dbConfig = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',      
  password: '',      
  database: ''  
};

// 2. 定義工具清單
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_files",
      description: "列出目錄下的檔案，幫助理解專案結構",
      inputSchema: {
        type: "object",
        properties: {
          relative_path: { type: "string", description: "要查看的目錄路徑" }
        },
        required: ["relative_path"]
      }
    },
    {
      name: "read_file",
      description: "讀取檔案內容",
      inputSchema: {
        type: "object",
        properties: {
          relative_path: { type: "string", description: "檔案相對路徑" }
        },
        required: ["relative_path"],
      },
    },
    {
      name: "create_file",
      description: "建立新檔案並寫入內容 (用於新建 PHP, CSS, JS)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "新檔案路徑" },
          content: { type: "string", description: "檔案原始碼" }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "apply_diff",
      description: "修改現有檔案 (Search & Replace 模式)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          search: { type: "string", description: "舊代碼片段" },
          replace: { type: "string", description: "新代碼片段" }
        },
        required: ["path", "search", "replace"]
      }
    },
    {
      name: "get_db_schema",
      description: "查看資料表結構",
      inputSchema: {
        type: "object",
        properties: {
          table_name: { type: "string" }
        },
        required: ["table_name"],
      },
    },
    {
      name: "execute_sql",
      description: "執行 SQL 修改資料庫 (CREATE TABLE, ALTER TABLE 等)",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string" }
        },
        required: ["sql"],
      },
    }
  ],
}));

// 3. 實作工具邏輯
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // --- [檔案類工具] ---
    if (name === "list_files") {
      const fullPath = path.join(basePath, args.relative_path);
      const files = await fs.readdir(fullPath);
      return { content: [{ type: "text", text: files.join("\n") }] };
    }

    if (name === "read_file") {
      const fullPath = path.join(basePath, args.relative_path);
      const content = await fs.readFile(fullPath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    }

    if (name === "create_file") {
      const fullPath = path.join(basePath, args.path);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, args.content, "utf-8");
      return { content: [{ type: "text", text: `✅ 檔案已建立: ${args.path}` }] };
    }

    if (name === "apply_diff") {
      const fullPath = path.join(basePath, args.path);
      const content = await fs.readFile(fullPath, "utf-8");
      if (!content.includes(args.search)) {
        throw new Error("找不到匹配的 search 代碼區塊");
      }
      const updated = content.replace(args.search, args.replace);
      await fs.writeFile(fullPath, updated, "utf-8");
      return { content: [{ type: "text", text: `✅ 檔案已更新: ${args.path}` }] };
    }

    // --- [資料庫類工具] ---
    if (name === "get_db_schema") {
      const connection = await mysql.createConnection(dbConfig);
      const [rows] = await connection.execute(`DESCRIBE ${args.table_name}`);
      await connection.end();
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }

    if (name === "execute_sql") {
      const connection = await mysql.createConnection(dbConfig);
      const [result] = await connection.execute(args.sql);
      await connection.end();
      return { content: [{ type: "text", text: `✅ SQL 執行成功。影響列數: ${result.affectedRows || 0}` }] };
    }

  } catch (error) {
    return { isError: true, content: [{ type: "text", text: `錯誤: ${error.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);