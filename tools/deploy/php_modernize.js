import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { resolveSecurePath, CONFIG } from "../../config.js";
import { validateArgs } from "../_shared/utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSFORMER_PHP = path.join(__dirname, "..", "_shared", "php_modernizer.php");

// D:\Project → /var/www/html（與 php.js 同一掛載慣例）
const DOCKER_MOUNT = "/var/www/html";

// 第三方套件資料夾：升級時自動跳過（與 /php_upgrade Skill 排除清單一致）
const DEFAULT_EXCLUDES = [
  "plugin", "plugins", "lib", "libs", "vendor", "node_modules", "packages",
  "third_party", "thirdparty", "ckeditor", "ckfinder", "tinymce",
  "phpmailer", "smarty", "tcpdf", "phpexcel", "mpdf", "dompdf", ".git",
];

const TRANSFORM_KEYS = [
  "remove_close_tag", "curly_offset", "php4_ctor",
  "var_to_public", "define_bareword", "autoload_register",
];

function toContainerPath(windowsPath) {
  const base = CONFIG.basePath.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const normalized = windowsPath.replace(/\\/g, "/");
  if (normalized.toLowerCase().startsWith(base.toLowerCase())) {
    return `${DOCKER_MOUNT}${normalized.slice(base.length)}`;
  }
  return null; // 不在掛載 basePath 內 → 容器看不到
}

function runExec(cmd, { timeout = 60000, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const proc = exec(cmd, { timeout, maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err && err.killed) return reject(new Error(`逾時或被中止：${err.message}`));
      resolve({ stdout: stdout || "", stderr: stderr || "", code: err ? (err.code ?? 0) : 0 });
    });
    if (input !== null) proc.stdin.end(input);
  });
}

async function checkContainer(container) {
  try {
    const { stdout } = await runExec(`docker inspect --format="{{.State.Running}}" ${container}`, { timeout: 10000 });
    return stdout.includes("true") ? null : `容器 ${container} 未啟動（docker start ${container}）`;
  } catch {
    return `容器 ${container} 不存在或未啟動（docker start ${container}）`;
  }
}

// 遞迴展開資料夾為 .php 檔清單，套用排除資料夾
async function collectPhpFiles(hostPath, recursive, excludeSet) {
  const stat = await fs.stat(hostPath);
  if (stat.isFile()) return hostPath.toLowerCase().endsWith(".php") ? [hostPath] : [];
  const out = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (excludeSet.has(e.name.toLowerCase())) continue;
        if (recursive) await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".php")) {
        out.push(full);
      }
    }
  }
  await walk(hostPath);
  return out;
}

const RULE_LABELS = {
  remove_close_tag: "移除結尾 ?>",
  curly_offset: "花括號取值 {n}→[n]",
  php4_ctor: "PHP4 建構子→__construct",
  var_to_public: "var→public",
  define_bareword: "define 裸常數加引號",
  autoload_register: "__autoload 補 spl_autoload_register",
};

export const definitions = [
  {
    name: "php_modernize",
    description:
      "PHP 舊版語法的『確定性機械升級』工具：用 PHP token_get_all 詞法分析（非 regex 散改）逐檔做語法等價轉換，" +
      "每個被改動的檔案在容器內 php -l 驗證通過才寫回。處理 6 條確定性規則：" +
      "①移除純 PHP 檔結尾 ?> ②$str{0}→$str[0] 花括號取值 ③PHP4 同名建構子→__construct（檔案含 namespace 自動略過）" +
      "④var→public ⑤define(FOO,→define('FOO', 裸常數加引號 ⑥__autoload 補 spl_autoload_register。" +
      "需語意判斷的（mysql_*、ereg、each、create_function、session_register、magic_quotes）不自動改，只在報告列出殘留筆數交給 LLM 處理。" +
      "預設 apply:false（只預覽不寫回，列出每檔會改哪幾條＋lint 是否通過）；確認後傳 apply:true 才實際寫入。" +
      "自動跳過 vendor/lib/plugin 等第三方資料夾。檔案須位於掛載到容器的 basePath 內。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "單一 .php 檔或資料夾路徑（資料夾會遞迴展開）。與 paths 擇一" },
        paths: { type: "array", items: { type: "string" }, description: "多個檔案/資料夾路徑。與 path 擇一" },
        recursive: { type: "boolean", description: "資料夾是否遞迴子目錄（預設 true）", default: true },
        apply: { type: "boolean", description: "false=只預覽不寫回（預設）；true=lint 通過才實際寫入檔案", default: false },
        transforms: {
          type: "array",
          items: { type: "string", enum: TRANSFORM_KEYS },
          description: `選填：只跑指定規則（預設全跑）。可選：${TRANSFORM_KEYS.join(", ")}`,
        },
        container: { type: "string", description: "執行 token 分析與 php -l 的 Docker 容器（預設 dev-php84，對最新版 lint 抓相容問題）", default: "dev-php84" },
        exclude: { type: "array", items: { type: "string" }, description: "選填：額外要跳過的資料夾名稱（附加在預設第三方清單之上）" },
      },
    },
  },
];

