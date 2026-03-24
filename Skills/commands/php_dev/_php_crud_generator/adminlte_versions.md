# AdminLTE 版本差異對照

> 由 `/php_crud_generator` Step 0b + Step 4 讀取使用。
> 產生 HTML 時依偵測到的版本使用不同 CSS class。

---

### 卡片 / Box 元件

| 元素 | LTE2 | LTE3 / LTE4 |
|------|------|-------------|
| 卡片容器 | `<div class="box">` | `<div class="card">` |
| 有色卡片 | `box box-primary` | `card card-primary` |
| 標題區 | `box-header with-border` | `card-header` |
| 標題 | `<h3 class="box-title">` | `<h3 class="card-title">` |
| 內容區 | `box-body` | `card-body` |
| 底部 | `box-footer` | `card-footer` |

### Grid / 表單

| 元素 | LTE2 | LTE3 / LTE4 |
|------|------|-------------|
| 12 欄 | `col-xs-12` | `col-12` |
| 表單群組 | `form-group` | `form-group` (LTE3) / `mb-3` (LTE4) |
| 取消按鈕 | `btn btn-default` | `btn btn-default` (LTE3) / `btn btn-secondary` (LTE4) |

### 資料迭代方式

| 元素 | LTE2（cursor） | LTE3 / LTE4（array） |
|------|---------------|---------------------|
| 迭代 | `while ($rs = $db->getNext())` | `foreach ($datas as $value):` |
| 欄位存取 | `$rs->field`（stdClass） | `$value['field']`（array） |
| 編輯頁 | `$data->field` | `$data['field']` |
