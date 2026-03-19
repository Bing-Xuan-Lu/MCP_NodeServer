---
name: feedback_md_linting
description: 編輯 MD 檔時 pre-existing lint warning 重複出現的處理方式
type: feedback
---

編輯 MD 檔後若 linter 報出大量警告，先確認是 pre-existing 問題（改之前就存在），不要把責任歸咎於本次修改。

**Why:** 過去在修改 tdd.md、php_crud_test.md 時，將 pre-existing 的 `|------|` separator 格式問題與缺語言標籤的 code block 誤診為「本次修改造成」，並錯誤歸因給「backtick 內有冒號逗號」，浪費多輪迭代。

**How to apply:**
1. 遇到 lint 報錯，先判斷是 pre-existing 還是新引入
2. 若是 pre-existing → 一次讀取所有 warning 行，批量修掉（不要逐個拖延）
3. 常見 MD 問題：
   - MD060：表格 separator 行 `|------|` 需與 header 一致，header 有空格則用 `| --- |`
   - MD040：fenced code block 必須指定語言（加 `text`、`bash`、`php` 等）
   - MD036：不可用 bold `**text**` 當標題，改用 `####`
   - MD001：標題層級不可跳（h3 → h5 不允許，需用 h4）
