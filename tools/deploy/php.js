import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import util from "util";
import { resolveSecurePath, CONFIG } from "../../config.js";
import { validateArgs } from "../_shared/utils.js";

const execPromise = util.promisify(exec);

// Docker 容器內的掛載路徑（D:\Project → /var/www/html）
const DOCKER_MOUNT = "/var/www/html";

/** 將本機 Windows 路徑轉為 Docker 容器內路徑 */
function toContainerPath(windowsPath) {
  const basePath = CONFIG.basePath.replace(/[\\/]+$/, "");
  const normalized = windowsPath.replace(/\\/g, "/");
  const baseNormalized = basePath.replace(/\\/g, "/");
  if (normalized.toLowerCase().startsWith(baseNormalized.toLowerCase())) {
    const relative = normalized.slice(baseNormalized.length);
    return `${DOCKER_MOUNT}${relative}`;
  }
  // 不在 basePath 內，原樣傳遞（可能是容器內絕對路徑）
  return normalized;
}

/** 檢查 Docker 容器是否在線 */
async function checkContainer(container) {
  try {
    const { stdout } = await execPromise(
      `docker inspect --format="{{.State.Running}}" ${container}`
    );
    if (!stdout.trim().includes("true")) throw new Error("not running");
    return null; // OK
  } catch {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `容器 ${container} 不存在或未啟動。\n建議動作：\n  • docker start ${container}\n  • 或確認容器名稱是否正確`,
      }],
    };
  }
}

// 記憶體 Cookie Jar（對話期間有效，MCP Server 重啟清空）
const cookieJars = new Map(); // jarName -> { cookieName: cookieValue }

function parseCookiesFromResponse(response) {
  const cookies = {};
  let headers = [];
  if (typeof response.headers.getSetCookie === "function") {
    headers = response.headers.getSetCookie();
  } else {
    const combined = response.headers.get("set-cookie");
    if (combined) headers = [combined];
  }
  for (const h of headers) {
    const nameValue = h.split(";")[0];
    const idx = nameValue.indexOf("=");
    if (idx > 0) cookies[nameValue.slice(0, idx).trim()] = nameValue.slice(idx + 1).trim();
  }
  return cookies;
}

