// tools/_shared/playwright_measure_prep.js
// 量測前置：等 loading 遮罩消失 → 依序點擊 trigger（含 JS-click fallback）→ 等目標元素出現
// 給 css_inspect / element_measure / css_computed_winner 共用。
// 解決痛點：頁面有 .loader 等遮罩蓋在目標上時，page.click() 的可點擊性檢查會卡 timeout 失敗，
// 且 domcontentloaded 不等 AJAX 渲染完，遮罩還在就開點。

// 常見 loading 遮罩 selector（pointer-events 蓋住目標導致 click 卡 timeout）
const DEFAULT_OVERLAY_SELECTORS = [
  ".loader", ".loading", ".overlay", ".spinner",
  '[class*="loading"]', '[class*="spinner"]', '[class*="overlay"]',
];

// 等遮罩元素全部 hidden（不存在 / display:none / visibility:hidden / opacity 0 / 尺寸 0）。
// 回傳逾時仍可見的遮罩 selector，null = 都清乾淨了。
async function waitOverlaysHidden(page, selectors, timeout) {
  if (!selectors || selectors.length === 0) return null;
  const deadline = Date.now() + timeout;
  let lastVisible = null;
  while (Date.now() < deadline) {
    lastVisible = await page.evaluate((sels) => {
      const isVisible = (el) => {
        if (!el) return false;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        if (parseFloat(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return true;
      };
      for (const s of sels) {
        try {
          for (const el of document.querySelectorAll(s)) {
            if (isVisible(el)) return s;
          }
        } catch (e) { /* invalid selector, skip */ }
      }
      return null;
    }, selectors).catch(() => null);
    if (!lastVisible) return null;
    await page.waitForTimeout(150);
  }
  return lastVisible;
}

// 偵測 selector 中心點實際命中的元素是不是「別的東西」（被遮罩蓋住）。
// 回傳攔截者描述，null = 沒被攔截。
async function detectInterceptor(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    if (!top || top === el || el.contains(top) || top.contains(el)) return null;
    return top.tagName.toLowerCase()
      + (top.id ? "#" + top.id : "")
      + (top.className && typeof top.className === "string"
          ? "." + top.className.trim().split(/\s+/).join(".") : "");
  }, selector).catch(() => null);
}

// 點一個 trigger：先正常 click（可設 timeout），被遮罩攔截 timeout 時 fallback 用 JS .click()。
async function clickTrigger(page, selector, { clickTimeout, force }) {
  const jsClick = () => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.click();
    return true;
  }, selector).catch(() => false);

  if (force) {
    return (await jsClick()) ? { ok: true, method: "js" } : { ok: false, error: "找不到元素" };
  }
  try {
    await page.click(selector, { timeout: clickTimeout });
    return { ok: true, method: "normal" };
  } catch (e) {
    // 一般 click 逾時 → 檢查是否被遮罩攔截 + JS-click fallback
    const interceptor = await detectInterceptor(page, selector);
    if (await jsClick()) return { ok: true, method: "js-fallback", interceptor };
    return { ok: false, interceptor, error: e.message };
  }
}

// 量測前置主流程。
// opts:
//   trigger_selectors[]  依序點擊以展開 popup/modal/dropdown
//   trigger_wait         每次 trigger click 後等待毫秒（預設 300）
//   click_timeout        trigger 一般 click 逾時（預設 5000）
//   force_click          直接用 JS .click() 繞過可點擊性檢查（預設 false）
//   wait_for_hidden      要等到 hidden 的遮罩 selector：undefined=用預設遮罩集；[]=關閉；[...]/string=自訂
//   wait_hidden_timeout  等遮罩消失逾時（預設 5000）
//   wait_for_selector    trigger 後等此 selector 出現（預設用 target_selector）
//   wait_for_timeout     等目標出現逾時（預設 3000）
//   target_selector      量測目標（wait_for_selector 未指定時的 fallback）
// 回傳 { ok, notes[], error? }。error 為已組好的可讀訊息字串。
async function prepareForMeasure(page, opts = {}) {
  const {
    trigger_selectors = [],
    trigger_wait = 300,
    click_timeout = 5000,
    force_click = false,
    wait_for_hidden,
    wait_hidden_timeout = 5000,
    wait_for_selector,
    wait_for_timeout = 3000,
    target_selector,
  } = opts;

  const notes = [];
  const overlaySelectors = wait_for_hidden === undefined
    ? DEFAULT_OVERLAY_SELECTORS
    : (Array.isArray(wait_for_hidden) ? wait_for_hidden : [wait_for_hidden]);

  // 1) 點 trigger 前先等遮罩消失
  const stuck1 = await waitOverlaysHidden(page, overlaySelectors, wait_hidden_timeout);
  if (stuck1) notes.push(`⚠️ 遮罩 "${stuck1}" 在 ${wait_hidden_timeout}ms 後仍可見（點擊可能被攔截）`);

  // 2) 依序點 trigger（含 JS-click fallback）
  for (const trig of trigger_selectors) {
    const r = await clickTrigger(page, trig, { clickTimeout: click_timeout, force: force_click });
    if (!r.ok) {
      const why = r.interceptor
        ? `被 "${r.interceptor}" 遮罩攔截（pointer-events）`
        : (r.error || "未知原因");
      return {
        ok: false,
        notes,
        error: [
          `❌ trigger 點擊失敗於 "${trig}"：${why}`,
          ``,
          `💡 解法：`,
          `  - 加 wait_for_hidden（如 [".loader"]）等遮罩消失再點`,
          `  - 加大 click_timeout（目前 ${click_timeout}ms）`,
          `  - 開 force_click:true 直接用 JS .click() 繞過可點擊性檢查`,
        ].join("\n"),
      };
    }
    if (r.method === "js-fallback") {
      notes.push(`ℹ️ "${trig}" 一般 click 逾時${r.interceptor ? `（被 "${r.interceptor}" 攔截）` : ""}，已改用 JS .click() fallback 成功`);
    }
    await page.waitForTimeout(trigger_wait);
    // trigger 後可能又冒出 loading 遮罩，再等一次
    await waitOverlaysHidden(page, overlaySelectors, wait_hidden_timeout);
  }

  // 3) 等目標元素出現（給 Vue/React 條件 render 留時間）
  const waitTarget = wait_for_selector || target_selector;
  if (waitTarget) {
    try {
      await page.waitForSelector(waitTarget, { timeout: wait_for_timeout, state: "attached" });
    } catch (e) {
      notes.push(`⚠️ 等待 "${waitTarget}" 出現逾時（${wait_for_timeout}ms）`);
    }
  }

  return { ok: true, notes };
}

export { prepareForMeasure, waitOverlaysHidden, detectInterceptor, DEFAULT_OVERLAY_SELECTORS };
