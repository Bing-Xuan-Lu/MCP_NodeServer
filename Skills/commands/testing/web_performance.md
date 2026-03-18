---
name: web_performance
description: |
  使用 Playwright 實測網頁載入指標並搭配 PageSpeed/Lighthouse 取得評分與優化建議。涵蓋：LCP/FCP/CLS 指標、圖片壓縮、快取策略、可執行優化報告。
  當使用者說「網頁很慢」「效能測試」「performance」「lighthouse」「跑分」時使用。
---

# /web_performance — 網站前端效能檢測與優化建議

你是前端效能分析專家，使用 Playwright 實測頁面載入指標，再搭配外部評分工具（PageSpeed Insights API → Lighthouse CLI → CrUX API，依可用性自動 fallback）取得評分與建議，產出可執行的優化報告。

---

## 輸入

$ARGUMENTS

格式：`網址 [選項]`

範例：
- `http://localhost:8084/myapp/adminControl/list.php` — 分析本機頁面
- `https://example.com` — 分析公開網站
- `http://localhost:8084/myapp/adminControl/list.php mobile` — 指定行動版策略

若未指定策略，預設同時測試 desktop 和 mobile。

## 可用工具

- **瀏覽器自動化**：`Playwright MCP`（截圖、PerformanceObserver 指標收集）
- **外部 API 呼叫**：`send_http_request`（PageSpeed Insights API、CrUX API）

---

## 步驟

### 步驟 0：判斷環境

根據網址判斷可用的檢測方式：

| 網址類型 | Playwright | PageSpeed API | Lighthouse CLI | CrUX API |
|---------|------------|---------------|---------------|----------|
| `localhost` / `127.0.0.1` | 可用 | 不可用 | 可用（本機也能測） | 不可用（無真實用戶數據） |
| 公開網址（https://...） | 可用 | 可用（可能 429） | 可用（fallback） | 可用（需有足夠流量） |

告知使用者將執行哪些檢測。

**Lighthouse CLI 前置檢查**：執行 `lighthouse --version`，若未安裝則提示：
```
npm install -g lighthouse
```
Lighthouse 為免費工具，本機執行不受 API 速率限制。

### 步驟 1：Playwright 頁面實測

#### 1a. 載入頁面並收集 Performance API 指標

```
browser_navigate {URL}
```

等待頁面完全載入後，執行 JavaScript 收集指標：

```
browser_evaluate function="() => {
  const perf = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByType('paint');
  const resources = performance.getEntriesByType('resource');

  // 資源分類統計
  const resourceStats = {};
  resources.forEach(r => {
    const type = r.initiatorType || 'other';
    if (!resourceStats[type]) resourceStats[type] = { count: 0, totalSize: 0 };
    resourceStats[type].count++;
    resourceStats[type].totalSize += r.transferSize || 0;
  });

  return {
    // 載入時間
    timing: {
      dns: Math.round(perf.domainLookupEnd - perf.domainLookupStart),
      tcp: Math.round(perf.connectEnd - perf.connectStart),
      ttfb: Math.round(perf.responseStart - perf.requestStart),
      domContentLoaded: Math.round(perf.domContentLoadedEventEnd - perf.startTime),
      loadComplete: Math.round(perf.loadEventEnd - perf.startTime),
      domInteractive: Math.round(perf.domInteractive - perf.startTime),
    },
    // Paint 時間
    paint: paint.map(p => ({ name: p.name, time: Math.round(p.startTime) })),
    // 資源統計
    resources: resourceStats,
    totalResources: resources.length,
    totalTransferSize: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
  };
}"
```

#### 1b. DOM 與頁面結構分析

```
browser_evaluate function="() => {
  const allElements = document.querySelectorAll('*');
  const images = document.querySelectorAll('img');
  const scripts = document.querySelectorAll('script[src]');
  const inlineScripts = document.querySelectorAll('script:not([src])');
  const stylesheets = document.querySelectorAll('link[rel=stylesheet]');
  const inlineStyles = document.querySelectorAll('style');

  // 檢查圖片問題
  const imageIssues = [];
  images.forEach(img => {
    const issues = [];
    if (!img.hasAttribute('width') || !img.hasAttribute('height')) issues.push('缺少 width/height 屬性（影響 CLS）');
    if (!img.hasAttribute('loading')) issues.push('未設定 lazy loading');
    if (!img.hasAttribute('alt')) issues.push('缺少 alt 屬性');
    if (img.naturalWidth > 1000 && !img.src.includes('.webp') && !img.src.includes('.avif')) issues.push('大圖未使用 WebP/AVIF 格式');
    if (issues.length > 0) imageIssues.push({ src: img.src.substring(0, 80), issues });
  });

  // 檢查 render-blocking 資源
  const renderBlocking = [];
  scripts.forEach(s => {
    if (!s.hasAttribute('async') && !s.hasAttribute('defer') && !s.type?.includes('module')) {
      renderBlocking.push({ type: 'script', src: s.src.substring(0, 80) });
    }
  });
  stylesheets.forEach(s => {
    if (!s.hasAttribute('media') || s.media === 'all') {
      renderBlocking.push({ type: 'stylesheet', href: s.href.substring(0, 80) });
    }
  });

  return {
    domCount: allElements.length,
    images: { total: images.length, issues: imageIssues.slice(0, 10) },
    scripts: { external: scripts.length, inline: inlineScripts.length },
    stylesheets: { external: stylesheets.length, inline: inlineStyles.length },
    renderBlocking: renderBlocking.slice(0, 10),
  };
}"
```

