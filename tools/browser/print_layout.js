// tools/browser/print_layout.js — print_layout_test
// 列印版面測試：Playwright 產真實分頁 PDF → poppler(pdf2image) render 每頁 PNG → 回傳頁圖 + 頁數 + 字體嵌入 + selector 估算落點
// 流程踩過的眉角內建：page.pdf 不觸發 beforeprint（手動派發）、printBackground、displayHeaderFooter 頁首頁尾、容器缺 poppler 自動補裝
// 暫存走 D:\MCP_Server\.tmp（= 容器 /develop/.tmp），不需 D:\tmp 也不碰 read_image basePath

import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import util from "util";
import { fileURLToPath } from "url";
import { validateArgs } from "../_shared/utils.js";
import { createBrowserPool } from "../_shared/browser_pool.js";

const execPromise = util.promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(__dirname, "..", "..");
const CONTAINER = "python_runner";
const DEVELOP_MOUNT = "/develop";

const browserPool = createBrowserPool(60000);

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "print_layout_test",
    description:
      "列印版面正確性測試：用 Playwright 產真實分頁 PDF（走 Chromium 列印引擎，等同瀏覽器 Ctrl+P）→ 把每頁 render 成 PNG 回傳供視覺檢查 → 附總頁數、字體是否嵌入、指定 selector 估算落在第幾頁。\n" +
      "專治列印版面問題：簽收欄貼底、元素被切跨頁、多餘空白頁、掃 min-height 臨界值。內建 beforeprint 事件派發（page.pdf 預設不觸發）、printBackground、displayHeaderFooter 頁首頁尾模擬。\n" +
      "需 Docker python_runner 容器（render PDF→PNG 用，缺 poppler 會自動補裝）。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要測列印版面的頁面 URL" },
        selectors: {
          type: "array",
          items: { type: "string" },
          description: "選填：要定位的元素 CSS selector 清單，回傳各自估算落在第幾頁 + 是否跨頁切斷（線性估算，忽略 break-inside，供掃臨界值用）",
        },
        format: { type: "string", description: "紙張大小（預設 A4），可 Letter/Legal/A3 等" },
        landscape: { type: "boolean", description: "橫向列印（預設 false）" },
        margin: {
          type: "object",
          properties: {
            top: { type: "string" }, right: { type: "string" },
            bottom: { type: "string" }, left: { type: "string" },
          },
          description: "頁邊距，含單位字串如 '10mm'/'0.5in'（預設 0；用 displayHeaderFooter 時建議設上下邊距讓頁首尾有空間）",
        },
        printBackground: { type: "boolean", description: "印出背景色/底圖（預設 true；關掉則背景全白）" },
        displayHeaderFooter: { type: "boolean", description: "顯示頁首頁尾（模擬瀏覽器列印，預設 false）" },
        headerTemplate: { type: "string", description: "頁首 HTML 模板（displayHeaderFooter 時生效，可用 .date .title .pageNumber .totalPages class）" },
        footerTemplate: { type: "string", description: "頁尾 HTML 模板（同上）" },
        scale: { type: "number", description: "縮放 0.1–2（預設 1）" },
        dpi: { type: "number", description: "PNG render 解析度（預設 150；調低省 token、調高更清晰）" },
        pages: { type: "string", description: "要回傳哪幾頁圖：'all'(預設)/'first'/'last'/'1,3,5'/'1-3'" },
        maxImages: { type: "number", description: "最多回傳幾張頁圖（預設 12，避免 token 爆量）" },
        returnImages: { type: "boolean", description: "是否回傳頁圖（預設 true；設 false 只回 metadata 快速迭代）" },
        fireBeforePrint: { type: "boolean", description: "產 PDF 前派發 beforeprint 事件觸發頁面列印調整邏輯（預設 true）" },
        emulatePrintMedia: { type: "boolean", description: "套用 @media print 樣式再量測 selector（預設 true）" },
        cookies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" }, value: { type: "string" },
              domain: { type: "string" }, path: { type: "string" },
            },
            required: ["name", "value", "domain"],
          },
          description: "選填：注入 cookies（登入後才看得到的列印頁）",
        },
        viewport: {
          type: "object",
          properties: { width: { type: "number" }, height: { type: "number" } },
          description: "視窗大小（預設 1280x1024）",
        },
        timeout: { type: "number", description: "頁面載入逾時毫秒（預設 30000）" },
      },
      required: ["url"],
    },
  },
];

