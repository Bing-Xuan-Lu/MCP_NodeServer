// tools/dom_compare.js — 批次比對兩個 URL 上多個選擇器的 CSS / HTML / JS 差異
// 用途：一次呼叫取代 4-6 次 browser_evaluate，直接回傳差異

import { createBrowserPool } from "./_shared/browser_pool.js";

// ============================================
// Browser Pool（跨呼叫複用 browser 進程）
// ============================================
const browserPool = createBrowserPool(60000);

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "dom_compare",
    description:
      "批次比對兩個 URL 上多個選擇器的差異。支援 css(computed style)、html(DOM 結構/屬性/文字)、js(執行 JS 表達式比對回傳值)、full(全部)四種模式。",
    inputSchema: {
      type: "object",
      properties: {
        url_a: { type: "string", description: "基準 URL（例如本機開發站）" },
        url_b: { type: "string", description: "比對 URL（例如遠端測試站）" },
        selectors: {
          type: "array",
          items: { type: "string" },
          description: "要比對的 CSS 選擇器陣列",
        },
        compare_mode: {
          type: "string",
          enum: ["css", "html", "js", "full"],
          description: "比對模式:css(computed style,預設)、html(DOM 結構)、js(JS 表達式)、full(全部)",
        },
        properties: {
          type: "array",
          items: { type: "string" },
          description:
            "css 模式:要比對的 CSS 屬性清單。留空則使用預設常用屬性集",
        },
        html_options: {
          type: "object",
          properties: {
            compare: {
              type: "string",
              enum: ["structure", "text", "attributes", "all"],
              description: "html 比對範圍:structure(標籤+子元素數)、text(文字內容)、attributes(class/id/style 等屬性)、all(全部,預設)",
            },
          },
          description: "html 模式的比對選項",
        },
        js_expressions: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "js 模式:鍵值對,key = 標籤名,value = JS 表達式。在兩邊執行並比對回傳值。例如 { \"itemCount\": \"document.querySelectorAll('.item').length\" }",
        },
        trigger_action: {
          type: "string",
          description:
            "選填:在兩個頁面上擷取前執行的 JS 表達式(例如觸發 Popup)。會在兩個頁面上分別執行",
        },
        trigger_action_b: {
          type: "string",
          description:
            "選填:url_b 專用的觸發 JS。未設時 fallback 到 trigger_action",
        },
        wait_after_trigger: {
          type: "number",
          description: "trigger_action 執行後等待毫秒數(預設 500)",
        },
        viewport: {
          type: "object",
          properties: {
            width: { type: "number" },
            height: { type: "number" },
          },
          description: "選填:指定視窗大小(預設 1920x1080)",
        },
        timeout: {
          type: "number",
          description: "頁面載入逾時毫秒數(預設 15000)",
        },
        cookies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "string" },
              domain: { type: "string" },
              path: { type: "string" },
            },
            required: ["name", "value", "domain"],
          },
          description: "選填:注入 cookies(用於需要登入的頁面,兩站共用)",
        },
        cookies_b: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: { type: "string" },
              domain: { type: "string" },
              path: { type: "string" },
            },
            required: ["name", "value", "domain"],
          },
          description: "選填:url_b 專用 cookies。未設時 fallback 到 cookies",
        },
        verbose: {
          type: "boolean",
          description: "是否輸出 same 欄位(預設 false,省 token)。true 時回傳完整 same 字典",
        },
        ignore_url_domain: {
          type: "boolean",
          description: "CSS 比對時自動忽略 URL 中的域名差異(預設 false)。例如 url(\"http://localhost:8084/img.png\") vs url(\"http://192.168.1.192:8410/img.png\") 視為相同",
        },
        screenshot: {
          type: "boolean",
          description: "是否回傳兩站截圖(預設 false)。true 時在 text 結果後附加兩張 image",
        },
      },
      required: ["url_a", "url_b"],
    },
  },
];

// ============================================
// 預設常用 CSS 屬性
// ============================================
const DEFAULT_PROPERTIES = [
  "position", "display", "width", "height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "top", "right", "bottom", "left",
  "transform", "z-index", "opacity",
  "font-size", "color", "background-color",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "box-sizing", "overflow", "text-align",
];

