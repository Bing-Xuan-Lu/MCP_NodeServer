// tools/playwright_tools.js — browser_interact + page_audit + css_inspect + element_measure + style_snapshot + css_coverage + browser_save_session + browser_restore_session
// 自帶 headless Chromium，不依賴 Playwright MCP

import fs from "fs/promises";
import path from "path";
import os from "os";
import { validateArgs, calcSpecificity } from "../_shared/utils.js";
import { prepareForMeasure } from "../_shared/playwright_measure_prep.js";

const SESSION_DIR = path.join(os.homedir(), ".claude", "sessions");

// css_inspect / element_measure 共用：量測前置（等遮罩 + trigger 展開）的 schema 片段
const MEASURE_PREP_SCHEMA = {
  trigger_selectors: {
    type: "array",
    items: { type: "string" },
    description: "選填：量測前依序 click 這些 selector（展開 popup/modal/dropdown 才出現的元素）。每次 click 後等待 trigger_wait 毫秒。",
  },
  trigger_wait: { type: "number", description: "選填：每次 trigger click 後等待毫秒（預設 300）" },
  click_timeout: { type: "number", description: "選填：trigger 一般 click 的逾時毫秒（預設 5000）。逾時自動 fallback 用 JS .click()。" },
  force_click: { type: "boolean", description: "選填：trigger 直接用 JS .click() 繞過可點擊性檢查（預設 false）。頁面有 loading 遮罩攔截點擊時開啟。" },
  wait_for_hidden: {
    type: "array",
    items: { type: "string" },
    description: "選填：量測 / 點 trigger 前先等這些遮罩 selector 消失。不傳=自動等常見 loading 遮罩（.loader/.loading/.overlay/.spinner）；傳 [] 關閉；傳 [\".my-loader\"] 指定。解 AJAX loading 遮罩攔截 click 的痛點。",
  },
  wait_hidden_timeout: { type: "number", description: "選填：等遮罩消失的逾時毫秒（預設 5000）" },
  wait_for_selector: { type: "string", description: "選填：trigger 後等此 selector 出現再量測（預設等目標 selector 本身）" },
  wait_for_timeout: { type: "number", description: "選填：wait_for_selector 等待逾時毫秒（預設 3000）" },
};

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
                  "auto_dismiss_file_chooser", "dismiss_file_chooser_now",
                  "inspect_element",
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
              hide_selectors: { type: "array", items: { type: "string" }, description: "screenshot 用:截圖前暫時把這些選擇器 display:none(浮動客服、chat widget、fixed banner 等),截完自動還原,避免遮擋 popup/內容" },
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
              property: { type: "string", description: "inspect_element 用：要查的 CSS 屬性（kebab-case，如 'background-color'）；省略時 dump 整個 computed style" },
              properties: { type: "array", items: { type: "string" }, description: "inspect_element 用：批次查多個屬性" },
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
      "一鍵頁面健檢:蒐集 console 錯誤/警告、載入失敗的資源(JS/CSS/圖片 404)、壞圖偵測(含 QC 增強:空 select/上傳欄位缺提示/表單殘留/CKEditor 狀態/CKFinder 健康)、效能指標(loadTime/DOMContentLoaded/FCP/LCP)、meta 標籤。一次呼叫取代多次手動檢查。",
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
  {
    name: "css_inspect",
    description:
      "深度檢查指定元素的 CSS 樣式：box model、computed styles、flex/grid 上下文、套用的 CSS 規則（含來源檔案與優先級）、繼承屬性。用於除錯排版問題，一次呼叫取代 DevTools 手動檢查。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要檢查的頁面 URL" },
        selector: { type: "string", description: "目標元素的 CSS 選擇器" },
        pseudoElement: {
          type: "string",
          enum: ["::before", "::after", "::first-line", "::first-letter", "::marker", "::placeholder"],
          description: "選填：檢查偽元素的樣式",
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
        ...MEASURE_PREP_SCHEMA,
      },
      required: ["url", "selector"],
    },
  },
  {
    name: "element_measure",
    description:
      "測量元素的尺寸/padding/margin，若指定第二個元素則計算兩者間距。等同 F12 量尺工具，一次呼叫取代手動 getBoundingClientRect + 算差值。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要測量的頁面 URL" },
        selectorA: { type: "string", description: "第一個元素的 CSS 選擇器" },
        selectorB: { type: "string", description: "選填：第二個元素（計算兩者間距）" },
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
          description: "選填:注入 cookies",
        },
        ...MEASURE_PREP_SCHEMA,
      },
      required: ["url", "selectorA"],
    },
  },
  {
    name: "style_snapshot",
    description:
      "批次擷取多個元素的指定 CSS 屬性，回傳結構化 JSON。用於 XD/Figma 比對（只比樣式不比內容，避免 image_diff 因文字不同炸紅一片）。對兩個 URL 各跑一次再 diff 即可精確列出差異屬性。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要擷取的頁面 URL" },
        selectors: {
          type: "array",
          items: { type: "string" },
          description: "要擷取的 CSS 選擇器列表",
        },
        properties: {
          type: "array",
          items: { type: "string" },
          description: "要擷取的 CSS 屬性（camelCase 或 kebab-case 皆可，預設常用 15 個）",
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
          description: "選填:注入 cookies",
        },
      },
      required: ["url", "selectors"],
    },
  },
  {
    name: "css_coverage",
    description:
      "分析頁面的 CSS 使用率：哪些規則被用到、哪些是死的（deadSelectors = selector 完全沒對到任何元素）。用於 CSS 檔清理/去重前的安全評估。可指定只分析特定 CSS 檔案。\n進階：開 detectOverridden=true 額外偵測「死宣告」——selector 有對到元素、但整條規則的宣告全被更高 specificity / inline style / !important 蓋掉（DevTools 會劃線、byte coverage 卻當它已使用）。注意：@media/@keyframes/@font-face/@page 內的規則為渲染變體，會排除在死宣告分析外避免誤判（如 @media print 的列印專用 class）。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要分析的頁面 URL" },
        cssFile: { type: "string", description: "選填：只分析指定的 CSS 檔案名（URL 包含此字串的 stylesheet）" },
        detectOverridden: { type: "boolean", description: "選填：偵測死宣告（selector 命中但宣告全被覆蓋）。預設 false。開啟會逐元素跑 CDP 比對，較慢。" },
        sampleLimit: { type: "number", description: "選填：detectOverridden 時每條規則最多取樣幾個命中元素判定（預設 20）" },
        maxElements: { type: "number", description: "選填：detectOverridden 全程最多檢查的元素總數上限（預設 400，避免大頁面跑太久）" },
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
          description: "選填:注入 cookies",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_save_session",
    description: "登入後儲存瀏覽器 session（cookies + localStorage + sessionStorage）到本機，供下次對話還原登入狀態，免重複走登入流程。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "登入後的任意頁面 URL（用於擷取 cookies 和 storage）" },
        session_key: { type: "string", description: "session 識別名稱，預設 'default'（建議用專案名，如 'myproject'）" },
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
          description: "選填：先注入這些 cookies 再擷取（用於已有 cookies 想一起存）",
        },
        viewport: {
          type: "object",
          properties: { width: { type: "number" }, height: { type: "number" } },
        },
        timeout: { type: "number", description: "頁面載入逾時毫秒數（預設 15000）" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_restore_session",
    description: "還原先前儲存的瀏覽器 session，回傳 cookies 陣列，可直接傳入 browser_interact / page_audit 的 cookies 參數跳過登入。若傳 target_url 會檢查 session domain 是否匹配，避免把 A 站 cookies 套到 B 站沒反應。",
    inputSchema: {
      type: "object",
      properties: {
        session_key: { type: "string", description: "session 識別名稱，預設 'default'" },
        target_url: { type: "string", description: "選填：要套用 session 的目標 URL，會與 session 的 domain/cookie_domains 比對，不匹配會警告" },
      },
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

          case "auto_dismiss_file_chooser": {
            // 註冊 page-level handler，後續任何 file chooser 觸發後自動 setFiles([]) 解除 modal state
            // 必須在會觸發 file chooser 的 click 之前呼叫；只需註冊一次。
            if (!page._autoDismissFileChooserRegistered) {
              page.on('filechooser', async (chooser) => {
                try { await chooser.setFiles([]); } catch {}
              });
              page._autoDismissFileChooserRegistered = true;
            }
            results.push({ action: label, ok: true, note: 'file chooser handler registered' });
            break;
          }

          case "dismiss_file_chooser_now": {
            // 已經卡在 modal state 時的緊急脫困：等下一個 filechooser event 並 setFiles([])
            // 配合 Promise.race，超時即放棄
            const TIMEOUT_MS = action.ms || 2000;
            try {
              const chooser = await Promise.race([
                page.waitForEvent('filechooser', { timeout: TIMEOUT_MS }),
                new Promise((_, rej) => setTimeout(() => rej(new Error('no filechooser event within timeout')), TIMEOUT_MS + 100)),
              ]);
              await chooser.setFiles([]);
              results.push({ action: label, ok: true, note: 'file chooser dismissed' });
            } catch (e) {
              results.push({ action: label, ok: false, error: `dismiss_file_chooser_now: ${e.message}` });
            }
            break;
          }

          case "inspect_element": {
            // F12-like：在當前 page session 內取目標元素的 computed style + matched CSS rules（CDP）
            // 沿用 actions 之前已建立的所有狀態（登入、cookies、popup 已開、購物車已加商品等）
            const targetProps = Array.isArray(action.properties) && action.properties.length
              ? action.properties
              : (action.property ? [action.property] : null);

            const elExists = await page.$(action.selector);
            if (!elExists) {
              results.push({ action: label, ok: false, error: `inspect_element: 找不到元素 ${action.selector}（在當前 page state 下）` });
              break;
            }

            // computed style（不需要 CDP，getComputedStyle 直接取）
            const computed = await page.evaluate(({ sel, props }) => {
              const el = document.querySelector(sel);
              if (!el) return null;
              const cs = window.getComputedStyle(el);
              if (props) {
                const out = {};
                for (const p of props) out[p] = cs.getPropertyValue(p);
                return out;
              }
              // 全 dump 但只挑非預設值
              const out = {};
              for (let i = 0; i < cs.length; i++) {
                const name = cs[i];
                out[name] = cs.getPropertyValue(name);
              }
              return out;
            }, { sel: action.selector, props: targetProps });

            // CDP：matched CSS rules + 來源檔行號
            let cdp = null;
            let matchedSummary = null;
            try {
              cdp = await context.newCDPSession(page);
              const sheetHeaders = new Map();
              cdp.on('CSS.styleSheetAdded', ({ header }) => sheetHeaders.set(header.styleSheetId, header));
              await cdp.send('DOM.enable');
              await cdp.send('CSS.enable');
              const { root } = await cdp.send('DOM.getDocument');
              const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: action.selector });

              if (nodeId) {
                const { matchedCSSRules = [], inherited = [] } = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
                let inlineProps = {};
                try {
                  const { inlineStyle } = await cdp.send('CSS.getInlineStylesForNode', { nodeId });
                  if (inlineStyle?.cssProperties) {
                    for (const p of inlineStyle.cssProperties) {
                      if (p.text && !p.disabled) inlineProps[p.name] = p.value;
                    }
                  }
                } catch {}

                const allRules = [];
                if (Object.keys(inlineProps).length) {
                  allRules.push({ selector: '[inline style]', source: 'inline', properties: inlineProps });
                }
                for (const entry of matchedCSSRules) {
                  const rule = entry.rule;
                  if (!rule?.selectorList || rule.origin === 'user-agent') continue;
                  const props = {};
                  for (const cssProp of (rule.style.cssProperties || [])) {
                    if (cssProp.text && !cssProp.text.startsWith('/*') && !cssProp.disabled) {
                      props[cssProp.name] = cssProp.value + (cssProp.important ? ' !important' : '');
                    }
                  }
                  if (!Object.keys(props).length) continue;
                  let source = '';
                  if (rule.origin === 'regular' && rule.style.styleSheetId) {
                    const header = sheetHeaders.get(rule.style.styleSheetId);
                    const file = header?.sourceURL ? header.sourceURL.split('/').pop().split('?')[0] : (header?.title || '');
                    const line = rule.style.range ? rule.style.range.startLine + 1 : null;
                    source = file ? (line ? `${file}:${line}` : file) : (line ? `line:${line}` : '');
                  }
                  allRules.push({ selector: rule.selectorList.text, source, properties: props, media: rule.media?.[0]?.text });
                }
                matchedSummary = { matched: allRules, inherited_count: inherited.length };
              }
            } catch (e) {
              matchedSummary = { error: `CDP query failed: ${e.message}` };
            } finally {
              if (cdp) await cdp.detach().catch(() => {});
            }

            const lines = [`=== inspect_element: ${action.selector} ===`];
            if (targetProps) {
              lines.push(`Computed (${targetProps.length} props):`);
              for (const [k, v] of Object.entries(computed || {})) lines.push(`  ${k}: ${v}`);
            } else {
              const entries = Object.entries(computed || {}).filter(([k]) => /color|background|font|margin|padding|border|display|position|width|height|grid|flex|z-index/.test(k));
              lines.push(`Computed (篩選 layout/visual ${entries.length} 項，全部 ${Object.keys(computed || {}).length}):`);
              for (const [k, v] of entries) lines.push(`  ${k}: ${v}`);
            }
            if (matchedSummary?.matched) {
              lines.push(`\nMatched CSS rules (${matchedSummary.matched.length})：`);
              matchedSummary.matched.forEach((r, i) => {
                lines.push(`  ${i + 1}. ${r.selector}${r.media ? ` @ ${r.media}` : ''}`);
                if (r.source) lines.push(`     source: ${r.source}`);
                const propsToShow = targetProps
                  ? Object.entries(r.properties).filter(([k]) => targetProps.includes(k))
                  : Object.entries(r.properties);
                for (const [k, v] of propsToShow) lines.push(`     ${k}: ${v}`);
              });
            } else if (matchedSummary?.error) {
              lines.push(`\n⚠️ ${matchedSummary.error}`);
            }
            contentBlocks.push({ type: 'text', text: lines.join('\n') });
            results.push({ action: label, ok: true, note: `${matchedSummary?.matched?.length || 0} matched rules` });
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
            const hideSels = Array.isArray(action.hide_selectors) ? action.hide_selectors : [];
            if (hideSels.length > 0) {
              await page.evaluate((sels) => {
                window.__hiddenForShot = [];
                for (const sel of sels) {
                  document.querySelectorAll(sel).forEach((el) => {
                    window.__hiddenForShot.push({ el, prev: el.style.visibility });
                    el.style.visibility = "hidden";
                  });
                }
              }, hideSels).catch(() => {});
            }
            try {
              if (action.selector) {
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
            } finally {
              if (hideSels.length > 0) {
                await page.evaluate(() => {
                  for (const rec of (window.__hiddenForShot || [])) {
                    rec.el.style.visibility = rec.prev || "";
                  }
                  window.__hiddenForShot = [];
                }).catch(() => {});
              }
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

    // QC 增強檢查（隨 images 一起執行）
    if (checks.includes("images")) {
      // emptySelects: 只有 0-1 個 option 的 <select>
      const emptySelects = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("select")).map(sel => {
          const label = sel.closest("tr,div,.form-group")?.querySelector("label,th")?.innerText?.trim() || "";
          return { name: sel.name, label, optionCount: sel.options.length };
        }).filter(x => x.optionCount <= 1);
      });
      report.emptySelects = emptySelects;

      // uploadFieldsWithoutHint: input[type=file] 周圍無尺寸提示
      const uploadFieldsWithoutHint = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('input[type="file"]')).map(input => {
          const container = input.closest("tr,div,.form-group");
          const label = container?.querySelector("label,th")?.innerText?.trim() || "";
          const hint = container?.innerText || "";
          const hasSize = /\d+\s*[×xX*]\s*\d+|Width|Height|px|尺寸|建議/.test(hint);
          return { label, hasSize };
        }).filter(x => !x.hasSize);
      });
      report.uploadFieldsWithoutHint = uploadFieldsWithoutHint;

      // dirtyFormFields: 非 hidden 且有預填值的 input/textarea（add.php 殘留檢測）
      const dirtyFormFields = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select'
        )).map(el => ({ name: el.name, value: el.value, tag: el.tagName }))
          .filter(x => x.value && x.value.trim().length > 0);
      });
      report.dirtyFormFields = dirtyFormFields;

      // ckEditorStatus: CKEditor 實例數量 + 各實例內容是否為空
      const ckEditorStatus = await page.evaluate(() => {
        if (typeof CKEDITOR === "undefined") return { available: false, instances: 0, nonEmpty: [] };
        const entries = Object.entries(CKEDITOR.instances);
        const nonEmpty = entries
          .map(([id, ed]) => ({ id, content: (ed.getData ? ed.getData() : "").trim() }))
          .filter(x => x.content.length > 0);
        return { available: true, instances: entries.length, nonEmpty };
      });
      report.ckEditorStatus = ckEditorStatus;

      // ckfinderHealth: 若頁面有 CKEditor，自動打 CKFinder connector
      if (ckEditorStatus.available) {
        const ckfinderHealth = await page.evaluate(async () => {
          const paths = [
            "/lib/plugin/ckfinder/core/connector/php/connector.php?command=Init&type=Images",
            "/ckfinder/core/connector/php/connector.php?command=Init&type=Images",
          ];
          for (const p of paths) {
            try {
              const res = await fetch(p, { credentials: "include" });
              const text = await res.text();
              const canUpload = res.status === 200 && (text.includes("resourceType") || text.includes("ResourceType"));
              return { endpoint: p, status: res.status, canUpload, error: null };
            } catch (e) { continue; }
          }
          return { endpoint: null, status: null, canUpload: false, error: "No CKFinder endpoint found" };
        });
        report.ckfinderHealth = ckfinderHealth;
      }

      const qcParts = [];
      if (emptySelects.length) qcParts.push(`${emptySelects.length} 空 select`);
      if (uploadFieldsWithoutHint.length) qcParts.push(`${uploadFieldsWithoutHint.length} 上傳欄位缺尺寸提示`);
      if (dirtyFormFields.length) qcParts.push(`${dirtyFormFields.length} 預填欄位`);
      if (ckEditorStatus.available) qcParts.push(`CKEditor ${ckEditorStatus.instances} 實例`);
      if (qcParts.length) summaryParts.push(`QC: ${qcParts.join(", ")}`);
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
// css_inspect 實作
// ============================================
async function handleCssInspect(args) {
  const {
    url,
    selector,
    pseudoElement,
    viewport = { width: 1920, height: 1080 },
    timeout = 15000,
    cookies = [],
    trigger_selectors = [],
    trigger_wait = 300,
    click_timeout = 5000,
    force_click = false,
    wait_for_hidden,
    wait_hidden_timeout = 5000,
    wait_for_selector,
    wait_for_timeout = 3000,
  } = args;

  const browser = await acquireBrowser();
  let context = null;

  try {
    context = await browser.newContext({
      viewport: { width: viewport.width || 1920, height: viewport.height || 1080 },
      ignoreHTTPSErrors: true,
    });
    if (cookies.length > 0) await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    // 量測前置：等遮罩消失 → 依序點 trigger（含 JS-click fallback）→ 等目標出現
    const prep = await prepareForMeasure(page, {
      trigger_selectors, trigger_wait, click_timeout, force_click,
      wait_for_hidden, wait_hidden_timeout,
      wait_for_selector, wait_for_timeout, target_selector: selector,
    });
    if (!prep.ok) {
      await context.close();
      return { content: [{ type: "text", text: [prep.error, ...prep.notes].join("\n") }] };
    }
    const prepNotes = prep.notes;

    // 先確認元素存在
    const elHandle = await page.$(selector);
    if (!elHandle) {
      await context.close();
      return { content: [{ type: "text", text: `❌ 找不到元素: ${selector}` }] };
    }

    // === 在瀏覽器內蒐集 computed + box + flex/grid 上下文 + 繼承 ===
    const browserData = await page.evaluate(({ sel, pseudo }) => {
      const el = document.querySelector(sel);
      if (!el) return null;

      const cs = window.getComputedStyle(el, pseudo || null);

      // Box model
      const rect = el.getBoundingClientRect();
      const box = {
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        padding: cs.padding,
        margin: cs.margin,
        border: cs.border,
        borderRadius: cs.borderRadius,
      };

      // Key computed styles
      const computedKeys = [
        "color", "backgroundColor", "fontSize", "fontWeight", "fontFamily",
        "lineHeight", "textAlign", "textDecoration", "display", "position",
        "zIndex", "opacity", "overflow", "visibility", "cursor",
        "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight",
        "top", "right", "bottom", "left",
        "flexGrow", "flexShrink", "flexBasis", "alignSelf", "justifySelf", "order",
        "gridColumn", "gridRow",
        "transform", "transition", "animation",
        "boxShadow", "textShadow", "whiteSpace", "wordBreak",
      ];
      const computed = {};
      for (const k of computedKeys) {
        const v = cs.getPropertyValue(
          k.replace(/[A-Z]/g, m => "-" + m.toLowerCase())
        );
        if (v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px"
          && v !== "0" && v !== "visible" && v !== "static" && v !== "default"
          && v !== "start") {
          computed[k] = v;
        }
      }
      // Always include these even if "default"
      computed.display = cs.display;
      computed.position = cs.position;

      // Flex/Grid context (parent)
      let flexContext = null;
      const parent = el.parentElement;
      if (parent) {
        const pcs = window.getComputedStyle(parent);
        const pDisplay = pcs.display;
        if (pDisplay.includes("flex") || pDisplay.includes("grid")) {
          flexContext = {
            parentDisplay: pDisplay,
            parentFlexDirection: pcs.flexDirection,
            parentJustifyContent: pcs.justifyContent,
            parentAlignItems: pcs.alignItems,
            parentGap: pcs.gap,
            selfAlignSelf: cs.alignSelf,
            selfJustifySelf: cs.justifySelf,
            selfFlexGrow: cs.flexGrow,
            selfFlexShrink: cs.flexShrink,
            selfFlexBasis: cs.flexBasis,
            selfOrder: cs.order,
          };
          if (pDisplay.includes("grid")) {
            flexContext.parentGridTemplateColumns = pcs.gridTemplateColumns;
            flexContext.parentGridTemplateRows = pcs.gridTemplateRows;
            flexContext.selfGridColumn = cs.gridColumn;
            flexContext.selfGridRow = cs.gridRow;
          }
        }
      }

      // Inherited properties
      const inheritKeys = ["fontFamily", "fontSize", "color", "lineHeight", "fontWeight", "textAlign", "visibility", "cursor", "letterSpacing", "wordSpacing"];
      const inherited = [];
      let ancestor = el.parentElement;
      const seen = new Set();
      while (ancestor) {
        const acs = window.getComputedStyle(ancestor);
        for (const k of inheritKeys) {
          if (seen.has(k)) continue;
          const prop = k.replace(/[A-Z]/g, m => "-" + m.toLowerCase());
          const elVal = cs.getPropertyValue(prop);
          const anVal = acs.getPropertyValue(prop);
          // Check if this ancestor explicitly sets it (different from its own parent)
          const grandParent = ancestor.parentElement;
          if (grandParent) {
            const gpVal = window.getComputedStyle(grandParent).getPropertyValue(prop);
            if (anVal !== gpVal && anVal === elVal) {
              inherited.push({
                property: k,
                value: anVal,
                from: ancestor.tagName.toLowerCase() + (ancestor.className ? "." + ancestor.className.toString().split(" ")[0] : ""),
              });
              seen.add(k);
            }
          }
        }
        ancestor = ancestor.parentElement;
      }

      // Element tag info
      const tag = el.tagName.toLowerCase();
      const classes = el.className ? (typeof el.className === "string" ? el.className : el.className.baseVal || "") : "";
      const id = el.id ? `#${el.id}` : "";
      const element = tag + id + (classes ? "." + classes.trim().split(/\s+/).join(".") : "");

      return { element, box, computed, flexContext, inherited };
    }, { sel: selector, pseudo: pseudoElement || null });

    if (!browserData) {
      await context.close();
      return { content: [{ type: "text", text: `❌ 無法取得元素資料: ${selector}` }] };
    }

    // === CDP: 取得 matched CSS rules（含 stylesheet 來源） ===
    let appliedRules = [];
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("DOM.enable");

      // 收集 stylesheet headers（CSS.enable 時 Chromium 會推送 styleSheetAdded）
      const sheetHeaders = new Map();
      cdp.on("CSS.styleSheetAdded", ({ header }) => {
        sheetHeaders.set(header.styleSheetId, header);
      });
      await cdp.send("CSS.enable");

      const { root } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", {
        nodeId: root.nodeId,
        selector,
      });

      if (nodeId) {
        const { matchedCSSRules = [] } = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });

        for (const entry of matchedCSSRules) {
          const rule = entry.rule;
          if (!rule?.selectorList) continue;
          if (rule.origin === "user-agent") continue;

          const selectorText = rule.selectorList.text;
          const properties = {};

          for (const prop of (rule.style.cssProperties || [])) {
            if (prop.text && !prop.text.startsWith("/*") && !prop.disabled) {
              properties[prop.name] = prop.value;
            }
          }
          if (Object.keys(properties).length === 0) continue;

          // 解析來源
          let source = rule.origin === "inline" ? "inline" : "";
          if (rule.origin === "regular" && rule.style.styleSheetId) {
            const header = sheetHeaders.get(rule.style.styleSheetId);
            const fileName = header?.sourceURL
              ? header.sourceURL.split("/").pop().split("?")[0]
              : header?.title || "";
            const line = rule.style.range ? rule.style.range.startLine + 1 : null;
            source = fileName ? (line ? `${fileName}:${line}` : fileName) : (line ? `line:${line}` : "");
          }

          appliedRules.push({ selector: selectorText, source, properties });
        }

        // 逆序：後載入 = 高優先，排前面
        appliedRules.reverse();
      }

      await cdp.detach().catch(() => {});
    } catch (cdpErr) {
      appliedRules = [{ _note: `CDP 取得 CSS 規則失敗: ${cdpErr.message}` }];
    }

    await context.close();

    const result = {
      ...(prepNotes.length > 0 ? { _notes: prepNotes } : {}),
      element: browserData.element,
      box: browserData.box,
      computed: browserData.computed,
      ...(browserData.flexContext ? { flexContext: browserData.flexContext } : {}),
      appliedRules,
      ...(browserData.inherited.length > 0 ? { inherited: browserData.inherited } : {}),
    };

    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2),
      }],
    };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return {
      content: [{ type: "text", text: `❌ css_inspect 執行失敗：${err.message}` }],
    };
  }
}

