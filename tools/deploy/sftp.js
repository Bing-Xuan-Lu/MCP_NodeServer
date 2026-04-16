import SftpClient from "ssh2-sftp-client";
import { Client as SSH2Client } from "ssh2";
import fs from "fs";
import fsP from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import { resolveSecurePath } from "../../config.js";
import { validateArgs } from "../_shared/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_FILE = path.join(__dirname, "..", "..", ".mcp_sftp_presets.json");

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
      "設定 SFTP 連線 (設定後同一次對話內的所有操作都會使用此連線)。可用 preset 參數載入已儲存的部署 preset",
    inputSchema: {
      type: "object",
      properties: {
        preset:           { type: "string", description: "載入已儲存的 preset 名稱（免填 host/user/password）" },
        host:             { type: "string", description: "遠端主機 IP 或網域" },
        port:             { type: "number", description: "連接埠", default: 22 },
        user:             { type: "string", description: "使用者名稱" },
        password:         { type: "string", description: "密碼（與 private_key_path 擇一）" },
        private_key_path: { type: "string", description: "私鑰絕對路徑（與 password 擇一）" },
      },
    },
  },
  {
    name: "sftp_upload",
    description:
      "上傳本機檔案或資料夾到遠端伺服器（支援單檔與整個目錄）。" +
      "若已設定 preset，可只傳相對路徑，自動補上 local_base / remote_base",
    inputSchema: {
      type: "object",
      properties: {
        local_path:  { type: "string", description: "本機路徑（相對 basePath 或絕對路徑；若有 preset 可傳相對於 local_base 的路徑）" },
        remote_path: { type: "string", description: "遠端目標絕對路徑（若有 preset 且省略，自動用 remote_base + local_path 組合）" },
      },
      required: ["local_path"],
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
    name: "sftp_upload_batch",
    description:
      "批次上傳多組本機檔案/資料夾到遠端（共用一條連線，減少 tool call）。" +
      "支援 glob pattern（如 admin/**/*.php）自動展開。" +
      "若已設定 preset，items 內可只傳相對路徑，自動補上 local_base / remote_base",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              local_path:  { type: "string", description: "本機路徑（相對 basePath）。支援 glob pattern（如 admin/**/*.php、cart/*.js），自動展開為多檔上傳" },
              remote_path: { type: "string", description: "遠端目標絕對路徑（若有 preset 且省略，自動用 remote_base + local_path 組合）" },
            },
            required: ["local_path"],
          },
          description: "上傳項目陣列，每項含 local_path 與 remote_path",
        },
      },
      required: ["items"],
    },
  },
  {
    name: "sftp_download_batch",
    description: "批次從遠端下載多組檔案/資料夾到本機（共用一條連線，減少 tool call）",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              remote_path: { type: "string", description: "遠端來源絕對路徑" },
              local_path:  { type: "string", description: "本機目標路徑（相對 basePath 或絕對路徑）" },
            },
            required: ["remote_path", "local_path"],
          },
          description: "下載項目陣列，每項含 remote_path 與 local_path",
        },
      },
      required: ["items"],
    },
  },
  {
    name: "sftp_delete_batch",
    description: "批次刪除多個遠端檔案或目錄（共用一條連線，減少 tool call）",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              remote_path: { type: "string", description: "遠端檔案或目錄路徑" },
              recursive:   { type: "boolean", description: "遞迴刪除目錄內容（預設 false）" },
            },
            required: ["remote_path"],
          },
          description: "刪除項目陣列",
        },
      },
      required: ["items"],
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
  {
    name: "sftp_preset",
    description:
      "管理 SFTP 部署 preset（儲存連線 + 路徑對應，重啟後仍保留）。" +
      "save：儲存/更新 preset；list：列出所有 preset；delete：刪除 preset",
    inputSchema: {
      type: "object",
      properties: {
        action:      { type: "string", enum: ["save", "list", "delete"], description: "操作類型" },
        preset_name: { type: "string", description: "Preset 名稱（save/delete 必填）" },
        host:        { type: "string", description: "遠端主機 IP 或網域（save 時填）" },
        port:        { type: "number", description: "連接埠（預設 22）" },
        user:        { type: "string", description: "使用者名稱（save 時填）" },
        password:    { type: "string", description: "密碼（save 時填，與 private_key_path 擇一）" },
        private_key_path: { type: "string", description: "私鑰絕對路徑（save 時填）" },
        local_base:  { type: "string", description: "本機專案根目錄（如 D:\\Project\\PG_dbox3），上傳時作為相對路徑基準" },
        remote_base: { type: "string", description: "遠端部署根目錄（如 /var/www/html_dbox3/），上傳時作為遠端路徑前綴" },
        excludes:    {
          type: "array", items: { type: "string" },
          description: "部署時排除的相對路徑 pattern（如 ['config/database.php', '.env']）",
        },
      },
      required: ["action"],
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
// 內部：Preset 路徑解析
// ============================================

/**
 * 根據 preset 的 local_base / remote_base 補全路徑
 * @returns {{ localPath: string, remotePath: string|null, presetNote: string }}
 */
function resolvePresetPaths(localPath, remotePath, sftpConfig) {
  const lb = sftpConfig?._local_base;
  const rb = sftpConfig?._remote_base;
  let note = "";

  // 如果已有完整 remote_path，直接用
  if (remotePath) return { localPath, remotePath, presetNote: "" };

  // 需要 preset 的 local_base + remote_base 來推算
  if (!lb || !rb) return { localPath, remotePath: null, presetNote: "" };

  // localPath 可能是相對於 local_base 的路徑，組合成完整路徑
  // 也可能已是相對於 basePath 的路徑，需判斷
  const normalizedLocal = localPath.replace(/\\/g, "/");
  const normalizedLB = lb.replace(/\\/g, "/").replace(/\/$/, "");

  let relativePart;
  let resolvedLocal = localPath;  // 預設不變；若為相對路徑會拼上 local_base

  // 若 localPath 已包含 local_base 前綴，取相對部分
  if (normalizedLocal.toLowerCase().startsWith(normalizedLB.toLowerCase())) {
    relativePart = normalizedLocal.slice(normalizedLB.length).replace(/^\//, "");
  } else if (normalizedLocal.toLowerCase().startsWith(normalizedLB.split("/").pop().toLowerCase())) {
    // 像 PG_dbox3/app/file.php 這種（basePath + project 相對路徑）
    const projectFolder = normalizedLB.split("/").pop();
    relativePart = normalizedLocal.slice(projectFolder.length).replace(/^\//, "");
  } else {
    // 當作純相對路徑 → 拼上 local_base 讓後續 resolveSecurePath 能定位到正確檔案
    relativePart = normalizedLocal;
    resolvedLocal = `${normalizedLB}/${normalizedLocal}`;
  }

  const remoteBase = rb.replace(/\/$/, "");
  const computed = `${remoteBase}/${relativePart}`;
  note = `\n📦 Preset 路徑映射：${lb} → ${rb}`;

  return { localPath: resolvedLocal, remotePath: computed, presetNote: note };
}

/**
 * 檢查檔案是否在 preset 排除清單中
 * @returns {string|null} 命中的 pattern，或 null
 */
function checkPresetExcludes(localPath, sftpConfig) {
  const excludes = sftpConfig?._excludes;
  if (!excludes?.length) return null;

  const normalized = localPath.replace(/\\/g, "/").toLowerCase();
  for (const pattern of excludes) {
    const p = pattern.replace(/\\/g, "/").toLowerCase();
    if (normalized.endsWith(p) || normalized.includes(`/${p}`)) {
      return pattern;
    }
  }
  return null;
}

// ============================================
// 內部：Preset 持久化（.mcp_sftp_presets.json）
// ============================================
async function loadPresets() {
  try {
    return JSON.parse(await fsP.readFile(PRESETS_FILE, "utf-8"));
  } catch { return {}; }
}
async function savePresets(data) {
  await fsP.writeFile(PRESETS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  // ── sftp_connect ──
  if (name === "sftp_connect") {
    let config;
    let presetInfo = null;

    if (args.preset) {
      // 從 preset 載入連線資訊
      const presets = await loadPresets();
      const p = presets[args.preset];
      if (!p) {
        const available = Object.keys(presets);
        return errorResp(`Preset "${args.preset}" 不存在。`, [
          available.length ? `可用 preset：${available.join(", ")}` : "尚未儲存任何 preset，請先用 sftp_preset save 建立",
        ]);
      }
      config = {
        host:     args.host || p.host,
        port:     args.port || p.port,
        user:     args.user || p.user,
        password: args.password || p.password || "",
      };
      if (p.private_key_path && !args.password) {
        try {
          config.privateKey = fs.readFileSync(p.private_key_path);
        } catch (e) {
          return errorResp(`Preset 私鑰讀取失敗：${e.message}`);
        }
      }
      presetInfo = p;
    } else {
      if (!args.host || !args.user) {
        return errorResp("需提供 host + user，或使用 preset 參數載入已儲存設定。", [
          "直接填寫 host、user、password 參數",
          "或用 sftp_preset list 查看可用 preset",
        ]);
      }
      config = {
        host:     args.host,
        port:     args.port,
        user:     args.user,
        password: args.password || "",
      };
    }

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

    // 儲存連線設定 + preset 路徑對應（供 upload 使用）
    currentSftp = config;
    if (presetInfo) {
      currentSftp._preset = args.preset;
      currentSftp._local_base = presetInfo.local_base || null;
      currentSftp._remote_base = presetInfo.remote_base || null;
      currentSftp._excludes = presetInfo.excludes || [];
    }

    const parts = [`✅ SFTP 已連線`, `主機: ${config.user}@${config.host}:${config.port}`, `認證: ${config.privateKey ? "私鑰" : "密碼"}`];
    if (presetInfo) {
      parts.push(`📦 Preset: ${args.preset}`);
      if (presetInfo.local_base) parts.push(`   local_base: ${presetInfo.local_base}`);
      if (presetInfo.remote_base) parts.push(`   remote_base: ${presetInfo.remote_base}`);
      if (presetInfo.excludes?.length) parts.push(`   excludes: ${presetInfo.excludes.join(", ")}`);
    }
    return { content: [{ type: "text", text: parts.join("\n") }] };
  }

  // ── sftp_upload ──
  if (name === "sftp_upload") {
    const check = requireSftp();
    if (!check.ok) return check.error;

    // Preset 路徑解析
    const { localPath, remotePath, presetNote } = resolvePresetPaths(
      args.local_path, args.remote_path, check.config
    );
    if (!remotePath) {
      return errorResp("無法推算 remote_path：未設定 preset 或未提供 remote_path。", [
        "明確指定 remote_path 參數",
        "或用 sftp_connect preset=xxx 載入含 remote_base 的 preset",
      ]);
    }

    // 排除檢查
    const excludeHit = checkPresetExcludes(localPath, check.config);
    if (excludeHit) {
      return errorResp(`⛔ 此檔案在 preset excludes 清單中：${excludeHit}`, [
        "此檔案含環境設定，直接上傳可能覆蓋遠端設定",
        "若確定要上傳，請明確指定完整 local_path + remote_path（不走 preset）",
      ]);
    }

    let localAbs;
    try {
      localAbs = resolveSecurePath(localPath);
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
        await client.uploadDir(localAbs, remotePath);
        return {
          content: [{ type: "text", text: `✅ 目錄上傳完成\n本機: ${localAbs}\n遠端: ${remotePath}${presetNote}` }],
        };
      } else {
        // 自動建立遠端目錄
        const remoteDir = remotePath.replace(/\/[^/]+$/, "");
        if (remoteDir) await client.mkdir(remoteDir, true).catch(() => {});
        await client.put(localAbs, remotePath);
        return {
          content: [{ type: "text", text: `✅ 檔案上傳完成\n本機: ${localAbs}\n遠端: ${remotePath}${presetNote}` }],
        };
      }
    } catch (err) {
      return errorResp(`上傳失敗：${err.message}`, [
        `呼叫 sftp_list ${path.dirname(remotePath)} 確認遠端目錄存在`,
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

  // ── sftp_upload_batch ──
  if (name === "sftp_upload_batch") {
    const check = requireSftp();
    if (!check.ok) return check.error;

    if (!args.items || args.items.length === 0) {
      return errorResp("items 陣列不可為空。");
    }

    let client;
    try {
      client = await createClient(check.config);
      const results = [];
      let okCount = 0;
      let skipCount = 0;

      // Glob 展開：若 local_path 含萬用字元（* ?），展開為多個檔案
      const expandedItems = [];
      for (const item of args.items) {
        if (/[*?{]/.test(item.local_path)) {
          try {
            // 用 resolvePresetPaths 取得完整路徑前綴，再從中推算 glob 基底
            const localBase = check.config?.local_base || '';
            const prefix = localBase
              ? resolveSecurePath(localBase).replace(/\\/g, '/')
              : resolveSecurePath('.').replace(/\\/g, '/');
            const fullPattern = `${prefix}/${item.local_path}`.replace(/\\/g, '/');
            const matched = await glob(fullPattern, { nodir: true });
            for (const m of matched) {
              const rel = path.relative(prefix, m).replace(/\\/g, '/');
              expandedItems.push({ local_path: rel });
            }
            if (matched.length === 0) {
              results.push(`⚠️ ${item.local_path}：glob 無符合檔案`);
            } else {
              results.push(`📦 ${item.local_path} → 展開 ${matched.length} 個檔案`);
            }
          } catch (err) {
            results.push(`❌ ${item.local_path}：glob 展開失敗：${err.message}`);
          }
        } else {
          expandedItems.push(item);
        }
      }

      for (const item of expandedItems) {
        // Preset 路徑解析
        const { localPath, remotePath } = resolvePresetPaths(
          item.local_path, item.remote_path, check.config
        );
        if (!remotePath) {
          results.push(`⚠️ ${item.local_path}：無法推算 remote_path（未設 preset 或未提供 remote_path）`);
          continue;
        }

        // 排除檢查
        const excludeHit = checkPresetExcludes(localPath, check.config);
        if (excludeHit) {
          results.push(`⛔ ${localPath} → 已排除（${excludeHit}）`);
          skipCount++;
          continue;
        }

        try {
          const localAbs = resolveSecurePath(localPath);
          if (!fs.existsSync(localAbs)) {
            results.push(`❌ ${localPath} → ${remotePath}：本機路徑不存在`);
            continue;
          }
          const stat = fs.statSync(localAbs);
          if (stat.isDirectory()) {
            await client.uploadDir(localAbs, remotePath);
          } else {
            // 自動建立遠端目錄（若不存在）
            const remoteDir = remotePath.replace(/\/[^/]+$/, "");
            if (remoteDir) {
              await client.mkdir(remoteDir, true).catch(() => {});
            }
            await client.put(localAbs, remotePath);
          }
          results.push(`✅ ${localPath} → ${remotePath}`);
          okCount++;
        } catch (err) {
          results.push(`❌ ${localPath} → ${remotePath}：${err.message}`);
        }
      }

      const summary = [`批次上傳完成：${okCount}/${args.items.length} 成功`];
      if (skipCount) summary.push(`（${skipCount} 個被 preset excludes 排除）`);
      if (check.config._preset) summary.push(`📦 Preset: ${check.config._preset}`);

      return {
        content: [{
          type: "text",
          text: `${summary.join(" ")}\n\n${results.join("\n")}`,
        }],
      };
    } catch (err) {
      return errorResp(`SFTP 連線失敗：${err.message}`, ["確認 SFTP 連線設定是否正確"]);
    } finally {
      if (client) await client.end().catch(() => {});
    }
  }

  // ── sftp_download_batch ──
  if (name === "sftp_download_batch") {
    const check = requireSftp();
    if (!check.ok) return check.error;

    if (!args.items || args.items.length === 0) {
      return errorResp("items 陣列不可為空。");
    }

    let client;
    try {
      client = await createClient(check.config);
      const results = [];
      let okCount = 0;

      for (const item of args.items) {
        try {
          const localAbs = resolveSecurePath(item.local_path);
          const remoteInfo = await client.stat(item.remote_path);

          if (remoteInfo.isDirectory) {
            fs.mkdirSync(localAbs, { recursive: true });
            await client.downloadDir(item.remote_path, localAbs);
          } else {
            fs.mkdirSync(path.dirname(localAbs), { recursive: true });
            await client.get(item.remote_path, localAbs);
          }
          results.push(`✅ ${item.remote_path} → ${item.local_path}`);
          okCount++;
        } catch (err) {
          results.push(`❌ ${item.remote_path} → ${item.local_path}：${err.message}`);
        }
      }

      return {
        content: [{
          type: "text",
          text: `批次下載完成：${okCount}/${args.items.length} 成功\n\n${results.join("\n")}`,
        }],
      };
    } catch (err) {
      return errorResp(`SFTP 連線失敗：${err.message}`, ["確認 SFTP 連線設定是否正確"]);
    } finally {
      if (client) await client.end().catch(() => {});
    }
  }

  // ── sftp_delete_batch ──
  if (name === "sftp_delete_batch") {
    const check = requireSftp();
    if (!check.ok) return check.error;

    if (!args.items || args.items.length === 0) {
      return errorResp("items 陣列不可為空。");
    }

    let client;
    try {
      client = await createClient(check.config);
      const results = [];
      let okCount = 0;

      for (const item of args.items) {
        try {
          const info = await client.stat(item.remote_path);
          if (info.isDirectory) {
            await client.rmdir(item.remote_path, item.recursive || false);
          } else {
            await client.delete(item.remote_path);
          }
          results.push(`✅ ${item.remote_path}`);
          okCount++;
        } catch (err) {
          results.push(`❌ ${item.remote_path}：${err.message}`);
        }
      }

      return {
        content: [{
          type: "text",
          text: `批次刪除完成：${okCount}/${args.items.length} 成功\n\n${results.join("\n")}`,
        }],
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

    // MySQL 中文自動注入 SET NAMES utf8mb4
    let finalCommand = command;
    const mysqlMatch = command.match(/^(docker\s+exec\s+\S+\s+)?mysql\b/);
    if (mysqlMatch) {
      const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(command);
      const hasSetNames = /set\s+names/i.test(command);
      if (hasCJK && !hasSetNames) {
        // 偵測 -e 'SQL' 或 -e "SQL" 模式，在 SQL 前插入 SET NAMES utf8mb4;
        finalCommand = command.replace(
          /(-e\s*['"])(.+?)(['"])/,
          (_, pre, sql, post) => `${pre}SET NAMES utf8mb4; ${sql}${post}`
        );
        if (finalCommand === command) {
          // 非 -e 模式（如 pipe），加前置提醒
          finalCommand = command;
        }
      }
    }

    const timeout = Math.min(Math.max((args.timeout || 30), 1), 300) * 1000;
    const config = check.config;

    // 組裝額外提示
    const mysqlWarnings = [];
    if (mysqlMatch && /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(command) && !/set\s+names/i.test(command)) {
      if (finalCommand !== command) {
        mysqlWarnings.push("🔤 偵測到 MySQL 指令含中文，已自動注入 SET NAMES utf8mb4");
      } else {
        mysqlWarnings.push("⚠️ 偵測到 MySQL 指令含中文但未包含 SET NAMES，建議手動加上 SET NAMES utf8mb4 以避免亂碼");
      }
    }

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
        conn.exec(finalCommand, (err, stream) => {
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
            if (mysqlWarnings.length) parts.push(mysqlWarnings.join("\n"));
            const warn = safety.level === "warn" ? `⚠️ 已確認執行高風險指令：${safety.msg}\n` : "";
            parts.push(`${warn}$ ${finalCommand}\nExit code: ${code}`);
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

  // ── sftp_preset ──
  if (name === "sftp_preset") {
    const action = args.action;

    if (action === "list") {
      const presets = await loadPresets();
      const names = Object.keys(presets);
      if (!names.length) {
        return { content: [{ type: "text", text: "尚未儲存任何 preset。\n用 sftp_preset action=save 建立第一個。" }] };
      }
      const lines = names.map((n) => {
        const p = presets[n];
        const parts = [`📦 ${n}`, `   ${p.user}@${p.host}:${p.port || 22}`];
        if (p.local_base) parts.push(`   local:  ${p.local_base}`);
        if (p.remote_base) parts.push(`   remote: ${p.remote_base}`);
        if (p.excludes?.length) parts.push(`   excludes: ${p.excludes.join(", ")}`);
        return parts.join("\n");
      });
      return { content: [{ type: "text", text: `SFTP Presets (${names.length}):\n\n${lines.join("\n\n")}` }] };
    }

    if (action === "delete") {
      if (!args.preset_name) return errorResp("delete 需要 preset_name 參數。");
      const presets = await loadPresets();
      if (!presets[args.preset_name]) {
        return errorResp(`Preset "${args.preset_name}" 不存在。`);
      }
      delete presets[args.preset_name];
      await savePresets(presets);
      return { content: [{ type: "text", text: `🗑️ Preset "${args.preset_name}" 已刪除。` }] };
    }

    if (action === "save") {
      if (!args.preset_name) return errorResp("save 需要 preset_name 參數。");
      if (!args.host || !args.user) {
        return errorResp("save 需要 host + user 參數。");
      }

      const presets = await loadPresets();
      const isUpdate = !!presets[args.preset_name];

      presets[args.preset_name] = {
        host:             args.host,
        port:             args.port || 22,
        user:             args.user,
        password:         args.password || "",
        private_key_path: args.private_key_path || "",
        local_base:       args.local_base || "",
        remote_base:      args.remote_base || "",
        excludes:         args.excludes || [],
      };
      await savePresets(presets);

      const verb = isUpdate ? "更新" : "建立";
      const p = presets[args.preset_name];
      const lines = [
        `✅ Preset "${args.preset_name}" 已${verb}`,
        `   ${p.user}@${p.host}:${p.port}`,
      ];
      if (p.local_base) lines.push(`   local_base:  ${p.local_base}`);
      if (p.remote_base) lines.push(`   remote_base: ${p.remote_base}`);
      if (p.excludes.length) lines.push(`   excludes: ${p.excludes.join(", ")}`);
      lines.push("", `使用方式：sftp_connect preset="${args.preset_name}"`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    return errorResp(`未知 action: ${action}`, ["支援 save / list / delete"]);
  }
}
