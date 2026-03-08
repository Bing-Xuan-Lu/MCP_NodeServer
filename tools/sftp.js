import SftpClient from "ssh2-sftp-client";
import fs from "fs";
import path from "path";
import { resolveSecurePath } from "../config.js";

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

      const lines = items
        .sort((a, b) => (b.type === "d") - (a.type === "d") || a.name.localeCompare(b.name))
        .map((f) => {
          const type = f.type === "d" ? "[DIR] " : "      ";
          const size = f.type === "d" ? "        " : `${(f.size / 1024).toFixed(1).padStart(7)} KB`;
          const date = new Date(f.modifyTime).toLocaleString("zh-TW", { hour12: false });
          return `${type}${f.name.padEnd(32)} ${size}  ${date}`;
        });

      return {
        content: [{
          type: "text",
          text: `📁 ${args.remote_path} (${items.length} 項):\n\n${lines.join("\n")}`,
        }],
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