// ============================================
// element_measure 實作
// ============================================
async function handleElementMeasure(args) {
  const {
    url,
    selectorA,
    selectorB,
    viewport = { width: 1920, height: 1080 },
    timeout = 15000,
    cookies = [],
    trigger_selectors = [],
    trigger_wait = 300,
    click_timeout = 5000,
    force_click = false,
    wait_for_hidden,
    wait_hidden_timeout = 5000,
    wait_for_selector,
    wait_for_timeout = 3000,
  } = args;

  const browser = await acquireBrowser();
  let context = null;

  try {
    context = await browser.newContext({
      viewport: { width: viewport.width || 1920, height: viewport.height || 1080 },
      ignoreHTTPSErrors: true,
    });
    if (cookies.length > 0) await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    // 量測前置：等遮罩消失 → 依序點 trigger（含 JS-click fallback）→ 等目標出現
    const prep = await prepareForMeasure(page, {
      trigger_selectors, trigger_wait, click_timeout, force_click,
      wait_for_hidden, wait_hidden_timeout,
      wait_for_selector, wait_for_timeout, target_selector: selectorA,
    });
    if (!prep.ok) {
      await context.close();
      return { content: [{ type: "text", text: [prep.error, ...prep.notes].join("\n") }] };
    }
    const prepNotes = prep.notes;

    const result = await page.evaluate(({ selA, selB }) => {
      const round = (n) => Math.round(n * 100) / 100;
      const elA = document.querySelector(selA);
      if (!elA) return { error: `找不到元素: ${selA}` };

      const csA = window.getComputedStyle(elA);
      const rectA = elA.getBoundingClientRect();

      const parseBox = (cs) => ({
        top: parseFloat(cs.getPropertyValue("padding-top")) || 0,
        right: parseFloat(cs.getPropertyValue("padding-right")) || 0,
        bottom: parseFloat(cs.getPropertyValue("padding-bottom")) || 0,
        left: parseFloat(cs.getPropertyValue("padding-left")) || 0,
      });
      const parseMargin = (cs) => ({
        top: parseFloat(cs.getPropertyValue("margin-top")) || 0,
        right: parseFloat(cs.getPropertyValue("margin-right")) || 0,
        bottom: parseFloat(cs.getPropertyValue("margin-bottom")) || 0,
        left: parseFloat(cs.getPropertyValue("margin-left")) || 0,
      });

      const out = {
        elementA: {
          selector: selA,
          width: round(rectA.width),
          height: round(rectA.height),
          x: round(rectA.x),
          y: round(rectA.y),
          padding: parseBox(csA),
          margin: parseMargin(csA),
          borderWidth: {
            top: parseFloat(csA.borderTopWidth) || 0,
            right: parseFloat(csA.borderRightWidth) || 0,
            bottom: parseFloat(csA.borderBottomWidth) || 0,
            left: parseFloat(csA.borderLeftWidth) || 0,
          },
        },
      };

      if (selB) {
        const elB = document.querySelector(selB);
        if (!elB) return { error: `找不到元素: ${selB}` };

        const csB = window.getComputedStyle(elB);
        const rectB = elB.getBoundingClientRect();

        out.elementB = {
          selector: selB,
          width: round(rectB.width),
          height: round(rectB.height),
          x: round(rectB.x),
          y: round(rectB.y),
          padding: parseBox(csB),
          margin: parseMargin(csB),
          borderWidth: {
            top: parseFloat(csB.borderTopWidth) || 0,
            right: parseFloat(csB.borderRightWidth) || 0,
            bottom: parseFloat(csB.borderBottomWidth) || 0,
            left: parseFloat(csB.borderLeftWidth) || 0,
          },
        };

        out.distance = {
          horizontal: round(rectB.left - rectA.right),
          vertical: round(rectB.top - rectA.bottom),
          centerToCenter: {
            horizontal: round((rectB.left + rectB.width / 2) - (rectA.left + rectA.width / 2)),
            vertical: round((rectB.top + rectB.height / 2) - (rectA.top + rectA.height / 2)),
          },
        };
      }

      return out;
    }, { selA: selectorA, selB: selectorB || null });

    await context.close();

    if (result.error) {
      return { content: [{ type: "text", text: [`❌ ${result.error}`, ...prepNotes].join("\n") }] };
    }

    const out = prepNotes.length > 0 ? { _notes: prepNotes, ...result } : result;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return { content: [{ type: "text", text: `❌ element_measure 執行失敗：${err.message}` }] };
  }
}

