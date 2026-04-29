import mysql from "mysql2/promise";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { validateArgs, normalizeArrayArg } from "../_shared/utils.js";
import { resolveSecurePath } from "../../config.js";

const pExecFile = promisify(execFile);

// ============================================
// docker_exec / ssh+docker_exec 連線：包裝 mysql CLI 為 mysql2-相容介面
// 用於容器內 DB 不對外開 port、需透過 docker exec 才能查詢的場景
// ============================================
const READONLY_RE = /^\s*(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN|WITH)\b/i;

function parseMysqlBatchOutput(stdout) {
  // mysql --batch 輸出：第一行為欄位名（tab 分隔），後續為資料列
  // NULL 顯示為字串 "NULL"
  if (!stdout || !stdout.trim()) return [[], []];
  const lines = stdout.replace(/\r\n/g, "\n").split("\n");
  // 移除尾端空行
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return [[], []];
  const headers = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => {
    const vals = line.split("\t");
    const row = {};
    headers.forEach((h, i) => {
      const v = vals[i];
      row[h] = v === "NULL" ? null : v === undefined ? null : v;
    });
    return row;
  });
  const fields = headers.map((name) => ({ name }));
  return [rows, fields];
}

async function dockerExecRawQuery(config, sql) {
  // 預設僅唯讀；config.allow_write=true 時放行寫入語句
  // checkDangerousStmt + confirm 機制仍會在 execute_sql 入口把關 DELETE/UPDATE/DROP/TRUNCATE
  if (!READONLY_RE.test(sql) && !config.allow_write) {
    throw new Error(
      `docker_exec 模式預設僅唯讀。` +
      `要執行寫入（INSERT/ALTER/CREATE 等）請在 set_database 加 allow_write: true。收到語句：${sql.slice(0, 80)}`
    );
  }
  const { container, db_user = "root", db_password = "", database = "" } = config;
  if (!container) throw new Error(`docker_exec 模式需要 container 欄位（容器名稱）`);

  const mysqlArgs = [
    "exec", "-i", container, "mysql", "--batch", "--default-character-set=utf8mb4",
    `-u${db_user}`,
  ];
  if (db_password) mysqlArgs.push(`-p${db_password}`);
  if (database) mysqlArgs.push(database);
  mysqlArgs.push("-e", sql);

  let cmd, args;
  if (config.ssh_host) {
    // 透過 SSH 中繼：ssh user@host docker exec ...
    // 使用陣列參數避免 shell injection；遠端命令需要 shell quoting
    const target = config.ssh_user ? `${config.ssh_user}@${config.ssh_host}` : config.ssh_host;
    // 把 docker exec 命令組合成單一字串給遠端 shell
    const remoteCmd = ["docker"]
      .concat(mysqlArgs)
      .map((a) => `'${String(a).replace(/'/g, "'\\''")}'`)
      .join(" ");
    cmd = "ssh";
    args = ["-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes"];
    if (config.ssh_port) args.push("-p", String(config.ssh_port));
    args.push(target, remoteCmd);
  } else {
    cmd = "docker";
    args = mysqlArgs;
  }

  try {
    const { stdout } = await pExecFile(cmd, args, { maxBuffer: 50 * 1024 * 1024 });
    return parseMysqlBatchOutput(stdout);
  } catch (err) {
    const stderr = err.stderr || err.message;
    throw new Error(`docker_exec 執行失敗：${stderr.slice(0, 500)}`);
  }
}

