import { exec } from "child_process";
import util from "util";
import { validateArgs } from "../_shared/utils.js";
import { resolveSecurePath } from "../../config.js";

const execPromise = util.promisify(exec);

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "git_status",
    description: "查看目前 Git 工作目錄狀態 (git status)。可指定 Docker 容器執行。",
    inputSchema: {
      type: "object",
      properties: {
        container: { type: "string", description: "選填：Docker 容器名稱（如 dev-php84），有值時在容器內執行" },
        cwd: { type: "string", description: "選填：本機模式下 git 執行目錄（相對 basePath 或絕對路徑），例如 '{ProjectFolder}'。不填則用 MCP Server 啟動目錄" },
        workdir: { type: "string", description: "選填：container 模式下容器內 git 執行目錄，預設 /var/www/html。若 repo 在子目錄請指定（如 /var/www/html/{ProjectFolder}）" },
      },
    },
  },
  {
    name: "git_diff",
    description: "查看檔案改動內容 (git diff)。可指定 Docker 容器執行。",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "指定檔案路徑（選填，不填則顯示所有未暫存改動）" },
        staged: { type: "boolean", description: "是否查看已暫存 (staged) 的改動" },
        container: { type: "string", description: "選填：Docker 容器名稱（如 dev-php84），有值時在容器內執行" },
        cwd: { type: "string", description: "選填：本機模式下 git 執行目錄（相對 basePath 或絕對路徑），例如 '{ProjectFolder}'。不填則用 MCP Server 啟動目錄" },
        workdir: { type: "string", description: "選填：container 模式下容器內 git 執行目錄，預設 /var/www/html。若 repo 在子目錄請指定（如 /var/www/html/{ProjectFolder}）" },
      },
    },
  },
  {
    name: "git_log",
    description: "查看最近的 Commit 歷史 (git log)。可指定 Docker 容器執行。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "顯示筆數 (預設 5)", default: 5 },
        container: { type: "string", description: "選填：Docker 容器名稱（如 dev-php84），有值時在容器內執行" },
        cwd: { type: "string", description: "選填：本機模式下 git 執行目錄（相對 basePath 或絕對路徑），例如 '{ProjectFolder}'。不填則用 MCP Server 啟動目錄" },
        workdir: { type: "string", description: "選填：container 模式下容器內 git 執行目錄，預設 /var/www/html。若 repo 在子目錄請指定（如 /var/www/html/{ProjectFolder}）" },
      },
    },
  },
  {
    name: "git_stash_ops",
    description: "執行 Git Stash 相關操作 (push, pop, list)。可指定 Docker 容器執行。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["push", "pop", "list"],
          description: "操作類型"
        },
        message: { type: "string", description: "Stash 訊息 (僅 push 適用)" },
        container: { type: "string", description: "選填：Docker 容器名稱（如 dev-php84），有值時在容器內執行" },
        cwd: { type: "string", description: "選填：本機模式下 git 執行目錄（相對 basePath 或絕對路徑），例如 '{ProjectFolder}'。不填則用 MCP Server 啟動目錄" },
        workdir: { type: "string", description: "選填：container 模式下容器內 git 執行目錄，預設 /var/www/html。若 repo 在子目錄請指定（如 /var/www/html/{ProjectFolder}）" },
      },
      required: ["action"],
    },
  },
];

// ============================================
// 工具處理
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  const container = args.container || null;

  // 解析執行目錄：本機模式用 cwd（resolveSecurePath 防越界），container 模式用 workdir
  let hostCwd = null;
  if (!container && args.cwd) {
    try {
      hostCwd = resolveSecurePath(args.cwd);
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `cwd 安全檢查失敗：${e.message}` }] };
    }
  }
  const opts = { cwd: hostCwd, workdir: args.workdir || null };

  if (name === "git_status") return runGit("git status", container, opts);
  if (name === "git_diff") {
    let cmd = "git diff";
    if (args.staged) cmd += " --staged";
    if (args.file_path) cmd += ` -- "${args.file_path}"`;
    return runGit(cmd, container, opts);
  }
  if (name === "git_log") {
    const limit = args.limit || 5;
    return runGit(`git log -n ${limit} --oneline`, container, opts);
  }
  if (name === "git_stash_ops") {
    if (args.action === "push") {
      const msg = args.message ? ` -m "${args.message}"` : "";
      return runGit(`git stash push${msg}`, container, opts);
    }
    if (args.action === "pop") return runGit("git stash pop", container, opts);
    if (args.action === "list") return runGit("git stash list", container, opts);
  }
}

async function runGit(cmd, container, opts = {}) {
  const workdir = container ? (opts.workdir || "/var/www/html") : null;
  try {
    let execCmd, label;
    if (container) {
      // -w 指定容器內工作目錄，避免在容器預設 cwd（非 repo）跑 git → "not a git repository"
      execCmd = `docker exec -w "${workdir}" ${container} ${cmd}`;
      label = ` [${container}:${workdir}]`;
    } else {
      execCmd = cmd;
      label = opts.cwd ? ` [${opts.cwd}]` : "";
    }
    const execOpts = { timeout: 15000 };
    if (!container && opts.cwd) execOpts.cwd = opts.cwd;
    const { stdout, stderr } = await execPromise(execCmd, execOpts);
    const output = stdout || stderr || "(無輸出)";
    return {
      content: [{ type: "text", text: `${output.trimEnd()}${label}` }],
    };
  } catch (err) {
    let hint = "";
    if (/not a git repository/i.test(err.message)) {
      hint = container
        ? `\n💡 容器內 ${workdir} 不是 git repo。請用 workdir 指定正確路徑（如 /var/www/html/{project}），或省略 container 改用本機 git（可加 cwd 指定專案目錄）。`
        : `\n💡 當前目錄不是 git repo。請用 cwd 指定專案目錄（如 cwd:"{ProjectFolder}"）。`;
    }
    return {
      isError: true,
      content: [{ type: "text", text: `Git 指令執行失敗：\n${err.message}${hint}` }],
    };
  }
}
