import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { validateArgs } from "../_shared/utils.js";
import { resolveSecurePath } from "../../config.js";
import { GSHEET_CREDENTIALS_PATH } from "../../env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(__dirname, "..", "..");
const CONTAINER = "python_runner";

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "gsheet_fetch_with_state",
    description:
      "Google Sheet 一條龍：可選 write_data 寫入輸入欄 → sleep N 秒等公式重算 → 批次 fetch 目標 range 的 FORMULA + UNFORMATTED_VALUE。" +
      "解決「忘了寫入就抓 → 用過期 state 下結論」與「auth/scopes/dual-render boilerplate 每次重寫」兩大痛點。" +
      "credentials.json 需有 Sheets API 權限。",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string", description: "Google Sheet ID（網址中的 /d/{this}/edit）" },
        credentials_path: {
          type: "string",
          description: "Service account JSON 路徑（相對 basePath 或絕對）。預設讀 env GSHEET_CREDENTIALS_PATH（未設則必填）",
        },
        write_data: {
          type: "array",
          description: "寫入動作清單（選填）。每項：{ range: 'web!A3', values: 'X' 或 [['X','Y']] }",
          items: {
            type: "object",
            properties: {
              range: { type: "string" },
              values: {},
            },
            required: ["range", "values"],
          },
        },
        value_input_option: {
          type: "string",
          enum: ["USER_ENTERED", "RAW"],
          description: "寫入模式（預設 USER_ENTERED 會解析公式）",
          default: "USER_ENTERED",
        },
        sleep_sec: { type: "number", description: "寫入後等公式重算的秒數（預設 2）", default: 2 },
        read_range: {
          type: ["string", "array"],
          description: "要讀的 range（單一字串或陣列），例：'web!A1:Z200' 或 [\"web!A1:Z10\", \"data!B5\"]",
        },
        dual_render: { type: "boolean", description: "是否同時拉 FORMULA 與 UNFORMATTED_VALUE（預設 true）", default: true },
      },
      required: ["spreadsheet_id", "read_range"],
    },
  },
  {
    name: "gsheet_xlookup_trace",
    description:
      "從一個 cell ref 出發，遞迴展開查表鏈（XLOOKUP / VLOOKUP / INDEX-MATCH / 一般 cell 引用），輸出展開樹（cell + formula + resolved value）。" +
      "解決手動跨多層 fetch 公式慢且易漏 layer 的痛點。",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        credentials_path: { type: "string", description: "預設讀 env GSHEET_CREDENTIALS_PATH（未設則必填）" },
        start_cell: { type: "string", description: "起始 cell（含工作表名），例：'web!D284'" },
        default_sheet: { type: "string", description: "起始 cell 未指定工作表時用此（選填）" },
        max_depth: { type: "number", description: "遞迴展開上限（預設 4）", default: 4 },
      },
      required: ["spreadsheet_id", "start_cell"],
    },
  },
];

