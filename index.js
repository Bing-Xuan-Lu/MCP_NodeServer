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
import { HOME as _HOME } from './env.js';

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

// ── 載入工具模組（白名單 + 並行載入）─────────────────────────
// 白名單而非 glob：載入失敗時清楚知道哪個模組壞了；
// 並行 import：30 個模組同時跑比序列快很多（冷啟動加速）。
// 新增工具模組時必須在此加一行（同 CLAUDE.md「新增 MCP 工具模組」步驟）。
const TOOL_MODULE_FILES = [
  "tools/notion_blocks.js",
  "tools/browser/css_tools.js",
  "tools/browser/dom_compare.js",
  "tools/browser/playwright_tools.js",
  "tools/data/database.js",
  "tools/data/gsheet.js",
  "tools/deploy/flyway.js",
  "tools/deploy/git.js",
  "tools/deploy/php.js",
  "tools/deploy/sftp.js",
  "tools/deploy/skill_factory.js",
  "tools/file_io/cleanup.js",
  "tools/file_io/excel.js",
  "tools/file_io/filesystem.js",
  "tools/file_io/images.js",
  "tools/file_io/multi_inject.js",
  "tools/file_io/pdf.js",
  "tools/file_io/pptx.js",
  "tools/file_io/word.js",
  "tools/system/agent_coord.js",
  "tools/system/bookmarks.js",
  "tools/system/file_to_prompt.js",
  "tools/system/memory_triggers.js",
  "tools/system/php_class.js",
  "tools/system/php_symbol.js",
  "tools/system/php_text_search.js",
  "tools/system/python.js",
  "tools/utils/file_diff.js",
  "tools/utils/image_diff.js",
  "tools/utils/image_transform.js",
];

async function loadToolModules() {
  const results = await Promise.allSettled(
    TOOL_MODULE_FILES.map(file => import(`./${file}`).then(m => ({ file, m })))
  );

  const modules = [];
  const failed = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { file, m } = r.value;
      if (m.definitions && m.handle) modules.push(m);
      else failed.push({ file, error: 'missing definitions/handle export' });
    } else {
      failed.push({ file: '(unknown)', error: r.reason?.message?.split('\n')[0] || String(r.reason) });
    }
  }

  if (failed.length > 0) {
    console.error(`\n🔴 ${failed.length} tool module(s) failed to load:`);
    for (const f of failed) console.error(`   ✗ ${f.file}: ${f.error}`);
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

// ── Heartbeat：寫 ~/.claude/.mcp-alive/<server>.json，給 session-start hook 偵測 ──
try {
  const _ALIVE_DIR = join(_HOME, '.claude', '.mcp-alive');
  mkdirSync(_ALIVE_DIR, { recursive: true });
  const _ALIVE_FILE = join(_ALIVE_DIR, 'project-migration-assistant-pro.json');
  const _writeBeat = () => {
    try {
      const payload = JSON.stringify({
        server: 'project-migration-assistant-pro',
        version: '5.1.0',
        pid: process.pid,
        started_at: new Date().toISOString(),
        last_beat: Date.now(),
      });
      // writeFileSync 會更新 mtime，hook 用 mtime 判活度
      import('fs').then(({ writeFileSync }) => writeFileSync(_ALIVE_FILE, payload, 'utf-8'));
    } catch (e) {}
  };
  _writeBeat();
  setInterval(_writeBeat, 10000).unref();
} catch (e) {}
