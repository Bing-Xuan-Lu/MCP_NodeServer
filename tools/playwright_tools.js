// tools/playwright_tools.js — browser_interact + page_audit
// 自帶 headless Chromium，不依賴 Playwright MCP

let playwrightModule = null;
async function getPlaywright() {
  if (!playwrightModule) {
    playwrightModule = await import("@playwright/test");
  }
  return playwrightModule;
}

// ============================================
// Browser Pool（跨呼叫複用 browser 進程）
// ============================================
let pooledBrowser = null;
let poolTimer = null;
const POOL_TTL = 60000; // 60 秒無活動自動關閉

async function acquireBrowser() {
  if (pooledBrowser && pooledBrowser.isConnected()) {
    clearTimeout(poolTimer);
    poolTimer = setTimeout(releasePool, POOL_TTL);
    return pooledBrowser;
  }
  const { chromium } = await getPlaywright();
  pooledBrowser = await chromium.launch({ headless: true });
  poolTimer = setTimeout(releasePool, POOL_TTL);
  return pooledBrowser;
}

function releasePool() {
  if (pooledBrowser) {
    pooledBrowser.close().catch(() => {});
    pooledBrowser = null;
    poolTimer = null;
  }
}

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "browser_interact",
    description:
      "在自帶 headless 瀏覽器中執行一連串動作(click、hover、type、dismiss overlay、wait、evaluate、extract、screenshot 等)。所有動作在同一個執行上下文中連續執行,hover 狀態不會中斷。一次 tool call 取代 3-6 次 Playwright MCP 呼叫。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要操作的頁面 URL" },
        actions: {
          type: "array",
          description: "依序執行的動作陣列",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "click", "hover", "type", "select", "check", "uncheck",
                  "dismiss", "wait", "wait_for", "scroll_to",
                  "evaluate", "extract", "extract_all", "screenshot",
                  "navigate", "watch_network", "collect_network",
                ],
                description: "動作類型",
              },
              selector: { type: "string", description: "CSS 選擇器(大部分動作需要)" },
              selectors: { type: "array", items: { type: "string" }, description: "extract_all 用:批次擷取多個選擇器" },
              text: { type: "string", description: "type 動作的輸入文字" },
              value: { type: "string", description: "select 動作的選項值" },
              expression: { type: "string", description: "evaluate 動作的 JS 表達式" },
              force: { type: "boolean", description: "click/hover 是否跳過遮擋檢查(預設 false)" },
              clear: { type: "boolean", description: "type 前是否清空欄位(預設 true)" },
              ms: { type: "number", description: "wait 動作的等待毫秒數" },
              state: { type: "string", enum: ["visible", "hidden", "attached"], description: "wait_for 的目標狀態(預設 visible)" },
              full_page: { type: "boolean", description: "screenshot 是否全頁截圖(預設 false)" },
              filename: { type: "string", description: "screenshot 存檔路徑(選填,設定後存檔而非回傳 base64)" },
              data: {
                type: "string",
                enum: ["text", "html", "value", "attribute", "boundingBox", "styles", "all"],
                description: "extract 要擷取的資料類型(預設 text)",
              },
              attribute: { type: "string", description: "extract data=attribute 時的屬性名" },
              styles: { type: "array", items: { type: "string" }, description: "extract data=styles 時的 CSS 屬性清單" },
              url: { type: "string", description: "navigate 動作的目標 URL" },
              wait_for_navigation: { type: "boolean", description: "click 後是否等待頁面導航完成(預設 false)" },
              filter: { type: "string", description: "watch_network 用:URL 過濾關鍵字(只捕捉包含此字串的請求,如 'ajax/' 或 'api/')" },
              include_body: { type: "boolean", description: "watch_network 用:是否捕捉 response body(預設 true)" },
              max_body_size: { type: "number", description: "watch_network 用:response body 最大擷取字元數(預設 2000)" },
            },
            required: ["type"],
          },
        },
        viewport: {
          type: "object",
          properties: { width: { type: "number" }, height: { type: "number" } },
          description: "視窗大小(預設 1920x1080)",
        },
        timeout: { type: "number", description: "頁面載入逾時毫秒數(預設 15000)" },
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
          description: "選填:注入 cookies(用於需要登入的頁面)",
        },
      },
      required: ["url", "actions"],
    },
  },
  {
    name: "page_audit",
    description:
      "一鍵頁面健檢:蒐集 console 錯誤/警告、載入失敗的資源(JS/CSS/圖片 404)、壞圖偵測、效能指標(loadTime/DOMContentLoaded/FCP/LCP)、meta 標籤。一次呼叫取代多次手動檢查。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要檢查的頁面 URL" },
        checks: {
          type: "array",
          items: { type: "string", enum: ["console", "resources", "images", "performance", "meta"] },
          description: "要執行的檢查項目(預設全部)",
        },
        viewport: {
          type: "object",
          properties: { width: { type: "number" }, height: { type: "number" } },
          description: "視窗大小(預設 1920x1080)",
        },
        timeout: { type: "number", description: "頁面載入逾時毫秒數(預設 30000)" },
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
          description: "選填:注入 cookies(用於需要登入的頁面)",
        },
      },
      required: ["url"],
    },
  },
];

