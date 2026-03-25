---
name: CSS 修改前先確認 computed style
description: 修改 CSS 前必須用 getComputedStyle 確認現有樣式，避免與壓縮 CSS 規則重疊
type: feedback
---

修改或新增 CSS 規則前，先用 `getComputedStyle` 確認目標元素現有的樣式值，再決定要加什麼。

**Why:** 壓縮過的 CSS（minified）用 grep 搜尋不容易看到完整規則，直接加新規則可能與既有規則疊加（如雙線 border）。

**How to apply:**
- 改 CSS 前用 Playwright `browser_evaluate` 跑 `getComputedStyle(el).borderBottom`（或相關屬性）確認現有值
- 特別注意壓縮 CSS — grep/搜尋可能漏掉規則，computed style 才是真相
- 新增 border/margin/padding 等累加型屬性前尤其要確認，避免與既有規則疊加
