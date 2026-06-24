#!/usr/bin/env node
/**
 * PostToolUse Hook — TaskStop + Bash(run_in_background) Docker Child Warning
 *
 * 問題：TaskStop 只 kill 外層 shell pipe，若該 background task 是 `docker exec` 啟動，
 *        container 內 child process 仍在跑（曾踩坑：以為 kill 了實際還在燒 sheet API）。
 *
 * 機制：
 *   1. PostToolUse(Bash) 偵測 run_in_background=true + 命令含 docker exec → 寫入 cache
 *      cache 路徑：%TEMP%/claude_docker_bg_tasks/<task_id>.cmd
 *   2. PostToolUse(TaskStop) 讀 task_id 對應的 cache → 若存在則提醒 + 給驗證指令
 *
 * 非阻擋：只輸出提醒 (exit 0)。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const CACHE_DIR = path.join(os.tmpdir(), 'claude_docker_bg_tasks');
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 小時自動清

function ensureCacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) {}
}

function cleanOldEntries() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > MAX_AGE_MS) fs.unlinkSync(fp);
    }
  } catch (e) {}
}

function extractDockerCommand(cmd) {
  // 匹配 `docker exec <container> <executable>` 模式
  const m = cmd.match(/docker\s+exec\s+(?:-\w+\s+)*([\w.-]+)\s+(\S+)/);
  if (!m) return null;
  return { container: m[1], executable: m[2] };
}

function extractTaskId(text) {
  if (!text) return null;
  // background task return msg: "Command running in background with ID: <id>"
  const m = text.match(/background with ID:\s*([a-z0-9]+)/i);
  return m ? m[1] : null;
}

function getStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (chunk) => { buf += chunk.toString(); });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  ensureCacheDir();
  cleanOldEntries();

  const raw = await getStdin();
  if (!raw) { process.exit(0); }

  let payload;
  try { payload = JSON.parse(raw); } catch (e) { process.exit(0); }

  const toolName = payload.tool_name || payload.tool || '';
  const toolInput = payload.tool_input || payload.input || {};
  const toolResponse = payload.tool_response || payload.response || {};

  // Branch 1: Bash with run_in_background → cache
  if (toolName === 'Bash' && toolInput.run_in_background) {
    const command = String(toolInput.command || '');
    const docker = extractDockerCommand(command);
    if (!docker) { process.exit(0); }
    // Extract task_id from tool response
    const responseText = typeof toolResponse === 'string'
      ? toolResponse
      : (toolResponse.output || JSON.stringify(toolResponse));
    const taskId = extractTaskId(responseText);
    if (!taskId) { process.exit(0); }
    // Cache
    const cacheFile = path.join(CACHE_DIR, `${taskId}.cmd`);
    fs.writeFileSync(cacheFile, JSON.stringify({
      task_id: taskId, command, container: docker.container, executable: docker.executable, ts: Date.now(),
    }, null, 2));
    process.exit(0);
  }

  // Branch 2: TaskStop → check cache + warn
  if (toolName === 'TaskStop') {
    const taskId = toolInput.task_id || toolInput.shell_id || '';
    if (!taskId) { process.exit(0); }
    const cacheFile = path.join(CACHE_DIR, `${taskId}.cmd`);
    if (!fs.existsSync(cacheFile)) { process.exit(0); }
    let entry;
    try { entry = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')); } catch (e) { process.exit(0); }
    // Output warning
    const exe = entry.executable.split(/[\\/]/).pop();
    const msg = `⚠️  [TaskStop docker-child] 該 background task 透過 \`docker exec ${entry.container}\` 啟動 child process。
TaskStop 只 kill 外層 pipe，container 內 \`${exe}\` 可能仍在跑。

驗證指令：
  docker exec ${entry.container} ps -ef | grep -E "${exe.replace(/\./g, '\\.')}" | grep -v grep

若還在跑，kill it：
  docker exec ${entry.container} kill <pid>`;
    process.stdout.write(msg + '\n');
    // 清掉 cache（已提醒過就不再提醒）
    try { fs.unlinkSync(cacheFile); } catch (e) {}
    process.exit(0);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
