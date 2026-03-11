import { exec } from "child_process";
import util from "util";

const execPromise = util.promisify(exec);

const CONTAINER = "python_runner";
const DEVELOP_MOUNT = "/develop"; // D:\Develop 掛載路徑

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
      },
    },
  },
];

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  if (name === "run_python_script") {
    return runPython(args);
  }
}

async function runPython({ code, file_path, args: scriptArgs }) {
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

  if (file_path) {
    // 檔案模式：將 Windows 路徑轉換為容器內路徑
    const containerPath = `${DEVELOP_MOUNT}/${file_path.replace(/\\/g, "/")}`;
    const safeArgs = scriptArgs ? ` ${scriptArgs}` : "";
    cmd = `docker exec ${CONTAINER} python3 "${containerPath}"${safeArgs}`;
  } else if (code) {
    // Inline 模式：透過 stdin 傳入避免引號逸出問題
    const escaped = code.replace(/'/g, "'\\''");
    cmd = `echo '${escaped}' | docker exec -i ${CONTAINER} python3`;
  } else {
    return {
      isError: true,
      content: [{ type: "text", text: "請提供 code（inline 程式碼）或 file_path（.py 檔案路徑）" }],
    };
  }

  try {
    const { stdout, stderr } = await execPromise(cmd, { timeout: 30000 });
    const output = [];
    if (stdout) output.push(`stdout:\n${stdout.trimEnd()}`);
    if (stderr) output.push(`stderr:\n${stderr.trimEnd()}`);
    return {
      content: [{ type: "text", text: output.join("\n\n") || "(無輸出)" }],
    };
  } catch (err) {
    const msg = err.stdout || err.stderr || err.message;
    return {
      isError: true,
      content: [{ type: "text", text: `執行失敗：\n${msg}` }],
    };
  }
}
