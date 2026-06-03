import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import util from "util";
import { validateArgs } from "../_shared/utils.js";

const execPromise = util.promisify(exec);

const CONTAINER = "python_runner";
const DEVELOP_MOUNT = "/develop"; // 對應 D:\MCP_Server（python/docker-compose.yml `..:/develop`）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(__dirname, "..", "..");

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "run_python_script",
    description:
      "在 Docker Python 容器（python_runner）中執行 Python 程式碼。" +
      "支援兩種模式：傳入 code 執行 inline 程式碼；傳入 file_path 執行 D:\\Develop\\ 下的 .py 檔案。" +
      "容器已掛載 D:\\Develop → /develop，可直接讀寫專案內的任何檔案。",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "直接執行的 Python 程式碼（與 file_path 擇一）",
        },
        file_path: {
          type: "string",
          description:
            "相對於 D:\\Develop\\ 的 .py 檔案路徑，例如 python/scripts/fix_encoding.py（與 code 擇一）",
        },
        args: {
          type: "string",
          description: "傳給腳本的命令列參數（選填，僅 file_path 模式適用）",
        },
        timeout: {
          type: "number",
          description: "執行逾時毫秒數（預設 30000；長任務如影片字幕/大量資料比對可加大，上限 600000）",
          default: 30000,
        },
      },
    },
  },
];

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  if (name === "run_python_script") {
    return runPython(args);
  }
}

async function runPython({ code, file_path, args: scriptArgs, timeout }) {
  // 逾時：預設 30s，可由呼叫端加大（上限 600s），避免長任務被 30s 砍卻看不出原因
  const timeoutMs = Math.min(Math.max(parseInt(timeout, 10) || 30000, 1000), 600000);
  // 確認容器在線
  try {
    await execPromise(`docker inspect --format="{{.State.Running}}" ${CONTAINER}`);
  } catch {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `容器 ${CONTAINER} 不存在或未啟動。\n建議動作：\n  • 執行 cd D:\\Develop\\python && docker compose up -d`,
      }],
    };
  }

  let cmd;
  let tmpScript = null;

  if (file_path) {
    // 檔案模式：將 Windows 路徑轉換為容器內路徑
    const containerPath = `${DEVELOP_MOUNT}/${file_path.replace(/\\/g, "/")}`;
    const safeArgs = scriptArgs ? ` ${scriptArgs}` : "";
    cmd = `docker exec ${CONTAINER} python3 "${containerPath}"${safeArgs}`;
  } else if (code) {
    // Inline 模式：寫到 .tmp 再 docker exec 執行，避免 Windows cmd.exe 對 `echo 'code'` 的 quote 處理錯誤
    const tmpDir = path.join(MCP_ROOT, ".tmp");
    await fs.mkdir(tmpDir, { recursive: true });
    tmpScript = path.join(tmpDir, `pyrun_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.py`);
    await fs.writeFile(tmpScript, code, "utf-8");
    const containerPath = `${DEVELOP_MOUNT}/.tmp/${path.basename(tmpScript)}`;
    cmd = `docker exec ${CONTAINER} python3 "${containerPath}"`;
  } else {
    return {
      isError: true,
      content: [{ type: "text", text: "請提供 code（inline 程式碼）或 file_path（.py 檔案路徑）" }],
    };
  }

  try {
    const { stdout, stderr } = await execPromise(cmd, { timeout: timeoutMs });
    const output = [];
    if (stdout) output.push(`stdout:\n${stdout.trimEnd()}`);
    if (stderr) output.push(`stderr:\n${stderr.trimEnd()}`);
    return {
      content: [{ type: "text", text: output.join("\n\n") || "(無輸出)" }],
    };
  } catch (err) {
    // 區分「逾時被砍」與「程式真的出錯」——逾時時 exec 砍 process，stdout/stderr 多半為空，
    // 過去只回「Command failed」害人盲猜。這裡明講是逾時 + 怎麼處理。
    const timedOut = err.killed === true || err.signal === "SIGTERM" || err.code === "ETIMEDOUT";
    if (timedOut) {
      const partial = [err.stdout, err.stderr].filter(Boolean).map((s) => String(s).trimEnd()).join("\n");
      return {
        isError: true,
        content: [{
          type: "text",
          text:
            `⏱ 執行逾時：超過 ${timeoutMs} ms 被中止（非程式錯誤）。\n` +
            `建議：① 若是長任務（影片字幕 / 大量資料 / 跑數據），加大 timeout 參數（如 timeout: 120000，上限 600000）；` +
            `② 或把工作拆小、先跑一小段確認邏輯對再放大。\n` +
            (partial ? `\n逾時前的部分輸出：\n${partial}` : `（逾時前無任何輸出）`),
        }],
      };
    }
    const msg = err.stdout || err.stderr || err.message;
    return {
      isError: true,
      content: [{ type: "text", text: `執行失敗：\n${msg}` }],
    };
  } finally {
    if (tmpScript) await fs.unlink(tmpScript).catch(() => {});
  }
}
