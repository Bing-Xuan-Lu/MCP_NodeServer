// tools/css_compare.js — 批次比對兩個 URL 上多個選擇器的 Computed Style
// 用途：一次呼叫取代 4-6 次 browser_evaluate，直接回傳差異

// 延遲載入 Playwright（避免啟動時載入）
let playwrightModule = null;
async function getPlaywright() {
  if (!playwrightModule) {
    playwrightModule = await import("@playwright/test");
  }
  return playwrightModule;
}

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "css_compare",
    description:
      "批次比對兩個 URL 上多個 CSS 選擇器的 computed style，回傳差異。可指定 trigger_action 在擷取前觸發互動（如開啟 Popup）。",
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
        properties: {
          type: "array",
          items: { type: "string" },
          description:
            "要比對的 CSS 屬性清單。留空則使用預設常用屬性集（position, display, width, height, margin, padding, top, right, bottom, left, transform, z-index, opacity, font-size, color, background-color, border, box-sizing, overflow, text-align）",
        },
        trigger_action: {
          type: "string",
          description:
            "選填：在兩個頁面上擷取前執行的 JS 表達式（例如觸發 Popup）。會在兩個頁面上分別執行，執行後等待 500ms",
        },
        wait_after_trigger: {
          type: "number",
          description: "trigger_action 執行後等待毫秒數（預設 500）",
        },
        viewport: {
          type: "object",
          properties: {
            width: { type: "number" },
            height: { type: "number" },
          },
          description: "選填：指定視窗大小（預設 1920x1080）",
        },
        timeout: {
          type: "number",
          description: "頁面載入逾時毫秒數（預設 15000）",
        },
      },
      required: ["url_a", "url_b", "selectors"],
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
// handle
// ============================================
export async function handle(name, args) {
  if (name !== "css_compare") return null;

  const {
    url_a,
    url_b,
    selectors,
    properties: userProps,
    trigger_action,
    wait_after_trigger = 500,
    viewport = { width: 1920, height: 1080 },
    timeout = 15000,
  } = args;

  if (!selectors || selectors.length === 0) {
    return { content: [{ type: "text", text: "❌ selectors 不可為空" }] };
  }
  if (selectors.length > 50) {
    return { content: [{ type: "text", text: "❌ selectors 上限 50 個" }] };
  }

  const props = userProps && userProps.length > 0 ? userProps : DEFAULT_PROPERTIES;

  const { chromium } = await getPlaywright();
  let browser = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: viewport.width || 1920, height: viewport.height || 1080 },
      ignoreHTTPSErrors: true,
    });

    const [pageA, pageB] = await Promise.all([
      context.newPage(),
      context.newPage(),
    ]);

    // 載入頁面
    await Promise.all([
      pageA.goto(url_a, { waitUntil: "networkidle", timeout }),
      pageB.goto(url_b, { waitUntil: "networkidle", timeout }),
    ]);

    // 觸發互動（如開 Popup）
    if (trigger_action) {
      await Promise.all([
        pageA.evaluate(trigger_action).catch((e) => ({ error: e.message })),
        pageB.evaluate(trigger_action).catch((e) => ({ error: e.message })),
      ]);
      await new Promise((r) => setTimeout(r, wait_after_trigger));
    }

    // 擷取 computed styles
    const extractStyles = async (page, label) => {
      return page.evaluate(
        ({ sels, propList }) => {
          const result = {};
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (!el) {
              result[sel] = null;
              continue;
            }
            const cs = window.getComputedStyle(el);
            const styles = {};
            for (const p of propList) {
              styles[p] = cs.getPropertyValue(p);
            }
            result[sel] = styles;
          }
          return result;
        },
        { sels: selectors, propList: props },
      );
    };

    const [stylesA, stylesB] = await Promise.all([
      extractStyles(pageA, "a"),
      extractStyles(pageB, "b"),
    ]);

    // 比對
    const results = {};
    let totalDiffs = 0;

    for (const sel of selectors) {
      const a = stylesA[sel];
      const b = stylesB[sel];

      if (a === null && b === null) {
        results[sel] = { match: null, error: "兩邊都找不到此選擇器" };
        continue;
      }
      if (a === null) {
        results[sel] = { match: null, error: "url_a 找不到此選擇器" };
        continue;
      }
      if (b === null) {
        results[sel] = { match: null, error: "url_b 找不到此選擇器" };
        continue;
      }

      const diffs = {};
      const same = {};
      for (const p of props) {
        if (a[p] !== b[p]) {
          diffs[p] = { a: a[p], b: b[p] };
        } else {
          same[p] = a[p];
        }
      }

      const diffCount = Object.keys(diffs).length;
      totalDiffs += diffCount;
      results[sel] = {
        match: diffCount === 0,
        diffs,
        same,
      };
    }

    // 摘要
    const matchCount = Object.values(results).filter((r) => r.match === true).length;
    const diffSelectors = Object.values(results).filter((r) => r.match === false).length;
    const errorSelectors = Object.values(results).filter((r) => r.match === null).length;

    const summary = [
      `比對完成：${selectors.length} 個選擇器，${props.length} 個屬性`,
      `✅ 完全一致：${matchCount}　⚠️ 有差異：${diffSelectors}　❌ 找不到：${errorSelectors}`,
      `共 ${totalDiffs} 個屬性差異`,
    ].join("\n");

    return {
      content: [
        {
          type: "text",
          text: summary + "\n\n" + JSON.stringify(results, null, 2),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `❌ css_compare 執行失敗：${err.message}` }],
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
