---
name: batch_replace_preference
description: 多檔相同字串替換應用 sed/node 腳本批次處理，不逐一 Edit
type: feedback
---

多檔做相同字串替換時，用一行 sed 或 node 腳本一次掃完所有檔案，不要逐一 Edit。

**Why:** 逐一 Edit 多檔相同替換浪費 tool call 來回，效率低。
**How to apply:** 當發現需要在 3+ 個檔案做相同 old_string → new_string 替換時，直接寫一行 Bash 批次處理。已在 repetition-detector.js 加入 L2.7 `edit_batch_replace` 規則自動偵測。