// ============================================
// 共用：執行 Python 腳本（用 stdin 傳 envelope JSON）
// ============================================
async function runGsheetPython(pyScript, envelope) {
  // 容器存活檢查
  try {
    await new Promise((resolve, reject) => {
      const p = spawn("docker", ["inspect", "--format={{.State.Running}}", CONTAINER]);
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("close", (code) => (code === 0 && out.trim() === "true" ? resolve() : reject(new Error(`container ${CONTAINER} 未運行`))));
    });
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `${err.message}。請先：cd D:/Develop/python && docker compose up -d` }] };
  }

  // 寫腳本到 MCP_Server/.tmp（mount 點 /develop）
  const tmpDir = path.join(MCP_ROOT, ".tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const scriptFile = path.join(tmpDir, `gsheet_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.py`);
  await fs.writeFile(scriptFile, pyScript, "utf-8");
  const containerScript = `/develop/.tmp/${path.basename(scriptFile)}`;

  try {
    return await new Promise((resolve) => {
      const cp = spawn("docker", ["exec", "-i", CONTAINER, "python3", containerScript]);
      let stdout = "", stderr = "";
      cp.stdout.on("data", (d) => (stdout += d.toString("utf-8")));
      cp.stderr.on("data", (d) => (stderr += d.toString("utf-8")));
      const timer = setTimeout(() => {
        cp.kill("SIGKILL");
        resolve({ isError: true, content: [{ type: "text", text: `逾時（>60s）\nstderr:\n${stderr}` }] });
      }, 60_000);
      cp.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve({ isError: true, content: [{ type: "text", text: `Python exit ${code}\nstderr:\n${stderr}\nstdout:\n${stdout}` }] });
        } else {
          try {
            const parsed = JSON.parse(stdout.trim().split("\n").pop());
            if (parsed.ok === false) {
              resolve({ isError: true, content: [{ type: "text", text: `gspread 錯誤：${parsed.error}` }] });
            } else {
              resolve({ content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] });
            }
          } catch (e) {
            resolve({ isError: true, content: [{ type: "text", text: `解析 JSON 失敗：${e.message}\nstdout:\n${stdout}\nstderr:\n${stderr}` }] });
          }
        }
      });
      cp.stdin.write(JSON.stringify(envelope));
      cp.stdin.end();
    });
  } finally {
    await fs.unlink(scriptFile).catch(() => {});
  }
}

// ============================================
// Python 腳本：fetch_with_state
// ============================================
const FETCH_SCRIPT = `
import sys, json, time
import gspread

env = json.loads(sys.stdin.read())
creds = env['creds']
params = env['params']

gc = gspread.service_account_from_dict(creds)
sh = gc.open_by_key(params['spreadsheet_id'])

write_data = params.get('write_data') or []
if write_data:
    payload = []
    for w in write_data:
        vals = w['values']
        if not isinstance(vals, list):
            vals = [[vals]]
        elif vals and not isinstance(vals[0], list):
            vals = [vals]
        payload.append({'range': w['range'], 'values': vals})
    sh.values_batch_update({
        'valueInputOption': params.get('value_input_option', 'USER_ENTERED'),
        'data': payload,
    })

sleep_sec = params.get('sleep_sec', 2)
if sleep_sec and write_data:
    time.sleep(sleep_sec)

read_range = params['read_range']
if isinstance(read_range, str):
    read_range = [read_range]

dual = params.get('dual_render', True)
result = {}
try:
    if dual:
        vresp = sh.values_batch_get(read_range, params={'valueRenderOption': 'UNFORMATTED_VALUE'})
        fresp = sh.values_batch_get(read_range, params={'valueRenderOption': 'FORMULA'})
        for vr, fr in zip(vresp.get('valueRanges', []), fresp.get('valueRanges', [])):
            rng = vr.get('range')
            result[rng] = {
                'value': vr.get('values', []),
                'formula': fr.get('values', []),
            }
    else:
        vresp = sh.values_batch_get(read_range, params={'valueRenderOption': 'UNFORMATTED_VALUE'})
        for vr in vresp.get('valueRanges', []):
            result[vr.get('range')] = {'value': vr.get('values', [])}
except AttributeError:
    # gspread 舊版 fallback：逐 range fetch
    for rng in read_range:
        v = sh.values_get(rng, params={'valueRenderOption': 'UNFORMATTED_VALUE'}).get('values', [])
        if dual:
            f = sh.values_get(rng, params={'valueRenderOption': 'FORMULA'}).get('values', [])
            result[rng] = {'value': v, 'formula': f}
        else:
            result[rng] = {'value': v}

print(json.dumps({
    'ok': True,
    'wrote': len(write_data),
    'slept_sec': sleep_sec if (sleep_sec and write_data) else 0,
    'data': result,
}, ensure_ascii=False, default=str))
`;

