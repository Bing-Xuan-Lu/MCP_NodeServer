// tools/css_tools.js — css_specificity_check + css_computed_winner
// css_specificity_check: 靜態 CSS 檔案分析（不需瀏覽器）
// css_computed_winner: 活頁面 CDP 查詢某 property 由哪條規則勝出

import fs from "fs/promises";
import { resolveSecurePath } from "../../config.js";
import { validateArgs } from "../_shared/utils.js";
import { createBrowserPool } from "../_shared/browser_pool.js";

// ============================================
// Browser Pool（跨呼叫複用 browser 進程）
// ============================================
const browserPool = createBrowserPool(60000);

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "css_specificity_check",
    description:
      "分析指定 CSS 檔案，找出所有包含目標 selector 的規則，回傳行號、完整 selector、specificity 分數、屬性清單。用於覆寫 CSS 前先確認 specificity，避免反覆迭代。",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "CSS 檔案路徑（相對 basePath 或絕對路徑）",
        },
        selector: {
          type: "string",
          description: "要搜尋的 CSS selector（支援部分匹配，例如 '.imgbox' 會匹配包含 .imgbox 的所有規則）",
        },
        exact: {
          type: "boolean",
          description: "是否精確匹配（預設 false = 部分匹配）",
        },
      },
      required: ["file", "selector"],
    },
  },
  {
    name: "css_computed_winner",
    description:
      "對活頁面查詢指定元素的某個 CSS property 最終由哪條規則勝出（類似 DevTools Computed 展開看來源）。回傳勝出規則 + 所有競爭規則，含 selector、source file:line、specificity。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要檢查的頁面 URL" },
        selector: { type: "string", description: "目標元素的 CSS 選擇器" },
        property: {
          type: "string",
          description: "要查詢的 CSS 屬性名（kebab-case，如 'grid-column', 'background-color'）",
        },
        properties: {
          type: "array",
          items: { type: "string" },
          description: "批次查詢多個屬性（與 property 擇一使用）",
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
      required: ["url", "selector"],
    },
  },
];

// ============================================
// Specificity 計算
// ============================================
function calcSpecificity(selectorStr) {
  // 移除 :not() 內容但保留其引數的 specificity
  // 簡化版：計算 ID / class+attr+pseudo-class / type+pseudo-element
  let s = selectorStr.trim();

  // 移除 ::pseudo-elements 先計數
  const pseudoElements = (s.match(/::(before|after|first-line|first-letter|marker|placeholder|selection|backdrop)/g) || []).length;
  s = s.replace(/::(before|after|first-line|first-letter|marker|placeholder|selection|backdrop)/g, "");

  // 移除屬性選擇器，先計數
  const attrs = (s.match(/\[[^\]]*\]/g) || []).length;
  s = s.replace(/\[[^\]]*\]/g, "");

  // 計算 ID
  const ids = (s.match(/#[a-zA-Z_-][\w-]*/g) || []).length;

  // 計算 pseudo-classes（:hover, :nth-child() 等，但排除 :not/:is/:where/:has）
  const pseudoClasses = (s.match(/:(?!not|is|where|has)[a-zA-Z][\w-]*(\([^)]*\))?/g) || []).length;

  // 計算 class selectors
  const classes = (s.match(/\.[a-zA-Z_-][\w-]*/g) || []).length;

  // 計算 type selectors（標籤名）
  // 先清掉已計數的部分
  let cleaned = s
    .replace(/#[a-zA-Z_-][\w-]*/g, "")
    .replace(/\.[a-zA-Z_-][\w-]*/g, "")
    .replace(/:[a-zA-Z][\w-]*(\([^)]*\))?/g, "")
    .replace(/[>+~\s,]/g, " ")
    .replace(/\*/g, "")
    .trim();
  const types = cleaned.split(/\s+/).filter(t => t && /^[a-zA-Z]/.test(t)).length;

  const a = ids;
  const b = classes + attrs + pseudoClasses;
  const c = types + pseudoElements;

  return { a, b, c, score: a * 100 + b * 10 + c, text: `(${a},${b},${c})` };
}

