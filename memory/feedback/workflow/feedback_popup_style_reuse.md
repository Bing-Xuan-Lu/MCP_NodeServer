---
name: popup/彈窗樣式必須沿用既有骨架
description: 新增或修改 popup/彈窗前必須先 Grep 同專案既有 popup class 與 HTML 結構沿用，禁止自刻 inline style
type: feedback
originSessionId: e363d54b-b7a9-4234-a957-53deb4a84df5
---
新增或修改 popup / 彈窗樣式前，必須先在同一頁或同專案 Grep 既有 popup 類別（命名慣例如 `Popup-*`、`.title/.value` 結構），沿用相同 HTML 骨架與 class 命名。

**Why:** {project_a} 某 popup 因自刻 flex/border/padding inline style，連續改稿 3 輪才統一。視覺一致性與維護性都崩壞。

**How to apply:**
- 接到「新增/修改 popup 樣式」任務時，前置檢查必做：
  1. Grep 同目錄 / 同模組既有 popup class（`Popup-`、`popup_`、`dialog`、`modal` 等關鍵字）
  2. 選一個最相似的既有 popup 作為骨架範本
  3. 沿用 class 命名、HTML 層次（wrapper > header > body > row > title/value）
- 禁止行為：自己寫 flex / border / padding / margin 的 inline style；新建 class 名稱做跟既有 popup 一樣的事。
- 例外：真的沒有既有 popup 可參考時，先和使用者確認骨架規範。