// ============================================
// style_snapshot 實作
// ============================================
async function handleStyleSnapshot(args) {
  const {
    url,
    selectors,
    properties: userProps,
    viewport = { width: 1920, height: 1080 },
    timeout = 15000,
    cookies = [],
  } = args;

  if (!selectors || selectors.length === 0) {
    return { content: [{ type: "text", text: "❌ selectors 不可為空" }] };
  }

  const defaultProps = [
    "color", "background-color", "font-size", "font-weight", "font-family",
    "line-height", "text-align", "text-decoration", "display", "padding",
    "margin", "border", "border-radius", "opacity", "width",
  ];
  const props = userProps && userProps.length > 0
    ? userProps.map(p => p.replace(/[A-Z]/g, m => "-" + m.toLowerCase()))
    : defaultProps;

  const browser = await acquireBrowser();
  let context = null;

  try {
    context = await browser.newContext({
      viewport: { width: viewport.width || 1920, height: viewport.height || 1080 },
      ignoreHTTPSErrors: true,
    });
    if (cookies.length > 0) await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    const snapshot = await page.evaluate(({ sels, cssProps }) => {
      const result = {};
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) {
          result[sel] = { _error: "元素不存在" };
          continue;
        }
        const cs = window.getComputedStyle(el);
        const styles = {};
        for (const prop of cssProps) {
          styles[prop] = cs.getPropertyValue(prop);
        }
        result[sel] = styles;
      }
      return result;
    }, { sels: selectors, cssProps: props });

    await context.close();

    return { content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }] };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return { content: [{ type: "text", text: `❌ style_snapshot 執行失敗：${err.message}` }] };
  }
}