#### 1c. 檢查 Console 錯誤

```
browser_console_messages level="error"
```

記錄 JS 錯誤數量和內容（錯誤會影響效能和體驗）。

#### 1d. 網路請求分析

```
browser_network_requests includeStatic=true filename=".playwright-mcp/network-requests.log"
```

找出：
- 失敗的請求（4xx / 5xx）
- 超大檔案（> 500KB）
- 未壓縮的資源（缺少 gzip/br）

#### 1e. `<head>` 腳本載入順序檢查（隱私權合規）

檢查 Consent Manager、GTM、GA 的相對載入順序：

```
browser_evaluate function="() => {
  const headChildren = Array.from(document.head.children);
  const loadOrder = [];
  let index = 0;
  headChildren.forEach(el => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script') {
      const src = el.src || '';
      const content = !el.src ? el.textContent.substring(0, 200) : '';
      const isGTM = content.includes('GTM-') || content.includes('googletagmanager') || src.includes('googletagmanager');
      const isGA = content.includes('gtag') || content.includes('G-') || src.includes('gtag');
      const isConsent = content.includes('consent') || content.includes('cookie') || content.includes('privacy') || src.includes('consent') || src.includes('cookie') || src.includes('privacy');
      if (isGTM || isGA || isConsent) {
        loadOrder.push({
          index: index,
          type: isConsent ? 'CONSENT' : isGTM ? 'GTM' : 'GA',
          src: src ? src.substring(src.lastIndexOf('/')+1, src.lastIndexOf('/')+60) : '(inline)',
          async: el.hasAttribute('async'),
          defer: el.hasAttribute('defer'),
        });
      }
      index++;
    }
  });
  return loadOrder;
}"
```

**正確順序**：Consent Manager → GTM Consent Mode default denied → GTM/GA
若 GTM/GA 排在 Consent 之前，標記為 🔴 嚴重合規問題。

### 步驟 2：外部評分工具（三層 Fallback）

依序嘗試以下方案，成功一個就停止：

#### 2a. PageSpeed Insights API（首選，僅公開網址）

若網址為公開網址，呼叫 PageSpeed Insights API：

```
WebFetch url="https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url={URL}&strategy=mobile&category=performance" prompt="提取以下資訊：1) Performance 總分 2) Core Web Vitals (LCP, FID, CLS, INP, TTFB, FCP) 的數值和評級 3) 所有 audit 結果中 score < 1 的項目（id、title、displayValue、description）4) 按 score 排序，最差的排前面"
```

再測 desktop：
```
WebFetch url="https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url={URL}&strategy=desktop&category=performance" prompt="提取同上資訊"
```

**若回傳 429（速率限制）→ 進入 2b**

#### 2b. Lighthouse CLI（Fallback 1，本機執行）

PageSpeed API 不可用時（429 或 localhost），使用 Lighthouse CLI 本機執行：

```bash
# 先確認已安裝
lighthouse --version

# Mobile 測試（預設）
lighthouse {URL} --output json --output-path .playwright-mcp/lighthouse-mobile.json --chrome-flags="--headless --no-sandbox" --only-categories=performance --form-factor=mobile --screenEmulation.mobile --throttling-method=simulate

# Desktop 測試
lighthouse {URL} --output json --output-path .playwright-mcp/lighthouse-desktop.json --chrome-flags="--headless --no-sandbox" --only-categories=performance --form-factor=desktop --screenEmulation.disabled --throttling-method=simulate
```

從 JSON 結果提取：
- `categories.performance.score * 100` → 總分
- `audits['largest-contentful-paint'].numericValue` → LCP
- `audits['cumulative-layout-shift'].numericValue` → CLS
- `audits['interactive'].numericValue` → TTI
- `audits['total-blocking-time'].numericValue` → TBT（FID/INP 的替代指標）
- `audits['first-contentful-paint'].numericValue` → FCP
- `audits['speed-index'].numericValue` → Speed Index
- 所有 `audits[*].score < 1` 的項目 → 待改善清單

