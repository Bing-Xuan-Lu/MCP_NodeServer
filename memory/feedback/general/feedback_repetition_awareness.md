---
name: repetition_awareness
description: Claude 重複呼叫同類工具時應自省並建議改進，而非持續執行
type: feedback
---

重複執行同類工具呼叫（如連續 Read 多張圖片）= 應該停下來檢討的訊號，不是繼續做下去。

**Why:** 使用者發現 Claude 長期重複 Read 圖片卻從未主動建議用 batch 工具或建立新工具，直到使用者自己提出才改善。重複行為浪費大量 token 且錯失工具改進機會。

**How to apply:**
- 同類工具呼叫達 3 次 → 暫停，向使用者提議改用 batch 工具或建立新工具
- 完全相同的工具+參數呼叫 2 次 → 一定有問題，停下來重新思考
- 已有 PreToolUse hook `repetition-detector.js` 會自動偵測並注入提醒
- 收到 `[Repetition Detector]` 訊息時必須認真回應，不可忽略繼續執行
