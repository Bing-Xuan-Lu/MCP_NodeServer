import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";
import fs from "fs/promises";
import path from "path";
import 'dotenv/config'; // 讀取 .env 或 settings.json 傳入的環境變數

/**
 * 專案遷移與開發助手 MCP Server (整合版)
 */

// 1. 初始化 Server
const server = new Server({
  name: "project-migration-assistant",
  version: "2.1.0",
}, {
  capabilities: { tools: {} },
});

// --- 設定區 (優先讀取環境變數，否則使用預設值) ---
const CONFIG = {
  basePath: process.env.BASE_PROJECT_PATH || "D:\\Project",
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'pnsdb'
  }
};

// --- 輔助函式：路徑安全解析 ---
// 確保 Agent 傳入的路徑不會跑出 basePath 之外
function resolveSecurePath(userPath) {
  const targetPath = path.resolve(CONFIG.basePath, userPath);
  if (!targetPath.startsWith(CONFIG.basePath)) {
    throw new Error(`安全限制：禁止存取專案目錄以外的路徑 (${targetPath})`);
  }
  return targetPath;
}

// 2. 定義工具清單
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_files",
      description: "列出指定目錄下的所有檔案與資料夾，用於了解專案結構",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "相對路徑 (例如 '.' 或 'PG_Milestone_ERP')" }
        },
        required: ["path"]
      }
    },
    {
      name: "read_file",
      description: "讀取檔案內容",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "相對路徑" }
        },
        required: ["path"],
      },
    },
    {
      name: "create_file",
      description: "建立新檔案 (如果檔案已存在會直接覆蓋)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "相對路徑" },
          content: { type: "string", description: "檔案內容" }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "apply_diff",
      description: "使用 Search & Replace 模式修改檔案 (支援 VS Code Diff 預覽)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "相對路徑" },
          search: { type: "string", description: "原始代碼片段 (必須完全匹配)" },
          replace: { type: "string", description: "新代碼片段" }
        },
        required: ["path", "search", "replace"]
      }
    },
    {
      name: "get_db_schema",
      description: "查看資料表結構 (DESCRIBE)",
      inputSchema: {
        type: "object",
        properties: {
          table_name: { type: "string", description: "資料表名稱" }
        },
        required: ["table_name"],
      },
    },
    {
      name: "execute_sql",
      description: "執行 SQL 指令 (DDL/DML)",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "要執行的 SQL 指令" }
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
    // --- 檔案操作類 ---
    
    if (name === "list_files") {
      const fullPath = resolveSecurePath(args.path || ".");
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const list = entries.map(e => e.isDirectory() ? `[DIR]  ${e.name}` : `[FILE] ${e.name}`).join("\n");
      return { content: [{ type: "text", text: `目錄 ${args.path} 內容：\n${list}` }] };
    }

    if (name === "read_file") {
      // 兼容 args.relative_path 與 args.path
      const p = args.path || args.relative_path;
      const fullPath = resolveSecurePath(p);
      const content = await fs.readFile(fullPath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    }

    if (name === "create_file") {
      const fullPath = resolveSecurePath(args.path);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, args.content, "utf-8");
      return { content: [{ type: "text", text: `✅ 成功建立檔案：${args.path}` }] };
    }

    if (name === "apply_diff") {
      const fullPath = resolveSecurePath(args.path);
      const content = await fs.readFile(fullPath, "utf-8");

      if (!content.includes(args.search)) {
        // 提供部分內容幫助 Debug
        const snippet = content.substring(0, 200) + "..."; 
        return {
          isError: true,
          content: [{ type: "text", text: `❌ 比對失敗：找不到指定的 search 區塊。\n請確保空白與換行完全一致。\n檔案開頭預覽：\n${snippet}` }]
        };
      }

      const updatedContent = content.replace(args.search, args.replace);
      await fs.writeFile(fullPath, updatedContent, "utf-8");
      return { content: [{ type: "text", text: `✅ 檔案已更新 (Diff Applied)：${args.path}` }] };
    }

    // --- 資料庫操作類 ---

    if (name === "get_db_schema") {
      const connection = await mysql.createConnection(CONFIG.db);
      try {
        const [rows] = await connection.execute(`DESCRIBE ${args.table_name}`);
        const schemaText = rows.map(r => `${r.Field} (${r.Type}) - Null: ${r.Null}, Key: ${r.Key}`).join("\n");
        return { content: [{ type: "text", text: `資料表 [${args.table_name}] 結構：\n${schemaText}` }] };
      } finally {
        await connection.end();
      }
    }

    if (name === "execute_sql") {
      const connection = await mysql.createConnection(CONFIG.db);
      try {
        const [result] = await connection.execute(args.sql);
        return { 
          content: [{ 
            type: "text", 
            text: `✅ SQL 執行成功。\n影響列數: ${result.affectedRows || 0}\n訊息: ${result.info || '無'}` 
          }] 
        };
      } finally {
        await connection.end();
      }
    }

  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: `MCP 錯誤: ${error.message}` }]
    };
  }
});

// 4. 啟動 Server
const transport = new StdioServerTransport();
await server.connect(transport);
