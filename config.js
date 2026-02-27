import path from "path";

export const CONFIG = {
  basePath: "D:\\Project\\",
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
    : path.resolve(CONFIG.basePath, userPath);

  const normalizedTarget = targetPath.toLowerCase();

  // 1. 預設允許：basePath 以內
  if (normalizedTarget.startsWith(CONFIG.basePath.toLowerCase())) {
    return targetPath;
  }

  // 2. Runtime 白名單允許
  for (const extra of EXTRA_ALLOWED_PATHS) {
    const normalizedExtra = path.resolve(extra).toLowerCase();
    if (normalizedTarget.startsWith(normalizedExtra)) {
      return targetPath;
    }
  }

  throw new Error(
    `安全限制：禁止存取路徑 "${targetPath}"。\n` +
    `若確認安全，請先呼叫 grant_path_access 工具開放此路徑。`
  );
}