// ============================================
// 長度字串 → CSS px（96dpi）
// ============================================
function lengthToPx(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const m = String(v).trim().match(/^([\d.]+)\s*(mm|cm|in|pt|px)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch ((m[2] || "px").toLowerCase()) {
    case "mm": return n * 96 / 25.4;
    case "cm": return n * 96 / 2.54;
    case "in": return n * 96;
    case "pt": return n * 96 / 72;
    default: return n; // px
  }
}

// 紙張 CSS px 尺寸（96dpi，portrait）
const PAPER_PX = {
  a4: { w: 794, h: 1123 }, a3: { w: 1123, h: 1587 }, a5: { w: 559, h: 794 },
  letter: { w: 816, h: 1056 }, legal: { w: 816, h: 1344 }, tabloid: { w: 1056, h: 1632 },
};

// ============================================
// 解析 pages 參數 → 要保留的 1-based 頁碼陣列
// ============================================
function resolvePages(spec, total) {
  const all = Array.from({ length: total }, (_, i) => i + 1);
  if (!spec || spec === "all") return all;
  if (spec === "first") return [1];
  if (spec === "last") return [total];
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const t = part.trim();
    const range = t.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = +range[1]; i <= +range[2]; i++) if (i >= 1 && i <= total) out.add(i);
    } else if (/^\d+$/.test(t)) {
      const i = +t; if (i >= 1 && i <= total) out.add(i);
    }
  }
  return out.size ? [...out].sort((a, b) => a - b) : all;
}

