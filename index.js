import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── 工具模組 ──────────────────────────────────────────────
import * as filesystem from "./tools/filesystem.js";
import * as php        from "./tools/php.js";
import * as database   from "./tools/database.js";
import * as excel      from "./tools/excel.js";
import * as bookmarks  from "./tools/bookmarks.js";

// ── Skills 模組 ───────────────────────────────────────────
import { definitions as skillDefinitions, getPrompt } from "./skills/index.js";

// ============================================
// 工具模組清單 (新增模組只需在此加一行)
// ============================================
const TOOL_MODULES = [filesystem, php, database, excel, bookmarks];

// ============================================
// MCP Server 初始化
// ============================================
const server = new Server(
  { name: "project-migration-assistant-pro", version: "5.1.0" },
  { capabilities: { tools: {}, prompts: {} } },
);

// ── 工具清單 ──────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_MODULES.flatMap((m) => m.definitions),
}));

// ── 工具呼叫路由 ──────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  for (const mod of TOOL_MODULES) {
    const isDefined = mod.definitions.some((d) => d.name === name);
    if (isDefined) {
      try {
        const result = await mod.handle(name, args);
        return result;
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `MCP Error: ${error.message}` }],
        };
      }
    }
  }

  return {
    isError: true,
    content: [{ type: "text", text: `未知的工具: ${name}` }],
  };
});

// ── Skills (Prompts) ──────────────────────────────────────
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: skillDefinitions,
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  return getPrompt(request.params.name, request.params.arguments || {});
});

// ============================================
// 啟動
// ============================================
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ MCP Server v5.1.0 Started.");