// ============================================
// CSS 檔案規則提取器（輕量級，無需 postcss）
// ============================================
function extractRules(cssContent) {
  const rules = [];
  let depth = 0;
  let currentSelector = "";
  let savedSelector = "";  // 保存進入 { 時的 selector
  let currentProps = "";
  let selectorStartLine = 0;
  let mediaContext = null;

  const lines = cssContent.split("\n");

  // 先移除所有 CSS 註解，但保留行號資訊（用空白替代）
  let cleaned = "";
  let inComment = false;
  for (let i = 0; i < cssContent.length; i++) {
    if (!inComment && cssContent[i] === "/" && cssContent[i + 1] === "*") {
      inComment = true;
      cleaned += "  "; // 替代 /*
      i++;
      continue;
    }
    if (inComment && cssContent[i] === "*" && cssContent[i + 1] === "/") {
      inComment = false;
      cleaned += "  "; // 替代 */
      i++;
      continue;
    }
    if (inComment) {
      cleaned += cssContent[i] === "\n" ? "\n" : " ";
    } else {
      cleaned += cssContent[i];
    }
  }

  const cleanedLines = cleaned.split("\n");

  for (let lineIdx = 0; lineIdx < cleanedLines.length; lineIdx++) {
    const line = cleanedLines[lineIdx];
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === "{") {
        if (depth === 0) {
          const sel = currentSelector.trim();
          if (sel.startsWith("@media") || sel.startsWith("@supports")) {
            mediaContext = sel;
          } else if (sel.startsWith("@")) {
            mediaContext = sel; // @keyframes, @font-face 等
          } else {
            savedSelector = sel;
          }
          currentSelector = "";
          currentProps = "";
        } else if (depth === 1 && mediaContext) {
          savedSelector = currentSelector.trim();
          currentSelector = "";
          currentProps = "";
        }
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          if (mediaContext) {
            mediaContext = null;
          } else if (savedSelector) {
            rules.push({
              selector: savedSelector,
              line: selectorStartLine,
              properties: parseProperties(currentProps),
              media: null,
            });
            savedSelector = "";
          }
          currentSelector = "";
          currentProps = "";
        } else if (depth === 1 && mediaContext) {
          if (savedSelector) {
            rules.push({
              selector: savedSelector,
              line: selectorStartLine,
              properties: parseProperties(currentProps),
              media: mediaContext,
            });
            savedSelector = "";
          }
          currentSelector = "";
          currentProps = "";
        }
      } else if (depth === 0 || (depth === 1 && mediaContext)) {
        // 收集 selector
        currentSelector += ch;
        // 記錄 selector 開始行號（第一個非空白字元）
        if (currentSelector.trim().length === 1 && ch.trim()) {
          selectorStartLine = lineIdx + 1;
        }
      } else {
        // 收集 properties
        currentProps += ch;
      }
    }
    // 換行符
    if (depth === 0 || (depth === 1 && mediaContext)) {
      currentSelector += "\n";
    } else {
      currentProps += "\n";
    }
  }

  return rules;
}

function parseProperties(propsStr) {
  const props = {};
  // 分割 by ; 但要注意值中可能包含 ; (如 data URI)
  const parts = propsStr.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith("/*")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const name = trimmed.substring(0, colonIdx).trim();
    const value = trimmed.substring(colonIdx + 1).trim();
    if (name && value && !name.startsWith("/*")) {
      props[name] = value;
    }
  }
  return props;
}