// ============================================
// browser_interact 實作
// ============================================
async function handleBrowserInteract(args) {
  const {
    url,
    actions,
    viewport = { width: 1920, height: 1080 },
    timeout = 15000,
    cookies = [],
  } = args;

  if (!actions || actions.length === 0) {
    return { content: [{ type: "text", text: "❌ actions 不可為空" }] };
  }
  if (actions.length > 100) {
    return { content: [{ type: "text", text: "❌ actions 上限 100 個" }] };
  }

  const browser = await acquireBrowser();
  const dismissedElements = [];
  let context = null;

  try {
    context = await browser.newContext({
      viewport: { width: viewport.width || 1920, height: viewport.height || 1080 },
      ignoreHTTPSErrors: true,
    });

    // 注入 cookies
    if (cookies.length > 0) {
      await context.addCookies(cookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
      })));
    }

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout });

    const results = [];
    const contentBlocks = [];

    // Network 監聽器狀態（由 watch_network / collect_network 動態控制）
    let networkCaptures = [];
    let networkFilter = "";
    let networkIncludeBody = true;
    let networkMaxBodySize = 2000;
    let networkListener = null;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const label = `[${i}] ${action.type}${action.selector ? ` "${action.selector}"` : ""}`;

      try {
        switch (action.type) {
          case "click": {
            if (action.wait_for_navigation) {
              const navPromise = page.waitForNavigation({ waitUntil: "networkidle", timeout }).catch(() => {});
              if (action.force) {
                await page.evaluate((sel) => document.querySelector(sel)?.click(), action.selector);
              } else {
                await page.click(action.selector, { timeout: 5000 });
              }
              await navPromise;
              results.push({ action: label, ok: true, url: page.url() });
            } else {
              if (action.force) {
                await page.evaluate((sel) => document.querySelector(sel)?.click(), action.selector);
              } else {
                await page.click(action.selector, { timeout: 5000 });
              }
              results.push({ action: label, ok: true });
            }
            break;
          }

          case "hover": {
            if (action.force) {
              await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
              }, action.selector);
            } else {
              await page.hover(action.selector, { timeout: 5000 });
            }
            results.push({ action: label, ok: true });
            break;
          }

          case "type": {
            if (action.clear !== false) {
              await page.fill(action.selector, action.text || "", { timeout: 5000 });
            } else {
              await page.type(action.selector, action.text || "", { timeout: 5000 });
            }
            results.push({ action: label, ok: true });
            break;
          }

          case "select": {
            await page.selectOption(action.selector, action.value, { timeout: 5000 });
            results.push({ action: label, ok: true });
            break;
          }

          case "check": {
            await page.check(action.selector, { timeout: 5000 });
            results.push({ action: label, ok: true });
            break;
          }

          case "uncheck": {
            await page.uncheck(action.selector, { timeout: 5000 });
            results.push({ action: label, ok: true });
            break;
          }

          case "dismiss": {
            await page.evaluate((sel) => {
              document.querySelectorAll(sel).forEach((el) => {
                el.dataset._origDisplay = el.style.display;
                el.style.display = "none";
              });
            }, action.selector);
            dismissedElements.push(action.selector);
            results.push({ action: label, ok: true });
            break;
          }

          case "wait": {
            await new Promise((r) => setTimeout(r, action.ms || 500));
            results.push({ action: label, ok: true });
            break;
          }

          case "wait_for": {
            await page.waitForSelector(action.selector, {
              state: action.state || "visible",
              timeout: action.ms || 10000,
            });
            results.push({ action: label, ok: true });
            break;
          }

          case "scroll_to": {
            await page.evaluate((sel) => {
              document.querySelector(sel)?.scrollIntoView({ block: "center", behavior: "instant" });
            }, action.selector);
            results.push({ action: label, ok: true });
            break;
          }

          case "navigate": {
            const targetUrl = action.url || action.value;
            if (!targetUrl) {
              results.push({ action: label, ok: false, error: "navigate 需要 url 參數" });
              break;
            }
            await page.goto(targetUrl, { waitUntil: "networkidle", timeout });
            results.push({ action: label, ok: true, url: page.url() });
            break;
          }

          case "watch_network": {
            // 清空之前的捕捉
            networkCaptures = [];
            networkFilter = action.filter || "";
            networkIncludeBody = action.include_body !== false;
            networkMaxBodySize = action.max_body_size || 2000;

            // 移除舊的 listener（避免重複掛載）
            if (networkListener) {
              page.removeListener("response", networkListener);
            }

            networkListener = async (response) => {
              const req = response.request();
              const resType = req.resourceType();
              // 只捕捉 XHR / fetch（跳過圖片、CSS、JS 等靜態資源）
              if (resType !== "xhr" && resType !== "fetch") return;

              const reqUrl = req.url();
              if (networkFilter && !reqUrl.includes(networkFilter)) return;

              const entry = {
                url: reqUrl.substring(0, 500),
                method: req.method(),
                status: response.status(),
                postData: req.postData()?.substring(0, networkMaxBodySize) || null,
                responseBody: null,
              };

              if (networkIncludeBody) {
                try {
                  const body = await response.text();
                  entry.responseBody = body.substring(0, networkMaxBodySize);
                  // 嘗試 parse JSON 以便結構化顯示
                  try { entry.responseBody = JSON.parse(entry.responseBody); } catch {}
                } catch {
                  entry.responseBody = "(無法讀取 body)";
                }
              }

              networkCaptures.push(entry);
            };

            page.on("response", networkListener);
            results.push({ action: label, ok: true, note: `開始監聽 XHR/Fetch${networkFilter ? `（過濾: ${networkFilter}）` : "（全部）"}` });
            break;
          }

          case "collect_network": {
            // 先等一下讓非同步 response 回來
            await page.waitForTimeout(action.ms || 500);

            if (networkCaptures.length === 0) {
              results.push({ action: label, ok: true, note: "沒有捕捉到 XHR/Fetch 請求", captures: [] });
            } else {
              results.push({
                action: label,
                ok: true,
                note: `捕捉到 ${networkCaptures.length} 個請求`,
                captures: networkCaptures,
              });
            }

            // 收集後清空，可再次 watch_network 開啟新一輪
            networkCaptures = [];
            break;
          }

          case "evaluate": {
            const evalResult = await page.evaluate(action.expression);
            results.push({ action: label, ok: true, result: evalResult });
            break;
          }

          case "extract": {
            const extractData = await page.evaluate(
              ({ sel, dataType, attrName, styleList }) => {
                const el = document.querySelector(sel);
                if (!el) return { __notFound: true };

                if (dataType === "all") {
                  const cs = window.getComputedStyle(el);
                  const attrs = {};
                  for (const a of el.attributes) attrs[a.name] = a.value;
                  return {
                    text: el.textContent?.trim().substring(0, 1000) || "",
                    html: el.innerHTML?.substring(0, 2000) || "",
                    value: el.value ?? null,
                    attributes: attrs,
                    boundingBox: el.getBoundingClientRect().toJSON(),
                    visible: el.offsetParent !== null || cs.display !== "none",
                    styles: Object.fromEntries((styleList || []).map((p) => [p, cs.getPropertyValue(p)])),
                  };
                }

                switch (dataType) {
                  case "text": return { text: el.textContent?.trim().substring(0, 2000) || "" };
                  case "html": return { html: el.innerHTML?.substring(0, 5000) || "" };
                  case "value": return { value: el.value ?? null };
                  case "attribute": return { [attrName || "class"]: el.getAttribute(attrName || "class") };
                  case "boundingBox": return { boundingBox: el.getBoundingClientRect().toJSON() };
                  case "styles": {
                    const cs2 = window.getComputedStyle(el);
                    return Object.fromEntries((styleList || []).map((p) => [p, cs2.getPropertyValue(p)]));
                  }
                  default: return { text: el.textContent?.trim().substring(0, 2000) || "" };
                }
              },
              { sel: action.selector, dataType: action.data || "text", attrName: action.attribute, styleList: action.styles },
            );

            if (extractData?.__notFound) {
              results.push({ action: label, ok: false, error: "找不到選擇器" });
            } else {
              results.push({ action: label, ok: true, data: extractData });
            }
            break;
          }

          case "extract_all": {
            const selList = action.selectors || (action.selector ? [action.selector] : []);
            if (selList.length === 0) {
              results.push({ action: label, ok: false, error: "extract_all 需要 selectors 陣列" });
              break;
            }
            const batchData = await page.evaluate(
              ({ sels, dataType, styleList }) => {
                const out = {};
                for (const sel of sels) {
                  const el = document.querySelector(sel);
                  if (!el) { out[sel] = null; continue; }
                  const cs = window.getComputedStyle(el);
                  out[sel] = {
                    text: el.textContent?.trim().substring(0, 500) || "",
                    visible: el.offsetParent !== null || cs.display !== "none",
                    boundingBox: el.getBoundingClientRect().toJSON(),
                    styles: Object.fromEntries((styleList || []).map((p) => [p, cs.getPropertyValue(p)])),
                  };
                }
                return out;
              },
              { sels: selList, dataType: action.data || "text", styleList: action.styles || [] },
            );
            results.push({ action: `[${i}] extract_all (${selList.length} selectors)`, ok: true, data: batchData });
            break;
          }

          case "screenshot": {
            let buf;
            if (action.selector) {
              // 元素級截圖
              const el = await page.$(action.selector);
              if (el) {
                buf = await el.screenshot();
              } else {
                results.push({ action: label, ok: false, error: `找不到選擇器: ${action.selector}` });
                break;
              }
            } else {
              buf = await page.screenshot({ fullPage: action.full_page || false });
            }

            if (action.filename) {
              // 存檔模式
              const fs = await import("node:fs/promises");
              const path = await import("node:path");
              // 確保目錄存在
              const dir = path.dirname(action.filename);
              await fs.mkdir(dir, { recursive: true }).catch(() => {});
              await fs.writeFile(action.filename, buf);
              results.push({ action: label, ok: true, saved: action.filename });
            } else {
              // 回傳 base64 模式
              const base64 = buf.toString("base64");
              results.push({ action: label, ok: true, screenshot: `[image ${contentBlocks.length}]` });
              contentBlocks.push({
                type: "image",
                data: base64,
                mimeType: "image/png",
              });
            }
            break;
          }

          default:
            results.push({ action: label, ok: false, error: `未知動作類型: ${action.type}` });
        }
      } catch (err) {
        results.push({ action: label, ok: false, error: err.message });
      }
    }

    // 還原被 dismiss 的元素
    if (dismissedElements.length > 0) {
      await page.evaluate((sels) => {
        for (const sel of sels) {
          document.querySelectorAll(sel).forEach((el) => {
            el.style.display = el.dataset._origDisplay || "";
            delete el.dataset._origDisplay;
          });
        }
      }, dismissedElements).catch(() => {});
    }

    // 清理 context（browser 留在 pool）
    await context.close().catch(() => {});

    // 組裝輸出
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.filter((r) => !r.ok).length;
    const summary = `browser_interact 完成：${actions.length} 動作，✅ ${okCount} 成功，${failCount > 0 ? `❌ ${failCount} 失敗` : "無失敗"}`;

    const content = [
      { type: "text", text: summary + "\n\n" + JSON.stringify(results, null, 2) },
      ...contentBlocks,
    ];

    return { content };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return {
      content: [{ type: "text", text: `❌ browser_interact 執行失敗：${err.message}` }],
    };
  }
}