```bash
# 快速提取重點（用 node 解析 JSON）
node -e "
const r = require('./.playwright-mcp/lighthouse-mobile.json');
console.log('Score:', Math.round(r.categories.performance.score * 100));
console.log('FCP:', r.audits['first-contentful-paint'].displayValue);
console.log('LCP:', r.audits['largest-contentful-paint'].displayValue);
console.log('CLS:', r.audits['cumulative-layout-shift'].displayValue);
console.log('TBT:', r.audits['total-blocking-time'].displayValue);
console.log('SI:', r.audits['speed-index'].displayValue);
const failed = Object.values(r.audits).filter(a => a.score !== null && a.score < 1 && a.details).sort((a,b) => a.score - b.score);
failed.forEach(a => console.log(a.score, a.title, a.displayValue || ''));
"
```

**注意事項**：
- Lighthouse 會自動啟動 Chrome，若 Playwright 正在使用 Chrome，需先關閉 Playwright 的瀏覽器（`browser_close`）再執行 Lighthouse，完成後再重新 `browser_navigate`
- 若 Lighthouse 未安裝，提示使用者：`npm install -g lighthouse`
- Lighthouse 執行時間較長（約 30-60 秒），告知使用者耐心等候

**若 Lighthouse 也失敗（未安裝或執行錯誤）→ 進入 2c**

#### 2c. CrUX API（Fallback 2，真實用戶數據，僅公開網址）

Chrome User Experience Report API 提供真實 Chrome 用戶的效能數據（免費，不需 API Key）：

```
WebFetch url="https://chromeuxreport.googleapis.com/v1/records:queryRecord" prompt="提取以下資訊：1) 各指標的 p75 數值 2) 評級分佈（good/needs-improvement/poor 百分比）3) 涵蓋指標：LCP、CLS、INP、FCP、TTFB"
```

注意：CrUX API 需用 POST 方法，若 WebFetch 不支援 POST，改用 Bash：

```bash
curl -s -X POST "https://chromeuxreport.googleapis.com/v1/records:queryRecord" \
  -H "Content-Type: application/json" \
  -d '{"url": "{URL}"}' | node -e "
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const r = JSON.parse(chunks.join(''));
  if (r.error) { console.log('CrUX 無數據:', r.error.message); process.exit(0); }
  const m = r.record.metrics;
  Object.keys(m).forEach(k => {
    const p = m[k].percentiles;
    const h = m[k].histogram;
    console.log(k + ': p75=' + (p?.p75 || 'N/A') +
      ' (good:' + ((h?.[0]?.density*100)||0).toFixed(0) + '%' +
      ' / poor:' + ((h?.[2]?.density*100)||0).toFixed(0) + '%)');
  });
});
"
```

**CrUX 限制**：
- 只有流量足夠的網站才有數據（小型活動頁面可能無數據）
- 數據為過去 28 天的彙總，不是即時測試結果
- 不提供具體的優化建議，僅提供指標數值

**若 CrUX 也無數據** → 在報告中標註「外部評分工具均不可用，僅使用 Playwright 實測數據」

### 步驟 3：產出效能報告

整合所有結果，產出報告：

```
📊 前端效能檢測報告
🔗 {URL}
📅 {日期}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔬 Playwright 實測指標

| 指標 | 數值 | 評級 |
|------|------|------|
| TTFB（首字節時間） | {N}ms | 🟢/🟡/🔴 |
| FCP（首次繪製） | {N}ms | 🟢/🟡/🔴 |
| DOM Content Loaded | {N}ms | 🟢/🟡/🔴 |
| 完全載入 | {N}ms | 🟢/🟡/🔴 |
| DOM 元素數 | {N} | 🟢/🟡/🔴 |
| 總資源數 | {N} | - |
| 總傳輸量 | {N} KB | 🟢/🟡/🔴 |

📦 資源分佈
| 類型 | 數量 | 大小 |
|------|------|------|
| script | {N} | {N} KB |
| css | {N} | {N} KB |
| img | {N} | {N} KB |
| font | {N} | {N} KB |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🌐 外部評分（PageSpeed / Lighthouse / CrUX，若有）

| | Mobile | Desktop |
|--|--------|---------|
| 總分 | {N}/100 | {N}/100 |
| LCP | {N}s | {N}s |
| FID/INP | {N}ms | {N}ms |
| CLS | {N} | {N} |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ 發現的問題（依嚴重度排序）

| # | 嚴重度 | 問題 | 影響 | 建議修正 |
|---|--------|------|------|---------|
| 1 | 🔴 嚴重 | {問題描述} | {影響指標} | {具體修正方式} |
| 2 | 🟡 中等 | ... | ... | ... |
| 3 | 🟢 建議 | ... | ... | ... |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🛠️ 優化行動清單（依投入/效益排序）

□ 1. {最高效益的改善項目}
     做法：{具體步驟}
□ 2. ...
□ 3. ...
```