// ============================================
// Python 腳本：xlookup_trace
// ============================================
const XLOOKUP_SCRIPT = `
import sys, json, re
import gspread

env = json.loads(sys.stdin.read())
creds = env['creds']
params = env['params']

gc = gspread.service_account_from_dict(creds)
sh = gc.open_by_key(params['spreadsheet_id'])
default_sheet = params.get('default_sheet') or ''
max_depth = int(params.get('max_depth', 4))

# 簡化版 A1 ref parser，支援：
#   'Sheet Name'!\$A\$1, Sheet!A1, A1, A1:B2
REF_RE = re.compile(r"(?:'([^']+)'|([A-Za-z_]\\w*))?!?(\\$?[A-Z]+\\$?\\d+(?::\\$?[A-Z]+\\$?\\d+)?)")

def normalize_ref(ref):
    m = REF_RE.match(ref)
    if not m: return ref
    sheet = m.group(1) or m.group(2) or default_sheet
    body = m.group(3)
    if sheet:
        return f"'{sheet}'!{body}"
    return body

def fetch_cell(ref, render):
    try:
        res = sh.values_get(ref, params={'valueRenderOption': render})
        vals = res.get('values', [])
        return vals[0][0] if vals and vals[0] else None
    except Exception as e:
        return f"<fetch error: {e}>"

cache = {}
def expand(ref, depth):
    ref_n = normalize_ref(ref)
    if ref_n in cache:
        return {'cell': ref_n, 'cycle_or_repeat': True, **cache[ref_n]}
    if depth > max_depth:
        return {'cell': ref_n, 'truncated': True}
    formula = fetch_cell(ref_n, 'FORMULA')
    value   = fetch_cell(ref_n, 'UNFORMATTED_VALUE')
    node = {'cell': ref_n, 'formula': formula, 'value': value, 'children': []}
    cache[ref_n] = {'formula': formula, 'value': value}
    if isinstance(formula, str) and formula.startswith('='):
        # 抓所有 cell refs（去除自己）
        seen = set([ref_n])
        for m in REF_RE.finditer(formula):
            r = m.group(0)
            r_n = normalize_ref(r)
            if r_n in seen or not r_n: continue
            seen.add(r_n)
            node['children'].append(expand(r_n, depth + 1))
    return node

tree = expand(params['start_cell'], 0)
print(json.dumps({'ok': True, 'tree': tree, 'unique_cells': len(cache)}, ensure_ascii=False, default=str))
`;

// ============================================
// 工具邏輯
// ============================================
export async function handle(name, args) {
  const def = definitions.find((d) => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  if (name !== "gsheet_fetch_with_state" && name !== "gsheet_xlookup_trace") return null;

  // 載入 credentials：優先用呼叫者傳入，否則讀環境變數 GSHEET_CREDENTIALS_PATH
  const credPath = args.credentials_path || GSHEET_CREDENTIALS_PATH;
  if (!credPath) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: "缺少 credentials_path。請傳入 service account JSON 路徑，或在 .env 設定 GSHEET_CREDENTIALS_PATH。",
      }],
    };
  }
  let resolvedCred;
  try {
    resolvedCred = resolveSecurePath(credPath);
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `credentials_path 安全檢查失敗：${e.message}` }] };
  }
  let creds;
  try {
    creds = JSON.parse(await fs.readFile(resolvedCred, "utf-8"));
  } catch (e) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `讀 credentials 失敗：${resolvedCred}\n  → ${e.message}\n  → 確認檔案存在，或對 credentials 目錄呼叫 grant_path_access`,
      }],
    };
  }

  if (name === "gsheet_fetch_with_state") {
    const params = {
      spreadsheet_id: args.spreadsheet_id,
      write_data: args.write_data || [],
      value_input_option: args.value_input_option || "USER_ENTERED",
      sleep_sec: args.sleep_sec ?? 2,
      read_range: args.read_range,
      dual_render: args.dual_render !== false,
    };
    return runGsheetPython(FETCH_SCRIPT, { creds, params });
  }

  if (name === "gsheet_xlookup_trace") {
    const params = {
      spreadsheet_id: args.spreadsheet_id,
      start_cell: args.start_cell,
      default_sheet: args.default_sheet || "",
      max_depth: args.max_depth ?? 4,
    };
    return runGsheetPython(XLOOKUP_SCRIPT, { creds, params });
  }
}
