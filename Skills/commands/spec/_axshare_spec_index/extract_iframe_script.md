# browser_evaluate iframe 內容抽取腳本

由 `/axshare_spec_index` 單頁模式 S2 引用。

## 用途

AxShare 內容多在 iframe 中，用 JS 直接從 iframe DOM 抽取，比 `browser_snapshot` 更完整。

## 腳本

```javascript
// 收集所有 iframe + 主頁面的文字內容
// 注意：Axure 流程圖畫布常在「巢狀更深」的 iframe，必須遞迴下探，
// 否則只會抓到淺層的左側 nav tree 與右側 comments，漏掉流程圖方框。
const result = { title: document.title, sections: [] };

function extractFromDoc(doc, label) {
  const section = { label, texts: [], tables: [], inputs: [], links: [], shapes: 0, connectors: 0 };

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: n => {
      const tag = n.parentElement?.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      const text = n.textContent.trim();
      return text.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  let node;
  while (node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (text) section.texts.push(text);
  }

  doc.querySelectorAll('table').forEach(t => {
    const rows = Array.from(t.rows).map(r =>
      Array.from(r.cells).map(c => c.textContent.trim())
    );
    if (rows.length > 0) section.tables.push(rows);
  });

  doc.querySelectorAll('input,select,textarea').forEach(el => {
    section.inputs.push({
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      name: el.name || '',
      placeholder: el.placeholder || '',
      value: el.value || ''
    });
  });

  doc.querySelectorAll('a[href]').forEach(a => {
    const text = a.textContent.trim();
    if (text) section.links.push({ text, href: a.href });
  });

  // 流程圖訊號：Axure 方框（.flow / shape）與連接線（SVG path/line/polyline）
  // shapes 多但 texts 少 → 該頁是流程圖，文字抽取不足，需走截圖 fallback
  section.shapes = doc.querySelectorAll('[class*="flow"],[class*="shape"]').length;
  section.connectors = doc.querySelectorAll('svg path, svg line, svg polyline').length;

  result.sections.push(section);

  // 遞迴下探巢狀 iframe（same-origin 才進得去，cross-origin 自動跳過）
  doc.querySelectorAll('iframe').forEach((f, i) => {
    try {
      if (f.contentDocument?.body) {
        extractFromDoc(f.contentDocument, label + '>iframe_' + i);
      }
    } catch (e) {} // cross-origin 跳過
  });
}

extractFromDoc(document, 'main');

// 流程圖判定旗標：任一層方框多、文字少 → diagram 頁，提示呼叫端走截圖 fallback
result.isDiagram = result.sections.some(s => s.shapes >= 5 && s.texts.length < s.shapes);
return result;
```

## 流程圖 canvas 偵測（截圖 fallback 用，單頁模式 S2b 引用）

當主抽取腳本回傳 `isDiagram: true`（方框多、文字少）時，用此腳本找出最像流程圖畫布的內層 iframe，
取得它的捲動尺寸，呼叫端據此放大 viewport 後再截圖，避免只截到一個視窗高度而截斷流程圖。

```javascript
// 遞迴找連接線最多（最像流程圖）的內層 iframe，回傳它的捲動尺寸供截圖前放大 viewport
function findCanvas(doc, label) {
  let best = null;
  const consider = (c) => {
    if (!best
      || c.connectors > best.connectors
      || (c.connectors === best.connectors && c.area > best.area)) best = c;
  };
  Array.from(doc.querySelectorAll('iframe')).forEach((f, i) => {
    let cdoc;
    try { cdoc = f.contentDocument; } catch (e) { return; } // cross-origin 跳過
    if (!cdoc?.body) return;
    const w = cdoc.body.scrollWidth, h = cdoc.body.scrollHeight;
    consider({
      label: label + '>iframe_' + i,
      scrollWidth: w,
      scrollHeight: h,
      area: w * h,
      connectors: cdoc.querySelectorAll('svg path, svg line, svg polyline').length
    });
    const deeper = findCanvas(cdoc, label + '>iframe_' + i); // 再往內遞迴
    if (deeper) consider(deeper);
  });
  return best;
}
return findCanvas(document, 'main'); // 可能為 null（無內層 iframe 時截整頁）
```

## 全站模式 nav 連結抽取（步驟 2 用）

```javascript
const frames = Array.from(document.querySelectorAll('iframe'));
const links = [];
frames.forEach(f => {
  try {
    f.contentDocument.querySelectorAll('a[href]').forEach(a => {
      const text = a.textContent.trim();
      const href = a.href;
      if (text && href) links.push({ text, href });
    });
  } catch(e) {}
});
// fallback：從主頁面找 AxShare hash 格式連結
if (links.length === 0) {
  document.querySelectorAll('a[href*="#p="],a[href*="#id="]').forEach(a => {
    links.push({ text: a.textContent.trim(), href: a.href });
  });
}
return links;
```