/** 回傳 mysql2.Connection 介面相容物件，根據 connection_type 切換實作 */
async function getQueryRunner(config) {
  if (config.connection_type === "docker_exec") {
    return {
      _dockerExec: true,
      query: async (sql) => dockerExecRawQuery(config, sql),
      execute: async (sql) => dockerExecRawQuery(config, sql),
      ping: async () => { await dockerExecRawQuery(config, "SELECT 1"); },
      end: async () => {},
    };
  }
  // 過濾 docker_exec 專屬欄位，避免污染 mysql2 設定
  const { connection_type, container, db_user, db_password, ssh_host, ssh_user, ssh_port, ...mysqlConfig } = config;
  return await mysql.createConnection(mysqlConfig);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_CONFIG_FILE = path.join(__dirname, "..", ".mcp_db_config.json");
const AUDIT_LOG = path.join(__dirname, "..", "..", "Project", "_mcp_audit.log");

// ============================================
// 防 Reward Hacking：危險語句檢查 + Audit Log
// ============================================

// 判斷單條 SQL 是否危險，回傳 null（安全）或 { block, reason }
function checkDangerousStmt(sql) {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase().replace(/\s+/g, " ");
  const keyword = upper.match(/^(DELETE|UPDATE|DROP|TRUNCATE)\b/)?.[1];
  if (!keyword) return null; // SELECT / INSERT / CREATE / ALTER / SHOW 等 → 安全

  // 例外：測試清理（MCP_TEST_ 標記是 php_crud_test.md 定義的正式清理 pattern）
  if (keyword === "DELETE" && trimmed.toUpperCase().includes("MCP_TEST_")) return null;

  // 硬性封鎖：DELETE / UPDATE 無 WHERE（幾乎不可能是故意的）
  if ((keyword === "DELETE" || keyword === "UPDATE") && !upper.includes(" WHERE ")) {
    return { block: true, reason: `${keyword} 無 WHERE 條件，可能影響整張表` };
  }

  // 軟性閘門（需 confirm: true）
  return {
    block: false,
    reason: `${keyword} 可能修改/刪除業務資料，需加 confirm: true 確認`,
  };
}

// 將非 SELECT 語句寫入 append-only audit log
async function auditSQL(sql, dbName) {
  try {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${dbName || "?"}] ${sql.replace(/\s+/g, " ").slice(0, 500)}\n`;
    await fs.appendFile(AUDIT_LOG, line, "utf-8");
  } catch {
    // audit 失敗不影響主流程
  }
}

// ============================================
// 記憶體狀態：多連線管理
// ============================================
const dbPool = new Map();  // key = database name, value = config object
let defaultDb = null;      // 最後一次 set_database 的 database name

// 啟動時自動載入已儲存的連線設定（密碼為空，需免密或手動補足）
try {
  const raw = JSON.parse(await fs.readFile(DB_CONFIG_FILE, "utf-8"));

  // 新格式：{ default, connections: { name: config } }
  if (raw && raw.connections && typeof raw.connections === "object") {
    for (const [name, config] of Object.entries(raw.connections)) {
      dbPool.set(name, { password: "", ...config });
    }
    defaultDb = raw.default || null;
    if (defaultDb && !dbPool.has(defaultDb)) defaultDb = dbPool.keys().next().value || null;
    console.error(`[database] 自動載入 ${dbPool.size} 個連線，預設：${defaultDb || "無"}`);
  }
  // 舊格式相容：單一物件 { host, port, user, database }
  else if (raw && raw.database) {
    dbPool.set(raw.database, { password: "", ...raw });
    defaultDb = raw.database;
    console.error(`[database] 自動載入連線（舊格式遷移）: ${raw.database}@${raw.host || "127.0.0.1"}:${raw.port || 3306}`);
  }
} catch {
  // 無設定檔或格式錯誤，略過
}

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "set_database",
    description: "設定資料庫連線。支援多連線：不同 database 各自儲存，最後設定的為預設連線。\n" +
      "兩種模式：\n" +
      "  1. 直連（預設）：填 host/port/user/password/database\n" +
      "  2. docker_exec（容器內 DB 不對外 port）：填 connection_type=\"docker_exec\" + container + db_user + db_password + database；可選 ssh_host/ssh_user/ssh_port 透過 SSH 中繼。預設僅唯讀（SELECT/SHOW/DESCRIBE/EXPLAIN/WITH），要執行 INSERT/ALTER/CREATE 等寫入語句請加 allow_write: true（DELETE/UPDATE/DROP/TRUNCATE 仍需 confirm: true）。",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "資料庫主機（直連模式）", default: "127.0.0.1" },
        port: { type: "number", description: "埠號（直連模式）", default: 3306 },
        user: { type: "string", description: "使用者名稱（直連模式）", default: "root" },
        password: { type: "string", description: "密碼（直連模式）" },
        database: { type: "string", description: "資料庫名稱" },
        remember: { type: "boolean", description: "是否記住此連線設定（密碼除外）供下次自動載入" },
        connection_type: {
          type: "string",
          enum: ["direct", "docker_exec"],
          description: "連線模式：direct（預設，host+port）或 docker_exec（透過 docker exec mysql CLI）。docker_exec 預設僅唯讀，要寫入需加 allow_write: true",
          default: "direct",
        },
        container: { type: "string", description: "docker_exec 模式：mysql 容器名稱" },
        db_user: { type: "string", description: "docker_exec 模式：DB 使用者名稱（預設 root）" },
        db_password: { type: "string", description: "docker_exec 模式：DB 密碼" },
        ssh_host: { type: "string", description: "docker_exec 模式：SSH 主機（選填，啟用 SSH 中繼）" },
        ssh_user: { type: "string", description: "docker_exec 模式：SSH 使用者" },
        ssh_port: { type: "number", description: "docker_exec 模式：SSH 埠（預設 22）" },
        allow_write: { type: "boolean", description: "docker_exec 模式：放行 INSERT/UPDATE/DELETE/CREATE/ALTER 等寫入語句（DELETE/UPDATE/DROP/TRUNCATE 仍受 checkDangerousStmt + confirm 把關）。預設 false。", default: false },
      },
      required: ["database"],
    },
  },
  {
    name: "load_db_connection",
    description: "從本地設定檔載入上次記住的資料庫連線設定",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_current_db",
    description: "查看目前所有已設定的資料庫連線（含預設標記）",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_db_schema",
    description: "查看資料表結構",
    inputSchema: {
      type: "object",
      properties: {
        table_name: { type: "string" },
        database: { type: "string", description: "指定資料庫名稱（不傳則用預設連線）" },
      },
      required: ["table_name"],
    },
  },
  {
    name: "execute_sql",
    description: "執行 SQL 指令 (DDL/DML)，支援多條語句以分號分隔、逐條執行。可用 sql（字串）或 file（讀取本機 SQL 檔）擇一傳入。DELETE/UPDATE/DROP/TRUNCATE 需加 confirm: true。可指定 database 切換連線。",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL 字串（與 file 擇一）" },
        file: { type: "string", description: "SQL 檔案路徑（相對 basePath 或絕對路徑，與 sql 擇一）" },
        database: { type: "string", description: "指定資料庫名稱（不傳則用預設連線）" },
        confirm: {
          type: "boolean",
          description: "對 DELETE/UPDATE/DROP/TRUNCATE 必須明確傳 true，表示已確認操作不是為了規避測試失敗",
        },
      },
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
        database: { type: "string", description: "指定資料庫名稱（不傳則用預設連線）" },
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
        database: { type: "string", description: "指定資料庫名稱（不傳則用預設連線）" },
        confirm: {
          type: "boolean",
          description: "批次中含 DELETE/UPDATE/DROP/TRUNCATE 時必須傳 true",
        },
      },
      required: ["queries"],
    },
  },
  {
    name: "mysql_log_tail",
    description: "MySQL 錯誤殘留檢查 / general_log 監控。action=recent_errors 預設：從 performance_schema.events_statements_history_long 撈最近失敗 SQL（含 ER_* 錯誤碼），免設定即可用。enable_general_log/disable_general_log 切換 general_log（output 設為 TABLE）。tail_general_log 讀 mysql.general_log 最近 N 筆。需要對應權限。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["recent_errors", "enable_general_log", "disable_general_log", "tail_general_log"],
          description: "操作類型",
          default: "recent_errors",
        },
        database: { type: "string", description: "指定資料庫連線（不傳則用預設）" },
        limit: { type: "number", description: "回傳筆數上限", default: 50 },
        since_minutes: { type: "number", description: "recent_errors / tail_general_log 回看分鐘數", default: 30 },
      },
    },
  },
  {
    name: "schema_diff",
    description: "比對兩個資料庫的資料表欄位差異（TYPE / IS_NULLABLE / DEFAULT / KEY / EXTRA / COMMENT）。輸入 source_db / target_db 連線名稱與 table_pattern（支援 LIKE），回傳欄位級對照表，免手刻 information_schema query。",
    inputSchema: {
      type: "object",
      properties: {
        source_db: { type: "string", description: "來源資料庫連線名稱（需先 set_database）" },
        target_db: { type: "string", description: "目標資料庫連線名稱（需先 set_database）" },
        table_pattern: { type: "string", description: "資料表 LIKE pattern，例如 tbl_project_allmono% 或 % 代表全部", default: "%" },
        ignore: {
          type: "array",
          items: { type: "string", enum: ["COMMENT", "DEFAULT", "EXTRA", "KEY"] },
          description: "忽略的比對欄位（預設全比）",
        },
      },
      required: ["source_db", "target_db"],
    },
  },
];

// ============================================
// 內部：保存連線設定 (不含密碼，多連線格式)
// ============================================
async function saveAllDbConfigs() {
  try {
    const connections = {};
    for (const [name, config] of dbPool.entries()) {
      const { password, ...safeConfig } = config;
      connections[name] = safeConfig;
    }
    const data = { default: defaultDb, connections };
    await fs.writeFile(DB_CONFIG_FILE, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ============================================
// 內部：讀取連線設定
// ============================================
async function loadDbConfig() {
  try {
    const raw = JSON.parse(await fs.readFile(DB_CONFIG_FILE, "utf-8"));
    // 新格式
    if (raw && raw.connections && typeof raw.connections === "object") {
      return raw;
    }
    // 舊格式 → 轉換
    if (raw && raw.database) {
      return { default: raw.database, connections: { [raw.database]: raw } };
    }
    return null;
  } catch {
    return null;
  }
}

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
function requireDb(database) {
  const key = database || defaultDb;
  if (!key || !dbPool.has(key)) {
    const available = dbPool.size > 0
      ? `可用連線：${[...dbPool.keys()].join(", ")}`
      : "";
    return {
      ok: false,
      error: errorResp(
        database
          ? `找不到資料庫 "${database}" 的連線設定。${available}`
          : `尚未設定資料庫連線。`,
        ["呼叫 set_database 設定連線或 load_db_connection 載入設定後重試"]
      ),
    };
  }
  return { ok: true, config: dbPool.get(key) };
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
// 內部：彙總 SQL 錯誤碼（用於批次執行後的錯誤摘要）
// ============================================
function summarizeSqlErrors(errorCodes) {
  if (!errorCodes.length) return "";
  const counts = new Map();
  for (const code of errorCodes) {
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c} x${n}`);
  return `🚨 SQL 錯誤摘要：${errorCodes.length} 條失敗 [${parts.join(", ")}]\n`;
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
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  // ── set_database ──
  if (name === "set_database") {
    const isDockerExec = args.connection_type === "docker_exec";
    const dbConfig = isDockerExec
      ? {
          connection_type: "docker_exec",
          database: args.database,
          container: args.container,
          db_user: args.db_user || "root",
          db_password: args.db_password || "",
          ssh_host: args.ssh_host,
          ssh_user: args.ssh_user,
          ssh_port: args.ssh_port,
          allow_write: args.allow_write === true,
        }
      : {
          host: args.host,
          port: args.port,
          user: args.user,
          password: args.password || "",
          database: args.database,
        };

    if (isDockerExec && !dbConfig.container) {
      return errorResp(`docker_exec 模式需要 container 欄位（容器名稱）。`, ["填入 container 參數後重試"]);
    }

    // 測試連線
    let conn;
    try {
      conn = await getQueryRunner(dbConfig);
      await conn.ping();
    } catch (err) {
      const isAuth = /Access denied|ER_ACCESS_DENIED/i.test(err.message);
      const hints = isAuth
        ? ["確認使用者名稱與密碼是否正確"]
        : isDockerExec
        ? ["確認 container 名稱、SSH 連線、容器內 mysql CLI 可用"]
        : ["確認 host、port、database 是否正確"];
      return errorResp(`連線失敗：${err.message}`, hints);
    } finally {
      if (conn) await conn.end();
    }

    dbPool.set(dbConfig.database, dbConfig);
    defaultDb = dbConfig.database;

    const target = isDockerExec
      ? `docker:${dbConfig.container}${dbConfig.ssh_host ? `@${dbConfig.ssh_host}` : ""}`
      : `${dbConfig.host}:${dbConfig.port}`;
    const userField = isDockerExec ? dbConfig.db_user : dbConfig.user;
    let msg = `✅ 已連線到 ${dbConfig.database}@${target} (user: ${userField})`;
    if (isDockerExec) {
      msg += dbConfig.allow_write
        ? `\n🐳 docker_exec 模式（allow_write: true）：寫入語句已放行；DELETE/UPDATE/DROP/TRUNCATE 仍需 confirm: true`
        : `\n🐳 docker_exec 模式：僅唯讀（SELECT/SHOW/DESCRIBE/EXPLAIN/WITH）。需寫入請加 allow_write: true 重新 set_database`;
    }
    if (dbPool.size > 1) {
      msg += `\n📊 目前共 ${dbPool.size} 個連線：${[...dbPool.keys()].join(", ")}（預設：${defaultDb}）`;
    }

    if (args.remember) {
      const saved = await saveAllDbConfigs();
      if (saved) msg += "\n💾 連線設定已持久化至 .mcp_db_config.json";
    }

    return { content: [{ type: "text", text: msg }] };
  }

  // ── load_db_connection ──
  if (name === "load_db_connection") {
    const data = await loadDbConfig();
    if (!data) {
      return errorResp("找不到已儲存的連線設定。", ["請先呼叫 set_database 並開啟 remember 選項"]);
    }

    let loaded = 0;
    for (const [name, config] of Object.entries(data.connections)) {
      if (!dbPool.has(name)) {
        dbPool.set(name, { ...config, password: "" });
        loaded++;
      }
    }
    if (data.default && dbPool.has(data.default)) {
      defaultDb = data.default;
    }

    return {
      content: [
        {
          type: "text",
          text: `📂 已載入 ${loaded} 個新連線（共 ${dbPool.size} 個）：${[...dbPool.keys()].join(", ")}（預設：${defaultDb || "無"}）\n⚠️ 密碼為空，若連線失敗請手動呼叫 set_database 補足密碼。`,
        },
      ],
    };
  }

  // ── get_current_db ──
  if (name === "get_current_db") {
    if (dbPool.size === 0) {
      return {
        content: [{ type: "text", text: "尚未設定任何資料庫連線。" }],
      };
    }
    const lines = [];
    for (const [name, config] of dbPool.entries()) {
      const marker = name === defaultDb ? " ← 預設" : "";
      lines.push(`${name}: ${config.host}:${config.port} (user: ${config.user})${marker}`);
    }
    return {
      content: [
        {
          type: "text",
          text: `📊 已設定 ${dbPool.size} 個連線：\n${lines.join("\n")}`,
        },
      ],
    };
  }

  // ── get_db_schema ──
  if (name === "get_db_schema") {
    const check = requireDb(args.database);
    if (!check.ok) return check.error;

    const conn = await getQueryRunner(check.config);
    try {
      const [rows] = await conn.execute(`DESCRIBE ${args.table_name}`);
      return {
        content: [
          { type: "text", text: `[${check.config.database}] ${args.table_name}:\n` + rows.map((r) => `${r.Field} (${r.Type})`).join("\n") },
        ],
      };
    } catch (err) {
      return errorResp(`查詢結構失敗：${err.message}`);
    } finally {
      await conn.end();
    }
  }

  // ── execute_sql ──
  if (name === "execute_sql") {
    const check = requireDb(args.database);
    if (!check.ok) return check.error;

    let sqlText = args.sql;
    if (!sqlText && args.file) {
      try {
        const fullPath = path.isAbsolute(args.file) ? args.file : resolveSecurePath(args.file);
        sqlText = await fs.readFile(fullPath, "utf-8");
      } catch (err) {
        return errorResp(`讀取 SQL 檔失敗：${err.message}`, ["確認檔案路徑正確，或授權該路徑（grant_path_access）"]);
      }
    }
    if (!sqlText) return errorResp("需傳入 sql 或 file 參數");

    const statements = splitSQL(sqlText);

    // 危險語句預檢
    const dangerList = [];
    for (const sql of statements) {
      const d = checkDangerousStmt(sql);
      if (d) dangerList.push({ sql: sql.slice(0, 120), ...d });
    }
    const blocked = dangerList.filter((d) => d.block);
    const needConfirm = dangerList.filter((d) => !d.block);
    if (blocked.length > 0) {
      return {
        isError: true,
        content: [{ type: "text", text: `⛔ 封鎖 ${blocked.length} 條危險語句：\n${blocked.map((d) => `  • ${d.reason}：${d.sql}`).join("\n")}` }],
      };
    }
    if (needConfirm.length > 0 && !args.confirm) {
      return {
        isError: true,
        content: [{ type: "text", text: `⚠️ 以下語句需加 confirm: true 才能執行（防止誤刪業務資料）：\n${needConfirm.map((d) => `  • ${d.reason}：${d.sql}`).join("\n")}` }],
      };
    }

    const conn = await getQueryRunner(check.config);
    const results = [];
    const errorCodes = [];
    const dbLabel = check.config.database;
    try {
      for (let i = 0; i < statements.length; i++) {
        const sql = statements[i];
        try {
          const [res] = await conn.execute(sql);
          if (Array.isArray(res)) {
            results.push(`[${i + 1}] 查詢結果 (${res.length} 筆)：\n${formatRows(res)}`);
          } else {
            // 非 SELECT 寫入 audit log
            const upper = sql.trim().toUpperCase();
            if (!upper.startsWith("SELECT") && !upper.startsWith("SHOW") && !upper.startsWith("DESCRIBE")) {
              await auditSQL(sql, dbLabel);
            }
            results.push(`[${i + 1}] ✅ 執行成功。影響列數: ${res.affectedRows}`);
          }
        } catch (err) {
          const code = err.code ? ` [${err.code}]` : "";
          const sqlState = err.sqlState ? ` (SQLSTATE ${err.sqlState})` : "";
          if (err.code) errorCodes.push(err.code);
          results.push(`[${i + 1}] ❌ 失敗${code}${sqlState}：${err.message}`);
          break;
        }
      }
      const header = dbPool.size > 1 ? `🗄️ [${dbLabel}]\n` : "";
      const summary = summarizeSqlErrors(errorCodes);
      return { content: [{ type: "text", text: summary + header + results.join("\n\n") }] };
    } finally {
      await conn.end();
    }
  }

  // ── get_db_schema_batch ──
  if (name === "get_db_schema_batch") {
    const check = requireDb(args.database);
    if (!check.ok) return check.error;

    const conn = await getQueryRunner(check.config);
    const results = [];
    const dbLabel = check.config.database;
    try {
      for (const table of args.table_names) {
        try {
          const [rows] = await conn.execute(`DESCRIBE \`${table}\``);
          const cols = rows.map((r) => `  ${r.Field} (${r.Type})`);
          results.push(`📋 ${table}:\n${cols.join("\n")}`);
        } catch (err) {
          results.push(`❌ ${table}：${err.message}`);
        }
      }
      const header = dbPool.size > 1 ? `🗄️ [${dbLabel}]\n` : "";
      return { content: [{ type: "text", text: header + results.join("\n\n") }] };
    } finally {
      await conn.end();
    }
  }

  // ── execute_sql_batch ──
  if (name === "execute_sql_batch") {
    const check = requireDb(args.database);
    if (!check.ok) return check.error;

    // 容錯：若傳 sql（execute_sql 風格）而非 queries，自動包成陣列
    if (!args.queries && typeof args.sql === "string") {
      args.queries = [{ sql: args.sql, label: args.label }];
    }
    args.queries = normalizeArrayArg(args.queries);
    if (!Array.isArray(args.queries) || args.queries.length === 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "❌ queries 必須是非空陣列。用法：queries: [{sql: '...'}, {sql: '...'}] 或 queries: ['SELECT ...', 'SELECT ...']" }],
      };
    }
    const normalized = [];
    for (let i = 0; i < args.queries.length; i++) {
      const raw = args.queries[i];
      let sql, label;
      if (typeof raw === "string") {
        sql = raw;
      } else if (raw && typeof raw === "object") {
        sql = raw.sql ?? raw.query;
        label = raw.label;
      }
      if (typeof sql !== "string" || !sql.trim()) {
        return {
          isError: true,
          content: [{ type: "text", text: `❌ queries[${i}] 缺少 sql 欄位或非字串（收到：${JSON.stringify(raw)?.slice(0, 120)}）` }],
        };
      }
      normalized.push({ sql, label });
    }
    args.queries = normalized;

    // 危險語句預檢（所有批次項目）
    const dangerList = [];
    for (const q of args.queries) {
      const d = checkDangerousStmt(q.sql);
      if (d) dangerList.push({ label: q.label || q.sql.slice(0, 60), ...d });
    }
    const blocked = dangerList.filter((d) => d.block);
    const needConfirm = dangerList.filter((d) => !d.block);
    if (blocked.length > 0) {
      return {
        isError: true,
        content: [{ type: "text", text: `⛔ 封鎖 ${blocked.length} 條危險語句：\n${blocked.map((d) => `  • ${d.reason}：${d.label}`).join("\n")}` }],
      };
    }
    if (needConfirm.length > 0 && !args.confirm) {
      return {
        isError: true,
        content: [{ type: "text", text: `⚠️ 批次中有 ${needConfirm.length} 條語句需加 confirm: true：\n${needConfirm.map((d) => `  • ${d.reason}：${d.label}`).join("\n")}` }],
      };
    }

    const conn = await getQueryRunner(check.config);
    const results = [];
    const errorCodes = [];
    const dbLabel = check.config.database;
    try {
      for (const q of args.queries) {
        const label = q.label || "SQL";
        try {
          const [res] = await conn.execute(q.sql);
          if (Array.isArray(res)) {
            // SELECT 結果：回傳實際資料
            results.push(`${label}: 查詢結果 (${res.length} 筆)：\n${formatRows(res)}`);
          } else {
            // DML：寫入 audit log + 回傳影響列數
            const upper = q.sql.trim().toUpperCase();
            if (!upper.startsWith("SELECT") && !upper.startsWith("SHOW") && !upper.startsWith("DESCRIBE")) {
              await auditSQL(q.sql, dbLabel);
            }
            results.push(`${label}: ✅ 成功（影響 ${res.affectedRows} 列）`);
          }
        } catch (err) {
          const code = err.code ? ` [${err.code}]` : "";
          const sqlState = err.sqlState ? ` (SQLSTATE ${err.sqlState})` : "";
          if (err.code) errorCodes.push(err.code);
          results.push(`${label}: ❌${code}${sqlState} ${err.message}`);
        }
      }
      const header = dbPool.size > 1 ? `🗄️ [${dbLabel}]\n` : "";
      const summary = summarizeSqlErrors(errorCodes);
      return { content: [{ type: "text", text: summary + header + results.join("\n") }] };
    } finally {
      await conn.end();
    }
  }

  // ── mysql_log_tail ──
  if (name === "mysql_log_tail") {
    const check = requireDb(args.database);
    if (!check.ok) return check.error;

    const action = args.action || "recent_errors";
    const limit = Math.max(1, Math.min(args.limit || 50, 500));
    const sinceMin = Math.max(1, args.since_minutes || 30);
    const conn = await getQueryRunner(check.config);
    const dbLabel = check.config.database;

    try {
      if (action === "recent_errors") {
        // 從 performance_schema 撈最近失敗的 SQL（不需開 general_log）
        try {
          const [rows] = await conn.execute(
            `SELECT EVENT_ID, MYSQL_ERRNO, RETURNED_SQLSTATE, MESSAGE_TEXT,
                    LEFT(SQL_TEXT, 500) AS SQL_TEXT,
                    CURRENT_SCHEMA,
                    TIMER_END
             FROM performance_schema.events_statements_history_long
             WHERE MYSQL_ERRNO <> 0
             ORDER BY EVENT_ID DESC
             LIMIT ?`,
            [limit]
          );
          if (!rows.length) {
            return { content: [{ type: "text", text: `✅ [${dbLabel}] performance_schema 最近無 SQL 錯誤殘留` }] };
          }
          const codeCounts = new Map();
          for (const r of rows) {
            const k = r.RETURNED_SQLSTATE + "/" + r.MYSQL_ERRNO;
            codeCounts.set(k, (codeCounts.get(k) || 0) + 1);
          }
          const summary = [...codeCounts.entries()].map(([k, n]) => `${k} x${n}`).join(", ");
          const lines = rows.map(r =>
            `[errno ${r.MYSQL_ERRNO} sqlstate ${r.RETURNED_SQLSTATE}] schema=${r.CURRENT_SCHEMA || "-"}\n  msg: ${r.MESSAGE_TEXT}\n  sql: ${(r.SQL_TEXT || "").replace(/\s+/g, " ").slice(0, 300)}`
          );
          return {
            content: [{ type: "text", text: `🚨 [${dbLabel}] 最近 ${rows.length} 筆 SQL 錯誤（${summary}）\n\n${lines.join("\n\n")}` }],
          };
        } catch (err) {
          return errorResp(`查詢 performance_schema 失敗：${err.message}`, [
            "確認帳號有 SELECT performance_schema 權限",
            "確認 performance_schema 已啟用 (SHOW VARIABLES LIKE 'performance_schema')",
          ]);
        }
      }

      if (action === "enable_general_log") {
        try {
          await conn.query(`SET GLOBAL log_output = 'TABLE'`);
          await conn.query(`SET GLOBAL general_log = 'ON'`);
          return { content: [{ type: "text", text: `✅ [${dbLabel}] general_log 已開啟（output=TABLE，寫入 mysql.general_log）。記得用完 disable_general_log 關閉。` }] };
        } catch (err) {
          return errorResp(`開啟 general_log 失敗：${err.message}`, ["需要 SUPER / SYSTEM_VARIABLES_ADMIN 權限"]);
        }
      }

      if (action === "disable_general_log") {
        try {
          await conn.query(`SET GLOBAL general_log = 'OFF'`);
          return { content: [{ type: "text", text: `✅ [${dbLabel}] general_log 已關閉` }] };
        } catch (err) {
          return errorResp(`關閉 general_log 失敗：${err.message}`);
        }
      }

      if (action === "tail_general_log") {
        try {
          const [rows] = await conn.execute(
            `SELECT event_time, command_type, LEFT(argument, 800) AS argument
             FROM mysql.general_log
             WHERE event_time >= NOW() - INTERVAL ? MINUTE
             ORDER BY event_time DESC
             LIMIT ?`,
            [sinceMin, limit]
          );
          if (!rows.length) {
            return { content: [{ type: "text", text: `[${dbLabel}] mysql.general_log 過去 ${sinceMin} 分鐘無紀錄（確認 general_log=ON 且 log_output=TABLE）` }] };
          }
          const lines = rows.map(r => {
            const arg = typeof r.argument === "string" ? r.argument : (r.argument?.toString?.("utf-8") ?? "");
            return `[${r.event_time}] ${r.command_type}: ${arg.replace(/\s+/g, " ").slice(0, 400)}`;
          });
          return { content: [{ type: "text", text: `📜 [${dbLabel}] mysql.general_log 最近 ${rows.length} 筆\n\n${lines.join("\n")}` }] };
        } catch (err) {
          return errorResp(`讀取 mysql.general_log 失敗：${err.message}`, [
            "需要 SELECT mysql.general_log 權限",
            "若 log_output=FILE 而非 TABLE，此 action 看不到（先 enable_general_log）",
          ]);
        }
      }

      return errorResp(`未知 action：${action}`);
    } finally {
      await conn.end();
    }
  }

  // ── schema_diff ──
  if (name === "schema_diff") {
    const srcCheck = requireDb(args.source_db);
    if (!srcCheck.ok) return srcCheck.error;
    const tgtCheck = requireDb(args.target_db);
    if (!tgtCheck.ok) return tgtCheck.error;

    const pattern = args.table_pattern || "%";
    const ignore = new Set(args.ignore || []);
    const compareFields = ["COLUMN_TYPE", "IS_NULLABLE", "COLUMN_DEFAULT", "COLUMN_KEY", "EXTRA", "COLUMN_COMMENT"]
      .filter(f => {
        if (ignore.has("COMMENT") && f === "COLUMN_COMMENT") return false;
        if (ignore.has("DEFAULT") && f === "COLUMN_DEFAULT") return false;
        if (ignore.has("EXTRA") && f === "EXTRA") return false;
        if (ignore.has("KEY") && f === "COLUMN_KEY") return false;
        return true;
      });

    async function fetchSchema(config) {
      const conn = await getQueryRunner(config);
      try {
        const [rows] = await conn.execute(
          `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
           FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?
           ORDER BY TABLE_NAME, ORDINAL_POSITION`,
          [config.database, pattern]
        );
        const map = new Map();
        for (const r of rows) {
          if (!map.has(r.TABLE_NAME)) map.set(r.TABLE_NAME, new Map());
          map.get(r.TABLE_NAME).set(r.COLUMN_NAME, r);
        }
        return map;
      } finally {
        await conn.end();
      }
    }

    let srcMap, tgtMap;
    try {
      [srcMap, tgtMap] = await Promise.all([fetchSchema(srcCheck.config), fetchSchema(tgtCheck.config)]);
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `讀取 schema 失敗: ${err.message}` }] };
    }

    const allTables = new Set([...srcMap.keys(), ...tgtMap.keys()]);
    const report = [];
    const srcLabel = srcCheck.config.database;
    const tgtLabel = tgtCheck.config.database;
    let diffCount = 0, sameCount = 0;

    for (const table of [...allTables].sort()) {
      const srcCols = srcMap.get(table);
      const tgtCols = tgtMap.get(table);
      if (!srcCols) { report.push(`\n━━ ${table} ━━\n  ❌ 僅存在於 [${tgtLabel}]`); diffCount++; continue; }
      if (!tgtCols) { report.push(`\n━━ ${table} ━━\n  ❌ 僅存在於 [${srcLabel}]`); diffCount++; continue; }

      const allCols = new Set([...srcCols.keys(), ...tgtCols.keys()]);
      const tableDiffs = [];
      for (const col of allCols) {
        const s = srcCols.get(col);
        const t = tgtCols.get(col);
        if (!s) { tableDiffs.push(`  + ${col}: 僅 [${tgtLabel}] 有 → ${t.COLUMN_TYPE}`); continue; }
        if (!t) { tableDiffs.push(`  - ${col}: 僅 [${srcLabel}] 有 → ${s.COLUMN_TYPE}`); continue; }
        const fieldDiffs = [];
        for (const f of compareFields) {
          if (String(s[f] ?? "") !== String(t[f] ?? "")) {
            fieldDiffs.push(`${f}: [${srcLabel}]=${JSON.stringify(s[f])} ≠ [${tgtLabel}]=${JSON.stringify(t[f])}`);
          }
        }
        if (fieldDiffs.length) tableDiffs.push(`  ~ ${col}\n      ${fieldDiffs.join("\n      ")}`);
      }
      if (tableDiffs.length) {
        report.push(`\n━━ ${table} ━━\n${tableDiffs.join("\n")}`);
        diffCount++;
      } else {
        sameCount++;
      }
    }

    const summary = `📊 Schema Diff [${srcLabel}] vs [${tgtLabel}]  pattern="${pattern}"\n  比對表數：${allTables.size}（✅ 相同 ${sameCount} / ⚠️ 差異 ${diffCount}）${ignore.size ? `\n  忽略欄位：${[...ignore].join(", ")}` : ""}`;
    const body = diffCount === 0 ? "\n\n✅ 所有資料表欄位定義完全一致。" : report.join("\n");
    return { content: [{ type: "text", text: summary + body }] };
  }
}
