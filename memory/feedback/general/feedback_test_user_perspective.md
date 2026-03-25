---
name: 修完 Bug 用使用者角度實測
description: Bug 修復後必須用 Playwright 從使用者角度實際操作驗證，不能只看 code
type: feedback
---

修完 Bug 後，都要用使用者的角度去測試（Playwright 瀏覽器操作）。

**Why:** 使用者明確要求，光看 code 不夠，要實際走一遍操作流程確認修復有效。

**How to apply:** 每個 Bug 修完 → 部署到測試機 → 用 Playwright 打開對應頁面 → 模擬使用者操作驗證。Email 相關功能測不到沒關係，其他都要實測。
