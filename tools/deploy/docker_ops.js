// tools/deploy/docker_ops.js — 本機 Docker 容器操作（docker cp）
// 用途：把本機檔案放進 / 拉出 docker container，不走 SSH（ssh_exec 是 remote 用）
// 為什麼需要：本機檔案在容器掛載點外時（如 Downloads/ 的 SQL dump 要進 DB 容器），只能用 docker cp。
//
// 安全限制：
//   - 來源/目的本機路徑必須在 basePath 白名單下（沿用 config.resolveSecurePath）
//   - 容器名必須符合 docker container name regex（避免命令注入）
//   - container_path 不允許含 shell metachar
//   - 一律走 spawn（不走 shell exec），避免 injection

import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { validateArgs } from "../_shared/utils.js";
import { resolveSecurePath } from "../../config.js";

const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const CONTAINER_PATH_RE = /^[a-zA-Z0-9_\-./]+$/; // 限制：英數、_、-、.、/
const DEFAULT_TIMEOUT_MS = 60_000;

export const definitions = [
  {
    name: "docker_cp",
    description:
      "在本機把檔案／目錄複製進 docker container 或從 container 拉出來（等同 `docker cp` 但有安全防護）。" +
      "適用場景：本機 Downloads/ 或其他非容器掛載點的檔案要進容器（如 SQL dump 進 DB 容器）、" +
      "或從容器內 /tmp/ 拉產出檔案回本機。**這是本機 docker 操作，不是 SSH remote**：遠端機器請用 ssh_exec。",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["to_container", "from_container"],
          description:
            "to_container = 本機 → 容器（local_path → container:container_path）；" +
            "from_container = 容器 → 本機（container:container_path → local_path）",
        },
        container: {
          type: "string",
          description: "docker container 名稱或 ID（如 dev-php84、dev-mariadb）",
        },
        local_path: {
          type: "string",
          description: "本機絕對路徑（檔案或目錄），需在 MCP basePath 白名單下",
        },
        container_path: {
          type: "string",
          description: "容器內路徑（如 /tmp/dump.sql），限英數 + _-./",
        },
        timeout_ms: {
          type: "number",
          description: "逾時毫秒（預設 60000，最大 600000）",
        },
      },
      required: ["direction", "container", "local_path", "container_path"],
    },
  },
];

function runSpawn(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const proc = spawn(cmd, args, { shell: false });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr: stderr + `\n[timeout after ${timeoutMs}ms]`, timedOut: true });
    }, timeoutMs);
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n[spawn error: ${err.message}]`, timedOut: false });
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

export async function handle(name, args) {
  if (name !== "docker_cp") return undefined;
  args = validateArgs(definitions[0].inputSchema, args);

  const { direction, container, container_path, timeout_ms } = args;

  if (!CONTAINER_NAME_RE.test(container)) {
    return { isError: true, content: [{ type: "text", text: `容器名稱不合法：${container}` }] };
  }
  if (!CONTAINER_PATH_RE.test(container_path)) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `container_path 含不允許字元：${container_path}\n僅允許英數 + _ - . /，避免 shell injection。`,
      }],
    };
  }
  if (!path.isAbsolute(args.local_path)) {
    return { isError: true, content: [{ type: "text", text: `local_path 必須是絕對路徑：${args.local_path}` }] };
  }

  // 走 basePath 白名單，禁止任意路徑
  let localPath;
  try {
    localPath = resolveSecurePath(args.local_path);
  } catch (e) {
    return {
      isError: true,
      content: [{
        type: "text",
        text:
          `local_path 不在 basePath 白名單下：${args.local_path}\n` +
          `若是必要路徑（如 C:\\Users\\xxx\\Downloads\\），請先 grant_path_access。\n` +
          `原始錯誤：${e.message}`,
      }],
    };
  }

  // 方向檢查
  if (direction === "to_container") {
    try {
      await fs.access(localPath);
    } catch {
      return { isError: true, content: [{ type: "text", text: `本機來源不存在：${localPath}` }] };
    }
  }

  const timeoutMs = Math.min(Math.max(timeout_ms || DEFAULT_TIMEOUT_MS, 1000), 600_000);
  const srcArg = direction === "to_container" ? localPath : `${container}:${container_path}`;
  const dstArg = direction === "to_container" ? `${container}:${container_path}` : localPath;

  const result = await runSpawn("docker", ["cp", srcArg, dstArg], timeoutMs);

  const lines = [`$ docker cp ${srcArg} ${dstArg}`, `Exit code: ${result.code}`];
  if (result.stdout) lines.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
  if (result.stderr) lines.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
  if (result.code === 0 && !result.stdout && !result.stderr) lines.push("（成功，無輸出）");

  if (result.code !== 0) {
    const hints = ["確認 docker daemon 運行中（docker ps）", `確認容器名 \`${container}\` 存在`];
    if (result.timedOut) hints.unshift("增加 timeout_ms 後重試");
    if (/no such container/i.test(result.stderr)) {
      hints.push("可能容器名稱拼錯或容器已停止");
    }
    lines.push(`\n建議：${hints.map((h) => `  • ${h}`).join("\n")}`);
    return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