// ============================================
// 容器內執行 python（自帶較長 timeout，供 apt/pip 自我修復）
// ============================================
async function runInContainer(pyCode, tmpDir, timeoutMs = 180000) {
  // 確認容器在線
  try {
    const { stdout } = await execPromise(`docker inspect --format="{{.State.Running}}" ${CONTAINER}`);
    if (!stdout.includes("true")) throw new Error("not running");
  } catch {
    return { error: `容器 ${CONTAINER} 未啟動。請先 cd D:\\MCP_Server\\python && docker compose up -d` };
  }
  const scriptName = `printrender_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.py`;
  const hostScript = path.join(tmpDir, scriptName);
  await fs.writeFile(hostScript, pyCode, "utf-8");
  const relFromRoot = path.relative(MCP_ROOT, hostScript).replace(/\\/g, "/");
  const containerPath = `${DEVELOP_MOUNT}/${relFromRoot}`;
  try {
    const { stdout, stderr } = await execPromise(`docker exec ${CONTAINER} python3 "${containerPath}"`, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (err) {
    return { error: err.stdout || err.stderr || err.message };
  } finally {
    await fs.unlink(hostScript).catch(() => {});
  }
}

// ============================================
// print_layout_test 實作
// ============================================
async function handlePrintLayoutTest(args) {
  const {
    url,
    selectors = [],
    format = "A4",
    landscape = false,
    margin,
    printBackground = true,
    displayHeaderFooter = false,
    headerTemplate,
    footerTemplate,
    scale = 1,
    dpi = 150,
    pages = "all",
    maxImages = 12,
    returnImages = true,
    fireBeforePrint = true,
    emulatePrintMedia = true,
    cookies = [],
    viewport = { width: 1280, height: 1024 },
    timeout = 30000,
  } = args;

  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tmpDir = path.join(MCP_ROOT, ".tmp", `printtest_${runId}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const pdfPath = path.join(tmpDir, "out.pdf");

  const browser = await browserPool.acquire({ viewport, headless: true });
  let context = null;
  try {
    context = await browser.newContext({
      viewport: { width: viewport.width || 1280, height: viewport.height || 1024 },
      ignoreHTTPSErrors: true,
    });
    if (cookies.length > 0) {
      await context.addCookies(cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/" })));
    }
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout });

    if (emulatePrintMedia) await page.emulateMedia({ media: "print" }).catch(() => {});
    if (fireBeforePrint) {
      await page.evaluate(() => {
        try {
          window.dispatchEvent(new Event("beforeprint"));
          if (typeof window.onbeforeprint === "function") window.onbeforeprint();
        } catch {}
      }).catch(() => {});
      await page.waitForTimeout(150);
    }

    // selector 估算落點（線性，忽略 break-inside；供掃 min-height 臨界值）
    let selectorLocations = [];
    if (selectors.length > 0) {
      const paper = PAPER_PX[String(format).toLowerCase()] || PAPER_PX.a4;
      const pageW = landscape ? paper.h : paper.w;
      const pageH = landscape ? paper.w : paper.h;
      const mTop = lengthToPx(margin?.top);
      const mBottom = lengthToPx(margin?.bottom);
      const contentH = Math.max(1, (pageH - mTop - mBottom) / (scale || 1));
      selectorLocations = await page.evaluate(({ sels, contentH }) => {
        const out = [];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (!el) { out.push({ selector: sel, found: false }); continue; }
          const r = el.getBoundingClientRect();
          const top = r.top + window.scrollY;
          const bottom = r.bottom + window.scrollY;
          const pageOfTop = Math.floor(top / contentH) + 1;
          const pageOfBottom = Math.floor(Math.max(top, bottom - 0.01) / contentH) + 1;
          out.push({
            selector: sel, found: true,
            topPx: Math.round(top), bottomPx: Math.round(bottom),
            estimatedPage: pageOfTop,
            spansPageBoundary: pageOfTop !== pageOfBottom,
            ...(pageOfTop !== pageOfBottom ? { spansPages: `${pageOfTop}→${pageOfBottom}` } : {}),
          });
        }
        return out;
      }, { sels: selectors, contentH });
    }

    // 產真實分頁 PDF
    const pdfOpts = {
      path: pdfPath,
      format,
      landscape,
      printBackground,
      displayHeaderFooter,
      scale,
      ...(margin ? { margin } : {}),
      ...(displayHeaderFooter && headerTemplate ? { headerTemplate } : {}),
      ...(displayHeaderFooter && footerTemplate ? { footerTemplate } : {}),
      // displayHeaderFooter 但沒給模板時，給空白模板避免 Chromium 預設大字
      ...(displayHeaderFooter && !headerTemplate ? { headerTemplate: "<span></span>" } : {}),
      ...(displayHeaderFooter && !footerTemplate ? { footerTemplate: "<span></span>" } : {}),
    };
    await page.pdf(pdfOpts);
    await context.close().catch(() => {});
    context = null;

    // 容器 render：pdfinfo(頁數/尺寸) + pdffonts(嵌入) + pdf2image(PNG)
    const containerTmp = `${DEVELOP_MOUNT}/${path.relative(MCP_ROOT, tmpDir).replace(/\\/g, "/")}`;
    const py = `
import subprocess, sys, shutil, os, json
# 自我修復：缺 poppler / pdf2image 就裝
if not shutil.which("pdftoppm"):
    subprocess.run("apt-get update -qq && apt-get install -y -qq poppler-utils", shell=True)
try:
    from pdf2image import convert_from_path
except ImportError:
    subprocess.run([sys.executable,"-m","pip","install","-q","--no-cache-dir","pdf2image","pillow"])
    from pdf2image import convert_from_path

pdf = "${containerTmp}/out.pdf"
out = {}
info = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True).stdout
for line in info.splitlines():
    if line.startswith("Pages"): out["pages"] = int(line.split(":")[1].strip())
    if line.startswith("Page size"): out["pageSize"] = line.split(":",1)[1].strip()
fonts = subprocess.run(["pdffonts", pdf], capture_output=True, text=True).stdout
fl = []
for line in fonts.splitlines()[2:]:
    cols = line.split()
    if len(cols) >= 5:
        fl.append({"name": cols[0], "embedded": cols[-4] == "yes"})
out["fonts"] = fl
${returnImages ? `
imgs = convert_from_path(pdf, dpi=${dpi})
names = []
for i, im in enumerate(imgs, 1):
    fn = f"page_{i}.png"
    im.save(os.path.join("${containerTmp}", fn), "PNG")
    names.append(fn)
out["rendered"] = names
out["imageSize"] = list(imgs[0].size) if imgs else None
` : `out["rendered"] = []`}
print("JSON_START" + json.dumps(out) + "JSON_END")
`;
    const r = await runInContainer(py, tmpDir);
    if (r.error) {
      await cleanup(tmpDir);
      return { content: [{ type: "text", text: `❌ PDF render 失敗：${r.error}` }] };
    }
    const m = (r.stdout || "").match(/JSON_START(.*)JSON_END/s);
    if (!m) {
      await cleanup(tmpDir);
      return { content: [{ type: "text", text: `❌ 無法解析 render 結果：\n${r.stdout}\n${r.stderr || ""}` }] };
    }
    const meta = JSON.parse(m[1]);

    // 組裝輸出
    const totalPages = meta.pages || 0;
    const wantPages = resolvePages(pages, totalPages).slice(0, maxImages);
    const fontsEmbedded = (meta.fonts || []).every(f => f.embedded);
    const cjkFonts = (meta.fonts || []).filter(f => /jheng|hei|ming|song|noto|kai|gothic|cjk|sun|micro/i.test(f.name));

    const lines = [
      `🖨️ print_layout_test — ${url}`,
      `總頁數：${totalPages}　紙張：${meta.pageSize || format}　render：${returnImages ? `${dpi}dpi ${meta.imageSize ? meta.imageSize.join("×") : ""}` : "(略過)"}`,
      `字體嵌入：${fontsEmbedded ? "✅ 全部嵌入" : "⚠️ 有未嵌入字體（CJK 可能變豆腐）"}` +
        (cjkFonts.length ? `　CJK字體：${cjkFonts.map(f => f.name + (f.embedded ? "✓" : "✗")).join(", ")}` : ""),
    ];
    if (selectorLocations.length) {
      lines.push("", "📍 selector 落點（線性估算，忽略 break-inside）：");
      for (const s of selectorLocations) {
        if (!s.found) { lines.push(`  ✗ ${s.selector}：找不到元素`); continue; }
        lines.push(`  ${s.spansPageBoundary ? "⚠️ 跨頁" : "  "} ${s.selector}：第 ${s.estimatedPage} 頁` +
          (s.spansPageBoundary ? `（被切 ${s.spansPages}）` : "") + `　y=${s.topPx}~${s.bottomPx}px`);
      }
    }
    if (returnImages && wantPages.length < totalPages) {
      lines.push("", `（共 ${totalPages} 頁，依 pages='${pages}'/maxImages=${maxImages} 回傳第 ${wantPages.join(",")} 頁）`);
    }

    const content = [{ type: "text", text: lines.join("\n") }];
    if (returnImages) {
      for (const p of wantPages) {
        const fp = path.join(tmpDir, `page_${p}.png`);
        try {
          const buf = await fs.readFile(fp);
          content.push({ type: "text", text: `── 第 ${p} 頁 ──` });
          content.push({ type: "image", data: buf.toString("base64"), mimeType: "image/png" });
        } catch { /* 該頁未 render，略過 */ }
      }
    }

    await cleanup(tmpDir);
    return { content };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    await cleanup(tmpDir);
    return { content: [{ type: "text", text: `❌ print_layout_test 執行失敗：${err.message}` }] };
  }
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ============================================
// handle 路由
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);
  switch (name) {
    case "print_layout_test": return handlePrintLayoutTest(args);
    default: return null;
  }
}