// ============================================
// URL 域名正規化（ignore_url_domain 用）
// ============================================
function normalizeUrlDomain(value) {
  if (!value || typeof value !== "string") return value;
  // url("http://localhost:8084/...") → url("__DOMAIN__/...")
  return value.replace(/url\(["']?https?:\/\/[^/\s"')]+/g, 'url("__DOMAIN__');
}

// ============================================
// 比對邏輯
// ============================================

/** CSS computed style 比對 */
async function compareCss(pageA, pageB, selectors, props, { verbose, ignoreDomain }) {
  const extract = (page) =>
    page.evaluate(
      ({ sels, propList }) => {
        const result = {};
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (!el) { result[sel] = null; continue; }
          const cs = window.getComputedStyle(el);
          const styles = {};
          for (const p of propList) styles[p] = cs.getPropertyValue(p);
          result[sel] = styles;
        }
        return result;
      },
      { sels: selectors, propList: props },
    );

  const [stylesA, stylesB] = await Promise.all([extract(pageA), extract(pageB)]);
  const results = {};
  let totalDiffs = 0;

  for (const sel of selectors) {
    const a = stylesA[sel], b = stylesB[sel];
    if (a === null && b === null) { results[sel] = { match: null, error: "兩邊都找不到此選擇器" }; continue; }
    if (a === null) { results[sel] = { match: null, error: "url_a 找不到此選擇器" }; continue; }
    if (b === null) { results[sel] = { match: null, error: "url_b 找不到此選擇器" }; continue; }

    const diffs = {};
    const same = verbose ? {} : undefined;
    for (const p of props) {
      let va = a[p], vb = b[p];
      if (ignoreDomain) { va = normalizeUrlDomain(va); vb = normalizeUrlDomain(vb); }
      if (va !== vb) { diffs[p] = { a: a[p], b: b[p] }; }
      else if (verbose) { same[p] = a[p]; }
    }
    const diffCount = Object.keys(diffs).length;
    totalDiffs += diffCount;

    if (diffCount === 0) {
      results[sel] = verbose ? { match: true, diffs: {}, same } : { match: true };
    } else {
      results[sel] = verbose ? { match: false, diffs, same } : { match: false, diffs };
    }
  }
  return { results, totalDiffs };
}

/** HTML DOM 結構比對 */
async function compareHtml(pageA, pageB, selectors, options = {}, verbose = false) {
  const compare = options.compare || "all";
  const extract = (page) =>
    page.evaluate(
      ({ sels, cmp }) => {
        const result = {};
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (!el) { result[sel] = null; continue; }
          const data = {};
          if (cmp === "structure" || cmp === "all") {
            data.tagName = el.tagName;
            data.childCount = el.children.length;
            data.childTags = Array.from(el.children).map((c) => c.tagName);
          }
          if (cmp === "text" || cmp === "all") {
            data.textContent = el.textContent?.trim().substring(0, 500) || "";
            data.innerText = el.innerText?.trim().substring(0, 500) || "";
          }
          if (cmp === "attributes" || cmp === "all") {
            const attrs = {};
            for (const attr of el.attributes) attrs[attr.name] = attr.value;
            data.attributes = attrs;
          }
          result[sel] = data;
        }
        return result;
      },
      { sels: selectors, cmp: compare },
    );

  const [htmlA, htmlB] = await Promise.all([extract(pageA), extract(pageB)]);
  const results = {};
  let totalDiffs = 0;

  for (const sel of selectors) {
    const a = htmlA[sel], b = htmlB[sel];
    if (a === null && b === null) { results[sel] = { match: null, error: "兩邊都找不到此選擇器" }; continue; }
    if (a === null) { results[sel] = { match: null, error: "url_a 找不到此選擇器" }; continue; }
    if (b === null) { results[sel] = { match: null, error: "url_b 找不到此選擇器" }; continue; }

    const diffs = {};
    const same = verbose ? {} : undefined;
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of allKeys) {
      const va = JSON.stringify(a[key]);
      const vb = JSON.stringify(b[key]);
      if (va !== vb) { diffs[key] = { a: a[key], b: b[key] }; totalDiffs++; }
      else if (verbose) { same[key] = a[key]; }
    }
    const diffCount = Object.keys(diffs).length;
    if (diffCount === 0) {
      results[sel] = verbose ? { match: true, diffs: {}, same } : { match: true };
    } else {
      results[sel] = verbose ? { match: false, diffs, same } : { match: false, diffs };
    }
  }
  return { results, totalDiffs };
}

/** JS 表達式比對 */
async function compareJs(pageA, pageB, expressions) {
  const keys = Object.keys(expressions);
  const results = {};
  let totalDiffs = 0;

  for (const key of keys) {
    const expr = expressions[key];
    const [valA, valB] = await Promise.all([
      pageA.evaluate(expr).catch((e) => ({ __error: e.message })),
      pageB.evaluate(expr).catch((e) => ({ __error: e.message })),
    ]);
    const strA = JSON.stringify(valA);
    const strB = JSON.stringify(valB);
    if (strA !== strB) {
      results[key] = { match: false, a: valA, b: valB, expression: expr };
      totalDiffs++;
    } else {
      results[key] = { match: true, value: valA, expression: expr };
    }
  }
  return { results, totalDiffs };
}

// ============================================
// handle
// ============================================
export async function handle(name, args) {
  if (name !== "dom_compare") return null;

  const {
    url_a,
    url_b,
    selectors = [],
    compare_mode = "css",
    properties: userProps,
    html_options = {},
    js_expressions = {},
    trigger_action,
    trigger_action_b,
    wait_after_trigger = 500,
    viewport = { width: 1920, height: 1080 },
    timeout = 15000,
    cookies = [],
    cookies_b,
    verbose = false,
    ignore_url_domain = false,
    screenshot: wantScreenshot = false,
  } = args;

  // 驗證
  const modes = compare_mode === "full" ? ["css", "html", "js"] : [compare_mode];
  const needSelectors = modes.includes("css") || modes.includes("html");
  if (needSelectors && (!selectors || selectors.length === 0)) {
    return { content: [{ type: "text", text: "❌ css/html 模式需提供 selectors" }] };
  }
  if (modes.includes("js") && (!js_expressions || Object.keys(js_expressions).length === 0)) {
    if (!needSelectors) {
      return { content: [{ type: "text", text: "❌ js 模式需提供 js_expressions" }] };
    }
    modes.splice(modes.indexOf("js"), 1);
  }
  if (selectors.length > 50) {
    return { content: [{ type: "text", text: "❌ selectors 上限 50 個" }] };
  }

  const props = userProps && userProps.length > 0 ? userProps : DEFAULT_PROPERTIES;
  const browser = await browserPool.acquire({ headless: true });

  try {
    // 建立兩個獨立 context（支援不同 cookies）
    const cookiesA = cookies;
    const cookiesActualB = cookies_b || cookies;

    const contextA = await browser.newContext({
      viewport: { width: viewport.width || 1920, height: viewport.height || 1080 },
      ignoreHTTPSErrors: true,
    });
    const contextB = await browser.newContext({
      viewport: { width: viewport.width || 1920, height: viewport.height || 1080 },
      ignoreHTTPSErrors: true,
    });

    if (cookiesA.length > 0) {
      await contextA.addCookies(cookiesA.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
      })));
    }
    if (cookiesActualB.length > 0) {
      await contextB.addCookies(cookiesActualB.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
      })));
    }

    const [pageA, pageB] = await Promise.all([contextA.newPage(), contextB.newPage()]);

    // 載入頁面
    await Promise.all([
      pageA.goto(url_a, { waitUntil: "networkidle", timeout }),
      pageB.goto(url_b, { waitUntil: "networkidle", timeout }),
    ]);

    // 觸發互動（支援 A/B 不同 trigger）
    const triggerA = trigger_action;
    const triggerB = trigger_action_b || trigger_action;
    if (triggerA || triggerB) {
      await Promise.all([
        triggerA ? pageA.evaluate(triggerA).catch((e) => ({ error: e.message })) : Promise.resolve(),
        triggerB ? pageB.evaluate(triggerB).catch((e) => ({ error: e.message })) : Promise.resolve(),
      ]);
      await new Promise((r) => setTimeout(r, wait_after_trigger));
    }

    // 依模式執行比對
    const output = {};
    const summaryParts = [];

    if (modes.includes("css")) {
      const css = await compareCss(pageA, pageB, selectors, props, {
        verbose,
        ignoreDomain: ignore_url_domain,
      });
      output.css = css.results;
      summaryParts.push(`CSS: ${selectors.length} 選擇器 × ${props.length} 屬性，${css.totalDiffs} 差異`);
    }

    if (modes.includes("html")) {
      const html = await compareHtml(pageA, pageB, selectors, html_options, verbose);
      output.html = html.results;
      summaryParts.push(`HTML(${html_options.compare || "all"}): ${selectors.length} 選擇器，${html.totalDiffs} 差異`);
    }

    if (modes.includes("js")) {
      const js = await compareJs(pageA, pageB, js_expressions);
      output.js = js.results;
      summaryParts.push(`JS: ${Object.keys(js_expressions).length} 表達式，${js.totalDiffs} 差異`);
    }

    // 截圖
    const contentBlocks = [];
    if (wantScreenshot) {
      const [bufA, bufB] = await Promise.all([
        pageA.screenshot({ fullPage: false }),
        pageB.screenshot({ fullPage: false }),
      ]);
      contentBlocks.push(
        { type: "image", data: bufA.toString("base64"), mimeType: "image/png" },
        { type: "image", data: bufB.toString("base64"), mimeType: "image/png" },
      );
      summaryParts.push("截圖: url_a [image 1], url_b [image 2]");
    }

    // 清理 context（browser 留在 pool）
    await Promise.all([contextA.close(), contextB.close()]).catch(() => {});

    // 單模式時攤平（向下相容原本的 css-only 輸出）
    const finalOutput = modes.length === 1 && modes[0] === "css" ? output.css : output;
    const summary = `比對完成（${compare_mode} 模式）\n` + summaryParts.join("\n");

    return {
      content: [
        { type: "text", text: summary + "\n\n" + JSON.stringify(finalOutput, null, 2) },
        ...contentBlocks,
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `❌ dom_compare 執行失敗：${err.message}` }],
    };
  }
}
