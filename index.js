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

// ── 動態載入工具模組 ───────────────────────────────────────
import { globSync } from "glob";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function loadToolModules() {
  // 掃描 tools/ 下的所有 .js 檔（不含 _shared/ 子目錄）
  // 使用 glob pattern: tools/**/*.js (遞迴載入分類資料夾)
  const toolFiles = globSync("tools/**/*.js", {
    cwd: __dirname,
    ignore: ["tools/_shared/**"]  // 排除 _shared 子目錄（僅供工具互相 import）
  });

  const modules = [];
  for (const file of toolFiles) {
    try {
      const module = await import(`./${file}`);
      if (module.definitions && module.handle) {
        modules.push(module);
      }
    } catch (err) {
      console.error(`⚠️  Failed to load tool module: ${file}`, err.message);
    }
  }

  return modules;
}

const TOOL_MODULES = await loadToolModules();

// ── Skills 模組 ───────────────────────────────────────────
import { definitions as skillDefinitions, getPrompt } from "./skills/index.js";

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
