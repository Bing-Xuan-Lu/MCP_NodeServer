import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Global Audit Log ──────────────────────────────────────
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const _HOME = process.env.USERPROFILE || process.env.HOME || '';
const _AUDIT_DIR  = join(_HOME, '.claude', 'logs');
const _AUDIT_FILE = join(_AUDIT_DIR, 'mcp_audit.log');

try { mkdirSync(_AUDIT_DIR, { recursive: true }); } catch (e) {}

const _KEY_PARAMS = ['file_path', 'path', 'remotePath', 'database', 'sql', 'command', 'url', 'query', 'name'];
function _summarize(args) {
  if (!args) return '';
  return _KEY_PARAMS
    .filter(k => args[k] !== undefined)
    .map(k => {
      const v = String(args[k]);
      return `${k}=${v.length > 80 ? v.slice(0, 80) + '…' : v}`;
    })
    .join(', ');
}

function _auditLog(toolName, args, status) {
  try {
    const line = `[${new Date().toISOString()}] ${toolName} | ${_summarize(args)} | ${status}\n`;
    appendFileSync(_AUDIT_FILE, line, 'utf-8');
  } catch (e) {}
}

// ── 工具模組 ──────────────────────────────────────────────
import * as filesystem    from "./tools/filesystem.js";
import * as php           from "./tools/php.js";
import * as database      from "./tools/database.js";
import * as excel         from "./tools/excel.js";
import * as bookmarks     from "./tools/bookmarks.js";
import * as skillFactory  from "./tools/skill_factory.js";
import * as sftp          from "./tools/sftp.js";
import * as python        from "./tools/python.js";
import * as word          from "./tools/word.js";
import * as pptx          from "./tools/pptx.js";
import * as pdf           from "./tools/pdf.js";
import * as fileToPrompt  from "./tools/file_to_prompt.js";
import * as rag           from "./tools/rag.js";
import * as git           from "./tools/git.js";
import * as images        from "./tools/images.js";
import * as domCompare    from "./tools/dom_compare.js";
import * as playwrightTools from "./tools/playwright_tools.js";
import * as imageDiff      from "./tools/image_diff.js";
import * as agentCoord     from "./tools/agent_coord.js";
import * as flyway         from "./tools/flyway.js";
import * as cssTools       from "./tools/css_tools.js";
import * as phpClass       from "./tools/php_class.js";

// ── Skills 模組 ───────────────────────────────────────────
import { definitions as skillDefinitions, getPrompt } from "./skills/index.js";

// ============================================
// 工具模組清單 (新增模組只需在此加一行)
// ============================================
const TOOL_MODULES = [filesystem, php, database, excel, bookmarks, skillFactory, sftp, python, word, pptx, pdf, images, fileToPrompt, rag, git, domCompare, playwrightTools, imageDiff, agentCoord, flyway, cssTools, phpClass];

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
        _auditLog(name, args, result?.isError ? 'error' : 'ok');
        return result;
      } catch (error) {
        _auditLog(name, args, `throw: ${error.message}`);
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
