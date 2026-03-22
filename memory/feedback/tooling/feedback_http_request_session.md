---
name: feedback_http_request_session
description: send_http_request 不回傳 Set-Cookie，無法跨請求維持 session，登入後功能測試需改用 Playwright
type: feedback
---

## send_http_request 不回傳 Set-Cookie

`send_http_request` 工具每次請求都是無狀態的，即使 POST 登入端點收到成功回應，Set-Cookie header 也不會被捕獲或攜帶到後續請求。

**Why:** 邏輯稽核員用 `send_http_request POST /ajax/member/login.php` 取得 `{"result":"1"}` 成功回應，但後續 GET 請求沒有攜帶 session cookie，導致登入後功能（會員中心、購物車、結帳）全部無法測試。

**How to apply:**
1. 無程式碼/無DB 場景下，邏輯稽核員只能測試**無需登入的公開端點**
2. 登入後功能的驗證必須交給 **UI/UX 稽核員（Playwright）**，Playwright 自動管理 cookie session
3. 若需要 HTTP 層的登入後測試，需要手動從 Playwright 複製 cookie 後帶入 `request_cookies` 參數
4. 評估：`send_http_request` 若能加入 session 模式（自動儲存並攜帶 Set-Cookie），可大幅提升邏輯測試覆蓋率
