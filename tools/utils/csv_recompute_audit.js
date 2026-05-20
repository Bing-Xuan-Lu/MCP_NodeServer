// tools/utils/csv_recompute_audit.js
// 對照 baseline CSV 跑 PHP class::method 重算後輸出 diff 報告 CSV
// 情境：報價/計算類 service 對齊 Sheet baseline，避免每次改算法都跑 60min GSheet quota
// 嚴格字串相等比對（無 tolerance）

import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { resolveSecurePath, CONFIG } from "../../config.js";

export const definitions = [
  {
    name: "csv_recompute_audit",
    description:
      "對照 baseline CSV 跑 PHP class::method 重算後輸出 diff 報告 CSV。\n" +
      "情境：報價/計算類 service 對齊 Sheet baseline，避免每次改算法都重跑 GSheet/API。\n" +
      "嚴格字串相等比對（不設 tolerance；浮點數請在 PHP 端先 round）。\n" +
      "輸出 CSV 欄位：case_id, php_error, baseline_{col}, new_{col}, diff_{col}（每個 mapping 一組）",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "PHP 專案資料夾名稱（相對 basePath，例：myproject）",
        },
        baseline_csv: {
          type: "string",
          description: "baseline CSV 路徑（相對 project 或絕對）。首列為欄位名",
        },
        output_csv: {
          type: "string",
          description: "輸出 audit CSV 路徑（相對 project 或絕對）",
        },
        class: { type: "string", description: "要呼叫的 PHP class 名（如 PriceService）" },
        method: { type: "string", description: "要呼叫的 method 名（如 compute）" },
        args_from: {
          type: "array",
          items: { type: "string" },
          description:
            "從 baseline CSV 取哪些欄位作為 method 參數（依序傳入）。" +
            "若值看起來是 JSON（首字 { 或 [）會自動 json_decode；否則以原字串傳入",
        },
        mapping: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "{csv_col: php_result_path}，比對 baseline[col] vs walk(result, path)。" +
            "path 支援點記號（如 'F825' 或 'result.totals.F825'）",
        },
        case_id_column: {
          type: "string",
          description: "顯示用 case id 欄位（預設取 baseline 第一欄）",
        },
        bootstrap: {
          type: "string",
          description:
            "選填：先 require 的 bootstrap PHP 檔（相對 project 或絕對）。" +
            "用於載入 autoload / 設定常數 / 模擬 $_SESSION 等",
        },
        container: {
          type: "string",
          description: "選填：Docker container 名稱（如 dev-php84）。給定時走 `docker exec -i {container} php`",
        },
        container_workdir: {
          type: "string",
          description:
            "選填：container 內對應 basePath/{project} 的路徑（預設 `/var/www/html/{project}`）。" +
            "用於把 host 端的 baseline_csv / output_csv / bootstrap 路徑翻譯成 container 看得到的路徑",
        },
        max_rows: { type: "number", description: "處理上限（預設 5000）", default: 5000 },
        timeout: { type: "number", description: "PHP 執行逾時毫秒（預設 60000）", default: 60000 },
      },
      required: ["project", "baseline_csv", "output_csv", "class", "method", "args_from", "mapping"],
    },
  },
];

// ── CSV ──────────────────────────────────────────────────────
function parseCsvLine(line) {
  const result = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === ",") { result.push(cur); cur = ""; }
      else if (c === '"' && cur === "") inQ = true;
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter(l => l.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(l => {
    const cells = parseCsvLine(l);
    const obj = {};
    header.forEach((h, i) => obj[h] = cells[i] ?? "");
    return obj;
  });
  return { header, rows };
}

