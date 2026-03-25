---
name: PHP 頁面太長主動切 include
description: 前台 PHP 頁面超過 300-400 行時主動拆分為 include 檔案，避免維護困難
type: feedback
---

頁面太長時主動切 include，不要硬塞在同一檔案裡。

**Why:** 曾遇到單一 PHP 頁面超過 900 行（33K tokens），混合多個功能區塊，難以維護。

**How to apply:**
- 發現 PHP 頁面超過 300-400 行時，考慮拆分為 include 檔案
- 命名慣例：`_{section_name}.php`（底線開頭表示 partial）
- 拆分原則：依功能區塊拆（如 `_list_section.php`、`_form_section.php`）
- 拆分後主檔只保留架構骨架和 `include_once()`
- 不限於特定頁面，任何前台頁面都適用