// ============================================
// css_coverage 死宣告偵測 helpers
// ============================================

// 找出 cssText 中所有 @media/@supports/@keyframes/@font-face/@page 區塊的字元範圍。
// 用於把渲染變體規則（如 @media print 的列印專用 class）排除在死宣告分析外，避免誤判。
function findAtRuleRanges(cssText) {
  const ranges = [];
  const re = /@(media|supports|keyframes|-webkit-keyframes|font-face|page|document|-moz-document)\b/gi;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    const start = m.index;
    // 從 @rule 後找第一個 '{'，再做括號配對找對應 '}'
    let i = cssText.indexOf("{", re.lastIndex);
    if (i === -1) break;
    let depth = 0;
    let end = -1;
    for (; i < cssText.length; i++) {
      if (cssText[i] === "{") depth++;
      else if (cssText[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) end = cssText.length;
    ranges.push([start, end]);
    re.lastIndex = end + 1;
  }
  return ranges;
}

function isInAtRule(index, ranges) {
  for (const [s, e] of ranges) {
    if (index >= s && index <= e) return true;
  }
  return false;
}

// 從規則 body 文字解析出宣告的屬性名（含 !important 標記）。
function parsePropNames(bodyStr) {
  const out = [];
  for (const part of (bodyStr || "").split(";")) {
    const t = part.trim();
    if (!t || t.startsWith("/*")) continue;
    const idx = t.indexOf(":");
    if (idx === -1) continue;
    const name = t.substring(0, idx).trim().toLowerCase();
    if (!name || name.startsWith("@") || name.includes("{")) continue;
    out.push({ name, important: /!\s*important/i.test(t) });
  }
  return out;
}

// 給定某元素的 matched CSS rules（CDP 格式）+ inline props，判定「目標 selector」是否
// 為某 property 的勝出來源（依 !important → specificity → cascade 順序）。
// matchedCSSRules 由 CDP 回傳，陣列順序為 cascade 由低到高優先（後者較高）。
function ruleWinsProperty(targetSelector, prop, matchedCSSRules, inlineProps) {
  const competing = [];
  if (inlineProps && inlineProps[prop] !== undefined) {
    competing.push({ selector: "[inline style]", important: false, score: 10000, order: -1, isInline: true });
  }
  for (let order = 0; order < matchedCSSRules.length; order++) {
    const rule = matchedCSSRules[order].rule;
    if (!rule?.selectorList || rule.origin === "user-agent") continue;
    for (const cssProp of (rule.style.cssProperties || [])) {
      if (cssProp.name === prop && cssProp.text && !cssProp.text.startsWith("/*") && !cssProp.disabled) {
        const isImportant = cssProp.important || /!\s*important/i.test(cssProp.text);
        const spec = calcSpecificity(rule.selectorList.text);
        competing.push({
          selector: rule.selectorList.text,
          important: isImportant,
          score: spec.score,
          order,
          isInline: rule.origin === "inline",
        });
      }
    }
  }
  if (competing.length === 0) return false;
  // 勝出：!important 優先 → specificity 高 → cascade 後者（order 大）優先
  competing.sort((a, b) => {
    if (a.important !== b.important) return a.important ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    return b.order - a.order;
  });
  const winner = competing[0];
  // 目標規則的 selectorList 文字可能含逗號群組；CDP 回傳的 selectorList.text 已是該節點匹配的群組原文
  return !winner.isInline && selectorTextMatches(winner.selector, targetSelector);
}

// 比對勝出規則的 selectorList 文字與目標單一 selector 是否同源（容忍逗號群組與空白差異）。
function selectorTextMatches(winnerSelectorText, targetSelector) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const target = norm(targetSelector);
  if (norm(winnerSelectorText) === target) return true;
  return winnerSelectorText.split(",").some(s => norm(s) === target);
}

