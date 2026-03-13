import SftpClient from "ssh2-sftp-client";
import { Client as SSH2Client } from "ssh2";
import fs from "fs";
import path from "path";
import { resolveSecurePath } from "../config.js";

// ============================================
// SSH 指令安全檢查
// ============================================
const BLOCKED_PATTERNS = [
  // 毀滅性檔案系統操作
  { re: /\brm\s+(-[^\s]*\s+)*-[^\s]*r[^\s]*\s+\/\s*$/,    msg: "禁止 rm -rf /" },
  { re: /\brm\s+(-[^\s]*\s+)*-[^\s]*r[^\s]*\s+\/[a-z]+\s*$/i, msg: "禁止 rm -rf 根目錄子目錄（如 /var, /etc）" },
  { re: /\bmkfs\b/,                                          msg: "禁止格式化磁碟 (mkfs)" },
  { re: /\bdd\s+.*\bof=\/dev\//,                             msg: "禁止 dd 寫入裝置" },
  { re: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,                   msg: "禁止 fork bomb" },
  { re: />\s*\/dev\/[sh]da/,                                 msg: "禁止寫入磁碟裝置" },
  { re: /\bchmod\s+(-[^\s]+\s+)*777\s+\/\s*$/,              msg: "禁止 chmod 777 /" },
  { re: /\bchown\s+(-[^\s]+\s+)*-R\s+.*\s+\/\s*$/,         msg: "禁止遞迴 chown /" },
];

const WARN_PATTERNS = [
  { re: /\brm\s/,              msg: "刪除檔案 (rm)" },
  { re: /\bkill\s/,            msg: "終止程序 (kill)" },
  { re: /\bkillall\s/,         msg: "終止所有同名程序 (killall)" },
  { re: /\bsystemctl\s+stop\b/, msg: "停止服務 (systemctl stop)" },
  { re: /\bsystemctl\s+disable\b/, msg: "停用服務 (systemctl disable)" },
  { re: /\bshutdown\b/,        msg: "關機 (shutdown)" },
  { re: /\breboot\b/,          msg: "重新開機 (reboot)" },
  { re: /\binit\s+[06]\b/,     msg: "系統狀態切換 (init)" },
  { re: /\biptables\s+.*-[FX]/, msg: "清除防火牆規則 (iptables flush)" },
  { re: /\btruncate\b/,        msg: "截斷檔案 (truncate)" },
  { re: /\b>\s*\/etc\//,       msg: "覆寫 /etc/ 設定檔" },
  { re: /\bDROP\s+(TABLE|DATABASE)\b/i, msg: "刪除資料表/資料庫 (DROP)" },
  { re: /\buseradd\b|\buserdel\b/, msg: "新增/刪除使用者" },
  { re: /\bpasswd\b/,          msg: "變更密碼 (passwd)" },
];

function checkCommandSafety(command) {
  const cmd = command.trim();
  for (const { re, msg } of BLOCKED_PATTERNS) {
    if (re.test(cmd)) return { level: "blocked", msg };
  }
  for (const { re, msg } of WARN_PATTERNS) {
    if (re.test(cmd)) return { level: "warn", msg };
  }
  return { level: "safe" };
}

// ============================================
// 記憶體狀態：當前 SFTP 連線設定
// ============================================
let currentSftp = null;

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "sftp_connect",
    description:
      "設定 SFTP 連線 (設定後同一次對話內的所有操作都會使用此連線)",
    inputSchema: {
      type: "object",
      properties: {
        host:             { type: "string", description: "遠端主機 IP 或網域" },
        port:             { type: "number", description: "連接埠 (預設 22)" },
        user:             { type: "string", description: "使用者名稱" },
        password:         { type: "string", description: "密碼（與 private_key_path 擇一）" },
        private_key_path: { type: "string", description: "私鑰絕對路徑（與 password 擇一）" },
      },
      required: ["host", "user"],
    },
  },
  {
    name: "sftp_upload",
    description: "上傳本機檔案或資料夾到遠端伺服器（支援單檔與整個目錄）",
    inputSchema: {
      type: "object",
      properties: {
        local_path:  { type: "string", description: "本機路徑（相對 basePath 或絕對路徑，需先 grant_path_access）" },
        remote_path: { type: "string", description: "遠端目標絕對路徑（例如 /var/www/html/project）" },
      },
      required: ["local_path", "remote_path"],
    },
  },
  {
    name: "sftp_download",
    description: "從遠端伺服器下載檔案或資料夾到本機（支援單檔與整個目錄）",
    inputSchema: {
      type: "object",
      properties: {
        remote_path: { type: "string", description: "遠端來源絕對路徑" },
        local_path:  { type: "string", description: "本機目標路徑（相對 basePath 或絕對路徑）" },
      },
      required: ["remote_path", "local_path"],
    },
  },
  {
    name: "sftp_list",
    description: "列出遠端目錄內容（檔名、類型、大小、修改時間）",
    inputSchema: {
      type: "object",
      properties: {
        remote_path: { type: "string", description: "遠端目錄路徑" },
      },
      required: ["remote_path"],
    },
  },
  {
    name: "sftp_list_batch",
    description: "批次列出多個遠端目錄內容（共用一條連線，減少 tool call 來回）",
    inputSchema: {
      type: "object",
      properties: {
        remote_paths: {
          type: "array",
          items: { type: "string" },
          description: "遠端目錄路徑陣列",
        },
      },
      required: ["remote_paths"],
    },
  },
  {
    name: "ssh_exec",
    description:
      "透過 SSH 在遠端主機執行指令（需先 sftp_connect）。" +
      "內建危險指令防護：毀滅性操作會被攔截，高風險操作會附帶警告。",
    inputSchema: {
      type: "object",
      properties: {
        command:        { type: "string", description: "要執行的 shell 指令" },
        timeout:        { type: "number", description: "逾時秒數（預設 30，最大 300）" },
        confirm_risky:  { type: "boolean", description: "若指令被標記為高風險，設為 true 以確認執行" },
      },
      required: ["command"],
    },
  },
  {
    name: "sftp_delete",
    description: "刪除遠端檔案或目錄",
    inputSchema: {
      type: "object",
      properties: {
        remote_path: { type: "string", description: "遠端檔案或目錄路徑" },
        recursive:   { type: "boolean", description: "遞迴刪除目錄內容（預設 false）" },
      },
      required: ["remote_path"],
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
// 內部：確認已設定連線
// ============================================
function requireSftp() {
  if (!currentSftp) {
    return {
      ok: false,
      error: errorResp("尚未設定 SFTP 連線。", ["呼叫 sftp_connect 設定連線後重試"]),
    };
  }
  return { ok: true, config: currentSftp };
}

// ============================================
// 內部：格式化目錄列表（共用，省 token）
// ============================================
function formatListing(remotePath, items) {
  const lines = items
    .sort((a, b) => (b.type === "d") - (a.type === "d") || a.name.localeCompare(b.name))
    .map((f) => {
      const type = f.type === "d" ? "[D] " : "    ";
      const size = f.type === "d" ? "" : ` ${(f.size / 1024).toFixed(1)}K`;
      const d = new Date(f.modifyTime);
      const date = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return `${type}${f.name}${size} ${date}`;
    });
  return `📁 ${remotePath} (${items.length}):\n${lines.join("\n")}`;
}

// ============================================
// 內部：建立 SFTP 連線
// ============================================
async function createClient(config) {
  const client = new SftpClient();
  const opts = {
    host: config.host,
    port: config.port || 22,
    username: config.user,
  };
  if (config.privateKey) {
    opts.privateKey = config.privateKey;
  } else {
    opts.password = config.password || "";
  }
  await client.connect(opts);
  return client;
}

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {

  // ── sftp_connect ──
  if (name === "sftp_connect") {
    const config = {
      host:     args.host,
      port:     args.port || 22,
      user:     args.user,
      password: args.password || "",
    };

    if (args.private_key_path) {
      try {
        config.privateKey = fs.readFileSync(args.private_key_path);
      } catch (e) {
        return errorResp(`讀取私鑰失敗：${e.message}`, [
          "確認私鑰檔案路徑是否正確",
          "改用 password 參數進行密碼認證",
        ]);
      }
    }

    // 測試連線
    let client;
    try {
      client = await createClient(config);
      await client.list("/");
    } catch (err) {
      const isAuth = /auth|credential|password/i.test(err.message);
      const isConn = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(err.message);
      const hints = isAuth
        ? ["確認使用者名稱與密碼（或私鑰）是否正確", "確認遠端伺服器允許此使用者登入"]
        : isConn
        ? ["確認主機 IP 與 port 是否正確", "確認防火牆已開放 SSH port（預設 22）"]
        : ["確認主機、port、帳號、密碼後重新呼叫 sftp_connect"];
      return errorResp(`SFTP 連線失敗：${err.message}`, hints);
    } finally {
      if (client) await client.end().catch(() => {});
    }

    currentSftp = config;
    return {
      content: [{
        type: "text",
        text: `✅ SFTP 已連線\n主機: ${config.user}@${config.host}:${config.port}\n認證: ${config.privateKey ? "私鑰" : "密碼"}`,
      }],
    };
  }

  // ── sftp_upload ──
  if (name === "sftp_upload") {
    const check = requireSftp();
    if (!check.ok) return check.error;

    let localAbs;
    try {
      localAbs = resolveSecurePath(args.local_path);
    } catch (e) {
      return errorResp(e.message, ["呼叫 grant_path_access 開放此路徑後重試"]);
    }

    if (!fs.existsSync(localAbs)) {
      return errorResp(`本機路徑不存在：${localAbs}`, [
        "確認路徑是否相對 basePath（D:\\Project\\）",
        "若路徑在 basePath 之外，先呼叫 grant_path_access 後重試",
      ]);
    }

    let client;
    try {
      client = await createClient(check.config);
      const stat = fs.statSync(localAbs);

      if (stat.isDirectory()) {
        await client.uploadDir(localAbs, args.remote_path);
        return {
          content: [{ type: "text", text: `✅ 目錄上傳完成\n本機: ${localAbs}\n遠端: ${args.remote_path}` }],
        };
      } else {
        await client.put(localAbs, args.remote_path);
        return {
          content: [{ type: "text", text: `✅ 檔案上傳完成\n本機: ${localAbs}\n遠端: ${args.remote_path}` }],
        };
      }
    } catch (err) {
      return errorResp(`上傳失敗：${err.message}`, [
        `呼叫 sftp_list ${path.dirname(args.remote_path)} 確認遠端目錄存在`,
        "確認遠端使用者對目標路徑有寫入權限",
      ]);
    } finally {
      if (client) await client.end().catch(() => {});
    }
  }

  // ── sftp_download ──
  if (name === "sftp_download") {
    const check = requireSftp();
    if (!check.ok) return check.error;

    let localAbs;
    try {
      localAbs = resolveSecurePath(args.local_path);
    } catch (e) {
      return errorResp(e.message, ["呼叫 grant_path_access 開放此路徑後重試"]);
    }

    let client;
    try {
      client = await createClient(check.config);
      const remoteInfo = await client.stat(args.remote_path);

      if (remoteInfo.isDirectory) {
        fs.mkdirSync(localAbs, { recursive: true });
        await client.downloadDir(args.remote_path, localAbs);
        return {
          content: [{ type: "text", text: `✅ 目錄下載完成\n遠端: ${args.remote_path}\n本機: ${localAbs}` }],
        };
      } else {
        fs.mkdirSync(path.dirname(localAbs), { recursive: true });
        await client.get(args.remote_path, localAbs);
        return {
          content: [{ type: "text", text: `✅ 檔案下載完成\n遠端: ${args.remote_path}\n本機: ${localAbs}` }],
        };
      }
    } catch (err) {
      const isNotFound = /no such file|ENOENT/i.test(err.message);
      return errorResp(`下載失敗：${err.message}`, isNotFound
        ? [`呼叫 sftp_list ${path.dirname(args.remote_path)} 確認來源路徑存在`]
        : ["確認遠端路徑正確", "確認遠端使用者有讀取權限"]
      );
    } finally {
      if (client) await client.end().catch(() => {});
    }
  }

  // ── sftp_list ──
  if (name === "sftp_list") {
    const check = requireSftp();
    if (!check.ok) return check.error;

    let client;
    try {
      client = await createClient(check.config);
      const items = await client.list(args.remote_path);
      return {
        content: [{ type: "text", text: formatListing(args.remote_path, items) }],
      };
    } catch (err) {
      return errorResp(`列目錄失敗：${err.message}`, [
        "確認遠端路徑存在且為目錄",
        "確認遠端使用者有讀取權限",
      ]);
    } finally {
      if (client) await client.end().catch(() => {});
    }
  }

  // ── sftp_list_batch ──
  if (name === "sftp_list_batch") {
    const check = requireSftp();
    if (!check.ok) return check.error;

    let client;
    try {
      client = await createClient(check.config);
      const results = [];

      for (const remotePath of args.remote_paths) {
        try {
          const items = await client.list(remotePath);
          results.push(formatListing(remotePath, items));
        } catch (err) {
          results.push(`❌ ${remotePath}：${err.message}`);
        }
      }

      return {
        content: [{ type: "text", text: results.join("\n\n") }],
      };
    } catch (err) {
      return errorResp(`SFTP 連線失敗：${err.message}`, ["確認 SFTP 連線設定是否正確"]);
    } finally {
      if (client) await client.end().catch(() => {});
    }
  }

  // ── ssh_exec ──
  if (name === "ssh_exec") {
    const check = requireSftp();
    if (!check.ok) return check.error;

    const command = (args.command || "").trim();
    if (!command) return errorResp("指令不可為空。");

    // 安全檢查
    const safety = checkCommandSafety(command);
    if (safety.level === "blocked") {
      return errorResp(`🚫 指令被攔截：${safety.msg}\n指令：${command}`, [
        "此指令具有不可逆的毀滅性風險，已被硬性禁止",
        "請改用更安全的替代方案",
      ]);
    }
    if (safety.level === "warn" && !args.confirm_risky) {
      return errorResp(
        `⚠️ 高風險指令偵測：${safety.msg}\n指令：${command}`,
        [
          "若確定要執行，請加上 confirm_risky: true 重新呼叫",
          "請先確認指令的影響範圍",
        ]
      );
    }

    const timeout = Math.min(Math.max((args.timeout || 30), 1), 300) * 1000;
    const config = check.config;

    return new Promise((resolve) => {
      const conn = new SSH2Client();
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          conn.end();
          resolve(errorResp(`指令逾時（${timeout / 1000} 秒）：${command}`, [
            "增加 timeout 參數後重試",
            "檢查指令是否需要互動式輸入（ssh_exec 不支援互動）",
          ]));
        }
      }, timeout);

      conn.on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            settled = true;
            clearTimeout(timer);
            conn.end();
            resolve(errorResp(`執行失敗：${err.message}`));
            return;
          }

          let stdout = "";
          let stderr = "";

          stream.on("data", (data) => { stdout += data.toString(); });
          stream.stderr.on("data", (data) => { stderr += data.toString(); });

          stream.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            conn.end();

            // 截斷過長的輸出（防止 token 爆炸）
            const MAX = 50000;
            if (stdout.length > MAX) stdout = stdout.slice(0, MAX) + `\n... (truncated, total ${stdout.length} chars)`;
            if (stderr.length > MAX) stderr = stderr.slice(0, MAX) + `\n... (truncated, total ${stderr.length} chars)`;

            const parts = [];
            const warn = safety.level === "warn" ? `⚠️ 已確認執行高風險指令：${safety.msg}\n` : "";
            parts.push(`${warn}$ ${command}\nExit code: ${code}`);
            if (stdout) parts.push(`--- stdout ---\n${stdout.trimEnd()}`);
            if (stderr) parts.push(`--- stderr ---\n${stderr.trimEnd()}`);
            if (!stdout && !stderr) parts.push("（無輸出）");

            resolve({
              content: [{ type: "text", text: parts.join("\n\n") }],
            });
          });
        });
      });

      conn.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(errorResp(`SSH 連線失敗：${err.message}`, [
          "確認 sftp_connect 連線設定是否正確",
          "確認遠端主機 SSH 服務正常",
        ]));
      });

      const connOpts = {
        host: config.host,
        port: config.port || 22,
        username: config.user,
      };
      if (config.privateKey) {
        connOpts.privateKey = config.privateKey;
      } else {
        connOpts.password = config.password || "";
      }
      conn.connect(connOpts);
    });
  }

  // ── sftp_delete ──
  if (name === "sftp_delete") {
    const check = requireSftp();
    if (!check.ok) return check.error;

    let client;
    try {
      client = await createClient(check.config);
      const info = await client.stat(args.remote_path);

      if (info.isDirectory) {
        await client.rmdir(args.remote_path, args.recursive || false);
        return { content: [{ type: "text", text: `✅ 目錄已刪除: ${args.remote_path}` }] };
      } else {
        await client.delete(args.remote_path);
        return { content: [{ type: "text", text: `✅ 檔案已刪除: ${args.remote_path}` }] };
      }
    } catch (err) {
      const isNonEmpty = /non-empty|not empty|ENOTEMPTY/i.test(err.message);
      return errorResp(`刪除失敗：${err.message}`, isNonEmpty
        ? ["目錄非空，設定 recursive: true 後重試"]
        : ["確認遠端路徑存在", "確認遠端使用者有刪除權限"]
      );
    } finally {
      if (client) await client.end().catch(() => {});
    }
  }
}