function csvEscape(s) {
  const str = s === null || s === undefined ? "" : String(s);
  return /[",\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

// ── 路徑解析（支援絕對與 project-相對） ────────────────────
function resolveProjectPath(project, p) {
  if (path.isAbsolute(p)) return resolveSecurePath(p);
  return resolveSecurePath(path.posix.join(project, String(p).replace(/\\/g, "/")));
}

function toContainerPath(hostAbsPath, projectName, containerWorkdir) {
  const projAbs = path.resolve(CONFIG.basePaths[0], projectName);
  const norm = path.resolve(hostAbsPath);
  if (norm.toLowerCase().startsWith(projAbs.toLowerCase())) {
    const rest = norm.slice(projAbs.length).replace(/\\/g, "/");
    return (containerWorkdir.replace(/\/$/, "") + (rest.startsWith("/") ? "" : "/") + rest).replace(/\/+/g, "/");
  }
  // 超出 project 範圍 → 無法翻譯，回 null
  return null;
}

// ── PHP loader 產生器 ────────────────────────────────────────
function buildPhpLoader({ bootstrapPath, className, methodName, argsFrom, mapping, caseIdColumn, baselineCsvPath, maxRows }) {
  const J = (v) => JSON.stringify(v).replace(/<\/script>/gi, "<\\/script>");
  const requireLine = bootstrapPath
    ? `require_once ${J(bootstrapPath)};`
    : "// no bootstrap";

  return `<?php
${requireLine}

function _walk_path($obj, $path) {
  if ($path === '' || $path === null) return $obj;
  $parts = explode('.', $path);
  $cur = $obj;
  foreach ($parts as $p) {
    if (is_array($cur) && array_key_exists($p, $cur)) { $cur = $cur[$p]; }
    elseif (is_object($cur) && isset($cur->$p)) { $cur = $cur->$p; }
    else { return null; }
  }
  return $cur;
}
function _maybe_json($s) {
  if (!is_string($s)) return $s;
  $t = trim($s);
  if ($t === '' || ($t[0] !== '{' && $t[0] !== '[')) return $s;
  $d = json_decode($t, true);
  return ($d === null && json_last_error() !== JSON_ERROR_NONE) ? $s : $d;
}
function _stringify($v) {
  if ($v === null) return '';
  if (is_bool($v)) return $v ? '1' : '0';
  if (is_scalar($v)) return (string)$v;
  return json_encode($v, JSON_UNESCAPED_UNICODE);
}

$baseline_csv_path = ${J(baselineCsvPath)};
$argsFrom = ${J(argsFrom)};
$mapping = ${J(mapping)};
$caseIdCol = ${J(caseIdColumn)};
$className = ${J(className)};
$methodName = ${J(methodName)};
$maxRows = ${maxRows};

if (!file_exists($baseline_csv_path)) {
  fwrite(STDERR, "baseline_csv not found: $baseline_csv_path\\n");
  exit(2);
}

$fp = fopen($baseline_csv_path, 'r');
if (!$fp) { fwrite(STDERR, "cannot open baseline_csv\\n"); exit(2); }
$header = fgetcsv($fp);
if (!$header) { fwrite(STDERR, "empty baseline_csv\\n"); exit(2); }

$results = [];
$count = 0;
while (($cells = fgetcsv($fp)) !== false) {
  if ($count++ >= $maxRows) break;
  $row = [];
  foreach ($header as $i => $h) { $row[$h] = $cells[$i] ?? ''; }

  $caseId = $row[$caseIdCol] ?? '';
  $result_row = ['case_id' => $caseId, 'php_error' => null];
  try {
    $args = array_map(function($k) use ($row) { return _maybe_json($row[$k] ?? null); }, $argsFrom);
    if (!class_exists($className)) throw new Exception("class not found: $className");
    if (!method_exists($className, $methodName)) throw new Exception("method not found: $className::$methodName");
    $ref = new ReflectionMethod($className, $methodName);
    $newValue = $ref->isStatic()
      ? $className::{$methodName}(...$args)
      : (new $className())->{$methodName}(...$args);

    foreach ($mapping as $col => $resultPath) {
      $newCellValue = _walk_path($newValue, $resultPath);
      $baseline = array_key_exists($col, $row) ? $row[$col] : null;
      $bStr = $baseline === null ? '' : (string)$baseline;
      $nStr = _stringify($newCellValue);
      $result_row["baseline_$col"] = $baseline;
      $result_row["new_$col"] = $nStr;
      $result_row["diff_$col"] = ($bStr === $nStr) ? 'identical' : 'mismatch';
    }
  } catch (Throwable $e) {
    $result_row['php_error'] = $e->getMessage();
    foreach ($mapping as $col => $_) {
      $result_row["baseline_$col"] = array_key_exists($col, $row) ? $row[$col] : null;
      $result_row["new_$col"] = null;
      $result_row["diff_$col"] = 'php_error';
    }
  }
  $results[] = $result_row;
}
fclose($fp);

echo "===CSV_AUDIT_RESULT_START===";
echo json_encode($results, JSON_UNESCAPED_UNICODE);
echo "===CSV_AUDIT_RESULT_END===\\n";
`;
}

// ── PHP 啟動（含 docker exec 模式） ─────────────────────────
function runPhp(phpCode, container, timeout) {
  return new Promise((resolve, reject) => {
    const cmd = container ? "docker" : "php";
    const argv = container ? ["exec", "-i", container, "php"] : [];
    const child = spawn(cmd, argv, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf-8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf-8"); });

    const tid = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`PHP timeout after ${timeout}ms`));
    }, timeout);

    child.on("error", (err) => { clearTimeout(tid); reject(err); });
    child.on("close", (code) => {
      clearTimeout(tid);
      if (code !== 0) {
        reject(new Error(`PHP exit ${code}\nstderr: ${stderr}\nstdout (tail 500): ${stdout.slice(-500)}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.stdin.write(phpCode);
    child.stdin.end();
  });
}

// ── Handler ─────────────────────────────────────────────────
export async function handle(name, args) {
  if (name !== "csv_recompute_audit") return null;

  const projectName = args.project;
  const containerWorkdir = args.container_workdir || `/var/www/html/${projectName}`;

  // Host 端絕對路徑
  let baselineHostAbs, outputHostAbs, bootstrapHostAbs = null;
  try {
    baselineHostAbs = resolveProjectPath(projectName, args.baseline_csv);
    outputHostAbs = resolveProjectPath(projectName, args.output_csv);
    if (args.bootstrap) bootstrapHostAbs = resolveProjectPath(projectName, args.bootstrap);
  } catch (e) {
    return { content: [{ type: "text", text: `❌ 路徑解析失敗：${e.message}` }], isError: true };
  }

  // PHP 端要看的路徑（container 模式時翻譯）
  const phpView = (hostAbs) => {
    if (!args.container) return hostAbs;
    const cp = toContainerPath(hostAbs, projectName, containerWorkdir);
    if (!cp) throw new Error(`路徑超出 project 範圍，無法翻譯成 container 路徑：${hostAbs}`);
    return cp;
  };

  let baselineForPhp, bootstrapForPhp = null;
  try {
    baselineForPhp = phpView(baselineHostAbs);
    if (bootstrapHostAbs) bootstrapForPhp = phpView(bootstrapHostAbs);
  } catch (e) {
    return { content: [{ type: "text", text: `❌ ${e.message}` }], isError: true };
  }

  // 取得 baseline header（先讀檔以推導 case_id_column 預設值 + row 計數）
  let headerSample, totalRows;
  try {
    const text = await fs.readFile(baselineHostAbs, "utf-8");
    const parsed = parseCSV(text);
    headerSample = parsed.header;
    totalRows = parsed.rows.length;
  } catch (e) {
    return { content: [{ type: "text", text: `❌ 讀 baseline_csv 失敗：${e.message}` }], isError: true };
  }
  if (headerSample.length === 0) {
    return { content: [{ type: "text", text: "❌ baseline_csv 沒有欄位" }], isError: true };
  }
  const caseIdColumn = args.case_id_column || headerSample[0];
  if (!headerSample.includes(caseIdColumn)) {
    return { content: [{ type: "text", text: `❌ case_id_column "${caseIdColumn}" 不在 baseline header（${headerSample.join(", ")}）` }], isError: true };
  }

  const maxRows = args.max_rows ?? 5000;
  if (totalRows > maxRows) {
    return { content: [{ type: "text", text: `❌ baseline 有 ${totalRows} 列，超過 max_rows=${maxRows}（可調 max_rows 參數）` }], isError: true };
  }

  // 產生 PHP loader
  const phpCode = buildPhpLoader({
    bootstrapPath: bootstrapForPhp,
    className: args.class,
    methodName: args.method,
    argsFrom: args.args_from,
    mapping: args.mapping,
    caseIdColumn,
    baselineCsvPath: baselineForPhp,
    maxRows,
  });

  // 跑 PHP
  let phpOut;
  try {
    phpOut = await runPhp(phpCode, args.container, args.timeout ?? 60000);
  } catch (e) {
    return { content: [{ type: "text", text: `❌ PHP 執行失敗：${e.message}` }], isError: true };
  }

  // 抓出 JSON 結果（過濾掉 PHP 可能列印的 warning/notice）
  const m = phpOut.stdout.match(/===CSV_AUDIT_RESULT_START===([\s\S]*?)===CSV_AUDIT_RESULT_END===/);
  if (!m) {
    return {
      content: [{ type: "text", text:
        `❌ 解析 PHP 輸出失敗（找不到 result sentinel）\n` +
        `stderr: ${phpOut.stderr.slice(0, 500)}\n` +
        `stdout (tail 500): ${phpOut.stdout.slice(-500)}`,
      }], isError: true,
    };
  }
  let results;
  try { results = JSON.parse(m[1]); }
  catch (e) {
    return { content: [{ type: "text", text: `❌ JSON parse 失敗：${e.message}\n${m[1].slice(0, 500)}` }], isError: true };
  }

  // 寫 output CSV
  const mappingCols = Object.keys(args.mapping);
  const outHeader = ["case_id", "php_error"];
  for (const col of mappingCols) outHeader.push(`baseline_${col}`, `new_${col}`, `diff_${col}`);
  const lines = [outHeader.map(csvEscape).join(",")];

  let pass = 0, mismatch = 0, errors = 0;
  for (const r of results) {
    const row = [csvEscape(r.case_id), csvEscape(r.php_error)];
    let rowHasMismatch = false;
    for (const col of mappingCols) {
      row.push(csvEscape(r[`baseline_${col}`]), csvEscape(r[`new_${col}`]), csvEscape(r[`diff_${col}`]));
      if (r[`diff_${col}`] === "mismatch") rowHasMismatch = true;
    }
    lines.push(row.join(","));
    if (r.php_error) errors++;
    else if (rowHasMismatch) mismatch++;
    else pass++;
  }
  await fs.mkdir(path.dirname(outputHostAbs), { recursive: true });
  await fs.writeFile(outputHostAbs, lines.join("\n") + "\n", "utf-8");

  // 前 10 筆 mismatch sample
  const sampleMm = results.filter(r => !r.php_error && mappingCols.some(c => r[`diff_${c}`] === "mismatch")).slice(0, 10);
  const sampleErr = results.filter(r => r.php_error).slice(0, 5);

  const outLines = [];
  outLines.push(`# csv_recompute_audit — ${args.class}::${args.method}`);
  outLines.push(`📄 baseline: ${path.relative(CONFIG.basePaths[0], baselineHostAbs).replace(/\\/g, "/")}`);
  outLines.push(`📄 output:   ${path.relative(CONFIG.basePaths[0], outputHostAbs).replace(/\\/g, "/")}`);
  outLines.push(`📊 結果：${pass} pass / ${mismatch} mismatch / ${errors} error  (共 ${results.length} 列)`);
  if (sampleMm.length > 0) {
    outLines.push("");
    outLines.push(`## 前 ${sampleMm.length} 筆 mismatch`);
    for (const r of sampleMm) {
      const diffs = mappingCols
        .filter(c => r[`diff_${c}`] === "mismatch")
        .map(c => `${c}: \`${r[`baseline_${c}`]}\` → \`${r[`new_${c}`]}\``);
      outLines.push(`  - **${r.case_id}**  ${diffs.join("  /  ")}`);
    }
  }
  if (sampleErr.length > 0) {
    outLines.push("");
    outLines.push(`## 前 ${sampleErr.length} 筆 PHP 錯誤`);
    for (const r of sampleErr) outLines.push(`  - **${r.case_id}**  ${r.php_error}`);
  }
  if (mismatch === 0 && errors === 0) outLines.push("\n✅ 全部 pass — baseline 與 PHP 重算結果完全一致");

  return { content: [{ type: "text", text: outLines.join("\n") }] };
}
