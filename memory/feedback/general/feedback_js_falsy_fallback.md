---
name: JS falsy fallback 陷阱
description: JS 中 parseInt(0) || 100 = 100，值可為 0 時不能用 || 做 fallback，改用 ?? 或三元運算
type: feedback
---

JS 中 `||` 會把 `0`、`""`、`false`、`null`、`undefined` 都當 falsy 觸發 fallback。

**Why:** `parseInt(val) || defaultVal` 當 val=0 時會回傳 defaultVal 而非 0，導致數值計算錯誤。

**How to apply:**
- 值可能為 `0` 或空字串時，用 `??`（nullish coalescing）取代 `||`
- `parseInt(val) ?? 100` — 只在 null/undefined 時 fallback
- 或用三元：`val !== null ? parseInt(val) : 100`
- 特別注意表單欄位（數量、金額、索引）常會有 0 值