// ============================================
// css_coverage 實作
// ============================================
async function handleCssCoverage(args) {
  const {
    url,
    cssFile,
    detectOverridden = false,
    sampleLimit = 20,
    maxElements = 400,
    viewport = { width: 1920, height: 1080 },
    timeout = 30000,
    cookies = [],
  } = args;

  const browser = await acquireBrowser();
  let context = null;

  try {
    context = await browser.newContext({
      viewport: { width: viewport.width || 1920, height: viewport.height || 1080 },
      ignoreHTTPSErrors: true,
    });
    if (cookies.length > 0) await context.addCookies(cookies);

    const page = await context.newPage();

    // 啟動 CSS coverage
    await page.coverage.startCSSCoverage();
    await page.goto(url, { waitUntil: "networkidle", timeout });

    // 等一下讓 lazy CSS 載入
    await page.waitForTimeout(1000);

    const coverageData = await page.coverage.stopCSSCoverage();

    let totalBytes = 0;
    let usedBytes = 0;
    const fileResults = [];

    for (const entry of coverageData) {
      const fileName = entry.url.split("/").pop().split("?")[0] || entry.url;

      // 如果指定了 cssFile，只分析匹配的
      if (cssFile && !entry.url.includes(cssFile)) continue;

      const fileTotal = entry.text.length;
      let fileUsed = 0;
      for (const range of entry.ranges) {
        fileUsed += range.end - range.start;
      }

      totalBytes += fileTotal;
      usedBytes += fileUsed;

      fileResults.push({
        file: fileName,
        totalBytes: fileTotal,
        usedBytes: fileUsed,
        coverage: fileTotal > 0 ? `${((fileUsed / fileTotal) * 100).toFixed(1)}%` : "0%",
      });
    }

    // 用 CDP 取得更精確的 selector 級別分析
    let usedSelectors = [];
    let deadSelectors = [];
    let atRuleSelectorsSkipped = 0; // @media/@keyframes 內未命中的 selector：不當死碼（渲染變體誤判防護）
    // 死宣告偵測用：收集「selector + 宣告屬性 + 是否在 @-rule 內」
    const parsedRules = [];      // { sel, props:[{name,important}], file, inAtRule }
    let overriddenAnalysis = null;

    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("DOM.enable");

      const sheetHeaders = new Map();
      cdp.on("CSS.styleSheetAdded", ({ header }) => {
        sheetHeaders.set(header.styleSheetId, header);
      });
      await cdp.send("CSS.enable");

      // 從 coverage 結果提取 selector 文字 + 宣告，用 querySelector 驗證 selector 是否命中
      for (const entry of coverageData) {
        if (cssFile && !entry.url.includes(cssFile)) continue;

        const cssText = entry.text;
        const fileName = entry.url.split("/").pop().split("?")[0] || entry.url;
        const atRuleRanges = findAtRuleRanges(cssText);
        // 同時捕捉規則 body（group 2）以解析宣告屬性
        const selectorRegex = /([^{}@/]+)\s*\{([^}]*)\}/g;
        let match;
        while ((match = selectorRegex.exec(cssText)) !== null) {
          const rawSelector = match[1].trim();
          if (!rawSelector || rawSelector.startsWith("@") || rawSelector.startsWith("/*")) continue;
          const inAtRule = isInAtRule(match.index, atRuleRanges);
          const propNames = parsePropNames(match[2]);

          // 處理逗號分隔的多選擇器
          const sels = rawSelector.split(",").map(s => s.trim()).filter(Boolean);
          for (const sel of sels) {
            if (sel.startsWith("@") || sel.startsWith("from") || sel.startsWith("to") || /^\d+%$/.test(sel)) continue;
            try {
              const found = await page.$(sel);
              if (found) {
                if (!usedSelectors.includes(sel)) usedSelectors.push(sel);
                if (detectOverridden && propNames.length > 0) {
                  parsedRules.push({ sel, props: propNames, file: fileName, inAtRule });
                }
              } else if (inAtRule) {
                // @-rule（@media/@keyframes…）內的 selector 為渲染變體，
                // 對當前 render 未命中不代表死碼（如 @media print 列印專用 class），不列入 deadSelectors
                atRuleSelectorsSkipped++;
              } else {
                if (!deadSelectors.includes(sel)) deadSelectors.push(sel);
              }
            } catch {
              // 無效的 CSS selector（如 ::placeholder），跳過
            }
          }
        }
      }

      // 死宣告偵測：對命中元素的規則逐屬性判定是否被覆蓋
      if (detectOverridden) {
        const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
        const matchCache = new Map(); // nodeId -> { matchedCSSRules, inlineProps }
        async function getMatched(nodeId) {
          if (matchCache.has(nodeId)) return matchCache.get(nodeId);
          let data = { matchedCSSRules: [], inlineProps: {} };
          try {
            const { matchedCSSRules = [] } = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });
            const inlineProps = {};
            try {
              const { inlineStyle } = await cdp.send("CSS.getInlineStylesForNode", { nodeId });
              for (const p of (inlineStyle?.cssProperties || [])) {
                if (p.text && !p.disabled) inlineProps[p.name] = p.value;
              }
            } catch {}
            data = { matchedCSSRules, inlineProps };
          } catch {}
          matchCache.set(nodeId, data);
          return data;
        }

        const deadDeclarations = [];   // 整條規則宣告全被覆蓋
        const partialOverridden = [];  // 部分屬性被覆蓋
        let elementsExamined = 0;
        let skippedAtRule = 0;
        let budgetExhausted = false;

        for (const rule of parsedRules) {
          if (rule.inAtRule) { skippedAtRule++; continue; }
          let nodeIds = [];
          try {
            const r = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: rule.sel });
            nodeIds = r.nodeIds || [];
          } catch { continue; }
          if (nodeIds.length === 0) continue;

          const sample = nodeIds.slice(0, sampleLimit);
          const liveProps = new Set();
          const allProps = rule.props.map(p => p.name);
          for (const nodeId of sample) {
            if (elementsExamined >= maxElements) { budgetExhausted = true; break; }
            elementsExamined++;
            const { matchedCSSRules, inlineProps } = await getMatched(nodeId);
            for (const p of allProps) {
              if (liveProps.has(p)) continue;
              if (ruleWinsProperty(rule.sel, p, matchedCSSRules, inlineProps)) liveProps.add(p);
            }
            if (liveProps.size === allProps.length) break; // 全活，無需再驗
          }
          const overridden = allProps.filter(p => !liveProps.has(p));
          if (overridden.length === 0) continue;
          const record = {
            selector: rule.sel,
            file: rule.file,
            matchedElements: nodeIds.length,
            sampled: sample.length,
            overriddenProps: overridden,
            liveProps: [...liveProps],
          };
          if (overridden.length === allProps.length) deadDeclarations.push(record);
          else partialOverridden.push(record);
          if (budgetExhausted) break;
        }

        overriddenAnalysis = {
          elementsExamined,
          skippedAtRuleRules: skippedAtRule,
          budgetExhausted,
          deadDeclarationCount: deadDeclarations.length,
          partialOverriddenCount: partialOverridden.length,
          deadDeclarations: deadDeclarations.slice(0, 100),
          partialOverridden: partialOverridden.slice(0, 50),
        };
      }

      await cdp.detach().catch(() => {});
    } catch (e) {
      // CDP selector 分析失敗不影響 byte-level coverage
      if (detectOverridden && !overriddenAnalysis) {
        overriddenAnalysis = { error: `死宣告偵測失敗：${e.message}` };
      }
    }

    await context.close();

    const result = {
      url,
      ...(cssFile ? { filter: cssFile } : {}),
      summary: {
        totalBytes,
        usedBytes,
        unusedBytes: totalBytes - usedBytes,
        coverage: totalBytes > 0 ? `${((usedBytes / totalBytes) * 100).toFixed(1)}%` : "0%",
      },
      files: fileResults,
      ...(usedSelectors.length > 0 ? {
        usedSelectors: usedSelectors.length,
        deadSelectors: deadSelectors.length,
        deadSelectorsList: deadSelectors.slice(0, 100), // 最多顯示 100 個
        ...(atRuleSelectorsSkipped > 0 ? { atRuleSelectorsSkipped } : {}),
      } : {}),
      ...(overriddenAnalysis ? { overriddenAnalysis } : {}),
    };

    let summary = `CSS Coverage: ${result.summary.coverage} (${result.summary.usedBytes}/${result.summary.totalBytes} bytes)` +
      (deadSelectors.length > 0 ? `\n${deadSelectors.length} dead selectors (selector 完全沒對到元素)` : "");
    if (overriddenAnalysis && !overriddenAnalysis.error) {
      summary += `\n死宣告偵測：${overriddenAnalysis.deadDeclarationCount} 條規則宣告全被覆蓋、${overriddenAnalysis.partialOverriddenCount} 條部分覆蓋` +
        `（檢查 ${overriddenAnalysis.elementsExamined} 個元素，排除 ${overriddenAnalysis.skippedAtRuleRules} 條 @-rule 規則）` +
        (overriddenAnalysis.budgetExhausted ? `\n⚠️ 已達 maxElements 上限，結果可能不完整，可調高 maxElements` : "") +
        `\n⚠️ caveat：未涵蓋 @media/print 等渲染變體；死宣告應再以 css_computed_winner 對單一屬性複核後才刪。`;
    } else if (overriddenAnalysis?.error) {
      summary += `\n${overriddenAnalysis.error}`;
    }

    return {
      content: [{ type: "text", text: summary + "\n\n" + JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return { content: [{ type: "text", text: `❌ css_coverage 執行失敗：${err.message}` }] };
  }
}

// ============================================
// browser_save_session 實作
// ============================================
async function handleSaveSession(args) {
  const {
    url,
    session_key = "default",
    cookies: injectCookies = [],
    viewport = { width: 1920, height: 1080 },
    timeout = 15000,
  } = args;

  const browser = await acquireBrowser();
  let context = null;
  try {
    context = await browser.newContext({
      viewport: { width: viewport.width || 1920, height: viewport.height || 1080 },
      ignoreHTTPSErrors: true,
    });

    if (injectCookies.length > 0) {
      await context.addCookies(injectCookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
      })));
    }

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout });

    // 擷取 cookies
    const cookies = await context.cookies();

    // 擷取 localStorage 和 sessionStorage
    const storages = await page.evaluate(() => ({
      localStorage: Object.fromEntries(Object.entries(localStorage)),
      sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
    }));

    // 從 URL 自動推導 domain label（取 hostname）；cookies 涵蓋的 domains 一併記錄
    const pageDomain = (() => {
      try { return new URL(url).hostname; } catch { return ""; }
    })();
    const cookieDomains = [...new Set(cookies.map(c => (c.domain || "").replace(/^\./, "")).filter(Boolean))];

    const sessionData = {
      saved_at: new Date().toISOString(),
      url,
      domain: pageDomain,
      cookie_domains: cookieDomains,
      cookies,
      localStorage: storages.localStorage,
      sessionStorage: storages.sessionStorage,
    };

    await context.close();

    await fs.mkdir(SESSION_DIR, { recursive: true });
    const sessionPath = path.join(SESSION_DIR, `${session_key}.json`);
    await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2), "utf-8");

    return {
      content: [{
        type: "text",
        text: `✅ Session 已儲存：${sessionPath}\n` +
          `  domain: ${pageDomain}${cookieDomains.length ? `（cookies: ${cookieDomains.join(", ")}）` : ""}\n` +
          `  cookies: ${cookies.length} 個\n` +
          `  localStorage keys: ${Object.keys(storages.localStorage).length}\n` +
          `  sessionStorage keys: ${Object.keys(storages.sessionStorage).length}\n\n` +
          `下次對話呼叫 browser_restore_session {session_key: "${session_key}", target_url: "${url}"} 即可還原。`,
      }],
    };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return { content: [{ type: "text", text: `❌ browser_save_session 失敗：${err.message}` }] };
  }
}

