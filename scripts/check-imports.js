#!/usr/bin/env node
/**
 * check-imports.js — 驗證所有 tool 模組的 import 路徑是否正確
 *
 * 用法：node scripts/check-imports.js
 * 時機：重構 tools/ 目錄結構後、移動檔案後、CI 檢查
 */

import { globSync } from "glob";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

process.chdir(ROOT);

const toolFiles = globSync("tools/**/*.js", { ignore: ["tools/_shared/**"] });

let ok = 0;
let fail = 0;

for (const file of toolFiles) {
  try {
    const m = await import(`../${file}`);
    if (m.definitions && m.handle) {
      ok++;
    } else {
      console.log(`⚠️  ${file} — missing definitions or handle export`);
      fail++;
    }
  } catch (e) {
    console.log(`❌ ${file} — ${e.message.split("\n")[0]}`);
    fail++;
  }
}

console.log(`\n${ fail === 0 ? "✅" : "🔴" } Result: ${ok} OK, ${fail} FAIL (${toolFiles.length} total)`);

if (fail > 0) {
  console.log("\nCommon fixes:");
  console.log("  - tools/{category}/xxx.js → config.js should be ../../config.js");
  console.log("  - tools/{category}/xxx.js → _shared/ should be ../_shared/");
  process.exit(1);
}