// ============================================
// page_audit 實作
// ============================================
async function handlePageAudit(args) {
  const {
    url,
    checks: userChecks,
    viewport = { width: 1920, height: 1080 },
    timeout = 30000,
    cookies = [],
  } = args;

  const checks = userChecks && userChecks.length > 0
    ? userChecks
    : ["console", "resources", "images", "performance", "meta"];

  const browser = await acquireBrowser();
  let context = null;

  try {
    context = await browser.newContext({
      viewport: { width: viewport.width || 1920, height: viewport.height || 1080 },
      ignoreHTTPSErrors: true,
    });

    if (cookies.length > 0) {
      await context.addCookies(cookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
      })));
    }

    const page = await context.newPage();

    // 收集 console 訊息
    const consoleLogs = [];
    if (checks.includes("console")) {
      page.on("console", (msg) => {
        const type = msg.type();
        if (type === "error" || type === "warning") {
          consoleLogs.push({ type, text: msg.text().substring(0, 500) });
        }
      });
    }

    // 收集載入失敗的資源
    const failedResources = [];
    if (checks.includes("resources")) {
      page.on("requestfailed", (req) => {
        failedResources.push({
          url: req.url().substring(0, 200),
          method: req.method(),
          resourceType: req.resourceType(),
          error: req.failure()?.errorText || "unknown",
        });
      });
      page.on("response", (res) => {
        if (res.status() >= 400) {
          failedResources.push({
            url: res.url().substring(0, 200),
            status: res.status(),
            resourceType: res.request().resourceType(),
          });
        }
      });
    }

    // 載入頁面
    const startTime = Date.now();
    await page.goto(url, { waitUntil: "networkidle", timeout });
    const loadTime = Date.now() - startTime;

    const report = {};
    const summaryParts = [];

    // Console 錯誤
    if (checks.includes("console")) {
      const errors = consoleLogs.filter((l) => l.type === "error");
      const warnings = consoleLogs.filter((l) => l.type === "warning");
      report.console = { errors, warnings };
      summaryParts.push(`Console: ${errors.length} 錯誤, ${warnings.length} 警告`);
    }

    // 載入失敗的資源
    if (checks.includes("resources")) {
      report.resources = { failed: failedResources };
      summaryParts.push(`Resources: ${failedResources.length} 載入失敗`);
    }

    // 壞圖偵測
    if (checks.includes("images")) {
      const imageReport = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll("img"));
        const broken = [];
        const noAlt = [];
        for (const img of imgs) {
          if (!img.complete || img.naturalWidth === 0) {
            broken.push({ src: img.src?.substring(0, 200), alt: img.alt || "" });
          }
          if (!img.alt && !img.getAttribute("aria-label")) {
            noAlt.push({ src: img.src?.substring(0, 200) });
          }
        }
        return { total: imgs.length, broken, noAlt };
      });
      report.images = imageReport;
      summaryParts.push(`Images: ${imageReport.total} 張，${imageReport.broken.length} 壞圖，${imageReport.noAlt.length} 缺 alt`);
    }

    // 效能指標
    if (checks.includes("performance")) {
      const perfData = await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0];
        const paint = performance.getEntriesByType("paint");
        const fcp = paint.find((p) => p.name === "first-contentful-paint");
        return {
          loadTime: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
          domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
          firstContentfulPaint: fcp ? Math.round(fcp.startTime) : null,
          transferSize: nav ? nav.transferSize : null,
        };
      });
      // LCP 需要額外等待
      const lcpValue = await page.evaluate(() => {
        return new Promise((resolve) => {
          let lcpTime = null;
          try {
            new PerformanceObserver((list) => {
              const entries = list.getEntries();
              if (entries.length > 0) lcpTime = Math.round(entries[entries.length - 1].startTime);
            }).observe({ type: "largest-contentful-paint", buffered: true });
          } catch (e) { /* LCP not supported */ }
          setTimeout(() => resolve(lcpTime), 1000);
        });
      });
      perfData.largestContentfulPaint = lcpValue;
      perfData.totalLoadTime = loadTime;
      report.performance = perfData;
      summaryParts.push(`Performance: 載入 ${loadTime}ms, DOM ${perfData.domContentLoaded || "?"}ms, FCP ${perfData.firstContentfulPaint || "?"}ms, LCP ${lcpValue || "?"}ms`);
    }

    // Meta 標籤
    if (checks.includes("meta")) {
      const metaData = await page.evaluate(() => {
        const getMeta = (name) =>
          document.querySelector(`meta[name="${name}"]`)?.content ||
          document.querySelector(`meta[property="${name}"]`)?.content || null;
        return {
          title: document.title || null,
          description: getMeta("description"),
          viewport: getMeta("viewport"),
          ogTitle: getMeta("og:title"),
          ogDescription: getMeta("og:description"),
          ogImage: getMeta("og:image"),
          charset: document.characterSet,
          lang: document.documentElement.lang || null,
        };
      });
      report.meta = metaData;
      summaryParts.push(`Meta: title=${metaData.title ? "✅" : "❌"} desc=${metaData.description ? "✅" : "❌"} viewport=${metaData.viewport ? "✅" : "❌"}`);
    }

    // 清理 context
    await context.close().catch(() => {});

    const summary = `🔍 page_audit 報告 — ${url}\n` + summaryParts.join("\n");

    return {
      content: [{
        type: "text",
        text: summary + "\n\n" + JSON.stringify(report, null, 2),
      }],
    };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return {
      content: [{ type: "text", text: `❌ page_audit 執行失敗：${err.message}` }],
    };
  }
}

// ============================================
// handle 路由
// ============================================
export async function handle(name, args) {
  switch (name) {
    case "browser_interact": return handleBrowserInteract(args);
    case "page_audit":       return handlePageAudit(args);
    default:                 return null;
  }
}