export async function handle(name, args) {
  if (name !== "php_modernize") return null;
  const def = definitions.find((d) => d.name === name);
  args = validateArgs(def.inputSchema, args);

  const container = args.container || "dev-php84";
  const apply = args.apply === true;
  const recursive = args.recursive !== false;

  const inputs = args.paths && args.paths.length ? args.paths : (args.path ? [args.path] : []);
  if (inputs.length === 0) {
    return { isError: true, content: [{ type: "text", text: "請提供 path 或 paths（.php 檔或資料夾）。" }] };
  }

  const cErr = await checkContainer(container);
  if (cErr) return { isError: true, content: [{ type: "text", text: cErr }] };

  // 1) 解析 + 展開檔案清單
  const excludeSet = new Set([...DEFAULT_EXCLUDES, ...(args.exclude || [])].map((s) => s.toLowerCase()));
  const hostFiles = [];
  const skippedOutside = [];
  for (const p of inputs) {
    let resolved;
    try {
      resolved = resolveSecurePath(p);
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `路徑無法存取：${p}\n${e.message}` }] };
    }
    let files;
    try {
      files = await collectPhpFiles(resolved, recursive, excludeSet);
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `讀取路徑失敗：${p}\n${e.message}` }] };
    }
    hostFiles.push(...files);
  }
  // 去重
  const uniqHost = [...new Set(hostFiles)];

  // 對應容器路徑（不在 basePath 掛載內的略過）
  const fileMap = []; // { host, container }
  for (const h of uniqHost) {
    const c = toContainerPath(h);
    if (c) fileMap.push({ host: h, container: c });
    else skippedOutside.push(h);
  }

  if (fileMap.length === 0) {
    const note = skippedOutside.length
      ? `\n（${skippedOutside.length} 個檔案不在掛載到容器的 basePath 內，容器看不到，已略過）`
      : "";
    return { isError: true, content: [{ type: "text", text: `沒有可處理的 .php 檔案。${note}` }] };
  }

  // 2) 把轉換器 tee 進容器暫存
  const transformerCode = await fs.readFile(TRANSFORMER_PHP, "utf-8");
  const remoteScript = `/tmp/_mcp_modernize_${Date.now()}.php`;
  try {
    const teeRes = await runExec(`docker exec -i ${container} tee ${remoteScript}`, { input: transformerCode, timeout: 20000 });
    if (teeRes.code !== 0 && !teeRes.stdout) {
      // tee 失敗
    }

    // 3) 餵 JSON payload 跑轉換器
    const payload = JSON.stringify({
      files: fileMap.map((f) => f.container),
      transforms: args.transforms || [],
      apply,
    });
    const run = await runExec(`docker exec -i ${container} php ${remoteScript}`, { input: payload, timeout: 180000 });

    let parsed;
    try {
      parsed = JSON.parse(run.stdout.trim());
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `轉換器輸出非預期（無法解析 JSON）：\n${run.stdout.slice(0, 2000)}\n${run.stderr ? `stderr: ${run.stderr.slice(0, 1000)}` : ""}` }],
      };
    }
    if (parsed.fatal) {
      return { isError: true, content: [{ type: "text", text: `轉換器錯誤：${parsed.fatal}` }] };
    }

    // 4) 整理報告
    const containerToHost = new Map(fileMap.map((f) => [f.container, f.host]));
    const results = parsed.results || [];

    let changedCount = 0, writtenCount = 0, lintFailCount = 0, errorCount = 0;
    const ruleTotals = {};
    const residualTotals = {};
    const perFile = [];

    for (const r of results) {
      const host = containerToHost.get(r.file) || r.file;
      const rel = path.relative(CONFIG.basePath, host).replace(/\\/g, "/");
      if (!r.ok) errorCount++;
      if (r.changed) changedCount++;
      if (r.written) writtenCount++;
      if (r.lint && !r.lint.ok) lintFailCount++;

      for (const t of (r.transforms || [])) ruleTotals[t.rule] = (ruleTotals[t.rule] || 0) + 1;
      for (const [k, v] of Object.entries(r.residual || {})) residualTotals[k] = (residualTotals[k] || 0) + v;

      // 只列出「有改動 / 有問題 / 有殘留」的檔案，乾淨已相容的不佔篇幅
      const hasResidual = Object.keys(r.residual || {}).length > 0;
      if (!r.changed && r.ok && !hasResidual) continue;

      const lines = [];
      let head = `📄 ${rel}`;
      if (!r.ok) head += `  ❌ ${r.error || "失敗"}`;
      else if (r.changed && r.written) head += `  ✅ 已寫入`;
      else if (r.changed && r.lint && !r.lint.ok) head += `  ⛔ lint 失敗，未寫入`;
      else if (r.changed && !apply) head += `  📝 預覽（會改 ${r.transforms.length} 處${r.lint ? `，lint ${r.lint.ok ? "✅" : "⛔"}` : ""}）`;
      else if (!r.changed) head += `  — 無確定性改動`;
      lines.push(head);

      const byRule = {};
      for (const t of (r.transforms || [])) {
        byRule[t.rule] = byRule[t.rule] || [];
        byRule[t.rule].push(t.line);
      }
      for (const [rule, ls] of Object.entries(byRule)) {
        lines.push(`   • ${RULE_LABELS[rule] || rule}：${ls.length} 處（行 ${ls.slice(0, 12).join(", ")}${ls.length > 12 ? "…" : ""}）`);
      }
      for (const w of (r.warnings || [])) lines.push(`   ⚠ ${w}`);
      if (hasResidual) {
        const parts = Object.entries(r.residual).map(([k, v]) => `${k}×${v}`);
        lines.push(`   🔶 需 LLM 判斷：${parts.join("、")}`);
      }
      if (r.lint && !r.lint.ok) lines.push(`   ⛔ lint：${(r.lint.error || "").split("\n").filter(Boolean).slice(-2).join(" / ")}`);
      perFile.push(lines.join("\n"));
    }

    // 標題摘要
    const ruleSummary = Object.entries(ruleTotals).map(([k, v]) => `${RULE_LABELS[k] || k} ${v}`).join("、") || "（無）";
    const residualSummary = Object.entries(residualTotals).map(([k, v]) => `${k}×${v}`).join("、");

    const header = [
      `${apply ? "🛠 php_modernize 已套用" : "🔍 php_modernize 預覽（apply:false，未寫入任何檔案）"} [${container}]`,
      `掃描 ${fileMap.length} 檔｜有確定性改動 ${changedCount}${apply ? `｜已寫入 ${writtenCount}` : ""}｜lint 失敗 ${lintFailCount}｜錯誤 ${errorCount}`,
      `機械轉換明細：${ruleSummary}`,
      residualSummary ? `🔶 殘留需 LLM 判斷（未自動改）：${residualSummary}` : `🔶 殘留需 LLM 判斷：無`,
      skippedOutside.length ? `（${skippedOutside.length} 個檔案不在容器掛載 basePath 內，已略過）` : "",
    ].filter(Boolean).join("\n");

    const footer = apply
      ? `\n\n✅ 已寫入 ${writtenCount} 檔。建議用 git diff 檢視後再 commit。殘留的 mysql_*/ereg/each 等需你逐一判斷改寫。`
      : `\n\n👉 確認無誤後，加上 apply:true 重跑即可實際寫入（僅 lint 通過的檔會被寫）。`;

    const body = perFile.length ? `\n\n${perFile.join("\n\n")}` : "\n\n（所有檔案皆已相容、無殘留）";

    return { content: [{ type: "text", text: header + body + footer }] };
  } finally {
    await runExec(`docker exec ${container} rm -f ${remoteScript}`, { timeout: 10000 }).catch(() => {});
  }
}