// ============================================
// browser_restore_session 實作
// ============================================
async function handleRestoreSession(args) {
  const { session_key = "default", target_url } = args;
  const sessionPath = path.join(SESSION_DIR, `${session_key}.json`);

  try {
    const raw = await fs.readFile(sessionPath, "utf-8");
    const sessionData = JSON.parse(raw);

    const age = Math.round((Date.now() - new Date(sessionData.saved_at).getTime()) / 1000 / 60);
    const cookies = sessionData.cookies || [];
    const savedDomain = sessionData.domain || "(未記錄)";
    const cookieDomains = sessionData.cookie_domains || [];

    // Domain 匹配檢查
    let domainWarn = "";
    if (target_url) {
      try {
        const targetHost = new URL(target_url).hostname;
        const matches = [savedDomain, ...cookieDomains].some(d => {
          if (!d) return false;
          return targetHost === d || targetHost.endsWith("." + d) || d.endsWith("." + targetHost);
        });
        if (!matches) {
          domainWarn = `\n⚠️ Domain 不匹配：target_url 是 ${targetHost}，但 session 儲存自 ${savedDomain}${cookieDomains.length ? `（cookies: ${cookieDomains.join(", ")}）` : ""}。套用後可能無效，建議重新登入並儲存新 session。\n`;
        }
      } catch {}
    }

    return {
      content: [{
        type: "text",
        text: `✅ Session 還原成功（${session_key}，${age} 分鐘前儲存）\n` +
          `  domain: ${savedDomain}${cookieDomains.length ? `（cookies: ${cookieDomains.join(", ")}）` : ""}\n` +
          `  cookies: ${cookies.length} 個\n` +
          `  localStorage keys: ${Object.keys(sessionData.localStorage || {}).length}\n` +
          domainWarn +
          `\ncookies 已回傳，直接傳入 browser_interact / page_audit 的 cookies 參數：\n` +
          JSON.stringify(cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })), null, 2),
      }],
      // 方便呼叫端直接取用
      _cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/" })),
    };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { content: [{ type: "text", text: `❌ 找不到 session：${sessionPath}\n請先執行 browser_save_session 儲存 session。` }] };
    }
    return { content: [{ type: "text", text: `❌ browser_restore_session 失敗：${err.message}` }] };
  }
}

// ============================================
// handle 路由
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  switch (name) {
    case "browser_interact":  return handleBrowserInteract(args);
    case "page_audit":        return handlePageAudit(args);
    case "css_inspect":       return handleCssInspect(args);
    case "element_measure":   return handleElementMeasure(args);
    case "style_snapshot":    return handleStyleSnapshot(args);
    case "css_coverage":            return handleCssCoverage(args);
    case "browser_save_session":    return handleSaveSession(args);
    case "browser_restore_session": return handleRestoreSession(args);
    default:                        return null;
  }
}
