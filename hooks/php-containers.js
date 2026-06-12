#!/usr/bin/env node
/**
 * PHP 容器自動發現（跨環境，不寫死容器名）
 *
 * 思路：不假設容器叫什麼，直接問 Docker——
 *   1. docker ps 列出在跑的容器
 *   2. 逐一 `php -r 'echo PHP_VERSION;'`，問得到版本的就是 PHP 容器
 *   3. 依版本由新到舊排序
 * 結果寫進 ~/.claude/php-containers-cache.json，TTL 內直接讀快取，
 * 避免每次 Write/Edit 都重掃 docker（hook 每次都是新 process，靠磁碟快取跨呼叫共用）。
 *
 * 回傳：[{ name, version, num }]，由新到舊；無 docker / 無 php 容器時回 []。
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CACHE_FILE = path.join(os.homedir(), '.claude', 'php-containers-cache.json');
const TTL_MS = 30 * 60 * 1000; // 30 分鐘刷新一次

// 從可能夾雜 xdebug 雜訊的輸出中抓 PHP 版本號
function parseVersion(out) {
  const m = (out || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return {
    version: `${m[1]}.${m[2]}.${m[3]}`,
    num: parseInt(m[1], 10) * 10000 + parseInt(m[2], 10) * 100 + parseInt(m[3], 10),
  };
}

function discover() {
  let names = [];
  try {
    const out = execSync('docker ps --format "{{.Names}}"', { timeout: 5000, encoding: 'utf-8' });
    names = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // 沒有 docker / daemon 沒開
  }
  const result = [];
  for (const name of names) {
    try {
      // 非 PHP 容器會「command not found」快速失敗，不會等到 timeout
      const out = execSync(`docker exec ${name} php -r "echo PHP_VERSION;" 2>&1`, {
        timeout: 4000,
        encoding: 'utf-8',
      });
      const v = parseVersion(out);
      if (v) result.push({ name, version: v.version, num: v.num });
    } catch {
      // 非 PHP 容器或執行失敗 → 略過
    }
  }
  result.sort((a, b) => b.num - a.num); // 新 → 舊
  return result;
}

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (raw && Number.isFinite(raw.ts) && Date.now() - raw.ts < TTL_MS && Array.isArray(raw.containers)) {
      return raw.containers;
    }
  } catch {}
  return null;
}

function writeCache(containers) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), containers }));
  } catch {}
}

/**
 * 取得 PHP 容器清單（由新到舊）。
 * @param {object} opts
 * @param {boolean} opts.refresh 強制重新掃描，忽略快取
 * @returns {Array<{name:string, version:string, num:number}>}
 */
export function getPhpContainers({ refresh = false } = {}) {
  // env 覆寫：特殊環境可指定容器名（逗號分隔，由新到舊）；版本未知留 null
  const envOverride = process.env.MCP_PHP_LINT_CONTAINERS;
  if (envOverride) {
    return envOverride
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name, version: null, num: null }));
  }
  if (!refresh) {
    const cached = readCache();
    if (cached) return cached;
  }
  const found = discover();
  writeCache(found);
  return found;
}
