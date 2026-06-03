import path from "path";
import os from "os";
import { createRequire } from "module";
import { MCP_BASE_PATHS } from "./env.js";

// 優先順序：.env (MCP_BASE_PATHS) → config.local.js → 硬編碼預設
let localConfig = {};
try {
  const require = createRequire(import.meta.url);
  localConfig = require("./config.local.js");
} catch {
  // 沒有 config.local.js 則使用預設值
}

export const CONFIG = {
  basePaths: MCP_BASE_PATHS ?? localConfig.basePaths ?? ["D:\\Project\\", "D:\\tmp\\"],
  /** @deprecated 向後相容：舊程式碼用 CONFIG.basePath，回傳 basePaths[0] */
  get basePath() { return this.basePaths[0]; },
};

/**
 * Runtime 額外允許路徑白名單（重啟 MCP Server 後自動清空）
 * 透過 grant_path_access 工具在對話中動態新增
 */
export const EXTRA_ALLOWED_PATHS = new Set();

/** 安全路徑解析：禁止存取 basePath 以外的目錄（除非在白名單中） */
export function resolveSecurePath(userPath) {
  // 判斷是否為絕對路徑（Windows: C:\... 或 Unix: /...）
  const isAbsolute = path.isAbsolute(userPath);
  const targetPath = isAbsolute
    ? path.resolve(userPath)
    : path.resolve(CONFIG.basePaths[0], userPath);

  const normalizedTarget = targetPath.toLowerCase();

  // 1. 預設允許：任一 basePath 以內
  if (CONFIG.basePaths.some(p => normalizedTarget.startsWith(p.toLowerCase()))) {
    return targetPath;
  }

  // 2. Runtime 白名單允許
  for (const extra of EXTRA_ALLOWED_PATHS) {
    const normalizedExtra = path.resolve(extra).toLowerCase();
    if (normalizedTarget.startsWith(normalizedExtra)) {
      return targetPath;
    }
  }

  // 3. Claude 記憶目錄預設允許（~/.claude/memory/ 與 ~/.claude/projects/<slug>/memory/）
  //    範圍鎖在 home 的 .claude 下、且路徑含 memory 區段；讓含中文記憶檔可走 create_file 避免 Write chunk 邊界截斷
  const claudeHome = path.join(os.homedir(), ".claude").toLowerCase();
  if (normalizedTarget.startsWith(claudeHome) && /[\\/]memory([\\/]|$)/i.test(normalizedTarget)) {
    return targetPath;
  }

  throw new Error(
    `安全限制：禁止存取路徑 "${targetPath}"。\n` +
    `若確認安全，請先呼叫 grant_path_access 工具開放此路徑。`
  );
}
