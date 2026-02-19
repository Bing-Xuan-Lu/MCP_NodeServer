import path from "path";
import "dotenv/config";

export const CONFIG = {
  basePath: "D:\\Project\\",
  db: {
    host: process.env.DB_HOST || "127.0.0.1",
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "pnsdb",
  },
};

/** 安全路徑解析：禁止存取 basePath 以外的目錄 */
export function resolveSecurePath(userPath) {
  const targetPath = path.resolve(CONFIG.basePath, userPath);
  const normalizedTarget = targetPath.toLowerCase();
  const normalizedBase = CONFIG.basePath.toLowerCase();

  if (!normalizedTarget.startsWith(normalizedBase)) {
    throw new Error(`安全限制：禁止存取路徑 ${targetPath}`);
  }
  return targetPath;
}
