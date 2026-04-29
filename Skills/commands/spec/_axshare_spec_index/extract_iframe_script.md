# browser_evaluate iframe 內容抽取腳本

由 `/axshare_spec_index` 單頁模式 S2 引用。

## 用途

AxShare 內容多在 iframe 中，用 JS 直接從 iframe DOM 抽取，比 `browser_snapshot` 更完整。

## 腳本

```javascript
// 收集所有 iframe + 主頁面的文字內容
const result = { title: document.title, sections: [] };

function extractFromDoc(doc, label) {
  const section = { label, texts: [], tables: [], inputs: [], links: [] };

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

  result.sections.push(section);
}

extractFromDoc(document, 'main');

Array.from(document.querySelectorAll('iframe')).forEach((f, i) => {
  try {
    if (f.contentDocument?.body) {
      extractFromDoc(f.contentDocument, 'iframe_' + i);
    }
  } catch(e) {} // cross-origin 跳過
});

return result;
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