// ============================================
// css_specificity_check 實作
// ============================================
async function handleCssSpecificityCheck(args) {
  const { file, selector, exact = false } = args;

  let filePath;
  try {
    filePath = resolveSecurePath(file);
  } catch (e) {
    return { content: [{ type: "text", text: `❌ ${e.message}` }] };
  }

  let cssContent;
  try {
    cssContent = await fs.readFile(filePath, "utf-8");
  } catch (e) {
    return { content: [{ type: "text", text: `❌ 無法讀取檔案: ${e.message}` }] };
  }

  const allRules = extractRules(cssContent);

  // 搜尋匹配的規則
  const normalizedQuery = selector.trim().toLowerCase();
  const matches = [];

  for (const rule of allRules) {
    // 一個規則可能有多個 selector（逗號分隔）
    const selectors = rule.selector.split(",").map(s => s.trim());

    for (const sel of selectors) {
      const normalizedSel = sel.toLowerCase();
      const isMatch = exact
        ? normalizedSel === normalizedQuery
        : normalizedSel.includes(normalizedQuery);

      if (isMatch) {
        const specificity = calcSpecificity(sel);
        matches.push({
          selector: sel,
          fullRule: rule.selector.includes(",") ? rule.selector.replace(/\s+/g, " ").trim() : undefined,
          line: rule.line,
          specificity: specificity.text,
          specificityScore: specificity.score,
          properties: rule.properties,
          ...(rule.media ? { media: rule.media } : {}),
        });
      }
    }
  }

  // 按 specificity 降序排列
  matches.sort((a, b) => b.specificityScore - a.specificityScore);

  if (matches.length === 0) {
    return {
      content: [{
        type: "text",
        text: `在 ${file} 中找不到${exact ? "精確" : ""}匹配 "${selector}" 的規則。\n\n提示：嘗試用更短的 selector 片段搜尋，或設 exact: false。`,
      }],
    };
  }

  // 格式化輸出
  const summary = `找到 ${matches.length} 條匹配規則（按 specificity 降序）：\n`;
  const details = matches.map((m, i) => {
    const propsStr = Object.entries(m.properties)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    return [
      `--- #${i + 1} ---`,
      `Selector: ${m.selector}`,
      ...(m.fullRule ? [`Full rule: ${m.fullRule}`] : []),
      `Line: ${m.line}`,
      `Specificity: ${m.specificity} (score: ${m.specificityScore})`,
      ...(m.media ? [`Media: ${m.media}`] : []),
      `Properties:\n${propsStr}`,
    ].join("\n");
  });

  return {
    content: [{
      type: "text",
      text: summary + details.join("\n\n"),
    }],
  };
}

