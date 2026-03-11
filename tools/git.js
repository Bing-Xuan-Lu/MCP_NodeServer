import { exec } from "child_process";
import util from "util";

const execPromise = util.promisify(exec);

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "git_status",
    description: "查看目前 Git 工作目錄狀態 (git status)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "git_diff",
    description: "查看檔案改動內容 (git diff)",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "指定檔案路徑（選填，不填則顯示所有未暫存改動）" },
        staged: { type: "boolean", description: "是否查看已暫存 (staged) 的改動" },
      },
    },
  },
  {
    name: "git_log",
    description: "查看最近的 Commit 歷史 (git log)",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "顯示筆數 (預設 5)", default: 5 },
      },
    },
  },
  {
    name: "git_stash_ops",
    description: "執行 Git Stash 相關操作 (push, pop, list)",
    inputSchema: {
      type: "object",
      properties: {
        action: { 
          type: "string", 
          enum: ["push", "pop", "list"], 
          description: "操作類型" 
        },
        message: { type: "string", description: "Stash 訊息 (僅 push 適用)" },
      },
      required: ["action"],
    },
  },
];

// ============================================
// 工具處理
// ============================================
export async function handle(name, args) {
  if (name === "git_status") return runGit("git status");
  if (name === "git_diff") {
    let cmd = "git diff";
    if (args.staged) cmd += " --staged";
    if (args.file_path) cmd += ` -- "${args.file_path}"`;
    return runGit(cmd);
  }
  if (name === "git_log") {
    const limit = args.limit || 5;
    return runGit(`git log -n ${limit} --oneline`);
  }
  if (name === "git_stash_ops") {
    if (args.action === "push") {
      const msg = args.message ? ` -m "${args.message}"` : "";
      return runGit(`git stash push${msg}`);
    }
    if (args.action === "pop") return runGit("git stash pop");
    if (args.action === "list") return runGit("git stash list");
  }
}

async function runGit(cmd) {
  try {
    const { stdout, stderr } = await execPromise(cmd);
    const output = stdout || stderr || "(無輸出)";
    return {
      content: [{ type: "text", text: output.trimEnd() }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Git 指令執行失敗：\n${err.message}` }],
    };
  }
}