### 步驟 4：產出 MD 報告檔

將步驟 3 的完整報告寫入 MD 檔案：

```
Write {MCP_ROOT}/reports/web_performance_{domain}_{YYYYMMDD}.md
```

**檔案命名規則**：
- `{domain}`：網址的域名部分，取代 `.` 為 `_`（如 `example_com`）
- `{YYYYMMDD}`：檢測日期

**報告內容結構**（完整版，比對話輸出更詳細）：

```markdown
# 前端效能檢測報告

- **網址**：{URL}
- **頁面標題**：{title}
- **檢測日期**：{date}
- **檢測工具**：Playwright MCP + Network Analysis
- **外部評分工具**：{PageSpeed API / Lighthouse CLI / CrUX API / 均不可用}

## 1. 載入時間指標
（含評級標準對照表）

## 2. 資源分佈
（含各類型數量、大小、佔比）

## 3. DOM 結構分析
（圖片問題、render-blocking 資源清單）

## 4. 隱私權合規檢查
（<head> 載入順序、網路請求時序、修正建議含程式碼）

## 5. 發現的問題（依嚴重度排序）
（每個問題含：問題描述、影響指標、具體修正方式）

## 6. 優化行動清單
（含優先順序、預估效益、難度）

## 7. 具體修正範例
（每個修正含修正前/修正後的程式碼）

---
*報告由 Claude Code /web_performance Skill 產出*
```

報告寫入後告知使用者檔案路徑。

### 步驟 5：互動式深入分析（可選）

報告產出後，詢問使用者是否要針對特定問題深入分析：

> 要針對哪個項目深入分析？
> 1. 逐一檢查圖片優化
> 2. 分析 JS bundle 大小
> 3. 檢查 CSS 使用率
> 4. 測試其他頁面
> 5. 完成

---

## 評級標準

| 指標 | 🟢 良好 | 🟡 需改善 | 🔴 差 |
|------|---------|----------|-------|
| TTFB | < 200ms | 200-600ms | > 600ms |
| FCP | < 1.8s | 1.8-3.0s | > 3.0s |
| LCP | < 2.5s | 2.5-4.0s | > 4.0s |
| CLS | < 0.1 | 0.1-0.25 | > 0.25 |
| INP | < 200ms | 200-500ms | > 500ms |
| DOM 元素數 | < 800 | 800-1500 | > 1500 |
| 總傳輸量 | < 1MB | 1-3MB | > 3MB |
| 完全載入 | < 3s | 3-6s | > 6s |

---

## 常見問題與修正對照

| 問題 | 影響指標 | 修正方式 |
|------|---------|---------|
| 圖片缺少 width/height | CLS | 加上明確的寬高屬性 |
| 圖片未 lazy load | LCP, 傳輸量 | 加 `loading="lazy"`（首屏圖片除外） |
| 圖片未用 WebP/AVIF | 傳輸量 | 轉檔或用 `<picture>` 提供多格式 |
| JS 未 async/defer | FCP, LCP | 加 `defer`（或 `async`）屬性 |
| CSS 未分離關鍵樣式 | FCP | 內聯關鍵 CSS，延遲載入其餘 |
| 未啟用 gzip/brotli | 傳輸量 | Web server 設定啟用壓縮 |
| 字型檔過大 | FCP, LCP | 使用 `font-display: swap` + 子集化 |
| 第三方腳本過多 | 全部 | 審查必要性，延遲載入非關鍵腳本 |
| DOM 過深/過多 | INP | 簡化結構，移除不必要的包裝元素 |
| 未快取靜態資源 | 重複載入 | 設定 Cache-Control header |

---

## 注意事項

- `localhost` 網址只能用 Playwright 實測和 Lighthouse CLI，無法用 PageSpeed API 和 CrUX API
- PageSpeed API 免費版有速率限制（約每分鐘 1-2 次），遇 429 自動 fallback 到 Lighthouse CLI
- Lighthouse CLI 需先安裝：`npm install -g lighthouse`（免費，本機執行無速率限制）
- Lighthouse 執行時會佔用 Chrome，若 Playwright 正在使用需先 `browser_close`，Lighthouse 完成後再重新開啟
- CrUX API 免費、不需 API Key，但只有流量足夠的網站才有數據（過去 28 天彙總）
- Playwright 測試結果受本機效能影響，數值僅供相對比較
- 報告中的「建議修正」應具體到可執行的程式碼或設定修改
- 若需要登入才能測試的頁面，先用 Playwright 完成登入流程再分析

### 三層 Fallback 摘要

```
PageSpeed API（公開網址首選）
  ↓ 429 或失敗
Lighthouse CLI（本機執行，需安裝）
  ↓ 未安裝或失敗
CrUX API（真實用戶數據，流量不足可能無數據）
  ↓ 無數據
僅使用 Playwright 實測指標
```