// ============================================
// css_computed_winner 實作
// ============================================
async function handleCssComputedWinner(args) {
  const {
    url,
    selector,
    property,
    properties: propsList,
    viewport = { width: 1920, height: 1080 },
    timeout = 15000,
    cookies = [],
  } = args;

  const targetProps = propsList || (property ? [property] : null);
  if (!targetProps || targetProps.length === 0) {
    return { content: [{ type: "text", text: "❌ 請指定 property 或 properties 參數" }] };
  }

  const browser = await browserPool.acquire({ headless: true });
  let context = null;

  try {
    context = await browser.newContext({
      viewport: { width: viewport.width || 1920, height: viewport.height || 1080 },
      ignoreHTTPSErrors: true,
    });
    if (cookies.length > 0) await context.addCookies(cookies);

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });

    // 確認元素存在
    const elHandle = await page.$(selector);
    if (!elHandle) {
      await context.close();
      return { content: [{ type: "text", text: `❌ 找不到元素: ${selector}` }] };
    }

    // 取得 computed values
    const computedValues = await page.evaluate(({ sel, props }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      const result = {};
      for (const p of props) {
        result[p] = cs.getPropertyValue(p);
      }
      return result;
    }, { sel: selector, props: targetProps });

    // CDP: 取得所有匹配的 CSS 規則
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");

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

    const results = {};

    if (nodeId) {
      const { matchedCSSRules = [], inherited = [] } = await cdp.send(
        "CSS.getMatchedStylesForNode",
        { nodeId }
      );

      // 也取得 inline styles
      let inlineProps = {};
      try {
        const { inlineStyle } = await cdp.send("CSS.getInlineStylesForNode", { nodeId });
        if (inlineStyle?.cssProperties) {
          for (const p of inlineStyle.cssProperties) {
            if (p.text && !p.disabled) {
              inlineProps[p.name] = p.value;
            }
          }
        }
      } catch {}

      for (const prop of targetProps) {
        const competing = [];

        // 檢查 inline style
        if (inlineProps[prop] !== undefined) {
          competing.push({
            selector: "[inline style]",
            source: "inline",
            value: inlineProps[prop],
            specificity: "(1,0,0,0)",
            specificityScore: 10000,
            isImportant: false,
          });
        }

        // 從匹配規則中找有此 property 的
        for (const entry of matchedCSSRules) {
          const rule = entry.rule;
          if (!rule?.selectorList || rule.origin === "user-agent") continue;

          for (const cssProp of (rule.style.cssProperties || [])) {
            if (cssProp.name === prop && cssProp.text && !cssProp.text.startsWith("/*") && !cssProp.disabled) {
              const selectorText = rule.selectorList.text;
              const isImportant = cssProp.important || cssProp.text.includes("!important");

              let source = rule.origin === "inline" ? "inline" : "";
              if (rule.origin === "regular" && rule.style.styleSheetId) {
                const header = sheetHeaders.get(rule.style.styleSheetId);
                const fileName = header?.sourceURL
                  ? header.sourceURL.split("/").pop().split("?")[0]
                  : header?.title || "";
                const line = rule.style.range ? rule.style.range.startLine + 1 : null;
                source = fileName ? (line ? `${fileName}:${line}` : fileName) : (line ? `line:${line}` : "");
              }

              const spec = calcSpecificity(selectorText);

              competing.push({
                selector: selectorText,
                source,
                value: cssProp.value,
                specificity: spec.text,
                specificityScore: (isImportant ? 10000 : 0) + spec.score,
                isImportant,
              });
            }
          }
        }

        // 按 specificityScore 降序（最高 = 勝出者）
        competing.sort((a, b) => b.specificityScore - a.specificityScore);

        results[prop] = {
          computedValue: computedValues?.[prop] || "",
          winner: competing[0] || null,
          allRules: competing,
        };
      }
    }

    await cdp.detach().catch(() => {});
    await context.close();

    // 格式化輸出
    const lines = [`元素: ${selector}\nURL: ${url}\n`];

    for (const [prop, data] of Object.entries(results)) {
      lines.push(`=== ${prop} ===`);
      lines.push(`Computed value: ${data.computedValue}`);

      if (data.winner) {
        lines.push(`Winner: ${data.winner.selector} → ${data.winner.value}${data.winner.isImportant ? " !important" : ""}`);
        lines.push(`  Source: ${data.winner.source}`);
        lines.push(`  Specificity: ${data.winner.specificity}`);
      } else {
        lines.push("Winner: (no matching rule found — may be inherited or default)");
      }

      if (data.allRules.length > 1) {
        lines.push(`\nAll competing rules (${data.allRules.length}):`);
        for (let i = 0; i < data.allRules.length; i++) {
          const r = data.allRules[i];
          lines.push(`  ${i + 1}. ${r.selector}`);
          lines.push(`     Value: ${r.value}${r.isImportant ? " !important" : ""}`);
          lines.push(`     Source: ${r.source} | Specificity: ${r.specificity}`);
        }
      }
      lines.push("");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return { content: [{ type: "text", text: `❌ css_computed_winner 執行失敗：${err.message}` }] };
  }
}

// ============================================
// handle 路由
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  switch (name) {
    case "css_specificity_check":  return handleCssSpecificityCheck(args);
    case "css_computed_winner":    return handleCssComputedWinner(args);
    default:                       return null;
  }
}