function buildCookieHeader(jarName) {
  const jar = cookieJars.get(jarName);
  if (!jar || Object.keys(jar).length === 0) return null;
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "run_php_script",
    description: "在伺服器上執行 PHP 腳本 (CLI 模式)，並回傳輸出結果 (Stdout/Stderr)。可指定 Docker 容器執行。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "PHP 檔案路徑 (例如: test_case.php)" },
        args: { type: "string", description: "選填：傳遞給腳本的參數 (例如: id=1)" },
        container: { type: "string", description: "選填：Docker 容器名稱（如 dev-php84），有值時在容器內執行" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_php_code",
    description: "直接執行 PHP code string（免建暫存檔）。程式碼透過 stdin 傳入 PHP CLI，省掉 Write → run → rm 三步驟。自動補 <?php 標籤。",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "PHP 程式碼（可含或不含 <?php 開頭，會自動補上）" },
        container: { type: "string", description: "選填：Docker 容器名稱（如 dev-php84），有值時在容器內執行" },
        timeout: { type: "number", description: "執行逾時毫秒數（預設 30000）", default: 30000 },
      },
      required: ["code"],
    },
  },
  {
    name: "send_http_request",
    description: "發送 HTTP 請求。支援 Multipart 實體檔案上傳、Cookie Jar session 持久化（save_cookies_as / cookie_jar）。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整網址" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], default: "GET" },
        headers: { type: "object", description: "自訂標頭" },
        data: { type: "string", description: "一般欄位資料 (JSON 字串)" },
        cookie_jar: { type: "string", description: "從命名 jar 讀取 cookie 帶入請求（登入後使用），例如 'frontend'" },
        save_cookies_as: { type: "string", description: "將回應的 Set-Cookie 存入命名 jar，例如 'frontend'（通常在登入請求時使用）" },
        files: {
          type: "array",
          description: "檔案列表",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "表單欄位名稱 (例如 'file_upload')" },
              filePath: { type: "string", description: "本地實體檔案路徑 (優先使用)" },
              filename: { type: "string", description: "上傳後的檔名 (選填)" },
              content: { type: "string", description: "純文字內容 (若無 filePath 則用此模擬)" },
            },
            required: ["name"],
          },
        },
        max_response_size: { type: "integer", description: "回應 body 字元上限（預設 20000；設 0 或負數 = 不截斷）" },
      },
      required: ["url"],
    },
  },
  {
    name: "tail_log",
    description: "讀取檔案最後 N 行 (適用於查看 PHP Error Log)。可指定 Docker 容器內的 log 路徑。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Log 檔案路徑（容器模式下為容器內絕對路徑，如 /var/log/apache2/error.log）" },
        lines: { type: "number", description: "要讀取的行數 (預設 50)", default: 50 },
        container: { type: "string", description: "選填：Docker 容器名稱（如 dev-php84），有值時讀取容器內的 log" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_php_test",
    description: "自動建立測試環境 (Session/Config) 並執行 PHP 腳本。可指定 Docker 容器執行。",
    inputSchema: {
      type: "object",
      properties: {
        targetPath: { type: "string", description: "要測試的 PHP 檔案路徑" },
        configPath: { type: "string", description: "設定檔路徑 (例如 config.php)" },
        sessionData: { type: "string", description: "模擬 $_SESSION 的 JSON 資料" },
        postData: { type: "string", description: "模擬 $_POST 的 JSON 資料" },
        container: { type: "string", description: "選填：Docker 容器名稱（如 dev-php84），有值時在容器內執行" },
      },
      required: ["targetPath"],
    },
  },
  {
    name: "run_php_script_batch",
    description: "批次執行多個 PHP 腳本（循序執行，減少 tool call 來回）。可指定 Docker 容器執行。",
    inputSchema: {
      type: "object",
      properties: {
        container: { type: "string", description: "選填：Docker 容器名稱（如 dev-php84），有值時所有腳本在容器內執行" },
        scripts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "PHP 檔案路徑" },
              args: { type: "string", description: "選填：傳遞給腳本的參數" },
              label: { type: "string", description: "選填：標籤方便識別" },
            },
            required: ["path"],
          },
          description: "腳本陣列，每項含 path 與可選的 args/label",
        },
      },
      required: ["scripts"],
    },
  },
  {
    name: "send_http_requests_batch",
    description: "批次發送多個 HTTP 請求（並行執行，減少 tool call 來回）",
    inputSchema: {
      type: "object",
      properties: {
        requests: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "請求標籤（選填，方便識別）" },
              url: { type: "string", description: "完整網址" },
              method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], default: "GET" },
              headers: { type: "object", description: "自訂標頭" },
              data: { type: "string", description: "請求資料 (JSON 字串)" },
              cookie_jar: { type: "string", description: "從命名 jar 讀取 cookie 帶入請求" },
            },
            required: ["url"],
          },
          description: "HTTP 請求陣列",
        },
        max_response_size: { type: "integer", description: "每筆回應 body 字元上限（預設 8000；設 0 或負數 = 不截斷）" },
      },
      required: ["requests"],
    },
  },
];

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  if (name === "run_php_script") {
    const isContainerAbsPath = args.container && /^\//.test(args.path);
    const fullPath = isContainerAbsPath ? args.path : resolveSecurePath(args.path);
    if (!fullPath.endsWith(".php")) throw new Error("安全限制：只能執行 .php 檔案");

    try {
      let cmd;
      let label = "";
      if (args.container) {
        const err = await checkContainer(args.container);
        if (err) return err;
        const containerPath = isContainerAbsPath ? fullPath : toContainerPath(fullPath);
        cmd = `docker exec ${args.container} php "${containerPath}" ${args.args || ""}`;
        label = ` [${args.container}]`;
      } else {
        cmd = `php "${fullPath}" ${args.args || ""}`;
      }
      const { stdout, stderr } = await execPromise(cmd, { timeout: 30000 });
      return {
        content: [
          {
            type: "text",
            text: `📝 PHP 執行結果${label}：\n${stdout}\n${stderr ? `⚠️ 錯誤輸出：\n${stderr}` : ""}`,
          },
        ],
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `執行失敗: ${error.message}` }] };
    }
  }

  if (name === "run_php_code") {
    const timeout = args.timeout || 30000;
    let code = args.code;
    if (!/^\s*<\?php/.test(code)) code = "<?php\n" + code;

    try {
      let cmd, label = "";
      if (args.container) {
        const err = await checkContainer(args.container);
        if (err) return err;
        cmd = `docker exec -i ${args.container} php`;
        label = ` [${args.container}]`;
      } else {
        cmd = `php`;
      }

      const { stdout, stderr } = await new Promise((resolve, reject) => {
        const proc = exec(cmd, { timeout }, (err, stdout, stderr) => {
          if (err && err.code !== 1 && err.killed !== true) {
            err.stdout = stdout;
            err.stderr = stderr;
            return reject(err);
          }
          resolve({ stdout, stderr });
        });
        proc.stdin.end(code);
      });

      return {
        content: [{
          type: "text",
          text: `📝 PHP 執行結果${label}：\n${stdout}${stderr ? `\n⚠️ 錯誤輸出：\n${stderr}` : ""}`,
        }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `執行失敗: ${error.message}${error.stdout ? `\nstdout: ${error.stdout}` : ""}${error.stderr ? `\nstderr: ${error.stderr}` : ""}` }],
      };
    }
  }

  if (name === "send_http_request") {
    try {
      const headers = args.headers || {};
      let body = null;

      // Cookie Jar：讀取已存 session cookie
      if (args.cookie_jar) {
        const cookieHeader = buildCookieHeader(args.cookie_jar);
        if (cookieHeader) headers["Cookie"] = cookieHeader;
      }

      if (args.files && Array.isArray(args.files) && args.files.length > 0) {
        const formData = new FormData();

        if (args.data) {
          try {
            const fields = typeof args.data === "string" ? JSON.parse(args.data) : args.data;
            for (const [key, value] of Object.entries(fields)) formData.append(key, value);
          } catch (e) {}
        }

        for (const file of args.files) {
          let blob;
          let finalFilename = file.filename;

          if (file.filePath) {
            const fullPath = resolveSecurePath(file.filePath);
            const fileBuffer = await fs.readFile(fullPath);
            blob = new Blob([fileBuffer]);
            if (!finalFilename) finalFilename = path.basename(fullPath);
          } else {
            blob = new Blob([file.content || ""], { type: "text/plain" });
            if (!finalFilename) finalFilename = "test.txt";
          }

          formData.append(file.name, blob, finalFilename);
        }

        body = formData;
        delete headers["Content-Type"];
      } else {
        body = args.data;
        if (
          headers["Content-Type"]?.includes("application/x-www-form-urlencoded") &&
          body
        ) {
          try {
            body = new URLSearchParams(JSON.parse(body)).toString();
          } catch (e) {}
        }
      }

      const options = { method: args.method || "GET", headers };
      if (args.method !== "GET" && args.method !== "HEAD" && body) options.body = body;

      const response = await fetch(args.url, options);
      const text = await response.text();

      // Cookie Jar：存入回應 Set-Cookie
      let cookieNote = "";
      if (args.save_cookies_as) {
        const newCookies = parseCookiesFromResponse(response);
        if (Object.keys(newCookies).length > 0) {
          const existing = cookieJars.get(args.save_cookies_as) || {};
          cookieJars.set(args.save_cookies_as, { ...existing, ...newCookies });
          cookieNote = `\n🍪 Cookie Jar "${args.save_cookies_as}" 已儲存：${Object.keys(newCookies).join(", ")}`;
        } else {
          cookieNote = `\n🍪 Cookie Jar "${args.save_cookies_as}"：回應無 Set-Cookie`;
        }
      }

      const maxSize = args.max_response_size === undefined ? 20000 : args.max_response_size;
      const unlimited = !Number.isFinite(maxSize) || maxSize <= 0;
      const totalLen = text.length;
      const responseBody = unlimited ? text : text.substring(0, maxSize);
      const truncNote = (!unlimited && totalLen > maxSize)
        ? `\n... ⚠️ 已截斷（${responseBody.length}/${totalLen} 字元，傳 max_response_size:0 取完整內容）`
        : "";
      return {
        content: [{ type: "text", text: `🌐 HTTP ${response.status}${cookieNote}\n${responseBody}${truncNote}` }],
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `請求失敗: ${error.message}` }] };
    }
  }

  if (name === "tail_log") {
    const lineCount = args.lines || 50;

    if (args.container) {
      // Docker 模式：直接用容器內路徑，不走 resolveSecurePath
      const err = await checkContainer(args.container);
      if (err) return err;
      try {
        const cmd = `docker exec ${args.container} tail -n ${lineCount} "${args.path}"`;
        const { stdout, stderr } = await execPromise(cmd, { timeout: 10000 });
        return { content: [{ type: "text", text: `📋 [${args.container}] ${args.path} (last ${lineCount} lines):\n${stdout}${stderr ? `\n⚠️ ${stderr}` : ""}` }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `讀取失敗 [${args.container}]: ${error.message}` }] };
      }
    }

    // 本機模式
    const fullPath = resolveSecurePath(args.path);
    const content = await fs.readFile(fullPath, "utf-8");
    const lines = content.split(/\r?\n/);
    const lastLines = lines.slice(-lineCount).join("\n");
    return { content: [{ type: "text", text: lastLines }] };
  }

  if (name === "run_php_test") {
    const useDocker = !!args.container;

    if (useDocker) {
      // ── Docker 模式：runner 檔在容器內建立與清理 ──
      const err = await checkContainer(args.container);
      if (err) return err;

      // 路徑解析：支援本機路徑（轉容器路徑）或容器內絕對路徑
      let targetInCode, configInCode, runnerDir;
      try {
        const localPath = resolveSecurePath(args.targetPath);
        targetInCode = toContainerPath(localPath);
        runnerDir = path.posix.dirname(targetInCode);
      } catch {
        // resolveSecurePath 失敗 → 當作容器內絕對路徑
        targetInCode = args.targetPath.replace(/\\/g, "/");
        runnerDir = path.posix.dirname(targetInCode);
      }
      if (args.configPath) {
        try {
          configInCode = toContainerPath(resolveSecurePath(args.configPath));
        } catch {
          configInCode = args.configPath.replace(/\\/g, "/");
        }
      }

      let wrapperCode = "<?php\n";
      if (args.sessionData) {
        wrapperCode += "session_start();\n";
        wrapperCode += `$_SESSION = json_decode('${args.sessionData.replace(/'/g, "\\'")}', true);\n`;
      }
      if (args.postData) {
        wrapperCode += `$_POST = json_decode('${args.postData.replace(/'/g, "\\'")}', true);\n`;
      }
      if (configInCode) {
        wrapperCode += `require_once '${configInCode}';\n`;
      }
      wrapperCode += `require '${targetInCode}';\n`;

      const runnerName = `_mcp_runner_${Date.now()}.php`;
      const runnerPath = `${runnerDir}/${runnerName}`;

      // 在容器內建立 runner 檔（用 docker exec -i + stdin pipe，避免 shell 引號問題）
      try {
        await new Promise((resolve, reject) => {
          const proc = exec(
            `docker exec -i ${args.container} tee "${runnerPath}" > /dev/null`,
            { timeout: 10000 },
            (err) => err ? reject(err) : resolve()
          );
          proc.stdin.end(wrapperCode);
        });
        const { stdout, stderr } = await execPromise(
          `docker exec ${args.container} php "${runnerPath}"`,
          { timeout: 30000 }
        );
        return {
          content: [{
            type: "text",
            text: `📝 測試結果 [${args.container}]：\n${stdout}\n${stderr ? `⚠️ 錯誤：\n${stderr}` : ""}`,
          }],
        };
      } finally {
        await execPromise(`docker exec ${args.container} rm -f "${runnerPath}"`).catch(() => {});
      }
    }

    // ── 本機模式 ──
    const targetPath = resolveSecurePath(args.targetPath);
    const configPath = args.configPath ? resolveSecurePath(args.configPath) : null;

    const targetInCode = targetPath.replace(/\\/g, "/");
    const configInCode = configPath ? configPath.replace(/\\/g, "/") : null;

    let wrapperCode = "<?php\n";
    if (args.sessionData) {
      wrapperCode += "session_start();\n";
      wrapperCode += `$_SESSION = json_decode('${args.sessionData.replace(/'/g, "\\'")}', true);\n`;
    }
    if (args.postData) {
      wrapperCode += `$_POST = json_decode('${args.postData.replace(/'/g, "\\'")}', true);\n`;
    }
    if (configInCode) {
      wrapperCode += `require_once '${configInCode}';\n`;
    }
    wrapperCode += `require '${targetInCode}';\n`;

    const tempFile = path.join(path.dirname(targetPath), `_mcp_runner_${Date.now()}.php`);
    await fs.writeFile(tempFile, wrapperCode);

    try {
      const { stdout, stderr } = await execPromise(`php "${tempFile}"`, { timeout: 30000 });
      return {
        content: [{
          type: "text",
          text: `📝 測試結果：\n${stdout}\n${stderr ? `⚠️ 錯誤：\n${stderr}` : ""}`,
        }],
      };
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  }

  if (name === "run_php_script_batch") {
    if (!args.scripts || args.scripts.length === 0) {
      return { isError: true, content: [{ type: "text", text: "scripts 陣列不可為空。" }] };
    }
    const useDocker = !!args.container;
    if (useDocker) {
      const err = await checkContainer(args.container);
      if (err) return err;
    }
    const envLabel = useDocker ? ` [${args.container}]` : "";
    const results = [];
    let okCount = 0;
    for (let i = 0; i < args.scripts.length; i++) {
      const s = args.scripts[i];
      const label = s.label || `Script ${i + 1}`;
      try {
        const isAbsPath = useDocker && /^\//.test(s.path);
        const fullPath = isAbsPath ? s.path : resolveSecurePath(s.path);
        if (!fullPath.endsWith(".php")) {
          results.push(`[${i + 1}] ${label} ❌ 安全限制：只能執行 .php 檔案`);
          continue;
        }
        let cmd;
        if (useDocker) {
          cmd = `docker exec ${args.container} php "${isAbsPath ? fullPath : toContainerPath(fullPath)}" ${s.args || ""}`;
        } else {
          cmd = `php "${fullPath}" ${s.args || ""}`;
        }
        const { stdout, stderr } = await execPromise(cmd, { timeout: 30000 });
        const output = stdout + (stderr ? `\n⚠️ stderr: ${stderr}` : "");
        results.push(`[${i + 1}] ${label} ✅ ${s.path}\n${output.substring(0, 1500)}${output.length > 1500 ? "\n... (截斷)" : ""}`);
        okCount++;
      } catch (err) {
        results.push(`[${i + 1}] ${label} ❌ ${s.path}\n${err.message.substring(0, 500)}`);
      }
    }
    return {
      content: [{
        type: "text",
        text: `批次 PHP 執行${envLabel}（${args.scripts.length} 個，✅${okCount} ❌${args.scripts.length - okCount}）：\n\n${results.join("\n\n---\n\n")}`,
      }],
    };
  }

  if (name === "send_http_requests_batch") {
    const batchMaxSize = args.max_response_size === undefined ? 8000 : args.max_response_size;
    const batchUnlimited = !Number.isFinite(batchMaxSize) || batchMaxSize <= 0;
    const tasks = args.requests.map(async (req, i) => {
      const label = req.label || `Request ${i + 1}`;
      try {
        const headers = req.headers || {};
        let body = null;

        // Cookie Jar：批次請求支援從 jar 讀取 cookie
        if (req.cookie_jar) {
          const cookieHeader = buildCookieHeader(req.cookie_jar);
          if (cookieHeader) headers["Cookie"] = cookieHeader;
        }

        if (req.data) {
          body = req.data;
          if (headers["Content-Type"]?.includes("application/x-www-form-urlencoded")) {
            try { body = new URLSearchParams(JSON.parse(req.data)).toString(); } catch (e) {}
          }
        }

        const options = { method: req.method || "GET", headers };
        if (req.method !== "GET" && req.method !== "HEAD" && body) options.body = body;

        const response = await fetch(req.url, options);
        const text = await response.text();
        const slice = batchUnlimited ? text : text.substring(0, batchMaxSize);
        const trunc = (!batchUnlimited && text.length > batchMaxSize) ? `\n... ⚠️ 已截斷（${slice.length}/${text.length}）` : "";
        return `[${i + 1}] ${label} ✅ HTTP ${response.status} ${req.method || "GET"} ${req.url}\n${slice}${trunc}`;
      } catch (err) {
        return `[${i + 1}] ${label} ❌ ${req.method || "GET"} ${req.url}\n${err.message}`;
      }
    });

    const results = await Promise.all(tasks);
    const successCount = results.filter((r) => r.includes("✅")).length;
    const failCount = results.length - successCount;

    return {
      content: [{
        type: "text",
        text: `批次 HTTP（${results.length} 個，✅${successCount} ❌${failCount}）：\n\n${results.join("\n\n---\n\n")}`,
      }],
    };
  }
}
